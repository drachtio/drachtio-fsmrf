const argv = require('minimist')(process.argv.slice(2));
const Srf = require('drachtio-srf');
const Mrf = require('../..');

const optsDrachtio = {
  host: argv['drachtio-address'] || '127.0.0.1',
  port: argv['drachtio-port'] || 9022,
  secret: argv['drachtio-secret'] || 'cymru'
} ;
const optsFreeswitch = {
  address: argv['freeswitch-address'] || '127.0.0.1',
  port: argv['freeswitch-port'] || 8021,
  secret: argv['freeswitch-secret'] || 'ClueCon'
};

const srf = new Srf() ;
srf.connect(optsDrachtio);

srf.on('connect', (err, hostport) => {
  console.log(`successfully connected to drachtio listening on ${hostport}`);
});

const mrf = new Mrf(srf) ;
mrf.connect(optsFreeswitch)
  .then((mediaserver) => {
    console.log('successfully connected to mediaserver');
    return srf.locals.ms = mediaserver;
  })
  .catch ((err) => {
    console.error(`error connecting to mediaserver: ${err}`);
  });
srf.invite((req, res) => {
  const ms = req.app.locals.ms ;
  let ep;
  ms.connectCaller(req, res)
    .then(({endpoint, dialog}) => {
      console.log('successfully connected call');
      dialog.on('destroy', () => { endpoint.destroy(); });
      ep = endpoint ;
      return ep.set('RECORD_STEREO', true);
    })
    .then(() => {
      return ep.recordSession('$${base_dir}/recordings/name_and_reason.wav') ;
    })
    .then((evt) => {
      return ep.play(['silence_stream://1000', 'ivr/8000/ivr-please_state_your_name_and_reason_for_calling.wav']);
    })
    .then((res) => {
      console.log(`finished playing: ${JSON.stringify(res$)}`);
      return ;
    })
    .catch ((err) => {
      console.log(`error connecting call to media server: ${err}`);
    });
}) ;


