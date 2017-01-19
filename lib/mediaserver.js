var esl = require('modesl') ;
var assert = require('assert') ;
var delegate = require('delegates') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var _ = require('lodash') ;
var only = require('only') ;
var async = require('async') ;
var generateUuid = require('uuid') ;
var Endpoint = require('./endpoint') ;
var Conference = require('./conference'); 
//var nullSdp = require('../data/nullsdp') ;
var fs = require('fs') ;
var path = require('path') ;
var net = require('net') ;
var moment = require('moment') ;
var debug = require('debug')('drachtio-fsmrf') ;

function wrapConnectionForTracing(ms, conn, tag) {
  var origSend = conn.send ;
  conn.send = function(command, args) {
    var trace = command + '\n' ;
    if(args) {
      Object.keys(args).forEach(function(key) {
        trace += (key + ': ' + args[key] + '\n');
      }); 
      trace += '\n';
    }
    ms._onRawSend( tag, trace) ;
    return origSend.call( this, command, args) ;
  } ;
}

/**
 * A freeswitch-based media-processing resource that contains Endpoints and Conferences.
 * @constructor
 * @param {esl.Connection} conn   inbound connection to freeswitch event socket   
 * @param {Mrf} mrf               media resource function that instantiated this MediaServer   
 * @param {object} app            drachtio app
 * @param {number} listenPort     tcp port to listen on for outbound event socket connections
 *
 * @fires MediaServer#connect
 * @fires MediaServer#ready
 * @fires MediaServer#error
 */
function MediaServer( conn, mrf, app, listenAddress, listenPort ) {
  Emitter.call(this); 

  this.listenAddress = listenAddress ;
  this.listenPort = listenPort ;
  this._conn = conn ;
  this._mrf = mrf ;
  this._app = app ;
  this._srf = mrf.srf ;
  this.pendingConnections = {} ;

  //these will be udpated every 20 seconds by the HEARTBEAT event messages
  
  /**
   * maximum number of active Endpoints allowed on the MediaServer
   * @type {Number}
   */
  this.maxSessions = 0 ;
  /**
   * current number of active Endpoints on the MediaServer
   * @type {Number}
   */
  this.currentSessions = 0 ;
  /**
   * current calls per second on the MediaServer
   * @type {Number}
   */
  this.cps = 0 ;

  /**
   * sip addresses and ports that the mediaserver is listening on
   * note that different addresses may be used for ipv4, ipv6, dtls, or udp connections
   * @type {Object}
   */
  this.sip = {
    ipv4: {
      udp: {},
      dtls: {}
    },
    ipv6: {
      udp: {},
      dtls: {}
    }
  } ;

  if( mrf.debugDir ) {
    // trace all messages to a log file
    var tag = 'mediaserver-' + conn.socket.address().address + '.txt' ;
    this.logger = fs.createWriteStream(path.join(mrf.debugDir, tag ) ) ;
    conn.on('esl::event::**', this._onRawRecv.bind(this, tag) ) ;
    wrapConnectionForTracing( this, conn, tag ) ;
  }

  this._conn.subscribe(['HEARTBEAT']) ;
  this._conn.on('esl::event::HEARTBEAT::*', this._onHeartbeat.bind(this)) ;
  this._conn.on('error', this._onError.bind(this));

  //create the server (outbound connections) 
  var server =  net.createServer() ;
  server.listen( listenPort, listenAddress, function() {

    this.listenPort = server.address().port ;
    
    this._server = new esl.Server({server: server, myevents:false}, function() {
      this.emit('connect') ;

      // find out the sip address and port the media server is listening on
      this._conn.api('sofia status', function(res){
        var status = res.getBody() ;
        var re = /^\s*drachtio_mrf\s.*sip:mod_sofia@((?:[0-9]{1,3}\.){3}[0-9]{1,3}:\d+)/m ;
        var results = re.exec( status ) ;
        if( null === results ) { throw new Error('No drachtio_mrf sip profile found on the media server: ' + status);}
        if( results ) {
          this.sip.ipv4.udp.address = results[1] ;          
        }

        // see if we have a TLS endpoint (Note: it needs to come after the RTP one in the sofia status output)
        re = /^\s*drachtio_mrf\s.*sip:mod_sofia@((?:[0-9]{1,3}\.){3}[0-9]{1,3}:\d+).*\(TLS\)/m ;
        results = re.exec( status ) ;
        if( results ) {
          this.sip.ipv4.dtls.address = results[1] ;
        }

        // see if we have an ipv6 endpoint 
        re = /^\s*drachtio_mrf.*sip:mod_sofia@(\[[0-9a-f:]+\]:\d+)/m ;
        results = re.exec( status ) ;
        if( results ) {
          this.sip.ipv6.udp.address = results[1] ;
        }
        
        // see if we have an ipv6 TLS endpoint 
        re = /^\s*drachtio_mrf.*sip:mod_sofia@(\[[0-9a-f:]+\]:\d+).*\(TLS\)/m ;
        results = re.exec( status ) ;
        if( results ) {
          this.sip.ipv6.dtls.address = results[1] ;
        }
        debug('media server signaling addresses: %s', JSON.stringify(this.sip));

        this.emit('ready') ;
      }.bind(this)) ;
    }.bind(this));   

    this._server.on('connection::ready', this._onNewCall.bind(this)) ;     
  }.bind(this)) ;


  Object.defineProperty(this, 'address', {
    get: function() { return this._conn.socket.remoteAddress ; }
  }) ;
}
util.inherits(MediaServer, Emitter) ;
module.exports = exports = MediaServer ;

MediaServer.prototype.hasCapability = function( capability ) {
  var family = 'ipv4' ;
  var cap = typeof capability === 'string' ? [capability] : capability ;
  var idx = cap.indexOf('ipv6') ;
  if( -1 !== cap ) {
    cap.splice( idx, 1 ) ;
    family = 'ipv6' ;
  }
  else {
    idx = cap.indexOf('ipv4') ;
    if( -1 !== idx ) {
      cap.splice( idx, 1 ) ;
    }
  }
  assert.ok(-1 !== ['dtls','udp'].indexOf(cap[0]), '\'capability\' must be from the set  \'ipv6\', \'ipv4\',\'dtls\',\'udp\'') ;

  return 'address' in this.sip[family][cap[0]] ;

} ;
/**
 * return Srf instance associated with this MediaServer
 * @return {Srf} Srf instance used to connect to this MediaServer
 */
MediaServer.prototype.getSrf = function() {
  return this._srf ;
} ;

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
 * allocate an Endpoint on the MediaServer, optionally allocating a media session to stream to a 
 * remote far end SDP (session description protocol).  If no far end SDP is provided, the endpoint
 * is initially created in the inactive state.
 * @param  {MediaServer~EndpointOptions}   [opts] - create options
 * @param  {MediaServer~createEndpointCallback} cb   callback that provides error or Endpoint
 */
MediaServer.prototype.createEndpoint = function( opts, cb ) {
  var self = this ;
  if( typeof opts === 'function' ) {
    cb = opts ;
    opts = {} ;
  }
  assert.ok(typeof cb === 'function', 'callback was not provided') ;
  assert.ok(typeof opts === 'object', 'opts param must be an object') ;

  //opts.tls deprecated
  opts.dtls = opts.dtls || opts.tls ;
  var family = opts.family || 'ipv4' ;
  var proto = opts.dtls ? 'dtls' : 'udp';

  if( !this.connected() ) { 
    process.nextTick( function() {
      cb(new Error('too early: mediaserver is not connected')) ;
    }) ;
    return ;
  }
  if( !this.sip[family][proto].address ) {
    debug('createEndpoint too early: sip addresses: %s', JSON.stringify(this.sip));
    process.nextTick( function() {
      cb(new Error('too early: mediaserver is not ready')) ;
    }) ;   
    return ; 
  }

  // generate a unique id to track the endpoint during creation 
  var uuid = generateUuid.v4() ;
  this.pendingConnections[uuid] = {
    callback: cb,
    createTimeout: setTimeout( this._onCreateTimeout.bind(this, uuid) , 120000 ),
    opts: {
      codecs: opts.codecs || [],
      is3pcc: !opts.remoteSdp
    }
  } ;
  debug('MediaServer#createEndpoint: attempting to create endpoint with uuid %s; there are now %d pending connections', uuid,  _.keys(this.pendingConnections).length) ;

  // launch an INVITE towards the media server 
  var uri = 'sip:drachtio@' ;
  if( opts.dtls && this.hasCapability([family, 'dtls']) ) {
    uri += this.sip[family].dtls.address  ;
  }
  else {
    uri += this.sip[family].udp.address ;
  }
  this._srf.createUacDialog( uri, {
    headers: {
      'User-Agent': 'drachtio-fsmrf:' + uuid,
      'X-esl-outbound': this.listenAddress + ':' + this.listenPort
    },
    localSdp: opts.remoteSdp
  }, function(err, dialog) {
    if( err ) { 
      delete self.pendingConnections[uuid] ;
      return cb( new Error( '' + err.status + ' ' + err.reason) ); 
    }

    //success!
    var obj = self.pendingConnections[uuid] ;
    if( obj.opts.is3pcc ) {
      // _onNewCall may not have been called yet, as it comes after we send the ACK
      obj.dialog = dialog ;
      debug('MediaServer#createEndpoint: created 3pcc dialog');
    }
    else {
      // _onNewCall will have been called at this point, as it comes in response to the INVITE
      obj.ep.dialog = dialog ;
      clearTimeout( obj.createTimeout ) ;
      delete self.pendingConnections[uuid] ;
      debug('MediaServer#createEndpoint - successfully created endpoint with uuid %s; there are now %d pending connections', uuid, 
        _.keys(this.pendingConnections).length) ;      
    }
  }) ;
} ;
/**
 * This callback provides the response to an attempt to create an Endpoint on the MediaServer.
 * @callback MediaServer~createEndpointCallback
 * @param {Error} error encountered while attempting to create the endpoint
 * @param {Endpoint} endpoint that was created
 */

/**
 * connects an incoming call to the media server, producing both an Endpoint and a SIP Dialog upon success
 * @param  {Object}   req  - drachtio request object for incoming call
 * @param  {Object}   res  - drachtio response object for incoming call
 * @param  {MediaServer~EndpointOptions}   [opts] - options for creating endpoint and responding to caller
  * @param  {MediaServer~connectCallerCallback} cb   callback invoked on completion of operation
*/
MediaServer.prototype.connectCaller = function(req, res, opts, cb) {
  var self = this ;
  if( typeof opts === 'function' ) {
    cb = opts ;
    opts = {} ;
  }

  async.waterfall([
      function createEndpoint(callback) {
        self.createEndpoint({
          remoteSdp: req.body,
          codecs: opts.codecs 
        }, callback) ;
      },
      function respondToCaller(ep, callback) {
        self._srf.createUasDialog(req, res, {
          localSdp: ep.local.sdp,
          headers: opts.headers
        }, function(err, dialog) {
          if( err ) { return callback(err);}
          callback(null, ep, dialog) ;
        }) ;
      }
    ], function(err, ep, dialog) {
      cb(err, ep, dialog) ;
  }) ;
} ;
/**
 * This callback provides the response to an attempt connect a caller to the MediaServer.
 * @callback MediaServer~connectCallerCallback
 * @param {Error} err - error encountered while attempting to create the endpoint
 * @param {Endpoint} ep - endpoint that was created
 * @param {Dialog} dialog - sip dialog that was created
 */

/**
 * creates a conference on the media server.
 * @param  {String}   name - conference name
 * @param {Conference~createOptions}  [opts] - conference-level configuration options
 * @param {Conference~createCallback} cb - callback invoked when conference is created
 */
MediaServer.prototype.createConference = function( name, opts, cb ) {
  var self = this ;
  if( typeof opts === 'function' ) {
    cb = opts ;
    opts = {} ;
  }
  assert.equal( typeof name, 'string', '\'name\' is a required parameter') ;
  assert.ok(typeof cb === 'function', 'callback was not provided') ;
  assert.ok(typeof opts === 'object', 'opts param must be an object') ;

  /* Steps for creating a conference:
     (1) Check to see if a conference of that name already exists - return error if so
     (2) Create the conference  control leg (endpoint)
     (3) Create the conference
  */
 
  async.waterfall([
    function doesConfExist(callback) {
      self.api('conference ' + name + ' list count', function(result) {
        debug('return from conference list: ', result) ;
        if( typeof result === 'string' && (result.match(/^No active conferences/) || result.match(/^Conference.*not found/) ) ) {
          return callback(null) ;
        }
        callback(null) ;
        //callback('conference exists') ;
      }); 
    },
    function createControlLeg(callback) {
      self.createEndpoint({}, function(err, endpoint) {
        if( err ) { return callback(err); }
        callback(null, endpoint) ;
      }); 
    },
    function createConference(endpoint, callback) {
      new Conference(endpoint, name, opts, function(err, conference) {
        if(err) { return callback(err); }
        callback( null, endpoint, conference); 
      }) ;
    } 
    ], function(err, endpoint, conference) {
      if( err ) { return cb(err); }
      debug('MediaServer#createConference: created endpoint for control leg: ', JSON.stringify(endpoint)) ;
      debug('MediaServer#createConference: created conference: ', JSON.stringify(conference)) ;

      cb(null, conference) ;
    }
  ) ;
} ;

MediaServer.prototype.toJSON = function() {
  return( only( this, 'sip maxSessions currentSessions cps cpuIdle fsVersion hostname v4address pendingConnections')) ;
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

//new outbound event socket connection
MediaServer.prototype._onNewCall = function(conn /*, id */) {

  if( this.logger ) {
    var tag = conn.getInfo().getHeader('Channel-Unique-ID') ;
    conn.on('esl::event::**', this._onRawRecv.bind(this, tag) ) ;
    wrapConnectionForTracing( this, conn, tag ) ;
  }

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

  debug('MediaServer#_onNewCall: received new call with uuid: %s', uuid) ;
  var obj = this.pendingConnections[uuid] ;
  obj.ep = new Endpoint( conn, this, this._app, obj.opts, obj.callback) ; 

  if( obj.opts.is3pcc ) {
    // because this comes after the ACK when INVITE is sent with no SDP
    debug('MediaServer#_onNewCall: received incoming call for 3pcc INVITE') ;
    obj.ep.dialog = obj.dialog ;
    clearTimeout( obj.createTimeout ) ;
    delete this.pendingConnections[uuid] ;
    debug('MediaServer#createEndpoint - successfully created endpoint with uuid %s; there are now %d pending connections', uuid, 
        _.keys(this.pendingConnections).length) ;      
  }
  else {
    debug('MediaServer#_onNewCall: received incoming call for new INVITE') ;    
  }
} ;

MediaServer.prototype._onRawRecv = function(tag, event /*, headers, body*/) {
  var obj = _.find( event.headers, function (hdr) { return hdr.name === 'Event-Name'; }) ;
  if( obj && -1 !== ['RE_SCHEDULE','HEARTBEAT'].indexOf( obj.value ) ) {
    this.logger.write('\n....skipping ' + obj.value + '....') ;
    return ;
  }

  this.logger.write('\n' + moment().format('YYYY-MM-DD:HH:mm:ss') + ': RECEIVING ' + tag + '\n') ;
  this.logger.write( event.serialize() ) ;
  this.logger.write('\n') ;
} ;
MediaServer.prototype._onRawSend = function(tag, data) {
  this.logger.write('\n' + moment().format('YYYY-MM-DD:HH:mm:ss') + ': SENDING ' + tag + '\n') ;
  this.logger.write( data ) ;
  this.logger.write('\n') ;
} ;


/** returns true if the MediaServer is in the 'connected' state
*   @name MediaServer#connected
*   @method
*/

delegate(MediaServer.prototype, '_conn')
  .method('connected') ;


/**
 * Arguments provided when creating an Endpoint on a MediaServer
 * @typedef {Object} MediaServer~EndpointOptions
 * @property {String} [remoteSdp] remote session description protocol (if not provided, an initially inactive Endpoint will be created)
 * @property {String[]} [codecs] - array of codecs, in preferred order (e.g. ['PCMU','G722','PCMA'])
 */

/**
 * connect event triggered when connection is made to the freeswitch media server.
 * @event MediaServer#connect
 */
/**
 * ready event triggered after connecting to the server and verifying it is properly configured and ready to accept calls.
 * @event MediaServer#ready
 */
/**
 * Error event triggered when connection to freeswitch media server fails.
 *
 * @event MediaServer#error
 * @type {object}
 * @property {String} message - Indicates the reason the connection failed
 */

