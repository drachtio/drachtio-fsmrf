const test = require('tape') ;
const Srf = require('drachtio-srf') ;
const Mrf = require('..') ;
const config = require('config') ;
const clearRequire = require('clear-module');
const Endpoint = require('../lib/endpoint');
const EP_FILE = '/tmp/endpoint_record.wav';
const EP_FILE2 = '/tmp/endpoint_record2.wav';

// connect the 2 apps to their drachtio servers
const connect = async(agents) => {
  return Promise.all(agents.map((agent) => new Promise((resolve, reject) => {
    agent.once('connect', (err) => {
      if (err) reject(err);
      else resolve();  
    });
  })));
};

// disconnect the 2 apps
function disconnect(agents) {
  agents.forEach((app) => {app.disconnect();}) ;
  clearRequire('./../app');
}


test('MediaServer#connectCaller create active endpoint using Promise', (t) => {
  t.timeoutAfter(6000);

  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let ms, ep, dlg ;

  srf.connect(config.get('drachtio-sut')) ;

  connect([srf, uac])
    .then(() => {
      srf.invite(handler);
      uac.startScenario() ;
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });


  function handler(req, res) {

    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.pass('connected to media server');
        ms = mediaserver ;
        return mediaserver.connectCaller(req, res);
      })
      .then(({endpoint, dialog}) => {
        t.ok(endpoint instanceof Endpoint, 'connected incoming call to endpoint');

        ep = endpoint ;
        dlg = dialog ;
        return uac.streamTo(ep.local.sdp);
      })
      .then(() => {
        t.pass('modified uac to stream to endpoint');
        return ep.getChannelVariables();
      })
      .then((vars) => {
        t.ok(vars.variable_rtp_use_codec_string.split(',').indexOf('PCMU') !== -1, 'PCMU is offered');
        t.ok(vars.variable_rtp_use_codec_string.split(',').indexOf('PCMA') !== -1, 'PCMA is offered');
        t.ok(vars.variable_rtp_use_codec_string.split(',').indexOf('OPUS') !== -1, 'OPUS is offered');

        return ep.play({file:'voicemail/8000/vm-record_message.wav', seekOffset: 8000, timeoutSecs: 2});
      })
      .then((vars) => {
        t.ok(vars.playbackSeconds === "2", 'playbackSeconds is correct');
        t.ok(vars.playbackMilliseconds === "2048", 'playbackMilliseconds is correct');
        t.ok(vars.playbackLastOffsetPos === "104000", 'playbackLastOffsetPos is correct');
        
        return ep.play('silence_stream://200');
      })
      .then(() => {
        t.pass('play a single file');
        return ep.play(['silence_stream://150', 'silence_stream://150']);
      })
      .catch((err) => {
        console.error(err);
        t.fail(err);
      })
      .then(() => {
        t.pass('play an array of files');
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
        return;
      })
      .catch ((err) => {
        t.fail(err);
        if (ep) ep.destroy() ;
        if (dlg) dlg.destroy() ;
        if (ms) ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
      });
  }
});

test('MediaServer#connectCaller create active endpoint using Callback', (t) => {
  t.timeoutAfter(5000);

  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let ms, ep, dlg ;

  srf.connect(config.get('drachtio-sut')) ;

  connect([srf, uac])
    .then(() => {
      srf.invite(handler);
      uac.startScenario() ;
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });

  function handler(req, res) {

    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.pass('connected to media server');
        return ms = mediaserver ;
      })
      .then(() => {
        return ms.connectCaller(req, res);
      })
      .then(({endpoint, dialog}) => {
        ep = endpoint ;
        dlg = dialog ;
        return uac.streamTo(endpoint.local.sdp);
      })
      .then(() => {
        t.pass('modified uac to stream to endpoint');
        return ep.getChannelVariables();
      })
      .then((vars) => {
        t.ok(vars.variable_rtp_use_codec_string.split(',').indexOf('PCMU') !== -1, 'PCMU is offered');
        t.ok(vars.variable_rtp_use_codec_string.split(',').indexOf('PCMA') !== -1, 'PCMA is offered');
        t.ok(vars.variable_rtp_use_codec_string.split(',').indexOf('OPUS') !== -1, 'OPUS is offered');
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
        return;
      })
      .catch((err) => {
        t.fail(err);
      });
  }
});

test('MediaServer#connectCaller add custom event listeners', (t) => {
  t.timeoutAfter(5000);

  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let ms, ep, dlg ;

  srf.connect(config.get('drachtio-sut')) ;

  connect([srf, uac])
    .then(() => {
      srf.invite(handler);
      uac.startScenario() ;
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });

  function handler(req, res) {

    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.pass('connected to media server');
        return ms = mediaserver ;
      })
      .then(() => {
        return ms.connectCaller(req, res);
      })
      .then(({endpoint, dialog}) => {
        ep = endpoint ;
        dlg = dialog ;
        return uac.streamTo(endpoint.local.sdp);
      })
      .then(() => {
        t.pass('modified uac to stream to endpoint');
        t.throws(ep.addCustomEventListener.bind(ep, 'example::event'), 'throws if handler is not present');
        t.throws(ep.addCustomEventListener.bind(ep, 'example::event', 'foobar'), 'throws if handler is not a function');
        t.throws(ep.addCustomEventListener.bind(ep, 'CUSTOM example::event'), 'throws if incorrect form of event name used');
        const listener = (args) => {};
        ep.addCustomEventListener('example::event', (args) => {});
        ep.addCustomEventListener('example::event', listener);
        t.equals(ep._customEvents.length, 1, 'successfully adds custom event listener');
        t.equals(ep.listenerCount('example::event'), 2, 'successfully adds custom event listener');
        ep.removeCustomEventListener('example::event', listener);
        t.equals(ep._customEvents.length, 1, 'successfully removes 1 listener');
        t.equals(ep.listenerCount('example::event'), 1, 'successfully removes 1 listener');
        ep.removeCustomEventListener('example::event');
        t.equals(ep._customEvents.length, 0, 'successfully removes custom event listener');
        return;
      })
      .then(() => {
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
        return;
      })
      .catch((err) => {
        t.fail(err);
      });
  }
});

test('play and collect dtmf', (t) => {
  t.timeoutAfter(10000);

  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let ms, ep, ep2, dlg ;
  const digits = '1';

  srf.connect(config.get('drachtio-sut')) ;

  connect([srf, uac])
    .then(() => {
      srf.invite(handler);
      uac.startScenario() ;
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });

  function handler(req, res) {

    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.pass('connected to media server');
        ms = mediaserver ;
        return mediaserver.connectCaller(req, res);
      })
      .then(({endpoint, dialog}) => {
        t.ok(endpoint instanceof Endpoint, 'connected incoming call to endpoint');
        ep = endpoint ;
        dlg = dialog ;
        return uac.streamTo(ep.local.sdp);
      })
      .then(() => {
        return ep.recordSession(EP_FILE);
      })
      .then((evt) => {
        t.pass('record_session');
        return uac.generateDtmf(digits);
      })
      .then(() => {
        return t.pass(`generating dtmf digits: \'${digits}\'`);
      })
      .then(() => {
        return ep.playCollect({file: 'silence_stream://200', min: 1, max: 4});
      })
      .then((response) => {
        t.ok(response.digits === '1', `detected digits: \'${response.digits}\'`);
        return ;
      })
      .then(() => {
        return ms.createEndpoint({codecs: ['PCMU', 'PCMA', 'OPUS']}) ;
      })
      .then((endpoint) => {
        ep2 = endpoint ;
        t.pass('created second endpoint');
        return ;
      })
      .then(() => {
        return ep.bridge(ep2);
      })
      .then(() => {
        t.pass('bridged endpoint');
        return ep.mute() ;
      })
      .then(() => {
        t.ok(ep.muted, 'muted endpoint');
        return ep.unmute();
      })
      .then(() => {
        t.ok(!ep.muted, 'unmuted endpoint');
        return ep.toggleMute();
      })
      .then(() => {
        t.ok(ep.muted, 'muted endpoint via toggle');
        return ep.toggleMute();
      })
      .then(() => {
        t.ok(!ep.muted, 'unmuted endpoint via toggle');
        return ep.unbridge();
      })
      .then(() => {
        t.pass('unbridged endpoint');
        return ep.set('playback_terminators', '#');
      })
      .then(() => {
        t.pass('set a single value');
        return ep.set({
          'playback_terminators': '*',
          'recording_follow_transfer': true
        });
      })
      .then((evt) => {
        t.pass('set multiple values');
        ep.destroy() ;
        ep2.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
        return ;
      })
      .catch((err) => {
        console.error(err);
        t.fail(err);
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
      });
  }
});

test('record', (t) => {
  t.timeoutAfter(10000);

  if (process.env.CI === 'travis') {
    t.pass('stubbed out for travis');
    t.end();
    return;
  }


  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let ms, ep, dlg ;

  srf.connect(config.get('drachtio-sut')) ;

  connect([srf, uac])
    .then(() => {
      srf.invite(handler);
      uac.startScenario() ;
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });

  function handler(req, res) {

    let promiseRecord;
    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.pass('connected to media server');
        ms = mediaserver ;
        return mediaserver.connectCaller(req, res);
      })
      .then(({endpoint, dialog}) => {
        t.ok(endpoint instanceof Endpoint, 'connected incoming call to endpoint');
        ep = endpoint ;
        dlg = dialog ;
        ep.on('dtmf', (evt) => {
          t.pass(`got dtmf: ${JSON.stringify(evt)}`);
        });
        return uac.streamTo(ep.local.sdp);
      })
      .then(() => {
        return ep.set('playback_terminators', '123456789#*');
      })
      .then(() => {
        ep.play(['silence_stream://1000', 'voicemail/8000/vm-record_message.wav']);
        promiseRecord = ep.record(EP_FILE2, {timeLimitSecs: 3});
        t.pass('started recording');
        return uac.generateSilence(2000);
      })
      .then((evt) => {
        t.pass('generating dtmf #');
        uac.generateDtmf('#');
        return promiseRecord;
      })
      .then((evt) => {
        t.ok(evt.terminatorUsed === '#', `record terminated by # key: ${JSON.stringify(evt)}`);
        return;
      })
      .then(() => {
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
        return ;
      })
      .catch((err) => {
        console.error(err);
        t.fail(err);
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
      });
  }
});

test.skip('fork audio', (t) => {
  t.timeoutAfter(15000);

  if (process.env.CI === 'travis') {
    t.pass('stubbed out for travis');
    t.end();
    return;
  }

  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let ms, ep, dlg ;

  srf.connect(config.get('drachtio-sut')) ;

  connect([srf, uac])
    .then(() => {
      srf.invite(handler);
      uac.startScenario() ;
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });

  function handler(req, res) {

    let promisePlayFile;
    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.pass('connected to media server');
        ms = mediaserver ;
        return mediaserver.connectCaller(req, res, {codecs: 'PCMU'});
      })
      .then(({endpoint, dialog}) => {
        t.ok(endpoint instanceof Endpoint, 'connected incoming call to endpoint');
        ep = endpoint ;
        dlg = dialog ;
        return uac.streamTo(ep.local.sdp);
      })
      .then(() => {
        return ep.forkAudioStart({
          wsUrl: 'ws://ws-server:3001',
          mixType: 'stereo',
          sampling: '16000',
          metadata: {foo: 'bar'},
          bi_audio_sample_rate: 8000
        });
      })
      .then(() => {
        t.pass('started forking audio with metadata');
        return uac.playFile('voicemail/16000/vm-record_message.wav');
      })
      .then((evt) => {
        return ep.forkAudioSendText('simple text');
      })
      .then(() => {
        t.pass('sent text frame ');
        return ep.forkAudioSendText({bar: 'baz'});
      })
      .then(() => {
        t.pass('sent text frame (json) ');
        return ep.forkAudioStop({foo: 'baz'});
      })
      .then(() => {
        t.pass('stopped forking audio with metadata');
        return ep.forkAudioStart({
          wsUrl: 'ws://ws-server:3001',
          mixType: 'stereo',
          sampling: '16000'
        });
      })
      .then(() => {
        t.pass('started forking audio with no metadata');
        return uac.playFile('voicemail/16000/vm-record_message.wav');
      })
      .then((evt) => {
        return ep.forkAudioStop();
      })
      .then(() => {
        t.pass('stopped forking audio with no metadata');
        return ;
      })
      .then(() => {
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
        return ;
      })
      .catch((err) => {
        console.error(err);
        t.fail(err);
        ep.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end() ;
      });
  }
});