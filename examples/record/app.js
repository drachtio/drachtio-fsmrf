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
  let ep, dlg;
  ms.connectCaller(req, res)
    .then(({endpoint, dialog}) => {
      console.log('successfully connected call');
      ep = endpoint ;
      dlg = dialog ;
      dlg.on('destroy', () => { if (ep) ep.destroy(); });
      return ep.set('playback_terminators', '123456789#*');
    })
    .then(() => {
      ep.play(['silence_stream://1000', 'voicemail/8000/vm-record_message.wav']);
      return ep.record('$${base_dir}/recordings/record_message.wav', {
        timeLimitSecs: 20
      }) ;
    })
    .then((evt) => {
      console.log(`record returned ${JSON.stringify(evt)}`);
      return ep.play(['ivr/8000/ivr-thank_you.wav']);
    })
    .then(() => {
      return Promise.all([ep.destroy(), dlg.destroy()]);
    })
    .then(() => {
      ep = null ;
      dlg = null ;
      return console.log('call completed');
    })
    .catch ((err) => {
      console.log(`error connecting call to media server: ${err}`);
    });
}) ;


