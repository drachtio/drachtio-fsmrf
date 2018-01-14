const test = require('tape').test ;
const exec = require('child_process').exec ;

test('starting docker network..', (t) => {
  t.timeoutAfter(180000);
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    if (-1 != stderr.indexOf('is up-to-date')) return t.end() ;
    console.log('docker network started, giving extra time for freeswitch to initialize...');
    setTimeout(() => {
      exec('docker exec test_freeswitch-sut_1 fs_cli -x "console loglevel debug"', (err, stdout, stderr) => {
        t.end(err) ;
      });
    }, 18000);
  });
});

