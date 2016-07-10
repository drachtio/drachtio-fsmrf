var esl = require('modesl') ;
var assert = require('assert') ;
var MediaServer = require('./mediaserver') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var Srf = require('drachtio-srf');
var noop = require('node-noop').noop;
var debug = require('debug')('drachtio-fsmrf') ;
var os = require('os');

/**
 * Creates a media resource framework instance.
 * @constructor
 * @param {Object} app - drachtio app
 * @param {Mrf~createOptions} [opts] configuration options
 */
function Mrf( app, opts ) {
  if (!(this instanceof Mrf)) { return new Mrf(app); }

  opts = opts || {} ;
  assert.equal( typeof app, 'function', 'argument \'app\' was not provided or was not a drachtio app') ;
  assert.ok( typeof opts.debugDir === 'undefined' || typeof opts.debugDir === 'string', '\'opts.debugDir\' must be a string') ;

  var host = app.get('host') ;
  var port = app.get('port') ;
  var secret = app.get('secret') ;
  debug('host: %s, port: %s, secret: %s', host, port, secret) ;

  //TODO: caller should optionally be able to pass in connect args and we create our own app

  Emitter.call(this); 

  opts = opts || {} ;
  this._app = app ;
  this.debugDir = opts.debugDir ;
  this.debugSendonly = opts.sendonly ;
  this.mediaServers = [] ;
  this.localAddresses = [];

  var interfaces = os.networkInterfaces();
  for (var k in interfaces) {
      for (var k2 in interfaces[k]) {
          var address = interfaces[k][k2];
          if (address.family === 'IPv4' && !address.internal) {
              this.localAddresses.push(address.address);
          }
      }
  }

  this._srf = new Srf(app) ;

  Object.defineProperty( this, 'srf', {
    get: function() {
      return this._srf ;
    }
  }) ;
}
/**
 * Options governing the creation of an mrf instance
 * @typedef {Object} Mrf~createOptions
 * @property {string} [debugDir] directory into which message trace files; the presence of this param will enable debug tracing
 * @returns {Object} the mrg instance, suitable for chaining
 */

util.inherits(Mrf, Emitter) ;


module.exports = exports = Mrf ;


/**
 * connect to the event socket of a freeswitch media server
 * 
 * @param  {Mrf~ConnectOptions}   opts - connection options
 * @param  {Mrf~ConnectCallback} cb - callback invoked after connection is made
 * @fires Mrf#error
 */
Mrf.prototype.connect = function( opts, cb ) {
  assert.equal( typeof opts, 'object', 'argument \'opts\' must be provided with connection options') ;
  assert.equal( typeof opts.address,'string', 'argument \'opts.address\' was not provided') ;

  var self = this ;
  var address = opts.address ;
  var port = opts.port || 8021 ;
  var secret = opts.secret || 'ClueCon' ;
  var listenPort = opts.listenPort || 8085 ;
  var listenAddress = opts.listenAddress || this.localAddresses[0] || '127.0.0.1' ;
  cb = cb || noop ;

  //handle connection errors in the MRF...
  var listener = this._onError.bind(this)  ;

  var conn = new esl.Connection(address, port, secret, function() {

    //...until we have initially connected and created a MediaServer object (which takes over error reporting)
    conn.removeListener('error', listener) ;

    var ms = new MediaServer( conn, self, self._app, listenAddress, listenPort ) ;
    self.mediaServers.push( ms ) ;

    ms.once('ready', function() {
      cb( ms ) ;
      self.emit('connect', ms) ;
    }) ;
  });

  conn.on('error', listener);
  return this ;

} ;
/**
 * This callback provides the response to a connection attempt to a freeswitch server
 * @callback Mrf~ConnectCallback
 * @param {MediaServer} ms - MediaServer instance
 */

Mrf.prototype._onError = function(err) {
    this.emit('error', err);
};

/**
 * Arguments provided when connecting to a freeswitch media server
 * @typedef {Object} Mrf~ConnectOptions
 * @property {String} address - hostname or IP address to connect to
 * @property {Number} [port=8021] - TCP port to connect to
 * @property {String} [secret=ClueCon] - freeswitch authentication secret
 * @property {String} [listenAddress=auto-discovered public IP address or 127.0.0.1] - local TCP address to listen for external connections from the freeswitch media server
 * @property {Number} [listenPort=8085] -  local TCP port to listen for external connections from the freeswitch media server
 */

 /**
 * Error event triggered when connection to freeswitch media server fails.
 *
 * @event Mrf#error
 * @type {object}
 * @property {String} message - Indicates the reason the connection failed
 */
