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

  // used to track play commands in progress
  this._playCommands = {} ;
 
  this._endpoint.conn.subscribe('all') ;
 
  this._endpoint.conn.on('esl::event::CUSTOM::*', this._onConferenceEvent.bind(this)) ;
 
  opts.flags = opts.flags || {} ;

  //set these because our leg is purely a control leg
  _.extend( opts.flags, {
    // ghost: true, DH: would like to be a ghost leg (not counted) but this causes the conf to be destroyed when it is the only remaining leg
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
 * return the MediaServer on which this conference is running
 * @return {MediaServer} MediaServer 
 */
Conference.prototype.getMediaServer = function() {
    return this._endpoint.getMediaServer() ;
} ;

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
  assert.ok(typeof file === 'string', '\'file\' parameter must be provided') ;
  cb = cb || noop ;
  this.recordFile = file ;
  this._endpoint.api('conference ', this.name + ' recording start ' + file, cb) ;
} ;
/**
 * pause the recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.pauseRecording = function( file, cb ) {  
  cb = cb || noop ;
  this.recordFile = file ;
  this._endpoint.api('conference ', this.name + ' recording pause ' + this.recordFile, cb) ;
} ;
/**
 * resume the recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.resumeRecording = function( file, cb ) {  
  cb = cb || noop ;
  this.recordFile = file ;
  this._endpoint.api('conference ', this.name + ' recording resume ' + this.recordFile, cb) ;
} ;
/**
 * stop the conference recording
 * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
 */
Conference.prototype.stopRecording = function( file, cb ) {
  cb = cb || noop ;
  this._endpoint.api('conference ', this.name + ' recording stop ' + this.recordFile, cb) ;
  this.recordFile = null ;
} ;
/**
 * play an audio file into the conference
 * @param  {string|Array}   file file (or array of files) to play 
 * @param  {Conference~playOperationCallback} [cb] - callback invoked when the files have completed playing
 */
Conference.prototype.play = function( file, cb ) {
  assert.ok( 'string' === typeof file || _.isArray( file ), 'file param is required and must be a string or array') ;

  var self = this ;
  var files = typeof file === 'string' ? [file] : file ;

  // each call to conference play queues the file up; i.e. the callback returns immediately upon successful queueing, 
  // not when the file has finished playing
  var queued = [] ;
  async.eachSeries( files, function( f, callback ) {
    self._endpoint.api('conference', self.name + ' play ' + f, function(result) {
      if( result && result.body && -1 !== result.body.indexOf(' not found.') ) {
        debug('file %s was not queued because it was not found, or conference is empty', f); 
      }
      else {
        queued.push( f ) ;
      }
      callback(null) ;
    }) ;
  }, function(){
    debug('files have been queued for playback into conference: ', queued) ;
    if( cb ) {
      if( queued.length > 0 ) {
        var firstFile = queued[0] ;
        var obj = {
          remainingFiles: queued.slice(1),
          seconds: 0,
          milliseconds: 0,
          samples: 0,
          done: cb        
        } ;
        self._playCommands[firstFile] = self._playCommands[firstFile] || [] ;
        self._playCommands[firstFile].push( obj ) ;        
      }
      else {
        // no files actually got queued, so execute the callback
        debug('Conference#play: no files were queued for callback, so invoking callback immediately') ;
        setImmediate( cb, {
          seconds: 0,
          milliseconds: 0,
          samples: 0
        }) ;
      }
    }
  }) ;
};
/**
 * This callback is invoked when a playback to conference command completes with a play done event of the final file.
 * @callback Conference~playOperationCallback
 * @param {Error} err  error returned, if any
 * @param {Conference~playbackResults} [results] - results describing the duration of media played
 */
/**
 * This object describes the results of a playback into conference operation
 * @typedef {Object} Conference~playbackResults
 * @property {number} seconds - total seconds of media played
 * @property {number} milliseconds - total milliseconds of media played
 * @property {number} samples - total number of samples played
 */

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
  debug('member started talking: ', evt.getHeader('Member-ID')) ;
} ;
Conference.prototype.onStopTalking = function(evt) {
  debug('member stopped talking: ', evt.getHeader('Member-ID')) ;
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
  var confName = evt.getHeader('Conference-Name') ;
  var file = evt.getHeader('File') ;
  debug('conference-level play has started: %s: %s' , confName, file);
} ;
Conference.prototype.onPlayFileMember = function(evt) {
  debug('member-level play has completed: ', evt) ;
} ;
Conference.prototype.onPlayFileDone = function(evt) {
  var confName = evt.getHeader('Conference-Name') ;
  var file = evt.getHeader('File') ;
  var seconds = parseInt( evt.getHeader('seconds')) ;
  var milliseconds = parseInt( evt.getHeader('milliseconds')) ;
  var samples = parseInt( evt.getHeader('samples')) ;

  debug('conference-level play has completed: %s: %s seconds: %d, milliseconds: %d, samples: %d',
    confName, file, seconds, milliseconds, samples);

  // check if the caller registered a callback for this play done
  var el = this._playCommands[file] ;
  if( !!el ) {
    assert( _.isArray(el), 'Conference#onPlayFileDone: this._playCommands must be an array') ;
    var obj = el[0] ;   
    obj.seconds += seconds ;
    obj.milliseconds += milliseconds ;
    obj.samples += samples ;

    if( 0 === obj.remainingFiles.length ) {

      // done playing all files in this request
      obj.done( null, {
        seconds: obj.seconds,
        milliseconds: obj.milliseconds,
        samples: obj.samples
      }) ;
    } 
    else {
      var firstFile = obj.remainingFiles[0] ;
      obj.remainingFiles = obj.remainingFiles.slice(1) ;
      this._playCommands[firstFile] = this._playCommands[firstFile] || [] ;
      this._playCommands[firstFile].push( obj ) ;
    }

    this._playCommands[file] = this._playCommands[file].slice(1) ;
    if( 0 === this._playCommands[file].length ) {
      //done with all queued requests for this file
      delete this._playCommands[file] ;
    }
  }
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
