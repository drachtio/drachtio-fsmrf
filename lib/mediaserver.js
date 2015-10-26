var esl = require('modesl') ;
var assert = require('assert') ;
var noop = require('node-noop').noop;
var delegate = require('delegates') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var _ = require('lodash') ;
var only = require('only') ;
var generateUuid = require('node-uuid') ;
var Endpoint = require('./endpoint') ;
var nullSdp = require('../data/nullsdp') ;
var debug = require('debug')('drachtio-fsmrf') ;

module.exports = exports = MediaServer ;

/**
 * A freeswitch-based media-processing resource that contains Endpoints and Conferences.
 * @constructor
 * @param {esl.Connection} conn   inbound connection to freeswitch event socket   
 * @param {Mrf} mrf               media resource function that instantiated this MediaServer   
 * @param {object} app            drachtio app
 * @param {number} listenPort     tcp port to listen on for outbound event socket connections
 */
function MediaServer( conn, mrf, app, listenPort ) {
  Emitter.call(this); 

  var self = this ;
  this._conn = conn ;
  this._mrf = mrf ;
  this._app = app ;
  this.pendingConnections = {} ;

  //these will be udpated every 20 seconds by the HEARTBEAT event messages
  this.maxSessions = 0 ;
  this.currentSessions = 0 ;
  this.cps = 0 ;

  this._conn.subscribe(['HEARTBEAT']) ;
  this._conn.on('esl::event::HEARTBEAT::*', this._onHeartbeat.bind(this)) ;
  this._conn.on('error', this._onError.bind(this));

  //create the server (outbound connections) 
  this._server = new esl.Server({port: listenPort, myevents:true}, function() {
    self.emit('connect') ;

    // find out the sip address and port the media server is listening on
    self._conn.api('sofia status', function(res){
      var status = res.getBody() ;
      var re = /^\s*drachtio_mrf\s.*sip:mod_sofia@((?:[0-9]{1,3}\.){3}[0-9]{1,3}):(\d+)/m ;
      var results = re.exec( status ) ;
      if( null === results ) { throw new Error('No drachtio_mrf sip profile found on the media server: ' + status);}
      self.sipAddress = results[1] ;
      self.sipPort = parseInt( results[2] ) ;
      self.emit('ready') ;
    }) ;

  });   
  this._server.on('connection::ready', self._onNewCall.bind(self)) ;     

}
util.inherits(MediaServer, Emitter) ;

/**
 * Close the inbound event socket connection
 */
MediaServer.prototype.disconnect = function() {
  this._conn.disconnect() ;
} ;

/**
 * send an api command to the freeswitch server
 * @param  {string}   command command to execute
 * @param  {MediaServer~apiCallback} cb      callback that handles the response
 */
MediaServer.prototype.api = function(command, cb) {
  assert(typeof command, 'string', '\'command\' must be a valid freeswitch api command') ;
  assert(typeof cb, 'function', 'callback must be provided') ;

  this._conn.api(command, function(res) {
    cb(res.getBody()) ;
  }) ;
} ;
/**
 * This callback provides the response to an api request.
 * @callback MediaServer~apiCallback
 * @param {string} body of the response message
 */

/**
 * allocate an Endpoint on the MediaServer
 * @param  {object}   opts create options
 * @param  {MediaServer~createEndpointCallback} cb   callback that provides error or Endpoint
 */
MediaServer.prototype.createEndpoint = function( opts, cb ) {
  if( typeof opts === 'function' ) {
    cb = opts ;
    opts = {} ;
  }
  assert.ok(typeof cb === 'function', 'callback was not provided') ;
  assert.ok(typeof opts === 'object', 'opts param must be an object') ;

  if( !this.connected() ) { 
    process.nextTick( function() {
      cb(new Error('too early: mediaserver is not connected')) ;
    }) ;
    return ;
  }
  if( !this.sipAddress ) {
    process.nextTick( function() {
      cb(new Error('too early: mediaserver is not ready')) ;
    }) ;   
    return ; 
  }

  var sdp = opts.remoteSdp || nullSdp('127.0.0.1', 16000) ;

  // generate a unique id to track the endpoint during creation 
  var uuid = generateUuid.v4() ;
  this.pendingConnections[uuid] = {
    callback: cb,
    createTimeout: setTimeout( this._onCreateTimeout.bind(this, uuid) , 120000 ),
    opts: {
      codecs: opts.codecs || []
    }
  } ;

  // launch an INVITE towards the media server 
  this._app.request({
      uri: 'sip:drachtio@' + this.sipAddress + ':' + this.sipPort,
      method: 'INVITE',
      headers: {
        'User-Agent': 'drachtio-fsmrf:' + uuid
      },
      body: sdp
    },
    function( err, req ){
      if( err ) { return cb(err) ; }

      debug('sent request: ', req.raw ) ;
      req.on('response', function(res, ack){
        if( res.status >= 200 ) {
          ack() ;
        }
      }) ;
    }
  );
} ;
/**
 * This callback provides the response to an api request.
 * @callback MediaServer~apiCallback
 * @param {Error} error encountered while attempting to create the endpoint
 * @param {Endpoint} endpoint that was created
 */

MediaServer.prototype.toJSON = function() {
  return( only( this, 'sipAddress sipPort maxSessions currentSessions cps cpuIdle fsVersion hostname v4address pendingConnections')) ;
} ;

MediaServer.prototype._onError = function(err) {
  this.emit('error', err);
};
MediaServer.prototype._onHeartbeat = function(evt) {
  this.maxSessions = parseInt( evt.getHeader('Max-Sessions')) ;
  this.currentSessions = parseInt( evt.getHeader('Session-Count')) ;
  this.cps = parseInt( evt.getHeader('Session-Per-Sec')) ;
  this.hostname = evt.getHeader('FreeSWITCH-Hostname') ;
  this.v4address = evt.getHeader('FreeSWITCH-IPv4') ;
  this.v6address = evt.getHeader('FreeSWITCH-IPv6') ;
  this.fsVersion = evt.getHeader('FreeSWITCH-Version') ;
  this.cpuIdle = parseFloat( evt.getHeader('Idle-CPU')) ;
} ;
MediaServer.prototype._onCreateTimeout = function( uuid ) {
  if( !(uuid in this.pendingConnections ) ) {
    console.error('MediaServer#_onCreateTimeout: uuid not found: %s', uuid) ;
    return ;
  }
  var obj = this.pendingConnections[uuid] ;
  obj.callback('Connection timeout') ;
  clearTimeout( obj.createTimeout ) ;

  delete this.pendingConnections[uuid] ;

  console.log('createEndpoint %s timed out; after removing there are %d Endpoints in pending create state', 
    uuid, _.keys(this.pendingConnections).length) ;
} ;
MediaServer.prototype._onNewCall = function(conn, id) {
  var self = this ;
  var userAgent = conn.getInfo().getHeader('variable_sip_user_agent') ;

  var re = /^drachtio-fsmrf:(.+)$/ ;
  var results = re.exec(userAgent) ;
  if( null === results ) {
    console.error('received INVITE without drachtio-fsmrf header, unexpected User-Agent: %s', userAgent) ;
    return conn.execute('hangup', 'NO_ROUTE_DESTINATION') ;
  }
  var uuid = results[1] ;
  if( !uuid || !(uuid in this.pendingConnections ) ) {
    console.error('received INVITE with unknown uuid: %s', uuid) ;
    return conn.execute('hangup', 'NO_ROUTE_DESTINATION') ;    
  }

  var obj = this.pendingConnections[uuid] ;
  clearTimeout( obj.createTimeout ) ;
  delete this.pendingConnections[uuid] ;

  var ep = new Endpoint( conn, self, self._app, obj.opts, obj.callback) ;
} ;

delegate(MediaServer.prototype, '_conn')
  .method('connected') ;
