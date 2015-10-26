var esl = require('modesl') ;
var noop = require('node-noop').noop;
var assert = require('assert') ;
var MediaServer = require('./mediaserver') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var debug = require('debug')('drachtio-fsmrf') ;

module.exports = exports = Mrf ;

/**
 * Creates a media resource function library.
 * 
 * @param {drachtio app} app 
 */
function Mrf( app ) {
  assert.equal( typeof app, 'function', 'argument \'app\' was not provided or was not a drachtio app') ;

  if (!(this instanceof Mrf)) return new Mrf(app);

  Emitter.call(this); 

  this._app = app ;
  this.mediaServers = [] ;

}
util.inherits(Mrf, Emitter) ;

Mrf.prototype.connect = function( opts, cb ) {
  assert.equal( typeof opts, 'object', 'argument \'opts\' must be provided with connection options') ;
  assert.equal( typeof opts.address,'string', 'argument \'opts.address\' was not provided') ;
  assert.equal( typeof cb, 'function', 'a callback function is required'); 

  var self = this ;
  var address = opts.address ;
  var port = opts.port || 8021 ;
  var secret = opts.secret || 'ClueCon' ;
  var listenPort = opts.listenPort || 8085 ;

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
    }) ;
  });

  conn.on('error', listener);

} ;

Mrf.prototype._onError = function(err) {
    this.emit('error', err);
};
