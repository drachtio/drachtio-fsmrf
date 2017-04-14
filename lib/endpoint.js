var assert = require('assert') ;
var noop = require('node-noop').noop;
var delegate = require('delegates') ;
var Emitter = require('events').EventEmitter ;
var Conference = require('./conference') ;
var ConferenceConnection = require('./conference-connection') ;
var util = require('util') ;
var only = require('only') ;
var _ = require('lodash') ;
var async = require('async') ;
var debug = require('debug')('drachtio-fsmrf') ;

var State = {
  NOT_CONNECTED: 1,
  EARLY: 2,
  CONNECTED: 3,
  DISCONNECTED: 4
};

/**
 * A media resource on a freeswitch-based MediaServer that is capable of play, record, signal detection, and signal generation
 * @constructor
 * @param {esl.Connection} conn - outbound connection from a media server for one session
 * @param {MediaServer}   ms - MediaServer that contains this Endpoint
 * @param {object}   app - drachtio app
 * @param {Endpoint~createOptions} [opts] configuration options
 * @param {Endpoint~createCallback} cb   callback that is invoked when the endpoint is connected and ready for use
 */
function Endpoint( conn, ms, app, opts, cb ) {
  Emitter.call(this); 
  var self = this ;

  if( typeof opts === 'function') {
    cb = opts ;
    opts = {} ;
  }

  this._conn = conn ;
  this._ms = ms ;
  this._app = app ;
  this._dialog = null ;
  this._executeCallbacks = {} ;

  this.uuid = conn.getInfo().getHeader('Channel-Unique-ID') ;

  /**
   * is secure media being transmitted (i.e. DLTS-SRTP)
   * @type Boolean
   */
  this.secure = /^m=audio\s\d*\sUDP\/TLS\/RTP\/SAVPF/m.test( conn.getInfo().getHeader('variable_switch_r_sdp') ) ;

  /**
   * endpoint was created with a 3pcc INVITE -- i.e. INVITE with no SDP, so endpoint is initially not streaming to a far end
   * @type {[type]}
   */
  this.is3pcc = opts.is3pcc ;

  /**
   * defines the local network connection of the Endpoint
   * @type {Endpoint~NetworkConnection}
   */
  this.local = {} ;
  /**
   * defines the remote network connection of the Endpoint
   * @type {Endpoint~NetworkConnection}
   */
  this.remote = {} ;
  /**
   * defines the SIP signaling parameters of the Endpoint
   * @type {Endpoint~SipInfo}
   */
  this.sip = {} ;
  this.state = State.NOT_CONNECTED ;

  debug('Endpoint: creating endpoint with uuid %s, is3pcc: %s', this.uuid, this.is3pcc);

  this._conn.subscribe('all') ;
 
  this._conn.on('esl::event::CHANNEL_EXECUTE::'+ this.uuid, this._onChannelExecute.bind(this)) ;
  this._conn.on('esl::event::CHANNEL_HANGUP::'+ this.uuid, this._onHangup.bind(this)) ;
  this._conn.on('error', this._onError.bind(this)) ;

  if( !this.is3pcc ) {
    this._conn.on('esl::event::CHANNEL_ANSWER::' + this.uuid, this._onAnswer.bind(this, cb)) ;
    this._conn.on('esl::event::CHANNEL_CALLSTATE::'+ this.uuid, this._onChannelCallState.bind(this, cb)) ;    
    if( opts.codecs ) {
      if( typeof opts.codecs === 'string') { opts.codecs = [opts.codecs]; }

      if( opts.codecs.length > 0 ) {
        self._conn.execute('set', 'codec_string=' + opts.codecs.join(',')) ;
      }
    }
    this._conn.execute('answer') ;
  }
  else {
    this.getChannelVariables( true, function( obj ) {
      self.local.sdp = obj['variable_rtp_local_sdp_str'] ;
      self.local.mediaIp = obj['variable_local_media_ip'] ;
      self.local.mediaPort = obj['variable_local_media_port'] ;

      self.remote.sdp = obj['variable_switch_r_sdp'] ;
      self.remote.mediaIp = obj['variable_remote_media_ip'] ;
      self.remote.mediaPort = obj['variable_remote_media_port'] ;

      self.dtmfType = obj['variable_dtmf_type'] ;
      self.sip.callId = obj['variable_sip_call_id'] ;  

      cb(null, self) ;
    }) ;
  }

  Object.defineProperty(this, 'dialog', {
    set: function(dialog) {
      this._dialog = dialog ;
      this._dialog.on('destroy', this._onBye.bind( this ) ) ;
    }
  }) ;
  Object.defineProperty(this, 'conn', {
    get: function() {
      return this._conn ;
    }
  }) ;
}
/**
 * Options governing the creation of an Endpoint
 * @typedef {Object} Endpoint~createOptions
 * @property {string} [debugDir] directory into which message trace files; the presence of this param will enable debug tracing
 * @property {string|array} [codecs] preferred codecs; array order indicates order of preference
 * 
 */

/**
 * This callback is invoked when an endpoint has been created and is ready for commands.
 * @callback Endpoint~createCallback
 * @param {Error} error 
 * @param {Endpoint} ep the Endpoint
 */
util.inherits(Endpoint, Emitter) ;

module.exports = exports = Endpoint ;


/**
 * return the MediaServer associated with this Endpoint
 * @return {MediaServer} MediaServer 
 */
Endpoint.prototype.getMediaServer = function() {
    return this._ms ;
} ;

function parseBodyText( txt ) {
  return txt.split('\n').reduce(function(obj, line) {
      var data = line.split(': '),
          key = data.shift(),
          value = decodeURIComponent( data.shift() );

      if(0 === key.indexOf('variable_rtp_audio') || 0 === key.indexOf('variable_rtp_video')  || 0 === key.indexOf('variable_playback') ) {
          obj[key] = parseInt(value, 10);
      } else if( key && key.length > 0 ) {
          obj[key] = value;
      }

      return obj;
  }, {});
}

/**
 * retrieve channel variables for the endpoint
 * @param  {boolean} [includeMedia] if true, retrieve rtp counters (e.g. variable_rtp_audio_in_raw_bytes, etc)
 * @param  {Endpoint~getChannelVariablesCallback} cb   callback function invoked when operation completes
 */
Endpoint.prototype.getChannelVariables = function( includeMedia, callback ) {
  var self = this ;
  if( typeof includeMedia === 'function') {
    callback = includeMedia ;
    includeMedia = false ;
  }

  async.waterfall([
    function setMediaStatsIfRequested(callback) {
      if( includeMedia === true ) {
        self.api('uuid_set_media_stats', self.uuid, function() {
          callback(null) ;
        }) ;
      }
      else {
        callback(null) ;
      }
    }, 
    function getVars(callback) {
      self.api('uuid_dump', self.uuid, function(event, headers, body) {
        callback( null, event, headers, body ) ;
      }) ;
    }
  ], function( err, event, headers, body) {
    debug('getChannelVariables: uuid_dump event:', event) ;
    debug('getChannelVariables: uuid_dump headers: ', headers) ;
    debug('getChannelVariables: uuid_dump headers: ', body) ;

    if( headers['Content-Type'] === 'api/response' && 'Content-Length' in headers ) {
      var bodyLen = parseInt( headers['Content-Length'], 10) ;
      return callback( parseBodyText( body.slice(0, bodyLen) ) ) ;
    }
    callback({}) ;
  }) ;
} ;

/**
 * play an audio file on the endpoint
 * @param  {string|Array}   file file (or array of files) to play 
 * @param  {Endpoint~playOperationCallback} [cb]   callback function invoked when operation completes
 */
Endpoint.prototype.play = function( file, cb ) {
  assert.ok( 'string' === typeof file || _.isArray( file ), 'file param is required and must be a string or array') ;

  var self = this ;
  cb = cb || noop ;
  var files = _.isArray( file ) ? file : [file] ;

  async.waterfall([
    function setDelimiter(callback) {
      if( 1 === files.length ) { 
        return callback(null); 
      }
      self._conn.execute('set', 'playback_delimiter=!', function(evt){
        debug('playback_delimiter response: ', evt) ;
        callback(null); 
      }) ;
    }, 
    function sendPlay(callback) {
      self._conn.execute('playback', files.join('!'), function(evt) {
        var result = {
          playbackSeconds: evt.getHeader('variable_playback_seconds'),
          playbackMilliseconds: evt.getHeader('variable_playback_ms'),
        } ;
        callback( null, result ) ;
      }) ;
    }
    ], 
    function(err, result){
      cb(err, result) ;
    }
  ) ;
} ;
/**
 * This callback is invoked when a media operation has completed
 * @callback Endpoint~playOperationCallback
 * @param {Error} err - error returned from play request
 * @param {object} results - results of the operation
 * @param {String} results.playbackSeconds - number of seconds of audio played
 * @param {String} results.playbackMilliseconds - number of fractional milliseconds of audio played
 */

/**
 * play an audio file and collect digits
 * @param  {Endpoint~playCollectOptions}   opts - playcollect options
 * @param  {Endpoint~playCollectOperationCallback} cb - callback function invoked when operation completes
 */
Endpoint.prototype.playCollect = function( opts, cb) {
  assert(typeof opts, 'object', '\'opts\' param is required') ;
  assert(typeof opts.file, 'string', '\'opts.file\' param is required') ;

  opts.min = opts.min || 0 ;
  opts.max = opts.max || 128 ;
  opts.tries = opts.tries || 1 ;
  opts.timeout = opts.timeout || 120000 ;
  opts.terminators = opts.terminators || '#' ;
  opts.invalidFile = opts.invalidFile || 'silence_stream://250' ;
  opts.varName = opts.varName || 'myDigitBuffer' ;
  opts.regexp = opts.regexp || '\\d+' ;
  opts.digitTimeout = opts.digitTimeout || 8000 ;

  var args = [] ;
  ['min', 'max', 'tries', 'timeout', 'terminators', 'file', 'invalidFile', 'varName','regexp','digitTimeout']
  .forEach(function(prop) { 
    args.push( opts[prop] ) ; 
  }) ;

  this._conn.execute('play_and_get_digits', args.join(' '), function(evt){
    if('play_and_get_digits' !== evt.getHeader('variable_current_application')) {
      console.log('expected response to play_and_get_digits but got %s', evt.getHeader('variable_current_application')) ;
      return ;
    }
    var result = {
      digits: evt.getHeader('variable_' + opts.varName),
      invalidDigits: evt.getHeader('variable_' + opts.varName + '_invalid'),
      terminatorUsed: evt.getHeader('variable_read_terminator_used'),
      playbackSeconds: evt.getHeader('variable_playback_seconds'),
      playbackMilliseconds: evt.getHeader('variable_playback_ms'),
    } ;
    cb(null, result) ;
  }) ;
} ;
/**
 * Options governing a play command
 * @typedef {Object} Endpoint~playCollectOptions
 * @property {String} file - file to play as a prompt
 * @property {number} [min=0] minimum number of digits to collect
 * @property {number} [max=128] maximum number of digits to collect
 * @property {number} [tries=1] number of times to prompt before returning failure
 * @property {String} [invalidFile=silence_stream://250] file or prompt to play when invalid digits are entered
 * @property {number} [timeout=120000] total timeout in millseconds to wait for digits after prompt completes
 * @property {String} [terminators=#] one or more keys which, if pressed, will terminate digit collection and return collected digits
 * @property {String} [varName=myDigitBuffer] name of freeswitch variable to use to collect digits
 * @property {String} [regexp=\\d+] regular expression to use to govern digit collection
 * @property {number} [digitTimeout=8000] inter-digit timeout, in milliseconds
 */

/**
 * This callback is invoked when a media operation has completed
 * @callback Endpoint~playCollectOperationCallback
 * @param {Error} err - error returned from play request
 * @param {object} results - results of the operation
 * @param {String} results.digits - digits collected, if any
 * @param {String} results.terminatorUsed - termination key pressed, if any
 * @param {String} results.playbackSeconds - number of seconds of audio played
 * @param {String} results.playbackMilliseconds - number of fractional milliseconds of audio played
 */

/**
 * Speak a phrase that requires grammar rules
 * @param  {string}   text phrase to speak
 * @param  {Endpoint~sayOptions}   opts - say command options
 * @param  {Endpoint~playOperationCallback} cb - callback function invoked when operation completes
 */
Endpoint.prototype.say = function( text, opts, cb) {
  debug('opts: ', opts);
  assert(typeof text, 'string', '\'text\' is required') ;
  assert(typeof opts, 'object', '\'opts\' param is required') ;
  assert(typeof opts.sayType, 'string', '\'opts.sayType\' param is required') ;
  assert(typeof opts.sayMethod, 'string', '\'opts.sayMethod\' param is required') ;

  opts.lang = opts.lang || 'en' ;
  opts.sayType = opts.sayType.toUpperCase() ;
  opts.sayMethod = opts.sayMethod.toLowerCase() ;

  assert.ok( !(opts.sayType in [
    'NUMBER',
    'ITEMS',
    'PERSONS',
    'MESSAGES',
    'CURRENCY',
    'TIME_MEASUREMENT',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'CURRENT_DATE_TIME',
    'TELEPHONE_NUMBER',
    'TELEPHONE_EXTENSION',
    'URL',
    'IP_ADDRESS',
    'EMAIL_ADDRESS',
    'POSTAL_ADDRESS',
    'ACCOUNT_NUMBER',
    'NAME_SPELLED',
    'NAME_PHONETIC',
    'SHORT_DATE_TIME']), 'invalid value for \'sayType\' param: ' + opts.sayType) ;

  assert.ok(!(opts.sayMethod in ['pronounced', 'iterated', 'counted']), 'invalid value for \'sayMethod\' param: ' + opts.sayMethod) ;

  if( opts.gender ) {
    opts.gender = opts.gender.toUpperCase() ;
    assert.ok(opts.gender in ['FEMININE','MASCULINE','NEUTER'], 'invalid value for \'gender\' param: ' + opts.gender) ;
  }

  var args = [] ;
  ['lang','sayType','sayMethod','gender'].forEach(function(prop) {
    if( opts[prop] ) {
      args.push( opts[prop] ) ;
    }
  });
  args.push( text ) ;

  this._conn.execute('say', args.join(' '), function(evt){
    if('say' !== evt.getHeader('variable_current_application')) {
      console.log('expected response to say but got %s', evt.getHeader('variable_current_application')) ;
      return ;
    }
    debug('response to say command: ', evt) ;
    var result = {
      playbackSeconds: evt.getHeader('variable_playback_seconds'),
      playbackMilliseconds: evt.getHeader('variable_playback_ms'),
    } ;
    cb(null, result) ;
  }) ;
} ;
/**
 * Options governing a say command
 * @typedef {Object} Endpoint~sayOptions
 * @property {String} sayType describes the type word or phrase that is being spoken; must be one of the following: 'number', 'items', 'persons', 'messages', 'currency', 'time_measurement', 'current_date', 'current_time', 'current_date_time', 'telephone_number', 'telephone_extensio', 'url', 'ip_address', 'email_address', 'postal_address', 'account_number', 'name_spelled', 'name_phonetic', 'short_date_time'.
 * @property {String} sayMethod method of speaking; must be one of the following: 'pronounced', 'iterated', 'counted'.
 * @property {String} [lang=en] language to speak
 * @property {String} [gender] gender of voice to use, if provided must be one of: 'feminine','masculine','neuter'.
 */

/**
 * join an endpoint into a conference
 * @param  {String|Conference}   conf - name of a conference or a Conference instance
 * @param  {Endpoint~confJoinOptions}  [opts] - options governing the connection between the endpoint and the conference
 * @param  {Endpoint~confJoinCallback} cb  - callback invoked when join operation is completed 
 */
Endpoint.prototype.joinConference = function( conf, opts, cb ) {
  assert.ok( typeof conf === 'string' || conf instanceof Conference, 'argument \'conf\' must be either a conference name or a Conference object' ) ;

  var confName = typeof conf === 'string' ? conf : conf.name ;
  if( typeof opts === 'function') {
    cb = opts ;
    opts = {} ;
  }
  opts.flags = opts.flags || {} ;

  var flags = [] ;
  _.each( opts.flags, function(value, key) { if( true === value ) { flags.push( _.snakeCase(key).replace(/_/g,'-') ); } }) ;

  var args = confName ;
  if( opts.profile ) { args += '@' + opts.profile; }

  if( !!opts.pin || flags.length > 0 ) {
    args += '+' ;
  }
  if( opts.pin ) { args += opts.pin ; }
  if( flags.length > 0 ) {
    args += '+flags{' + flags.join('|') + '}' ;
  }
  debug('executing conference with args: ', args) ;
  var eventUuid = this.execute('conference', args) ;

  this._executeCallbacks[eventUuid] = {
    callback: cb,
    args: {
      pin: opts.pin,
      profile: opts.profile,
      flags: flags
    },
    confName: confName
  } ;

} ;

/**
 * Bridge two endpoints together
 * @param  {Endpoint | string}   other    - an Endpoint or uuid of a channel to bridge with
 * @param  {endpointOperationCallback} callback - callback invoked when bridge operation completes
 */
Endpoint.prototype.bridge = function( other, callback ) {
  assert.ok( typeof other === 'string' || other instanceof Endpoint, 'argument \'other\' must be either a uuid or an Endpoint' ) ;

  var otherUuid = typeof other === 'string' ? other : other.uuid ;

  this.api('uuid_bridge', [this.uuid, otherUuid], function(event, headers, body) {
    debug('Endpoint#bridge: event: ', event) ;
    debug('Endpoint#bridge: headers: ', headers) ;
    debug('Endpoint#bridge: body: ', body) ;

    if( 0 === body.indexOf('+OK') ) {
      return callback(null) ;
    }
    callback(new Error(body) ) ;
  }); 
} ;

/**
 * Park two endpoints that were previously bridged together
 * @param  {endpointOperationCallback} callback - callback invoked when bridge operation completes
 */
Endpoint.prototype.unbridge = function( callback ) {

  this.api('uuid_transfer', [this.uuid, '-both','park','inline'], function(event, headers, body) {
    debug('Endpoint#bridge: event: ', event) ;
    debug('Endpoint#bridge: headers: ', headers) ;
    debug('Endpoint#bridge: body: ', body) ;

    if( 0 === body.indexOf('+OK') ) {
      return callback(null) ;
    }
    callback(new Error(body) ) ;
  }); 
} ;


/**
 * Options governing a join operation between an endpoint and a conference
 * @typedef {Object} Endpoint~confJoinOptions
 * @property {string} [pin] entry pin for the conference
 * @property {string} [profile=default] conference profile to use
 * @property {Object} [flags] parameters governing the connection of the endpoint to the conference
 * @property {boolean} [flags.mute=false] enter the conference muted
 * @property {boolean} [flags.deaf=false] enter the conference deaf'ed (can not hear)
 * @property {boolean} [flags.muteDetect=false] Play the mute_detect_sound when talking detected by this conferee while muted
 * @property {boolean} [flags.distDtmf=false] Send any DTMF from this member to all participants
 * @property {boolean} [flags.moderator=false] Flag member as a moderator
 * @property {boolean} [flags.nomoh=false] Disable music on hold when this member is the only member in the conference
 * @property {boolean} [flags.endconf=false] Ends conference when all members with this flag leave the conference after profile param endconf-grace-time has expired
 * @property {boolean} [flags.mintwo=false] End conference when it drops below 2 participants after a member enters with this flag
 * @property {boolean} [flags.ghost=false] Do not count member in conference tally
 * @property {boolean} [flags.joinOnly=false] Only allow joining a conference that already exists
 * @property {boolean} [flags.positional=false] Process this member for positional audio on stereo outputs
 * @property {boolean} [flags.noPositional=false] Do not process this member for positional audio on stereo outputs
 * @property {boolean} [flags.joinVidFloor=false] Locks member as the video floor holder
 * @property {boolean} [flags.noMinimizeEncoding] Bypass the video transcode minimizer and encode the video individually for this member
 * @property {boolean} [flags.vmute=false] Enter conference video muted
 * @property {boolean} [flags.secondScreen=false] Open a 'view only' connection to the conference, without impacting the conference count or data.
 * @property {boolean} [flags.waitMod=false] Members will wait (with music) until a member with the 'moderator' flag set enters the conference
 * @property {boolean} [flags.audioAlways=false] Do not use energy detection to choose which participants to mix; instead always mix audio from all members
 * @property {boolean} [flags.videoBridgeFirstTwo=false] In mux mode, If there are only 2 people in conference, you will see only the other member
 * @property {boolean} [flags.videoMuxingPersonalCanvas=false] In mux mode, each member will get their own canvas and they will not see themselves
 * @property {boolean} [flags.videoRequiredForCanvas=false] Only video participants will be shown on the canvas (no avatars)
 */
/**
 * This callback is invoked when a join operation between an Endpoint and a conference has completed
 * @callback Endpoint~joinOperationCallback
 * @param {Error} err - error returned from join request
 * @param {ConferenceConnection} conn - object representing the connection of this participant to the conference
 */


/**
 * Releases an Endpoint and associated resources
 * @param  {Endpoint~destroyCallback=} cb callback function invoked after endpoint has been released
 */
Endpoint.prototype.destroy = function(cb) {
  var self = this ;
  cb = cb || noop ;

  if( State.CONNECTED !== this.state ) {
    process.nextTick(function() { cb('endpoint could not be deleted because it is not connected'); }) ;
    return ;
  }

  this.state = State.DISCONNECTED ;
  this._conn.execute('hangup', function(/* evt */){
    self._conn.disconnect() ;
    cb(null) ;
  }); 
  if( this._dialog ) {
    this._dialog.destroy() ;
    this._dialog = null ;
  }
} ;
/**
 * This callback is invoked when an endpoint has been destroyed / released.
 * @callback Endpoint~destroyCallback
 * @param {Error} error, if any
 */

//event handlers
Endpoint.prototype._onError = function(err) {
  if( err.errno && (err.errno === 'ECONNRESET' || err.errno === 'EPIPE') && this.state === State.DISCONNECTED ) {
    debug('ignoring connection reset error during teardown of connection') ;
    return ;
  }
  console.error('Endpoint#_onError: uuid: %s: ', this.uuid, err) ;
  console.trace('Trace: ', err) ;
} ;
Endpoint.prototype._onAnswer = function(cb, evt) {
  debug('Endpoint#_onAnswer: id: %s, conn: %s', this.uuid, this._conn._id) ;

  this.local.sdp = evt.getHeader('variable_rtp_local_sdp_str') ;
  this.local.mediaIp = evt.getHeader('variable_local_media_ip') ;
  this.local.mediaPort = evt.getHeader('variable_local_media_port') ;

  this.remote.sdp = evt.getHeader('variable_switch_r_sdp') ;
  this.remote.mediaIp = evt.getHeader('variable_remote_media_ip') ;
  this.remote.mediaPort = evt.getHeader('variable_remote_media_port') ;

  this.dtmfType = evt.getHeader('variable_dtmf_type') ;
  this.sip.callId = evt.getHeader('variable_sip_call_id') ;  

  this.state = State.CONNECTED ;

  if( !this.secure ) {
    cb(null, this) ;
  }
} ;
Endpoint.prototype._onChannelCallState = function( cb, evt ) {
  var channelCallState = evt.getHeader('Channel-Call-State')  ;
  debug('Endpoint#_onChannelCallState %s: Channel-Call-State: ', this.uuid, channelCallState) ;
  if( State.NOT_CONNECTED === this.state ) {
    var self = this ;
    if( 'EARLY' === channelCallState ) {
      this.state = State.EARLY ;

      // if we are using DLTS-SRTP, the 200 OK has been sent at this point; however, answer will not be sent by FSW until the handshake.
      // We need to invoke the callback provided in the constructor now in order to allow the calling app to access the endpoint.
      if( this.secure ) {
        this.getChannelVariables( true, function( obj ) {
          self.local.sdp = obj['variable_rtp_local_sdp_str'] ;
          self.local.mediaIp = obj['variable_local_media_ip'] ;
          self.local.mediaPort = obj['variable_local_media_port'] ;

          self.remote.sdp = obj['variable_switch_r_sdp'] ;
          self.remote.mediaIp = obj['variable_remote_media_ip'] ;
          self.remote.mediaPort = obj['variable_remote_media_port'] ;

          self.dtmfType = obj['variable_dtmf_type'] ;
          self.sip.callId = obj['variable_sip_call_id'] ;  
 
          cb(null, self) ;
        }) ;
      }
    }
  }
} ;
Endpoint.prototype._onHangup = function(evt) {

  if( State.DISCONNECTED !== this.state ) {
    this._conn.disconnect(); 
  }
  this.state = State.DISCONNECTED ;
  this.emit('hangup', evt) ;
} ;
Endpoint.prototype._onBye = function( /* evt */) {
  debug('got BYE from media server') ;
  this.emit('destroy') ;
} ;
Endpoint.prototype._onChannelExecute = function(evt) {
  var eventUuid = evt.getHeader('Application-UUID') ;
  var obj = this._executeCallbacks[eventUuid] ;
  if( !!obj ) {
    delete this._executeCallbacks[eventUuid] ;
    debug('CHANNEL_EXECUTE from join conference: ', evt) ;
    var confConnection = new ConferenceConnection( this, obj.confName, obj.args )  ;
    obj.callback( null, confConnection );
  }
};


//representation
Endpoint.prototype.toJSON = function() {
  return( only( this, 'sip local remote uuid')) ;
} ;
Endpoint.prototype.toString = function() {
  return this.toJSON().toString() ;
} ;

delegate(Endpoint.prototype, '_conn')
  .method('connected') 
  .method('api')
  .method('execute')
  .method('filter') ;

delegate(Endpoint.prototype, '_dialog')
  .method('request')
  .method('modify') ;

/** execute a freeswitch application on the endpoint
* @method Endpoint#execute
* @param {string} app - application to execute
* @param {string | Array} [args] - arguments 
* @param {Endpoint~mediaOperationCallback} cb - callback invoked when a CHANNEL_EXECUTE_COMPLETE is received for  the application
 */
/** execute a freeswitch api on the endpoint
* @method Endpoint#api
* @param {string} command - api command to execute
* @param {string | Array} [args] - arguments 
* @param {Endpoint~mediaOperationCallback} cb - callback invoked when a response to the api command is received
*/
/** returns true if the Endpoint is in the 'connected' state
*   @name Endpoint#connected
*   @method
*/

/** modify the endpoint by changing attributes of the media connection
*   @name Endpoint#modify
*   @method
*   @param  {string} sdp - 'hold', 'unhold', or a session description protocol
*   @param  {Endpoint~modifyCallback} [cb] - callback invoked when operation has completed
*/
/**
 * This callback provides the response to a modifySession request.
 * @callback Endpoint~modifyCallback
 * @param {Error} err  non-success sip response code received from far end
 */
/**
 * This callback provides the response to a endpoint operation request of some kind.
 * @callback Endpoint~endpointOperationCallback
 * @param {Error} err - null if operation succeeds; otherwises provides an indication of the error  
 */
/**
 * This callback is invoked when the response is received to a command executed on the endpoint
 * @callback Endpoint~mediaOperationCallback
 * @param {Object} response - response to the command
 */
/**
 * This callback is invoked when the response is received to a command executed on the endpoint
 * @callback Endpoint~getChannelVariablesCallback
 * @param {Object} obj - an object with key-value pairs where the key is channel variable name and the value is the associated value
 */


/**
 * Information describing either the local or remote end of a connection to an Endpoint
 * @typedef {Object} Endpoint~NetworkConnection
 * @property {String} sdp - session description protocol offered
 */
/**
 * Information describing the SIP Dialog that established the Endpoint
 * @typedef {Object} Endpoint~SipInfo
 * @property {String} callId - SIP Call-ID
 */
/**
 * destroy event triggered when the Endpoint is destroyed by the media server.
 * @event Endpoint#destroy
 */

