const test = require('tape') ;
const exec = require('child_process').exec ;

const sleepFor = async(ms) => new Promise((resolve, reject) => setTimeout(resolve, ms));

test('starting docker network..', (t) => {
  t.plan(1);
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, async(err, stdout, stderr) => {
    //console.log(stderr);
    console.log('docker network started, giving extra time for freeswitch to initialize...');
    await testFreeswitches(['freeswitch-sut', 'freeswitch-uac'], 35000);
    t.pass('docker is up');
  });
});

const testFreeswitches = async(arr, timeout) => {
  const timer = setTimeout(() => {
    throw new Error('timeout waiting for freeswitches to come up');
  }, timeout);

  do {
    await sleepFor(5000);
    try {
      await Promise.all(arr.map((freeswitch) => testOneFsw(freeswitch)));
      //console.log('successfully connected to freeswitches');
      clearTimeout(timer);
      return;
    } catch (err) {
    }
  } while(true);
};

function testOneFsw(fsw) {
  return new Promise((resolve, reject) => {
    exec(`docker exec ${fsw} fs_cli -x "console loglevel debug"`, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(err);  
    });
  });
}
