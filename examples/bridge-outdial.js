var drachtio = require('drachtio') ;
var app = drachtio() ;
var Srf = require('drachtio-srf') ;
var srf = new Srf(app) ;
var Mrf = require('..') ;
var mrf = new Mrf(app) ;
var async = require('async') ;
var argv = require('minimist')(process.argv.slice(2));

function usage() {
  console.log('usage: node bridge-outdial.js --gateway a.b.c.d --called-number xxxxxxxxx --drachtio-host x.x.x --drachtio-port xxxx --drachtio-secret YzYzYz --mrf-host y.y.y.y --mrf-port zzzzz --mrf-secret ZyZyZy') ;
  console.log('defaults if not provided:') ;
  console.log(' --drachtio-host 127.0.0.1') ;
  console.log(' --drachtio-port 8022') ;
  console.log(' --drachtio-secret cyrmu') ;
  console.log(' --mrf-host 127.0.0.1') ;
  console.log(' --mrf-port 8021') ;
  console.log(' --mrf-secret ClueCon') ;
  console.log(' --called-number the number received on the incoming INVITE') ;
  process.exit(-1) ;

}
var dConfig = {
  host: argv['drachtio-host'] || '127.0.0.1',
  port: argv['drachtio-port'] || 8022,
  secret: argv['drachtio-secret'] || 'cymru' 
} ;

var mConfig = {
  address: argv['mrf-host'] || '127.0.0.1',
  port: argv['mrf-port'] || 8021,
  secret: argv['mrf-secret'] || 'ClueCon'
} ;

var gateway = argv.gateway ;
if( !gateway ) {
  usage() ;
}
var calledNumber = argv['called-number'] ;

app.connect(dConfig) 
.on('error', function(err) {
  console.error(err) ;
  usage() ;
})
.on('connect', function() {
  console.log('successfully connected to drachtio server') ;
}) ;

var ms ;
mrf.connect(mConfig, 
  function(mediaserver) {
    ms = mediaserver ;
    console.log('successfully connected to media server') ;
  }, 
  function(err) {
    console.error('Error connecting to media server: ', err.message ) ;
    usage() ;
  }
) ;  

srf.invite( function( req, res) {

  // step 1:  create two endpoints on the media server and connect them
  async.waterfall([
      createUasFacingEndpoint.bind( this, ms, req.body ), 
      createUacFacingEndpoint, 
      bridgeEndpoints
    ],
    function(err, ms, epUas, epUac) {
      if( err ) {
        console.error('error establishing bridge: ', err) ;
        return res.send(503) ;
      }

      // step 2: create SIP dialog where A and B parties are exchanging media with the respective endpoints
      srf.createBackToBackDialogs( req, res, gateway, {
        localSdpA: epUas.local.sdp,
        localSdpB: epUac.local.sdp, 
        calledNumber: calledNumber || req.calledNumber,
        onProvisional: function( provisionalResponse ) {

          // we got a 183 or the like from callee, so update endpoint on where to stream 
          if( provisionalResponse.body && provisionalResponse.body.length > 0 ) {
            epUac.modify( provisionalResponse.body ) ;
          }
        }
      }, function( err, uasDialog, uacDialog ) {
        if( err ) {
          console.error('error completing call: ', err) ;
          return ;
        }
        console.log('%s: successfully connected call', uasDialog.sip.callId) ;

        // modify B endpoint to stream to callee (if we got a 183, this may have already been done, but no harm)
        epUac.modify( uacDialog.remote.sdp ) ;

        uasDialog.on('destroy', onDestroy.bind( uasDialog, uacDialog, epUas, epUac )) ;
        uacDialog.on('destroy', onDestroy.bind( uacDialog, uasDialog, epUas, epUac )) ;
    }) ;
  }) ;
}) ;

function onDestroy( other, epUas, epUac ) {
  var uas = this ;
  if('uas' === other.type ) { uas = other ; }
  [other, epUac, epUas].forEach( function(e) { e.destroy(); }) ;
}

function createUasFacingEndpoint(ms, callerSdp, callback) {
  ms.createEndpoint({
    codecs: ['PCMU', 'PCMA', 'OPUS'],
    remoteSdp: callerSdp
  }, function( err, ep ) {
    if( err ) {
      console.error('Error creating UAS-facing endpoint: ', err) ;
      return callback(err) ;
    }
    callback(null, ms, ep); 
  }); 
} 

function createUacFacingEndpoint( ms, epUas, callback) {
  ms.createEndpoint({
    codecs: ['PCMU', 'PCMA', 'OPUS']    
  },function( err, ep ) {
    if( err ) {
      console.error('Error creating UAC-facing endpoint: ', err) ;
      return callback(err) ;
    }
    callback(null, ms, epUas, ep); 
  }); 
} 

function bridgeEndpoints(ms, epUas, epUac, callback) {
  epUas.bridge( epUac, function(err) {
    if( err ) {
      console.error('Error bridging endpoints: ', err) ;
      return callback(err) ;
    }
    callback(null, ms, epUas, epUac);         
  }) ;
}
