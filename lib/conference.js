var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var only = require('only') ;
var _ = require('lodash') ;
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
   * conference state
   * @type {Number}
   */
  this.state = State.NOT_CREATED ;

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
  return( only( this, 'name state uuid memberId confConn endpoint')) ;
} ;
Conference.prototype.toString = function() {
  return this.toJSON().toString() ;
} ;
