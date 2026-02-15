`gelf-pro-plus`
=============
[Graylog2](https://github.com/Graylog2/graylog2-server) client library for Node.js. Sends logs to Graylog2 server in GELF (Graylog Extended Log Format) format.

> **Fork notice:** This is a fork of [`gelf-pro`](https://github.com/kkamkou/node-gelf-pro) by [Kanstantsin Kamkou](https://github.com/kkamkou).
> It adds persistent TCP connection reuse (`keepAlive`) for high-throughput scenarios, with automatic reconnection, message queuing, and backoff.
> All credit for the original library goes to the original author and contributors.

**Features:**
- JS object marshalling
- UDP/TCP/TLS support
- Persistent TCP connection reuse with automatic reconnection
- Filtering, Transforming, Broadcasting.

## Installation
```
npm install gelf-pro-plus
```

Library only depends on: `lodash#~4.17`

## Initialization
```javascript
var log = require('gelf-pro-plus');
```

### Adapters

- UDP (with deflation and chunking)
  - Input: `GELF UDP`
- TCP
  - Input: `GELF TCP` (with `Null frame delimiter`)
- TCP via TLS(SSL)
  - Input: `GELF TCP` (with `Null frame delimiter` and `Enable TLS`)

> [!NOTE]
> By default, the TCP and TCP-TLS adapters create a new connection for each message.
> For high-throughput use cases, you can enable persistent connection reuse with the `keepAlive` option.
> See [TCP Connection Reuse](#tcp-connection-reuse) below.


> [!NOTE]
> Within a more or less stable network (which is most likely), I would recommend using the `udp` adapter.
> I would also recommend it for an average to high-loaded project.
> For sensitive information, the `tcp-tls` adapter is recommended.

### Configuration
```javascript
// simple
log.setConfig({adapterOptions: {host: 'my.glog-server.net'}});

// advanced
log.setConfig({
  fields: {facility: "example", owner: "Tom (a cat)"}, // optional; default fields for all messages
  filter: [], // optional; filters to discard a message
  transform: [], // optional; transformers for a message
  broadcast: [], // optional; listeners of a message
  levels: {}, // optional; default: see the levels section below
  aliases: {}, // optional; default: see the aliases section below
  adapterName: 'udp', // optional; currently supported "udp", "tcp" and "tcp-tls"; default: udp
  adapterOptions: { // this object is passed to the adapter.connect() method
    // common
    host: '127.0.0.1', // optional; default: 127.0.0.1
    port: 12201, // optional; default: 12201
    // ... and so on
    
    // tcp adapter example
    family: 4, // tcp only; optional; version of IP stack; default: 4
    timeout: 1000, // tcp only; optional; default: 10000 (10 sec)
    keepAlive: false, // tcp/tcp-tls only; optional; enable persistent connection reuse; default: false
    
    // udp adapter example
    protocol: 'udp4', // udp only; optional; udp adapter: udp4, udp6; default: udp4
    
    // tcp-tls adapter example
    key: fs.readFileSync('client-key.pem'), // tcp-tls only; optional; only if using the client certificate authentication
    cert: fs.readFileSync('client-cert.pem'), // tcp-tls only; optional; only if using the client certificate authentication
    ca: [fs.readFileSync('server-cert.pem')] // tcp-tls only; optional; only for the self-signed certificate
  }
});
```
> `log.setConfig` merges the data. Therefore, you can call it multiple times.

### Basic functionality
```javascript
var extra = {tom: 'cat', jerry: 'mouse', others: {spike: 1, tyke: 1}};

log.info("Hello world", extra, function (err, bytesSent) {});
log.info("Hello world", function (err, bytesSent) {});
log.info("Hello world", extra);
log.info("Hello world");

log.error('Oooops.', new Error('An error message'));
// ^-- extra becomes: {short_message: 'Oooops.', _error_message: 'An error message', _error_stack: Error's stack}

log.error(new Error('An error message'));
// ^-- extra becomes: {short_message: 'An error message', full_message: Error's stack}

log.message(new Error('An error message'), 3); // same as previous
```

##### Extra
In case `extra` [is a plain object](https://lodash.com/docs#isPlainObject),
the library converts it to a readable format. Other values [are converted to string](https://lodash.com/docs#toString).
The acceptable format of a key is: `^[\w-]$`
```javascript
log.info(
  'a new msg goes here',
  {me: {fname: 'k', lname: 'k', bdate: new Date(2000, 01, 01)}}
);
// ^-- extra becomes: {_me_fname: 'k', _me_lname: 'k', _me_bdate: 'Tue Feb 01 2000 00:00:00 GMT+0100 (CET)'}
```

##### Filtering
Sometimes we have to discard a message which is not suitable for the current environment. It is `NOT` possible to modify the data.
```javascript
log.setConfig({
  filter: [
    function (message) { // rejects a "debug" message
      return (message.level < 7);
    }
  ]
});
```

##### Transforming
`transforming` happens after `filtering`. It is possible to modify the data.

```javascript
log.setConfig({
  transform: [
    function (message) { // unwind an error
      if (_.isError(message.error)) {
        message.error = {message: message.error.message, stack: message.error.stack};
      }
      return message;
    }
  ]
});
```

##### Broadcasting
`broadcasting` happens after `transforming`. It is `NOT` possible to modify the data.

```javascript
log.setConfig({
  broadcast: [
    function (message) { // broadcasting to console
      console[message.level > 3 ? 'log' : 'error'](message.short_message, message);
    }
  ]
});
```

### Levels ([1](https://httpd.apache.org/docs/current/mod/core.html#loglevel), [2](https://logging.apache.org/log4j/2.0/log4j-api/apidocs/org/apache/logging/log4j/Level.html), [3](http://stackoverflow.com/questions/2031163/when-to-use-the-different-log-levels))

Default:  
`{emergency: 0, alert: 1, critical: 2, error: 3, warning: 4, notice: 5, info: 6, debug: 7}`  
Example: `log.emergency(...)`, `log.critical(...)`, etc.  
Custom example: `{alert: 0, notice: 1, ...}`

### TCP Connection Reuse

By default, the `tcp` and `tcp-tls` adapters create a new connection for every message. For high-throughput scenarios (e.g. hundreds of messages per second), you can enable persistent connection reuse with the `keepAlive` option.

When enabled, the adapter maintains a single TCP connection, queues messages during outages, and automatically reconnects with exponential backoff.

```javascript
log.setConfig({
  adapterName: 'tcp', // also works with 'tcp-tls'
  adapterOptions: {
    host: '127.0.0.1',
    port: 12201,
    keepAlive: true,
    keepAliveOptions: {
      maxQueueSize: 5000,         // max messages buffered while disconnected; default: 5000
      reconnectBaseDelay: 100,    // initial reconnect delay in ms; default: 100
      reconnectMaxDelay: 5000,    // max reconnect delay in ms (backoff cap); default: 5000
      reconnectMaxAttempts: 0,    // 0 = unlimited retries; default: 0
      writeTimeout: 5000,         // per-message write timeout in ms; default: 5000
      queueFullBehavior: 'drop-oldest' // 'drop-oldest', 'drop-newest', or 'error'; default: 'drop-oldest'
    }
  }
});
```

When you are done, close the connection to clean up:
```javascript
log.close(function () {
  console.log('GELF connection closed');
});
```

**How it works:**
- Messages are queued and sent over a single persistent connection using `socket.write()`
- If the connection drops, messages are buffered and the adapter reconnects automatically
- Reconnection uses exponential backoff: `100ms -> 200ms -> 400ms -> ... -> 5s (cap)`
- In-flight messages that fail mid-write are re-queued and retried
- When the queue is full, the oldest messages are dropped by default (configurable)
- Message timestamps are set when `log.info()` is called, not when delivered, so queued messages retain their original timestamps

### Third party adapters
You can force using custom adapter by setting the `adapter` right after initialisation.  The [signature](lib/adapter/abstract.js) might be found here. 
```javascript
  var log = require('gelf-pro');
  var myFancyAdapter = require('...');
  log.adapter = myFancyAdapter;
  // (!) adapterName and adapterOptions will be ignored
```

### Aliases

Default: `{log: 'debug', warn: 'warning'}`  
Example: `log.log(...) -> log.debug(...)`, `log.warn(...) -> log.warning(...)`, etc.  
Custom example: `{red: 'alert', yellow: 'notice', ...}`

### Tests
#### Cli
```bash
npm install
npm test
```

#### Docker
```bash
[sudo] docker build --no-cache -t node-gelf-pro .
[sudo] docker run -ti --rm -v "${PWD}:/opt/app" -w "/opt/app" node-gelf-pro
```

#### Contributors

- [Kanstantsin Kamkou](https://github.com/kkamkou)
- [corbinu](https://github.com/corbinu)
- [joelharkes](https://github.com/joelharkes)
- [mkalam-alami](https://github.com/mkalam-alami)

#### License

[MIT](LICENSE)
