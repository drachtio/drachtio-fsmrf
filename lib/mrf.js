var esl = require('modesl') ;
var assert = require('assert') ;
var MediaServer = require('./mediaserver') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var Srf = require('drachtio-srf');
var noop = require('node-noop').noop;
var debug = require('debug')('drachtio-fsmrf') ;

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
  assert.ok( typeof opts.debugDir === 'undefined' || typeof opts.debugDir === 'string', '\'opts.debugDir\' must be a function') ;

  var host = app.get('host') ;
  var port = app.get('port') ;
  var secret = app.get('secret') ;
  debug('host: %s, port: %s, secret: %s', host, port, secret) ;

  //TODO: caller should optionally be able to pass in connect args and we create our own app

  Emitter.call(this); 

  opts = opts || {} ;
  this._app = app ;
  this.debugDir = opts.debugDir ;
  this.mediaServers = [] ;


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
 * 
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
  cb = cb || noop ;

  //handle connection errors in the MRF...
  var listener = this._onError.bind(this)  ;

  debug('connecting');
  var conn = new esl.Connection(address, port, secret, function() {

    //...until we have initially connected and created a MediaServer object (which takes over error reporting)
    conn.removeListener('error', listener) ;

    var ms = new MediaServer( conn, self, self._app, listenPort ) ;
    self.mediaServers.push( ms ) ;

    ms.once('connect', function() {
      cb( ms ) ;
      self.emit('connect', ms) ;
    }) ;
  });

  conn.on('error', listener);

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
 * @property {Number} [listenPort=8085] -  local TCP port to listen for external connections from the freeswitch media server
 */

 /**
 * Error event triggered when connection to freeswitch media server fails.
 *
 * @event Mrf#error
 * @type {object}
 * @property {String} message - Indicates the reason the connection failed
 */
