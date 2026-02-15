/**
 * Licensed under the MIT License
 *
 * @author   Kanstantsin A Kamkou (2ka.by)
 * @license  http://www.opensource.org/licenses/mit-license.php The MIT License
 * @link     https://github.com/kkamkou/node-gelf-pro
 */

'use strict';

// required stuff
var _ = require('lodash'),
  net = require('net'),
  abstract = require('./abstract');

// compatibility
var buffer = require('../compatibility/buffer');

// the class itself
var adapter = Object.create(abstract);

/**
 * Builds a null-terminated packet from a message string
 * @param {String} message
 * @returns {Buffer}
 */
adapter._buildPacket = function (message) {
  var msg = buffer.from(message.replace(/\x00/g, '')); // eslint-disable-line
  return buffer.from(Array.prototype.slice.call(msg, 0, msg.length).concat(0x00));
};

/**
 * Sends a message to the server (legacy mode: new connection per message)
 * @param {String} message
 * @param {Function} callback
 * @returns {adapter}
 */
adapter._sendLegacy = function (message, callback) {
  var cb = _.once(callback),
    timeout = this.options.timeout || 10000,
    client = this._instance(this.options);

  client.setTimeout(timeout, function () {
    client.emit('error', new Error('Timeout (' + timeout + ' ms)'));
  });

  client
    .once('error', function (err) {
      client.end();
      client.destroy();
      cb(err);
    })
    .once('connect', function () {
      // @todo #37:60m add deflation with GELF 2.0
      var msg = buffer.from(message.replace(/\x00/g, '')), // eslint-disable-line
        packet = buffer.from(Array.prototype.slice.call(msg, 0, msg.length).concat(0x00));
      client.end(packet, function () {
        cb(null, packet.length);
      });
    });

  return this;
};

/**
 * Returns keepAlive options with defaults
 * @returns {Object}
 */
adapter._getKeepAliveOptions = function () {
  var defaults = {
    maxQueueSize: 5000,
    reconnectBaseDelay: 100,
    reconnectMaxDelay: 5000,
    reconnectMaxAttempts: 0,
    writeTimeout: 5000,
    queueFullBehavior: 'drop-oldest'
  };
  return _.defaults({}, this.options.keepAliveOptions || {}, defaults);
};

/**
 * Initializes persistent connection state (called once lazily)
 */
adapter._initPersistent = function () {
  if (this._persistentInitialized) { return; }
  this._persistentInitialized = true;
  this._state = 'disconnected';
  this._socket = null;
  this._queue = [];
  this._draining = false;
  this._currentEntry = null;
  this._reconnectDelay = 0;
  this._reconnectTimer = null;
  this._reconnectAttempts = 0;
};

/**
 * Establishes the persistent connection
 */
adapter._connect = function () {
  if (this._state === 'closed') { return; }
  if (this._state === 'connecting' || this._state === 'connected') { return; }

  this._state = 'connecting';
  var self = this;
  var client = this._instance(this.options);
  this._socket = client;

  var kaOpts = this._getKeepAliveOptions();

  client.setTimeout(kaOpts.writeTimeout, function () {
    client.emit('error', new Error('Socket timeout'));
  });

  client.once('connect', function () {
    self._state = 'connected';
    self._reconnectDelay = 0;
    self._reconnectAttempts = 0;
    client.setTimeout(0);
    self._drain();
  });

  client.on('error', function (err) {
    self._handleDisconnect(err);
  });

  client.on('close', function () {
    if (self._state === 'connected' || self._state === 'connecting') {
      self._handleDisconnect(new Error('Connection closed'));
    }
  });
};

/**
 * Handles disconnection: cleans up socket, re-queues in-flight, schedules reconnect
 * @param {Error} err
 */
adapter._handleDisconnect = function (err) {
  if (this._state === 'closed' || this._state === 'disconnected') { return; }

  this._state = 'disconnected';

  if (this._socket) {
    try {
      this._socket.removeAllListeners();
      this._socket.destroy();
    } catch (e) { /* ignore cleanup errors */ }
    this._socket = null;
  }

  this._draining = false;

  // re-queue the in-flight message if write didn't complete
  if (this._currentEntry) {
    this._currentEntry.inflight = false;
    this._queue.unshift(this._currentEntry);
    this._currentEntry = null;
  }

  var kaOpts = this._getKeepAliveOptions();
  if (kaOpts.reconnectMaxAttempts > 0 &&
      this._reconnectAttempts >= kaOpts.reconnectMaxAttempts) {
    this._errorAllQueued(new Error('Max reconnect attempts reached'));
    return;
  }

  this._scheduleReconnect();
};

/**
 * Schedules a reconnect with exponential backoff
 */
adapter._scheduleReconnect = function () {
  if (this._state === 'closed') { return; }
  if (this._reconnectTimer) { return; }

  var kaOpts = this._getKeepAliveOptions();
  var base = kaOpts.reconnectBaseDelay;
  var max = kaOpts.reconnectMaxDelay;

  this._reconnectDelay = Math.min(base * Math.pow(2, this._reconnectAttempts), max);
  this._reconnectAttempts++;

  var self = this;
  this._reconnectTimer = setTimeout(function () {
    self._reconnectTimer = null;
    if (self._state === 'disconnected' && self._queue.length > 0) {
      self._connect();
    }
  }, this._reconnectDelay);
};

/**
 * Drains the queue: writes queued messages to the connected socket
 */
adapter._drain = function () {
  if (this._state !== 'connected' || this._draining) { return; }
  if (this._queue.length === 0) { return; }

  this._draining = true;
  var self = this;

  var processNext = function () {
    if (self._state !== 'connected' || self._queue.length === 0) {
      self._draining = false;
      self._currentEntry = null;
      return;
    }

    var entry = self._queue.shift();
    entry.inflight = true;
    self._currentEntry = entry;

    self._socket.write(entry.packet, function (writeErr) {
      if (!entry.inflight) { return; }
      self._currentEntry = null;
      if (writeErr) {
        self._queue.unshift(entry);
        self._handleDisconnect(writeErr);
      } else {
        entry.callback(null, entry.packet.length);
        process.nextTick(processNext);
      }
    });
  };

  processNext();
};

/**
 * Calls all queued callbacks with an error
 * @param {Error} err
 */
adapter._errorAllQueued = function (err) {
  var queue = this._queue;
  this._queue = [];
  queue.forEach(function (entry) {
    entry.callback(err);
  });
};

/**
 * Enqueues a message for sending
 * @param {Buffer} packet
 * @param {Function} callback
 */
adapter._enqueue = function (packet, callback) {
  var kaOpts = this._getKeepAliveOptions();
  var cb = _.once(callback);

  if (this._queue.length >= kaOpts.maxQueueSize) {
    if (kaOpts.queueFullBehavior === 'drop-oldest') {
      var dropped = this._queue.shift();
      dropped.callback(new Error('Queue overflow: message dropped'));
    } else {
      cb(new Error(kaOpts.queueFullBehavior === 'error' ? 'Queue full' : 'Queue overflow: message dropped'));
      return;
    }
  }

  this._queue.push({packet: packet, callback: cb, enqueuedAt: Date.now()});
};

/**
 * Sends a message using persistent connection
 * @param {String} message
 * @param {Function} callback
 * @returns {adapter}
 */
adapter._sendPersistent = function (message, callback) {
  this._initPersistent();

  if (this._state === 'closed') {
    callback(new Error('Adapter is closed'));
    return this;
  }

  var packet = this._buildPacket(message);
  this._enqueue(packet, callback);

  if (this._state === 'disconnected') {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;
    this._connect();
  } else if (this._state === 'connected') {
    this._drain();
  }

  return this;
};

/**
 * Closes the persistent connection and cleans up
 * @param {Function} [callback]
 */
adapter.close = function (callback) {
  callback = callback || _.noop;

  if (!this._persistentInitialized || this._state === 'closed') {
    callback();
    return this;
  }

  this._state = 'closed';

  if (this._reconnectTimer) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  if (this._currentEntry) {
    this._currentEntry.inflight = false;
    this._currentEntry.callback(new Error('Adapter closed'));
    this._currentEntry = null;
  }

  this._errorAllQueued(new Error('Adapter closed'));

  if (this._socket) {
    try {
      this._socket.removeAllListeners();
      this._socket.end();
      this._socket.destroy();
    } catch (e) { /* ignore */ }
    this._socket = null;
  }

  callback();
  return this;
};

/**
 * Sends a message to the server
 * @param {String} message
 * @param {Function} callback
 * @returns {adapter}
 */
adapter.send = function (message, callback) {
  if (this.options.keepAlive) {
    return this._sendPersistent(message, callback);
  }
  return this._sendLegacy(message, callback);
};

/**
 * @param {Object} options
 * @returns {net.Socket}
 * @access protected
 */
adapter._instance = function (options) {
  return net.connect(options);
};

// exporting outside
module.exports = adapter;
