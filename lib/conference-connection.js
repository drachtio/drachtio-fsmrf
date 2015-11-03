var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var assert = require('assert') ;
var only = require('only') ;
var _ = require('lodash') ;
var noop = require('node-noop').noop;
var debug = require('debug')('drachtio-fsmrf') ;

/**
 * a connection between an Endpoint and a Conference
 * @constructor
 * @param {Endpoint} endpoint - endpoint that is connected to the conference
 * @param {string} confName - name of the conference
 * @param {ConferenceConnection~createOptions} opts - configuration options
 */
function ConferenceConnection( endpoint, confName, opts) {
  Emitter.call(this); 

  this._endpoint = endpoint ;

  /**
   * name of the associated conference
   * @type {string}
   */
  this.confName = confName ;
  this.createArgs = opts ;

  endpoint.conn.on('esl::event::CUSTOM::*', this._onConferenceEvent.bind(this)) ;

  Object.defineProperty(this, 'endpointUuid', {
    get: function() {
      return this._endpoint.uuid; 
    }
  }) ;
}
/**
 * Options governing the creation of a ConferenceCreation
 * @typedef {Object} ConferenceConnection~createOptions
 * 
 */

util.inherits(ConferenceConnection, Emitter) ;

module.exports = exports = ConferenceConnection ;

// media operations
/**
 * mute the member
 * @param  {ConferenceConnection~mediaOperationCallback} [cb] - callback invoked when operation completes
 */
ConferenceConnection.prototype.mute = function( cb ) {
  cb = cb || noop ;
  this._endpoint.api('conference', this.confName + ' mute ' + this.memberId, cb ) ;
} ;
/**
 * This callback is invoked whenever any media command has completed
 * @callback ConferenceConnection~mediaOperationCallback
 * @param {Object} response - response to the command
 */

/**
 * deaf the member
 * @param  {ConferenceConnection~mediaOperationCallback} [cb] - callback invoked when operation completes
 */
ConferenceConnection.prototype.deaf = function( cb ) {
  cb = cb || noop ;
  this._endpoint.api('conference', this.confName + ' deaf ' + this.memberId, cb ) ;
} ;
/**
 * kick the member out of the conference
 * @param  {ConferenceConnection~mediaOperationCallback} [cb] - callback invoked when operation completes
 */
ConferenceConnection.prototype.kick = function( cb ) {
  cb = cb || noop ;
  this._endpoint.api('conference', this.confName + ' kick ' + this.memberId, cb ) ;
} ;
/**
 * play a file to the member
 * @param string file - file to play
 * @param {ConferenceConnection~playOptions} [opts] - play options
 * @param  {ConferenceConnection~mediaOperationCallback} [cb] - callback invoked when operation completes
 */
ConferenceConnection.prototype.play = function( file, opts, cb ) {
  assert.equals( typeof file === 'string', '\'file\' is required and must be a file to play') ;

  if( typeof opts === 'function') {
    cb = opts ;
    opts = {} ;
  }
  var args = [] ;
  if( opts.vol ) {
    args.push('vol=' + opts.volume) ;
  }
  if( opts.fullScreen ) {
    args.push( 'full-screen=' + opts.fullScreen ) ;
  }
  if( opts.pngMs ) {
    args.push( 'png_ms=' + opts.pngMs) ;
  }
  this._endpoint.api('conference', this.confName + ' play ' + (args.length ? args.join(',') + ' ' : '') + this.memberId, cb ) ;
} ;
/**
 * Options governing a play command
 * @typedef {Object} ConferenceConnection~mediaOperationCallback
 * @property {number} [volume] - volume at which to play the file
 * @property {string} [fullScreen] - play the video in full screen mode in the conference
 * @property {string} [pngMs] - Specify a PNG file to play and how many milliseconds, -1 for indefinite
 */

/**
 * transfer a member to a new conference
 * @param  {String}   newConf - name of new conference to transfer to
 * @param  {ConferenceConnection~mediaOperationsCallback} [cb] - callback invoked when transfer has completed 
 */
ConferenceConnection.prototype.transfer = function( newConf, cb ) {
  assert.equals(typeof newConf === 'string', '\'newConf\' is required and is the name of the conference to transfer to') ;

  cb = cb || noop ;
  this._endpoint.api('conference', this.confName + ' transfer ' + newConf + ' ' + this.memberId, cb ) ;
} ;


//handlers
ConferenceConnection.prototype.onAddMember = function( evt ) {
  if( !this.memberId ) {
    this.memberId = evt.getHeader('Member-ID') ;
    debug('ConferenceConnection#onAddMember: ', JSON.stringify(this)) ;
  }
} ;

function unhandled(evt) {
  debug('ConferenceConnection#_onConferenceEvent: unhandled event with action: %s', evt.getHeader('Action')) ;
}

ConferenceConnection.prototype._onConferenceEvent = function( evt ) {
  var eventName = evt.getHeader('Event-Subclass') ;
  if( eventName === 'conference::maintenance') {
    var action = evt.getHeader('Action') ;
    debug('ConferenceConnection#_onConferenceEvent: conference event action: %s ', action) ;

    //invoke a handler for this action, if we have defined one
    (ConferenceConnection.prototype['on' + _.capitalize(_.camelCase(action))] || unhandled).bind( this, evt )() ;

  }
  else {
    debug('ConferenceConnection#_onConferenceEvent: got unhandled custom event: ', eventName ) ;
  }
}; 

// representation
ConferenceConnection.prototype.toJSON = function() {
  return( only( this, 'confName createArgs endpointUuid memberId')) ;
} ;
ConferenceConnection.prototype.toString = function() {
  return this.toJSON().toString() ;
} ;
