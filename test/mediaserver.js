const test = require('tape').test ;
const Srf = require('drachtio-srf') ;
const Mrf = require('..') ;
const config = require('config') ;
const clearRequire = require('clear-require');
const async = require('async');
const MediaServer = require('../lib/mediaserver');
const debug = require('debug')('drachtio:fsmrf') ;

// connect the 2 apps to their drachtio servers
function connect(agents) {
  return new Promise((resolve, reject) => {
    async.each(agents, (agent, callback) => {
      agent.once('connect', (err, hostport) => {
        callback(err) ;
      }) ;
    }, (err) => {
      if (err) { return reject(err); }
      resolve() ;
    });
  });
}

// disconnect the 2 apps
function disconnect(agents) {
  agents.forEach((app) => {app.disconnect();}) ;
  clearRequire('./../app');
}

test('Mrf#connect using Promise', (t) => {
  t.timeoutAfter(1000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  connect([srf])
    .then(() => {
      t.ok(mrf.localAddresses.constructor.name === 'Array', 'mrf.localAddresses is an array');

      return mrf.connect(config.get('freeswitch-uac'));
    })
    .then((mediaserver) => {
      t.ok(mediaserver.conn.socket.constructor.name === 'Socket', 'socket connected');
      t.ok(mediaserver.srf instanceof Srf, 'mediaserver.srf is an Srf');
      t.ok(mrf.mediaservers.length === 1, 'mrf.mediaservers is populated');
      t.ok(mediaserver instanceof MediaServer,
        `successfully connected to mediaserver at ${mediaserver.sip.ipv4.udp.address}`);
      t.ok(mediaserver.hasCapability(['ipv4', 'udp']), 'mediaserver has ipv4 udp');
      t.ok(mediaserver.hasCapability(['ipv4', 'dtls']), 'mediaserver has ipv4 dtls');
      t.ok(!mediaserver.hasCapability(['ipv6', 'udp']), 'mediaserver does not have ipv6 udp');
      t.ok(!mediaserver.hasCapability(['ipv6', 'dtls']), 'mediaserver does not have ipv6 dtls');
      mediaserver.disconnect() ;
      t.ok(mediaserver.conn.socket === null, 'Mrf#disconnect closes socket');
      disconnect([srf]);
      t.end() ;
      return;
    })
    .catch((err) => {
      t.fail(err);
    });
}) ;

test('Mrf#connect rejects Promise with error when attempting connection to non-listening port', (t) => {
  t.timeoutAfter(1000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  connect([srf])
    .then(() => {
      return mrf.connect(config.get('freeswitch-uac-fail'));
    })
    .then((mediaserver) => {
      return t.fail('should not have succeeded');
    })
    .catch((err) => {
      t.ok(err.code === 'ECONNREFUSED', 'Promise rejects with connection refused error');
      disconnect([srf]);
      t.end() ;
    });
}) ;

test('Mrf#connect using callback', (t) => {
  t.timeoutAfter(1000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  connect([srf])
    .then(() => {
      t.ok(mrf.localAddresses.constructor.name === 'Array', 'mrf.localAddresses is an array');

      return mrf.connect(config.get('freeswitch-uac'), (err, mediaserver) => {
        if (err) return t.fail(err);

        t.ok(mediaserver.conn.socket.constructor.name === 'Socket', 'socket connected');
        t.ok(mediaserver.srf instanceof Srf, 'mediaserver.srf is an Srf');
        t.ok(mrf.mediaservers.length === 1, 'mrf.mediaservers is populated');
        t.ok(mediaserver instanceof MediaServer,
          `successfully connected to mediaserver at ${mediaserver.sip.ipv4.udp.address}`);
        t.ok(mediaserver.hasCapability(['ipv4', 'udp']), 'mediaserver has ipv4 udp');
        t.ok(mediaserver.hasCapability(['ipv4', 'dtls']), 'mediaserver has ipv4 dtls');
        t.ok(!mediaserver.hasCapability(['ipv6', 'udp']), 'mediaserver does not have ipv6 udp');
        t.ok(!mediaserver.hasCapability(['ipv6', 'dtls']), 'mediaserver does not have ipv6 dtls');
        disconnect([srf]);
        mediaserver.disconnect() ;
        t.ok(mediaserver.conn.socket === null, 'Mrf#disconnect closes socket');
        t.end() ;
      });
    })
    .catch((err) => {
      t.fail(err);
    });
}) ;
/*
test('Mrf#connect callback returns error when attempting connection to non-listening port', (t) => {
  t.timeoutAfter(1000);

  const srf = new Srf();
  srf.connect(config.get('drachtio-uac')) ;
  const mrf = new Mrf(srf) ;

  connect([srf])
    .then(() => {
      return mrf.connect(config.get('freeswitch-uac-fail'), (err) => {
        t.ok(err.code === 'ECONNREFUSED', 'callback with err connection refused');
        disconnect([srf]);
        t.end();
      }) ;
    })
    .catch((err) => {
      t.fail(err);
    });
}) ;
*/