const Srf = require('drachtio-srf') ;
const Mrf = require('../..');
const assert = require('assert');

module.exports = function(opts) {

  const srf = new Srf() ;
  srf.connect(opts.drachtio);

  let ep, ms ;

  srf.startScenario = function() {
    const mrf = new Mrf(srf);

    mrf.connect(opts.freeswitch)
      .then((mediaserver) => {
        ms = mediaserver ;
        return mediaserver.createEndpoint();
      })
      .then((endpoint) => {
        ep = endpoint ;
        return srf.createUAC(opts.uri, {
          localSdp: endpoint.local.sdp
        });
      })
      .catch((err) => {
        assert(`call-generator: error connecting to media server at ${JSON.stringify(opts.freeswitch)}: ${err}`);
      });
  };

  srf.streamTo = function(remoteSdp) {
    return ep.dialog.modify(remoteSdp) ;
  };

  srf.generateSilence = function(duration) {
    return ep.play(`silence_stream://${duration}`)
      .then((evt) => {
        return evt;
      })
      .catch((err) => {
        console.log(`error: ${err}`);
      });
  };

  srf.generateDtmf = function(digits) {
    ep.execute('send_dtmf', `${digits}@125`)
      .then((res) => {
        return;
      })
      .catch((err, res) => {
        console.log(`error generating dtmf: ${JSON.stringify(err)}`);
      });
  };

  var origDisconnect = srf.disconnect.bind(srf) ;
  srf.disconnect = function() {
    ep.destroy() ;
    ms.disconnect() ;
    origDisconnect();
  };

  return srf ;
} ;

