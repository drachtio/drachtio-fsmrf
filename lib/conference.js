var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var assert = require('assert') ;
var only = require('only') ;
var noop = require('node-noop').noop;
var _ = require('lodash') ;
var async = require('async') ;
var debug = require('debug')('drachtio-fsmrf') ;

var State = {
  NOT_CREATED: 1,
  CREATED: 2,
  DESTROYED: 3
};

/**
 * an audio or video conference mixer.  Conferences may be created on the fly by simply joining an endpoint
 * to a named conference without explicitly creating a Conference object.  The main purpose of the Conference
 * object is to enable the ability to create a conference on the media server without having an inbound call
 * (e.g., to create a scheduled conference at a particular point in time).
 *
 * @constructor
 * @param {Endpoint} endpoint - endpoint that will provide the control connection to the conference
 * @param {String}   name  - conference name
 * @param {Conference~createOptions}  [opts] - conference-level configuration options
 * @param {Conference~createCallback} cb - callback invoked when conference is created
 */
function Conference( endpoint, name, opts, cb ) {
  Emitter.call(this); 
  var self = this ;

  if( typeof opts === 'function') {
    cb = opts ;
    opts = {} ;
  }

  this._endpoint = endpoint ;

  /**
   * conference name
   * @type {string}
   */

  this.name = name ;

  /**
   * file that conference is currently being recorded to
   * @type {String}
   */
  this.recordFile = null ;

  /**
   * conference state
   * @type {Number}
   */
  this.state = State.NOT_CREATED ;

  /**
   * true if conference is locked
   * @type {Boolean}
   */
  this.locked = false ;

  /**
   * member ID of the conference control leg
   * @type {Number}
   */
  this.memberId = -1 ;

  /**
   * current participants in the conference, keyed by member ID
   * @type {Object}
   */
  this.participants = {} ;

  /**
   * max number of members allowed (-1 means no limit)
   * @type {Number}
   */
  this.maxMembers = -1 ;
 
  this._endpoint.conn.subscribe('all') ;
 
  this._endpoint.conn.on('esl::event::CUSTOM::*', this._onConferenceEvent.bind(this)) ;
 
  opts.flags = opts.flags || {} ;

  //set these because our leg is purely a control leg
  _.extend( opts.flags, {
    ghost: true,
    endconf: true,
    mute: true,
    vmute: true 
  }) ;

  this._endpoint.joinConference(name, opts, function( err, connection) {
    self.confConn = connection ;
    debug('conference created: ', JSON.stringify(self)) ;

    if( opts.maxMembers ) {
      connection.api('conference', name + ' set max_members ' + opts.maxMembers ) ;
      self.maxMembers = opts.maxMembers ;
    }
    cb(err, self) ;
  }) ;
}

util.inherits(Conference, Emitter) ;

module.exports = exports = Conference ;

/**
 * destroy the conference, releasing all legs
 * @param  {Conference~destroyCallback} cb - callback invoked when conference has been destroyed
 */
Conference.prototype.destroy = function(cb) {
    this._endpoint.destroy(cb) ;
} ;
/**
 * This callback is invoked when a conference has been destroyed
 * @callback Conference~destroyCallback
 * @param {Error} error, if any
 */

//media operations
/**
 * adjust the automatic gain control for the conference
 * @param  {Number|String}   level - 'on', 'off', or a numeric level
 * @param  {Conference~mediaOperationCallback} [cb] - callback invoked when operation completes
 */
Conference.prototype.agc = function( level, cb ) {
  assert.ok( typeof level === 'number' || -1 !== ['on','off'].indexOf(level), 
    '\'level\' must be \'on\', \'off\', or a numeric level to apply' );

  cb = cb || noop ;
  this._endpoint.api('conference', this.name + ' agc ' + level, cb) ;
} ;
/**
 * This callback is invoked whenever any media command has completed
 * @callback Conference~mediaOperationCallback
 * @param {Object} response - response to the command
 */

/**
 * check the status of the conference recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.chkRecord = function(cb) {
  cb = cb || noop ;
  this._endpoint.api('conference', this.name + ' chk-record', cb) ;  
} ;
/**
 * deaf all the non-moderators in the conference
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.deafAll = function(cb) {
  cb = cb || noop ;
  this._endpoint.api('conference', this.name + ' deaf non_moderator', cb) ;    
} ;
/**
 * mute all the non-moderators in the conference
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.muteAll = function(cb) {
  cb = cb || noop ;
  this._endpoint.api('conference', this.name + ' mute non_moderator', cb) ;    
} ;
/**
 * lock the conference
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.lock = function(cb) {
  var self = this ;
  cb = cb || noop ;
  this._endpoint.api('conference', this.name + ' lock', function(res) {
    self.locked = true ;
    cb(res) ;
  }) ;    
} ;
/**
 * unlock the conference
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.unlock = function(cb) {
  var self = this ;
  cb = cb || noop ;
  this._endpoint.api('conference', this.name + ' unlock', function(res) {
    self.locked = false ;
    cb(res) ;
  }) ;    
} ;
/**
 * start recording the conference
 * @param  {String}   file - filepath to record to
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.startRecording = function( file, cb ) {
  assert.equals(typeof file === 'string', '\'file\' parameter must be provided') ;

  cb = cb || noop ;
  this.recordFile = file ;
  this._endpoint.api('record', this.name + ' recording start ' + file, cb) ;
} ;
/**
 * pause the recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.pauseRecording = function( file, cb ) {  
  cb = cb || noop ;
  this.recordFile = file ;
  this._endpoint.api('record', this.name + ' recording pause ' + this.recordFile, cb) ;
} ;
/**
 * resume the recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.resumeRecording = function( file, cb ) {  
  cb = cb || noop ;
  this.recordFile = file ;
  this._endpoint.api('record', this.name + ' recording resume ' + this.recordFile, cb) ;
} ;
/**
 * stop the conference recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.stopRecording = function( file, cb ) {
  cb = cb || noop ;
  this._endpoint.api('record', this.name + ' recording tops ' + this.recordFile, cb) ;
  this.recordFile = null ;
} ;
/**
 * play an audio file into the conference
 * @param  {string|Array}   file file (or array of files) to play 
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.play = function( file, cb ) {
  assert.ok( 'string' === typeof file || _.isArray( file ), 'file param is required and must be a string or array') ;

  var self = this ;
  cb = cb || noop ;
  var files = typeof file === 'string' ? [file] : file ;

  var result = {} ;

  async.eachSeries( files, function( f, callback ) {
    self._endpoint.api('conference', self.name + ' play ' + f, function(evt) {
      result = {
        playbackSeconds: evt.getHeader('variable_playback_seconds'),
        playbackMilliseconds: evt.getHeader('variable_playback_ms'),
      } ;
      callback(null) ;
    }) ;

  }, function(){
    cb( result ) ;
  }) ;
};

//conference event handlers
Conference.prototype.onAddMember = function( evt ) {
 debug('Conference#onAddMember: ', JSON.stringify(this)) ;
 if( !this.uuid ) {
    this.uuid = evt.getHeader('Conference-Unique-ID') ;
    this.memberId = evt.getHeader('Member-ID') ;

    this._endpoint.filter('Conference-Unique-ID', this.uuid, function(res) {
      debug('response to filter command: ', res) ;
    }) ;

    debug('created conference with Conference-Unique-ID: ', this.uuid) ;
  }
  else {
    //debug('Conference#onAddMember: another leg joined: ', evt) ;
    var size = parseInt( evt.getHeader('Conference-Size') );
    var newMemberId = evt.getHeader('Member-ID')  ;
    var memberType = evt.getHeader('Member-Type') ;
    var memberGhost = evt.getHeader('Member-Ghost') ;
    var channelUuid = evt.getHeader('Channel-Call-UUID') ;
    var obj = {
      memberId: newMemberId,
      type: memberType,
      ghost: memberGhost,
      channelUuid: channelUuid
    } ;
    this.participants[newMemberId] = obj ;

    debug('Adding member to conference, size is now %d: ', size, this.participants) ;
  }
} ;
Conference.prototype.onDelMember = function(evt) {
    var memberId = evt.getHeader('Member-ID') ;
    var size = parseInt( evt.getHeader('Conference-Size') );

    delete this.participants[memberId] ;
    debug('member with member-id %s left, size is now: %d, remaining participants: ', memberId, size, this.participants) ;
} ;
Conference.prototype.onStartTalking = function(evt) {
  debug('member started talking: ', evt) ;
} ;
Conference.prototype.onStopTalking = function(evt) {
  debug('member stopped talking: ', evt) ;
} ;
Conference.prototype.onMuteDetect = function(evt) {
  debug('a muted member is talking: ', evt) ;
} ;
Conference.prototype.onUnmuteMember = function(evt) {
  debug('a member has been unmuted: ', evt) ;
} ;
Conference.prototype.onMuteMember = function(evt) {
  debug('a member has been muted: ', evt) ;
} ;
Conference.prototype.onKickMember = function(evt) {
  debug('a member has been kicked: ', evt) ;
} ;
Conference.prototype.onDtmfMember = function(evt) {
  debug('a member has entered DTMF: ', evt) ;
} ;
Conference.prototype.onPlayFile = function(evt) {
  debug('conference-level play has started: ', evt) ;
} ;
Conference.prototype.onPlayFileMember = function(evt) {
  debug('member-level play has completed: ', evt) ;
} ;
Conference.prototype.onPlayFileDone = function(/* evt */) {
  debug('conference-level play has completed: ' /*, evt*/) ;
} ;
Conference.prototype.onLock = function(evt) {
  debug('conference has been locked: ', evt) ;
} ;
Conference.prototype.onUnlock = function(evt) {
  debug('conference has been unlocked: ', evt) ;
} ;
Conference.prototype.onTransfer = function(evt) {
  debug('member has been transferred to another conference: ', evt) ;
} ;
Conference.prototype.onRecord = function(evt) {
  debug('conference record has started or stopped: ', evt) ;
} ;

function unhandled(evt) {
  debug('Conference#_onConferenceEvent: unhandled event: %s', evt.getHeader('Action')) ;
}

// esl connection event handlers
Conference.prototype._onConferenceEvent = function( evt ) {
  var eventName = evt.getHeader('Event-Subclass') ;
  if( eventName === 'conference::maintenance') {
    var action = evt.getHeader('Action') ;
    debug('Conference#_onConferenceEvent: conference event action: %s ', action) ;

    //invoke a handler for this action, if we have defined one
    (Conference.prototype['on' + _.capitalize(_.camelCase(action))] || unhandled).bind( this, evt )() ;

  }
  else {
    debug('Conference#_onConferenceEvent: got unhandled custom event: ', eventName ) ;
  }
}; 

// representation
Conference.prototype.toJSON = function() {
  return( only( this, 'name state uuid memberId confConn endpoint maxMembers locked recordFile')) ;
} ;
Conference.prototype.toString = function() {
  return this.toJSON().toString() ;
} ;
