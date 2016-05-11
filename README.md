[![drachtio logo](http://davehorton.github.io/drachtio-srf/img/definition-only-cropped.png)](http://davehorton.github.io/drachtio-srf)

Welcome to the drachtio media resource function, empowering nodejs/javascript developers to build rich media application on SIP / VoIP networks.

drachtio is an open-source, nodejs-based ecosystem for creating any kind of VoIP server-based application: registrar, proxy, back-to-back user agent, and many others. Within the drachtio ecosystem, drachtio-fsmrf is a high-level media processing abstraction layer that utilizes [freeswitch](https://freeswitch.org) as a media server, and partners with the [drachtio signaling resource framework](http://davehorton.github.io/drachtio-srf/) to enable the creation of media-processing applications such as conferencing, IVR and others.


*Note:* API documentation for drachtio-fsmrf [can be found here](http://davehorton.github.io/drachtio-fsmrf/api/index.html).

```js
var app = require('drachtio')() ;
var Mrf = require('drachtio-fsmrf') ;
var mrf = new Mrf(app) ;
var Srf = require('drachtio-srf') ;
var srf = new Srf(app) ;
var ms  ;

srf.connect({...}) ;
mrf.connect({...}, function(mediaServer) {ms = mediaServer;}) ;

srf.invite( function(req, res) {
  
  // connect caller to an endpoint on the media server
  ms.connectCaller(req, res, function(err, ep, dialog) {
    if( err ) throw err ;

    // set up dialog handlers
    dialog.on('destroy', onCallerHangup.bind(dialog, ep)) ;

    // play some prompts
    ep.play(['ivr/8000/ivr-please_reenter_your_pin.wav',
      'ivr/8000/ivr-please_state_your_name_and_reason_for_calling.wav',
      'ivr/8000/ivr-you_lose.wav'], function(err, results){
        console.log('results: ', results) ;
      }) ;
  }) ; 
}) ;

function onCallerHangup( ep ) {
  // release endpoint
  ep.destroy() ;
}
```

### Getting Started

*Note:* drachtio-fsmrf applications require a network connection to a [drachtio server](https://github.com/davehorton/drachtio-server) process that sits in the VoIP network and handles the low-level SIP messaging.

*Additionally*, drachtio-fsmrf applications require a freeswitch media server, configured as defined in the [drachtio-fs-ansible](https://github.com/davehorton/drachtio-fs-ansible), which provides an ansible role that can be used build up a freeswitch media server for use with drachtio-fsrmf from a vanilla ubuntu install.

#### Install drachtio-fsmrf

```bash
npm install drachtio-fsmrf --save
```

#### Create an instance of the media resource function
First, create a drachtio "app".  This contains the middleware stack and core message routing functions needed for the core drachtio library that is central to all drachtio applications.  Next, create a new instance of the drachtio media resource function, passing the drachtio app that you just created.

```js
var drachtio = require('drachtio') ;
var app = drachtio();
var Mrf = require('drachtio-fsmrf'); 
var mrf = new Mrf(app) ;
```

#### Create an instance of the signaling resource framework</h4>
In most cases, you will also want to create an instance of the [drachtio signaling resource framework](http://davehorton.github.io/drachtio-srf/) as well, in order to handle the SIP signaling requirements of the application.

```js
var Srf = require('drachtio-srf'); 
var srf = new Srf(app) ;
```

#### Connect to one or more freeswitch media servers
In order to create and manipulate [endpoints](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html), [conferences](http://davehorton.github.io/drachtio-fsmrf/api/Conference.html) and other resources, you must first obtain a reference to an instance of a [MediaServer](http://davehorton.github.io/drachtio-fsmrf/api/MediaServer.html).  This is done by the 'mrf.connect' method:

```js
mrf.connect({
  address: '10.1.0.100',  // IP address freeswitch event socket is listening on
  port: 8021,           // freeswitch event socket listen port
  secret: 'ClueCon',    // freeswitch authentication secret
  listenPort: 8085      // leave at 8085; unless freeswitch dial plan is changed
}, function(ms) {
  console.log('connected to mediaserver: ', JSON.stringify(ms)) ;
});
```

#### Allocate and manipulate resources on a media server
Once you have obtained a reference to a media server, you can obtain access to resources on the media server via any of the following methods:
* [MediaServer#createConference](http://davehorton.github.io/drachtio-fsmrf/api/MediaServer.html#createConference)
* [MediaServer#createEndpoint](http://davehorton.github.io/drachtio-fsmrf/api/MediaServer.html#createEndpoint)
* [MediaServer#connectCaller](http://davehorton.github.io/drachtio-fsmrf/api/MediaServer.html#connectCaller)

You can also send freeswitch api commands directly to the media server by invoking the [MediaServer#api](http://davehorton.github.io/drachtio-fsmrf/api/MediaServer.html#api) method.

Once you are done working with an endpoint, you should call [Endpoint#destroy](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html#destroy) to release it back to the media server.

### IVR Features
Once you have an [endpoint](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html), and a connected SIP [dialog](http://davehorton.github.io/drachtio-srf/api/Dialog.html), you can create IVR interactions by calling methods on the endpoint:

* [Endpoint#play](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html#play) - play one or more audio files
* [Endpoint#playCollect](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html#playCollect) - play an audio file and collect DTMF input from the call
* [Endpoint#say](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html#say) - speak a phrase, using a defined grammar

### Conferencing Features
There are two ways to create a conference:

1. By calling [MediaServer#createConference](http://davehorton.github.io/drachtio-fsmrf/api/MediaServer.html#createConference) which creates a named conference on the media server
1. By allocating an endpoint, and then calling [Endpoint#joinConference](http://davehorton.github.io/drachtio-fsmrf/api/Endpoint.html#joinConference), to which you can either pass a previously allocated conference object, or simply the name of a conference.  In the latter case, a conference is dynamically created on the media server.

### Sample applications
Besides the example applications found in the [examples](https://github.com/davehorton/drachtio-fsmrf/tree/master/examples) folder, the following full-fledged sample applications are available:

* [Two-stage dialing application](https://github.com/davehorton/drachtio-sample-twostage-dialing)

### License
[MIT](https://github.com/davehorton/drachtio-fsmrf/blob/master/LICENSE)
