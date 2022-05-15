const test = require('tape') ;
const Srf = require('drachtio-srf') ;
const Mrf = require('..') ;
const config = require('config') ;
const clearRequire = require('clear-module');
const MediaServer = require('../lib/mediaserver');
const Conference = require('../lib/conference');
const Endpoint = require('../lib/endpoint');
const CONF_NAME = 'test';
const CONF_NAME2 = 'test2';
const CONF_RECORD_FILE = 'conf-test-recording.wav';

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

test('MediaServer#createConference without specifying a name', (t) => {
  t.timeoutAfter(5000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  let mediaserver ;

  return connect([srf])
    .then(() => {
      return mrf.connect(config.get('freeswitch-uac'));
    })
    .then((ms) => {
      t.pass('connected to media server')
      mediaserver = ms ;
      return mediaserver.createConference();
    })
    .then((conference) => {
      t.ok(conference instanceof Conference, `successfully created conference '${conference.name}'`);
      return conference.destroy() ;
    })
    .then(() => {
      t.pass('conference destroyed');
      mediaserver.disconnect() ;
      disconnect([srf]);
      return;
    })
    .catch((err) => {
      t.fail(err);
    });
}) ;

test('MediaServer#createConference using Promises', (t) => {
  t.timeoutAfter(5000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  let mediaserver ;

  return connect([srf])
    .then(() => {
      return mrf.connect(config.get('freeswitch-uac'));
    })
    .then((ms) => {
      mediaserver = ms ;
      return mediaserver.createConference(CONF_NAME, {maxMembers:5});
    })
    .then((conference) => {
      t.ok(conference instanceof Conference, `successfully created conference '${CONF_NAME}'`);
      return conference.destroy() ;
    })
    .then(() => {
      t.pass('conference destroyed');
      mediaserver.disconnect() ;
      disconnect([srf]);
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });
}) ;

test('MediaServer#createConference using Callback', (t) => {
  t.timeoutAfter(5000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  let mediaserver ;

  return connect([srf])
    .then(() => {
      return mrf.connect(config.get('freeswitch-uac'));
    })
    .then((ms) => {
      mediaserver = ms ;
      return mediaserver.createConference(CONF_NAME);
    })
    .then((conference) => {
      t.ok(conference instanceof Conference, `successfully created conference '${CONF_NAME}'`);
      return conference.destroy();
    })
    .then(() => {
      t.pass('conference destroyed');
      mediaserver.disconnect() ;
      disconnect([srf]);
      return ;
    })
    .catch((err) => {
      t.fail(err);
    });
}) ;

test('Connect incoming call into a conference', (t) => {
  t.timeoutAfter(25000);

  const uac = require('./scripts/call-generator')(config.get('call-generator')) ;
  const srf = new Srf();
  const mrf = new Mrf(srf) ;
  let dlg, ms, ep, conf, conf2 ;

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
    let conf;
    mrf.connect(config.get('freeswitch-sut'))
      .then((mediaserver) => {
        t.ok(mediaserver instanceof MediaServer, 'contacted mediaserver');
        ms = mediaserver ;
        return mediaserver.connectCaller(req, res);
      })
      .then(({endpoint, dialog}) => {
        ep = endpoint ;
        dlg = dialog ;
        t.ok(ep instanceof Endpoint, 'connected incoming call to mediaserver');
        return uac.streamTo(ep.local.sdp) ;
      })
      .then(() => {
        return ms.createConference(CONF_NAME, {maxMembers: 54});
      })
      .then((conference) => {
        conf = conference;
        conf.set('max_members', 100);
        return conf;
      })
      .then((conf) => {
        t.pass('set max members to 100');
        return conf.get('max_members');
      })
      .then((max) => {
        t.ok(max === 100, 'verified max members is 100');
        return conf.startRecording(CONF_RECORD_FILE);
      })
      .then(() => {
        t.pass('started recording');
        return ep.join(conf);
      })
      .then(({memberId, confUuid}) => {
        t.ok(typeof memberId === 'number', `connected endpoint to conference with memberId ${memberId}`);
        return conf.getSize() ;
      })
      .then((count) => {
        t.ok(count === 2, 'getSize() returns 2 total legs');
        return ep.unjoin() ;
      })
      .then(() => {
        t.pass('removed endpoint from conference');
        return ep.join(conf) ;
      })
      .then(({memberId, confUuid}) => {
        t.ok(typeof memberId === 'number', `added endpoint back to conference with memberId ${memberId}`);
        return conf.agc('on');
      })
      .then(() => {
        t.pass('agc on');
        return conf.agc('off');
      })
      .then(() => {
        t.pass('agc off');
        return ep.confMute();
      })
      .then(() => {
        t.pass('endpoint muted');
        return ep.confUnmute();
      })
      .then(() => {
        t.pass('endpoint unmuted');
        return ep.confPlay('silence_stream://100');
      })
      .then(() => {
        t.pass('played file to member');
        return conf.pauseRecording(CONF_RECORD_FILE) ;
      })
      .then((evt) => {
        t.pass('paused recording');
        return conf.resumeRecording(CONF_RECORD_FILE);
      })
      .then((evt) => {
        t.pass('resumed recording');
        return ep.confDeaf();
      })
      .then(() => {
        t.pass('endpoint deafed');
        return ep.confUndeaf();
      })
      .then(() => {
        t.pass('endpoint undeafed');
        return conf.lock();
      })
      .then(() => {
        t.pass('locked conference');
        return conf.unlock();
      })
      .then(() => {
        t.pass('unlocked conference');
        return conf.mute('all');
      })
      .then(() => {
        t.pass('mute conference');
        return conf.unmute('all');
      })
      .then(() => {
        t.pass('unmute conference');
        return conf.deaf('all');
      })
      .then(() => {
        t.pass('deaf conference');
        return conf.undeaf('all');
      })
      .then(() => {
        t.pass('undeaf conference');
        return ms.createConference(CONF_NAME2);
      })
      .then((conference) => {
        t.ok(conference instanceof Conference, 'created second conference');
        conf2 = conference ;
        return ;
      })
      .then(() => {
        return ep.transfer(conf2);
      })
      .then(() => {
        t.pass('endpoint transfered to second conference');
        return conf.stopRecording(CONF_RECORD_FILE);
      })
      .then(() => {
        t.pass('stopped recording');
        return ep.confHup();
      })
      .then((evt) => {
        t.pass('endpoint huped');
        conf2.destroy() ;
        return conf.destroy() ;
      })
      .then(() => {
        t.pass('conference destroyed');
        return ep.destroy() ;
      })
      .then(() => {
        t.pass('endpoint destroyed');
        ms.disconnect() ;
        disconnect([srf, uac]);
        t.end();
        return;
      })
      .catch((err) => {
        console.error(`error ${err}`);
        t.fail(err);
        ep.destroy() ;
        conf.destroy() ;
        dlg.destroy() ;
        ms.disconnect() ;
        disconnect([srf, uac]);
      });
  }
});
