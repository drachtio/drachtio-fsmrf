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
  debug('got ready event, media server is connected and ready') ;
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
        debug('sent 200 OK, received ack') ;

        ep.say('1.96', {
          sayType: 'currency',
          sayMethod: 'pronounced'
        }, function( err, results ) {
          debug('say finished with results: ', results) ;
        });
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
