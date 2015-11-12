var drachtio = require('drachtio') ;
var app = drachtio() ;
var Mrf = require('..') ;
var mrf = new Mrf(app) ;
var debug = require('debug')('drachtio-fsmrf') ;

app.connect({
  host: 'localhost',
  port: 8022,
  secret: 'cymru',
}) ;


function onEndpointDeleted( /* ep, evt */) {
  debug('received hangup from far end') ;
}

function start( ms ) {
  var ep ;

  app.invite( function(req,res) {

    ms.createEndpoint({
      remoteSdp: req.body,
      codecs: ['PCMU','G722','PCMA']
    }, function(err, endpoint) {
      if( err ) { throw err ; }
      ep = endpoint ;

      ep.on('hangup', onEndpointDeleted.bind(this, ep) ) ;

      res.send(200, {
        body: ep.local.sdp
      }, function() {

        ep.playCollect({
          file: 'ivr/8000/ivr-please_reenter_your_pin.wav',
          min: 1,
          max: 8,
          tries: 2,
          timeout: 5000,
          digitTimeout: 2000,
          terminators: '#'
        }, function(err, results){
          if( err ) { throw( err ) ; }

          debug('playCollect finished: ', results) ;

          if( !results.digits ) {
            ep.play('ivr/8000/ivr-has_left_the_building.wav', function() {
              ep.destroy() ;
            }) ;
          }
        }) ;
      }) ;
    }) ;
  }) ;

  app.bye( function(req, res) {
    res.send(200) ;
    if( !!ep && ep.connected()) { ep.destroy() ; }
  }) ;
}


mrf.connect({
  address: '127.0.0.1',
  port: 8021,
  secret: 'ClueCon',
  listenPort: 8085
}, function(ms) {
  console.log('successfully connected to media server: ') ;
  ms.once('ready', start.bind(null, ms) ) ;
}) ;
