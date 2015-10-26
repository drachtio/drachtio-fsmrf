var esl = require('modesl') ;
var assert = require('assert') ;
var noop = require('node-noop').noop;
var delegate = require('delegates') ;
var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var only = require('only') ;
var _ = require('lodash') ;
var async = require('async') ;
var debug = require('debug')('drachtio-fsmrf') ;

module.exports = exports = Endpoint ;

/**
 * Possible Endpoint States
 * @type {Object}
 */
var State = {
  NOT_CONNECTED: 1,
  CONNECTED: 2,
  DISCONNECTED: 3
};

/**
 * A media resource on a freeswitch-based MediaServer that is capable of play, record, and signal detection
 * @param {esl.Connection}   conn outbound connection from a media server for one session
 * @param {MediaServer}   ms   MediaServer that contains this Endpoint
 * @param {object}   app  drachtio app
 * @param {Endpoint~createCallback} cb   callback that is invoked when the endpoint is connected and ready for use
 */
function Endpoint( conn, ms, app, opts, cb ) {
  Emitter.call(this); 

  var self = this ;
  this._conn = conn ;
  this._ms = ms ;
  this._app = app ;
  this.local = {} ;
  this.remote = {} ;
  this.sip = {} ;
  this.state = State.NOT_CONNECTED ;

  this._conn.subscribe('all') ;
 
  this._conn.on('esl::event::CHANNEL_ANSWER::*', this._onAnswer.bind(this, cb)) ;
  this._conn.on('esl::event::CHANNEL_HANGUP::*', this._onHangup.bind(this)) ;
  this._conn.on('error', this._onError.bind(this)) ;

  if( opts.codecs.length > 0 ) {
    this._conn.execute('set', 'codec_string=' + opts.codecs.join(',')) ;
  }
  this._conn.execute('answer') ;
}
/**
 * This callback is invoked when an endpoint has been created and is ready for commands.
 * @callback Endpoint~createCallback
 * @param {Error} error 
 * @param {Endpoint} ep the Endpoint
 */
util.inherits(Endpoint, Emitter) ;

/**
 * Releases an Endpoint and associated resources
 * @param  {Endpoint~destroyCallback} cb callback function
 */
Endpoint.prototype.destroy = function(cb) {
  var self = this ;
  cb = cb || noop ;

  if( State.CONNECTED !== this.state ) {
    process.nextTick(function() { cb('endpoint could not be deleted because it is not connected'); }) ;
    return ;
  }

  this.state = State.DISCONNECTED ;
  this._conn.execute('hangup', function(evt){
    self._conn.disconnect() ;
    cb(null) ;
  }); 
} ;
/**
 * This callback is invoked when an endpoint has been destroyed / released.
 * @callback Endpoint~destroyCallback
 * @param {Error} error, if any
 */

/**
 * play an audio file on the endpoint
 * @param  {string|Array}   file file (or array of files) to play 
 * @param  {Endpoint~mediaOperationCallback} cb   callback function
 */
Endpoint.prototype.play = function( file, cb ) {
  assert.ok( 'string' == typeof file || _.isArray( file ), 'file param is required and must be a string or array') ;

  var self = this ;
  cb = cb || noop ;
  var files = _.isArray( file ) ? file : [file] ;

  async.waterfall([
    function setDelimiter(callback) {
      if( 1 == files.length ) { 
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
 * @callback Endpoint~mediaOperationCallback
 * @param {Error} error, if any
 * @param {object} results results of the operation
 */

/**
 * play an audio file and collect digits
 * @param  {object}   opts arguments
 * @param  {Endpoint~mediaOperationCallback} cb  callback 
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
  opts.varName = 'myDigitBuffer' ;
  opts.regexp = opts.regexp || '\\d+' ;
  opts.digitTimeout = opts.digitTimeout || 8000 ;

  var args = [] ;
  ['min', 'max', 'tries', 'timeout', 'terminators', 'file', 'invalidFile','varName', 'regexp', 'digitTimeout']
  .forEach(function(prop) { 
    args.push( opts[prop] ) ; 
  }) ;

  this._conn.execute('play_and_get_digits', args.join(' '), function(evt){
    if('play_and_get_digits' !== evt.getHeader('variable_current_application')) {
      console.log('expected response to play_and_get_digits but got %s', evt.getHeader('variable_current_application')) ;
      return ;
    }
    var result = {
      digits: evt.getHeader('variable_myDigitBuffer'),
      terminatorUsed: evt.getHeader('variable_read_terminator_used'),
      playbackSeconds: evt.getHeader('variable_playback_seconds'),
      playbackMilliseconds: evt.getHeader('variable_playback_ms'),
    } ;
    cb(null, result) ;
  }) ;
} ;

/**
 * Speak a phrase that requires grammar rules
 * @param  {string}   text phrase to speak
 * @param  {object}   opts options
 * @param  {Endpoing~mediaOperationCallback} cb   callback
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


//event handlers
Endpoint.prototype._onError = function(err) {
  if( err.errno && err.errno === 'ECONNRESET' && this.state === State.DISCONNECTED ) {
    debug('ignoring connection reset error during teardown of connection') ;
    return ;
  }
  console.error('Endpoint#_onError: ', err) ;
} ;
Endpoint.prototype._onAnswer = function(cb, evt) {
  this.local.sdp = evt.getHeader('variable_rtp_local_sdp_str') ;
  this.local.mediaIp = evt.getHeader('variable_local_media_ip') ;
  this.local.mediaPort = evt.getHeader('variable_local_media_port') ;

  this.remote.sdp = evt.getHeader('variable_switch_r_sdp') ;
  this.remote.mediaIp = evt.getHeader('variable_remote_media_ip') ;
  this.remote.mediaPort = evt.getHeader('variable_remote_media_port') ;

  this.dtmfType = evt.getHeader('variable_dtmf_type') ;
  this.sip.callId = evt.getHeader('variable_sip_call_id') ;  

  this.state = State.CONNECTED ;

  debug('answer event: ', evt) ;

  cb(null, this) ;
} ;
Endpoint.prototype._onHangup = function(evt) {

  if( State.DISCONNECTED !== this.state ) {
    this._conn.disconnect(); 
  }
  this.state = State.DISCONNECTED ;
  this.emit('hangup', evt) ;
} ;

//representation
Endpoint.prototype.toJSON = function() {
  return( only( this, 'sip local remote')) ;
} ;
Endpoint.prototype.toString = function() {
  return this.toJSON().toString() ;
} ;

delegate(Endpoint.prototype, '_conn')
  .method('connected') 
  .method('api')
  .method('execute') ;