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
  return buffer.from(
    Array.prototype.slice.call(msg, 0, msg.length).concat(0x00)
  );
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
        packet = buffer.from(
          Array.prototype.slice.call(msg, 0, msg.length).concat(0x00)
        );
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
    poolSize: 1,
    onBatchDisconnect: 'retry',
    maxQueueSize: 5000,
    reconnectBaseDelay: 100,
    reconnectMaxDelay: 5000,
    reconnectMaxAttempts: 0,
    writeTimeout: 5000,
    queueFullBehavior: 'drop-oldest',
    batchSize: 16,
  };
  return _.defaults({}, this.options.keepAliveOptions || {}, defaults);
};

/**
 * Creates a fresh connection slot
 * @returns {Object}
 */
adapter._createSlot = function () {
  return {
    state: 'disconnected',
    socket: null,
    queue: [],
    draining: false,
    currentBatch: null,
    reconnectDelay: 0,
    reconnectTimer: null,
    reconnectAttempts: 0,
  };
};

/**
 * Initializes persistent connection state (called once lazily)
 */
adapter._initPersistent = function () {
  if (this._persistentInitialized) {
    return;
  }
  this._persistentInitialized = true;

  var kaOpts = this._getKeepAliveOptions();
  var size = Math.max(1, Math.floor(kaOpts.poolSize));

  this._pool = [];
  for (var i = 0; i < size; i++) {
    this._pool.push(this._createSlot());
  }
  this._nextSlot = 0;
  this._poolClosed = false;
};

/**
 * Establishes a persistent connection for a slot
 * @param {Object} slot
 */
adapter._connect = function (slot) {
  if (this._poolClosed) {
    return;
  }
  if (slot.state === 'closed') {
    return;
  }
  if (slot.state === 'connecting' || slot.state === 'connected') {
    return;
  }

  slot.state = 'connecting';
  var self = this;
  var client = this._instance(this.options);
  slot.socket = client;

  var kaOpts = this._getKeepAliveOptions();

  client.setTimeout(kaOpts.writeTimeout, function () {
    client.emit('error', new Error('Socket timeout'));
  });

  client.once('connect', function () {
    slot.state = 'connected';
    slot.reconnectDelay = 0;
    slot.reconnectAttempts = 0;
    client.setTimeout(0);
    self._drain(slot);
  });

  client.on('error', function (err) {
    self._handleDisconnect(slot, err);
  });

  client.on('close', function () {
    if (slot.state === 'connected' || slot.state === 'connecting') {
      self._handleDisconnect(slot, new Error('Connection closed'));
    }
  });
};

/**
 * Handles disconnection: cleans up socket, handles in-flight batch, schedules reconnect
 * @param {Object} slot
 * @param {Error} err
 */
adapter._handleDisconnect = function (slot, err) {
  if (slot.state === 'closed' || slot.state === 'disconnected') {
    return;
  }

  slot.state = 'disconnected';

  if (slot.socket) {
    try {
      slot.socket.removeAllListeners();
      slot.socket.destroy();
    } catch (e) {
      /* ignore cleanup errors */
    }
    slot.socket = null;
  }

  slot.draining = false;

  // handle in-flight batch based on onBatchDisconnect policy
  if (slot.currentBatch) {
    var kaOpts = this._getKeepAliveOptions();
    if (kaOpts.onBatchDisconnect === 'drop') {
      // at-most-once: error the in-flight batch, don't re-queue
      for (var d = 0; d < slot.currentBatch.length; d++) {
        slot.currentBatch[d].inflight = false;
        slot.currentBatch[d].callback(err || new Error('Connection lost'));
      }
    } else {
      // 'retry' (default): re-queue in-flight batch to front
      for (var i = slot.currentBatch.length - 1; i >= 0; i--) {
        slot.currentBatch[i].inflight = false;
        slot.queue.unshift(slot.currentBatch[i]);
      }
    }
    slot.currentBatch = null;
  }

  var kaOpts2 = this._getKeepAliveOptions();
  if (
    kaOpts2.reconnectMaxAttempts > 0 &&
    slot.reconnectAttempts >= kaOpts2.reconnectMaxAttempts
  ) {
    this._errorSlotQueue(slot, new Error('Max reconnect attempts reached'));
    return;
  }

  this._scheduleReconnect(slot);
};

/**
 * Schedules a reconnect with exponential backoff for a slot
 * @param {Object} slot
 */
adapter._scheduleReconnect = function (slot) {
  if (this._poolClosed || slot.state === 'closed') {
    return;
  }
  if (slot.reconnectTimer) {
    return;
  }

  var kaOpts = this._getKeepAliveOptions();
  var base = kaOpts.reconnectBaseDelay;
  var max = kaOpts.reconnectMaxDelay;

  slot.reconnectDelay = Math.min(
    base * Math.pow(2, slot.reconnectAttempts),
    max
  );
  slot.reconnectAttempts++;

  var self = this;
  slot.reconnectTimer = setTimeout(function () {
    slot.reconnectTimer = null;
    if (slot.state === 'disconnected' && slot.queue.length > 0) {
      self._connect(slot);
    }
  }, slot.reconnectDelay);
};

/**
 * Drains the queue: writes queued messages to the connected socket for a slot
 * @param {Object} slot
 */
adapter._drain = function (slot) {
  if (slot.state !== 'connected' || slot.draining) {
    return;
  }
  if (slot.queue.length === 0) {
    return;
  }

  slot.draining = true;
  var self = this;
  var kaOpts = this._getKeepAliveOptions();
  var maxCount = kaOpts.batchSize;

  var processNext = function () {
    if (slot.state !== 'connected' || slot.queue.length === 0) {
      slot.draining = false;
      slot.currentBatch = null;
      return;
    }

    // collect a batch
    var batch = [];
    while (batch.length < maxCount && slot.queue.length > 0) {
      var entry = slot.queue.shift();
      entry.inflight = true;
      batch.push(entry);
    }

    slot.currentBatch = batch;

    // cork to batch writes into fewer TCP segments
    if (slot.socket.cork) {
      slot.socket.cork();
    }

    // write each packet individually (no Buffer.concat overhead)
    var lastIdx = batch.length - 1;
    for (var i = 0; i < batch.length; i++) {
      if (i < lastIdx) {
        slot.socket.write(batch[i].packet);
      } else {
        // only the last write gets the callback
        slot.socket.write(batch[i].packet, function (writeErr) {
          // guard: if disconnect already handled this batch, bail
          var stillInflight = false;
          for (var j = 0; j < batch.length; j++) {
            if (batch[j].inflight) {
              stillInflight = true;
              break;
            }
          }
          if (!stillInflight) {
            return;
          }

          slot.currentBatch = null;

          if (writeErr) {
            for (var k = batch.length - 1; k >= 0; k--) {
              batch[k].inflight = false;
              slot.queue.unshift(batch[k]);
            }
            self._handleDisconnect(slot, writeErr);
          } else {
            for (var m = 0; m < batch.length; m++) {
              batch[m].inflight = false;
              batch[m].callback(null, batch[m].packet.length);
            }
            process.nextTick(processNext);
          }
        });
      }
    }

    if (slot.socket.uncork) {
      slot.socket.uncork();
    }
  };

  processNext();
};

/**
 * Calls all queued callbacks in a single slot with an error
 * @param {Object} slot
 * @param {Error} err
 */
adapter._errorSlotQueue = function (slot, err) {
  var queue = slot.queue;
  slot.queue = [];
  queue.forEach(function (entry) {
    entry.callback(err);
  });
};

/**
 * Calls all queued callbacks across all pool slots with an error
 * @param {Error} err
 */
adapter._errorAllQueued = function (err) {
  for (var i = 0; i < this._pool.length; i++) {
    this._errorSlotQueue(this._pool[i], err);
  }
};

/**
 * Enqueues a message for sending on a specific slot
 * @param {Object} slot
 * @param {Buffer} packet
 * @param {Function} callback
 */
adapter._enqueue = function (slot, packet, callback) {
  var kaOpts = this._getKeepAliveOptions();
  var cb = _.once(callback);

  if (slot.queue.length >= kaOpts.maxQueueSize) {
    if (kaOpts.queueFullBehavior === 'drop-oldest') {
      var dropped = slot.queue.shift();
      dropped.callback(new Error('Queue overflow: message dropped'));
    } else {
      cb(
        new Error(
          kaOpts.queueFullBehavior === 'error'
            ? 'Queue full'
            : 'Queue overflow: message dropped'
        )
      );
      return;
    }
  }

  slot.queue.push({ packet: packet, callback: cb, enqueuedAt: Date.now() });
};

/**
 * Sends a message using persistent connection pool
 * @param {String} message
 * @param {Function} callback
 * @returns {adapter}
 */
adapter._sendPersistent = function (message, callback) {
  this._initPersistent();

  if (this._poolClosed) {
    callback(new Error('Adapter is closed'));
    return this;
  }

  var packet = this._buildPacket(message);

  // round-robin slot selection
  var slotIndex = this._nextSlot;
  this._nextSlot = (this._nextSlot + 1) % this._pool.length;
  var slot = this._pool[slotIndex];

  this._enqueue(slot, packet, callback);

  if (slot.state === 'disconnected') {
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = null;
    }
    slot.reconnectAttempts = 0;
    this._connect(slot);
  } else if (slot.state === 'connected') {
    this._drain(slot);
  }

  return this;
};

/**
 * Closes all persistent connections and cleans up
 * @param {Function} [callback]
 */
adapter.close = function (callback) {
  callback = callback || _.noop;

  if (!this._persistentInitialized || this._poolClosed) {
    callback();
    return this;
  }

  this._poolClosed = true;

  for (var i = 0; i < this._pool.length; i++) {
    var slot = this._pool[i];
    slot.state = 'closed';

    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = null;
    }

    if (slot.currentBatch) {
      for (var j = 0; j < slot.currentBatch.length; j++) {
        slot.currentBatch[j].inflight = false;
        slot.currentBatch[j].callback(new Error('Adapter closed'));
      }
      slot.currentBatch = null;
    }

    this._errorSlotQueue(slot, new Error('Adapter closed'));

    if (slot.socket) {
      try {
        slot.socket.removeAllListeners();
        slot.socket.end();
        slot.socket.destroy();
      } catch (e) {
        /* ignore */
      }
      slot.socket = null;
    }
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
