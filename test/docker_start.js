const test = require('blue-tape').test ;
const exec = require('child_process').exec ;
const async = require('async');

test('starting docker network..', (t) => {
  t.plan(1);
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    if (-1 != stderr.indexOf('is up-to-date')) {
      return t.end() ;
    }
    console.log('docker network started, giving extra time for freeswitch to initialize...');
    testFreeswitches(['freeswitch-sut', 'freeswitch-uac'], 35000, (err) => {
      if (err) {
        exec(`docker logs freeswitch-sut`, (err, stdout, stderr) => {
          console.log(stdout);
          console.log(stderr);
          t.end(err);
        });
      }
      else t.pass('docker is up');
    });
  });
});

function testFreeswitches(arr, timeout, callback) {
  let timeup = false;
  const timer = setTimeout(() => {
    timeup = true;
  }, timeout);

  async.whilst(
    () => !timeup && arr.length,
    (callback) => setTimeout(() => async.each(arr, testOneFsw.bind(null, arr), () => callback()), 1000),
    () => {
      if (arr.length > 0) {
        clearTimeout(timer);
        return callback(new Error('some freeswitches did not initialize'));
      }
      callback(null);
    }
  );
}

function testOneFsw(arr, fsw, callback) {
  exec(`docker exec ${fsw} fs_cli -x "console loglevel debug"`, (err, stdout, stderr) => {
    if (!err) {
      console.log(`freeswitch ${fsw} is ready`);
      const idx = arr.indexOf(fsw);
      arr.splice(idx, 1);
    }
    callback(null);
  });
}
