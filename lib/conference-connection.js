var Emitter = require('events').EventEmitter ;
var util = require('util') ;
var only = require('only') ;
var _ = require('lodash') ;
var debug = require('debug')('drachtio-fsmrf') ;

function ConferenceConnection( endpoint, confName, opts) {
  Emitter.call(this); 

  this._endpoint = endpoint ;
  this.confName = confName ;
  this.createArgs = opts ;

  endpoint.conn.on('esl::event::CUSTOM::*', this._onConferenceEvent.bind(this)) ;

  Object.defineProperty(this, 'endpointUuid', {
    get: function() {
      return this._endpoint.uuid; 
    }
  }) ;
}
util.inherits(ConferenceConnection, Emitter) ;

module.exports = exports = ConferenceConnection ;

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
