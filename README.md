# drachtio-fsmrf [![Build Status](https://secure.travis-ci.org/davehorton/drachtio-fsmrf.png)](http://travis-ci.org/davehorton/drachtio-fsmrf) [![NPM version](https://badge.fury.io/js/drachtio-fsmrf.svg)](http://badge.fury.io/js/drachtio-fsmrf)

[![drachtio logo](http://davehorton.github.io/drachtio-srf/img/definition-only-cropped.png)](http://davehorton.github.io/drachtio-srf)

Welcome to the Drachtio Media Resource framework, a partner module to [drachtio-srf](http://davehorton.github.io/drachtio-srf) for building high-performance [SIP](https://www.ietf.org/rfc/rfc3261.txt) server applications in pure javascript.

drachtio-fsmrf implements common media server functions on top of Freeswitch and enables rich media applications involving IVR, conferencing and other features to be built in pure javascript without requiring in-depth knowledge of freeswitch configuration.

**Note**, drachtio-fsmrf applications require a freeswitch media server, configured as per [drachtio/drachtio-freeswitch-mrf](https://cloud.docker.com/swarm/drachtio/repository/docker/drachtio/drachtio-freeswitch-mrf/general).  To build your own properly-configured Freeswitch to use with this module, either review that Dockerfile or have a look at [drachtio-mrf-ansible](https://github.com/davehorton/drachtio-mrf-ansible)

[API documentation for drachtio-fsmrf can be found here](http://davehorton.github.io/drachtio-fsmrf/api/index.html).

# Data Model
This module exports a single class, **Mrf** (aka Media Resource Framework).  

Invoking the constructor creates an instance of the Mrf class that can then be used to connect to **Mediaservers**; once connected to a Mediaserver you can create and manipulate instances of **Endpoints** and **Conferences**.

That's it -- those are all the classes you need to work with. You can connect calls to a Mediaserver, producing an Endpoint.  You can then perform operations like *play*, *say*, *bridge*, *park* etc on the Endpoint (which equates to a Freeswitch channel).  You can create Conferences, join Endpoints into Conferences, and perform operations on the Conference.  And you can call any of the myriad freeswitch applications or api methods via the Endpoint and Conference classes.

Let's dive in.

# Getting Started
First, create an instance of both the drachtio signaling resource framework and the media resource framework, as per below.

```js
const Srf = require('drachtio-srf');
const Mrf = require('drachtio-fsmrf');

const srf = new Srf() ;
srf.connect(host: '127.0.0.1');

srf.on('connect', (err, hostport) => {
  console.log(`successfully connected to drachtio listening on ${hostport}`);
});

const mrf = new Mrf(srf) ;
```
At that point, the mrf instance can be used to connect to and produce instances of MediaServers
```js
mrf.connect({address: '127.0.0.1', port: 8021, secret: 'ClueCon'})
  .then((mediaserver) => {
    console.log('successfully connected to mediaserver');
  })
  .catch ((err) => {
    console.error(`error connecting to mediaserver: ${err}`);
  });
```
In the example above, we see the `mrf#connect` method returns a Promise that resolves with an instance of the media server.  As with all public methods, a callback variant is available as well:
```js
// we're connecting to the Freeswitch event socket
mrf.connect({address: '127.0.0.1', port: 8021, secret: 'ClueCon'}, (err, mediaserver) => {
    if (err) {
      return console.log(`error connecting to mediaserver: ${err}`);
    }
    console.log(`connected to mediaserver listening on ${JSON.stringify(ms.sip)}`);
    /*
      {
        "ipv4": {
          "udp": {
            "address":"172.28.0.11:5060"
          },
          "dtls": {
            "address":"172.28.0.11:5081"
          }
        },
        "ipv6":{
          "udp":{},
          "dtls":{}
        }
      }
    */
  }
});
```
Having a media server instance, we can now create instances of Endpoints and Conferences and invoke operations on those objects.

# Performing Media Operations

We can create an Endpoint when we have an incoming call, by connecting it to a Mediaserver.
```js
srf.invite((req, res) => {
  mediaserver.connectCaller(req, res)
    .then(({endpoint, dialog}) => {
      console.log('successfully connected call to media server');

```
In the example above, we use `MediaServer#connectCaller()` to connect a call to a Mediaserver, producing both an Endpoint (represening the channel on Freeswitch) and a Dialog (representing the UAS dialog).

Again, note that a callback version is also available:
```js
srf.invite((req, res) => {   
  mediaserver.connectCaller(req, res, (err, {endpoint, dialog} => {
    if (err) return console.log(`Error connecting ${err}`);
    console.log('successfully connected call to media server');
  });

```
We can also create an Endpoint outside of any inbound call by calling `MediaServer#createEndpoint()`.  This will give us an initially inactive Endpoint that we can later modify to stream to a remote destination:
```js
mediaserver.createEndpoint()
  .then((endpoint) => {

    // some time later...
    endpoint.modify(remoteSdp);

  });

```
Once we have an Endpoint, we can do things like play a prompt and collect dtmf:
```js
endpoint.playCollect({file: myFile, min: 1, max: 4})
  .then((obj) => {
    console.log(`collected digits: ${obj.digits}`);
  });
```
Conferences work similarly - we create them and then can join Endpoints to them.
```js
mediaserver.createConference('my_conf', {maxMembers: 50})
  .then((conference) => {
    return endpoint.join(conference)
  })
  .then(() => {
    console.log('endpoint joined to conference')
  });
```
When an Endpoint is joined to a Conference, we have an additional set of operations we can invoke on the Endpoint -- things like mute/unmute, turn on or off automatic gain control, playing a file directly to the participant on that Endpoint, etc.  These actions are performed by methods that all begin with *conf*:
```js
endpoint.join(conference, (err) => {
  if (err) return console.log(`Error ${err}`);

  endpoint.confMute();
  endpoint.confPlay(myFile);
}
```

# Execute any Freeswitch application or api
As shown above, some methods have been added to the `Endpoint` and `Conference` class to provide syntactic sugar over freeswitch aplications and apis.  However, any Freeswitch application or api can also be called directly.

`Endpoint#execute` executes a Freeswitch application and returns in either the callback or the Prompise the contents of the associated CHANNEL_EXECUTE_COMPLETE event that Freeswitch returns. The event structure [is defined here](https://github.com/englercj/node-esl/blob/master/lib/esl/Event.js):

```js
// generate dtmf from an Endpoint
endpoint.execute('send_dtmf', `${digits}@125`, (err, evt) => {
  if (err) return console.error(err);

  console.log(`last dtmf duration was ${evt.getHeader('variable_last_dtmf_duration')}`);
})
```
`Endpoint#api` executes a Freeswitch api call and returns in either the callback or the Promise the response that Freeswitch returns to the command.  
```js
endpoint.api('uuid_dump', endpoint.uuid)
  .then((response) => {
    console.log(`${JSON.stringify(response)}`);
    //
    //    {
    //  "headers": [{
    //    "name": "Content-Type",
    //    "value": "api/response"
    //  }, {
    //    "name": "Content-Length",
    //    "value": 8475
    //  }],
    //  "hPtr": null,
    //  "body": "Event-Name: CHANNEL_DATA\n..

  });
```
Note that Content-Type api/response returned by api requests return a body consisting of plain text separated by newlines. To parse this body into a plain javascript object with named properties, use the `Mrf#utils#parseBodyText` method, as per below:
```js
endpoint.api('uuid_dump', endpoint.uuid)
  .then((evt) => {
    const vars = Mrf.utils.parseBodyText(evt.getBody());
    console.log(`${JSON.stringify(vars)}`);
    //   {
    //    "Event-Name": "CHANNEL_DATA",
    //    "Core-UUID": "de006bc8-f892-11e7-a989-3b397b4b8083",
    //     ...
    //   }
  });
```
# Tests
To run tests you will need Docker and docker-compose installed on your host, as the test suite runs in a docker network created by [docker-compose-testbed.yaml](test/docker-compose-testbed.yaml).  The first time you run the tests, it will take a while since docker images will be downloaded to your host.
```js
$ npm test

  starting docker network..

    docker network started, giving extra time for freeswitch to initialize...

  Mrf#connect using Promise

    ✔ mrf.localAddresses is an array
    ✔ socket connected
    ✔ mediaserver.srf is an Srf

    ...etc...
```
# License
[MIT](https://github.com/davehorton/drachtio-fsmrf/blob/master/LICENSE)
