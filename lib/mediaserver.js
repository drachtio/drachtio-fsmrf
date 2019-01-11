const esl = require('modesl') ;
const assert = require('assert') ;
const delegate = require('delegates') ;
const Emitter = require('events').EventEmitter ;
const _ = require('lodash') ;
const only = require('only') ;
const async = require('async') ;
const generateUuid = require('uuid') ;
const Endpoint = require('./endpoint') ;
const Conference = require('./conference');
const fs = require('fs') ;
const path = require('path') ;
const net = require('net') ;
const moment = require('moment') ;
const debug = require('debug')('drachtio:fsmrf') ;

function wrapConnectionForTracing(ms, conn, tag) {
  const origSend = conn.send ;
  conn.send = (command, args) => {
    let trace = command + '\n' ;
    if (args) {
      Object.keys(args).forEach(function(key) {
        trace += (key + ': ' + args[key] + '\n');
      });
      trace += '\n';
    }
    ms._onRawSend(tag, trace) ;
    return origSend.call(conn, command, args) ;
  } ;
}


/**
 * A freeswitch-based media-processing resource that contains Endpoints and Conferences.
 * @constructor
 * @param {esl.Connection} conn   inbound connection to freeswitch event socket
 * @param {Mrf} mrf               media resource function that instantiated this MediaServer
 * @param {object} app            drachtio app
 * @param {number} listenPort     tcp port to listen on for outbound event socket connections
 *
 * @fires MediaServer#connect
 * @fires MediaServer#ready
 * @fires MediaServer#error
 */

class MediaServer extends Emitter {
  constructor(conn, mrf, listenAddress, listenPort) {
    super() ;

    this._conn = conn ;
    this._mrf = mrf ;
    this._srf = mrf.srf ;
    this.pendingConnections = new Map() ;

    /**
     * maximum number of active Endpoints allowed on the MediaServer
     * @type {Number}
     */
    this.maxSessions = 0 ;
    /**
     * current number of active Endpoints on the MediaServer
     * @type {Number}
     */
    this.currentSessions = 0 ;
    /**
     * current calls per second on the MediaServer
     * @type {Number}
     */
    this.cps = 0 ;

    /**
     * sip addresses and ports that the mediaserver is listening on
     * note that different addresses may be used for ipv4, ipv6, dtls, or udp connections
     * @type {Object}
     */
    this.sip = {
      ipv4: {
        udp: {},
        dtls: {}
      },
      ipv6: {
        udp: {},
        dtls: {}
      }
    } ;

    if (mrf.debugDir) {
      // trace all messages to a log file
      const tag = 'mediaserver-' + conn.socket.address().address + '.txt' ;
      this.logger = fs.createWriteStream(path.join(mrf.debugDir, tag)) ;
      conn.on('esl::event::**', this._onRawRecv.bind(this, tag)) ;
      wrapConnectionForTracing(this, conn, tag) ;
    }

    this._conn.subscribe(['HEARTBEAT']) ;
    this._conn.on('esl::event::HEARTBEAT::*', this._onHeartbeat.bind(this)) ;
    this._conn.on('error', this._onError.bind(this));
    this._conn.on('esl::end', () => {
      if (!this.closing) console.error(`Mediaserver: lost connection to freeswitch at ${this.address}, attempting to reconnect..`);
    });
    this._conn.on('esl::ready', () => {
      console.info(`Mediaserver: connected to freeswitch at ${this.address}`);
    });

    //create the server (outbound connections)
    const server =  net.createServer() ;
    server.listen(listenPort, listenAddress, () => {
      this.listenAddress = server.address().address;
      this.listenPort = server.address().port ;
      this._server = new esl.Server({server: server, myevents:false}, () => {
        this.emit('connect') ;

        // exec 'sofia status' on the freeswitch server to find out
        // configuration information, including the sip address and port the media server is listening on
        this._conn.api('sofia status', (res) => {
          const status = res.getBody() ;
          let re = /^\s*drachtio_mrf\s.*sip:mod_sofia@((?:[0-9]{1,3}\.){3}[0-9]{1,3}:\d+)/m ;
          let results = re.exec(status) ;
          if (null === results) throw new Error(`No drachtio_mrf sip profile found on the media server: ${status}`);
          if (results) {
            this.sip.ipv4.udp.address = results[1] ;
          }

          // see if we have a TLS endpoint (Note: it needs to come after the RTP one in the sofia status output)
          re = /^\s*drachtio_mrf\s.*sip:mod_sofia@((?:[0-9]{1,3}\.){3}[0-9]{1,3}:\d+).*\(TLS\)/m ;
          results = re.exec(status) ;
          if (results) {
            this.sip.ipv4.dtls.address = results[1] ;
          }

          // see if we have an ipv6 endpoint
          re = /^\s*drachtio_mrf.*sip:mod_sofia@(\[[0-9a-f:]+\]:\d+)/m ;
          results = re.exec(status) ;
          if (results) {
            this.sip.ipv6.udp.address = results[1] ;
          }

          // see if we have an ipv6 TLS endpoint
          re = /^\s*drachtio_mrf.*sip:mod_sofia@(\[[0-9a-f:]+\]:\d+).*\(TLS\)/m ;
          results = re.exec(status);
          if (results) {
            this.sip.ipv6.dtls.address = results[1] ;
          }
          debug('media server signaling addresses: %s', JSON.stringify(this.sip));

          this.emit('ready') ;
        });
      });

      this._server.on('connection::ready', this._onNewCall.bind(this)) ;
    }) ;
  }

  get address() {
    return this.conn.socket && this.conn.socket.remoteAddress ;
  }

  get conn() {
    return this._conn ;
  }

  get srf() {
    return this._srf;
  }

  /**
   * disconnect from the media server
   */
  disconnect() {
    this.closing = true;
    this._server.close() ;
    this.conn.removeAllListeners();
    this.conn.disconnect() ;
  }

  /**
   * check if the media server has a specific capability
   * @param  {string}  a named capability -  ipv6, ipv4, dtls, or udp
   * @return {Boolean}   true if the media server supports this capability
   */
  hasCapability(capability) {
    let family = 'ipv4' ;
    const cap = typeof capability === 'string' ? [capability] : capability ;
    let idx = cap.indexOf('ipv6') ;
    if (-1 !== idx) {
      cap.splice(idx, 1) ;
      family = 'ipv6' ;
    }
    else {
      idx = cap.indexOf('ipv4') ;
      if (-1 !== idx) {
        cap.splice(idx, 1) ;
      }
    }
    assert.ok(-1 !== ['dtls', 'udp'].indexOf(cap[0]), 'capability must be from the set ipv6, ipv4, dtls, udp') ;

    return 'address' in this.sip[family][cap[0]] ;
  }

  /**
   * send a freeswitch API command to the server
   * @param  {string}   command  command to execute
   * @param  {MediaServer~apiCallback} [callback] optional callback that returns api response
   * @return {Promise|Mediaserver} returns a Promise if no callback supplied; otherwise
   * a reference to the mediaserver object
   */
  api(command, callback) {
    assert(typeof command, 'string', '\'command\' must be a valid freeswitch api command') ;

    const __x = (callback) => {
      this.conn.api(command, (res) => {
        callback(res.getBody()) ;
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve) => {
      __x((body) => {
        resolve(body);
      });
    });
  }

  /**
   * allocate an Endpoint on the MediaServer, optionally allocating a media session to stream to a
   * remote far end SDP (session description protocol).  If no far end SDP is provided, the endpoint
   * is initially created in the inactive state.
   * @param  {MediaServer~EndpointOptions}   [opts] - create options
   * @param  {MediaServer~createEndpointCallback} [callback] callback that provides error or Endpoint
   * @return {Promise|Mediaserver} returns a Promise if no callback supplied; otherwise
   * a reference to the mediaserver object
   */
  createEndpoint(opts, callback) {
    if (typeof opts === 'function') {
      callback = opts ;
      opts = {} ;
    }
    opts = opts || {} ;

    opts.headers = opts.headers || {};
    opts.customEvents = this._mrf.customEvents;

    opts.is3pcc = !opts.remoteSdp;

    var family = opts.family || 'ipv4' ;
    var proto = opts.dtls ? 'dtls' : 'udp';

    const __x = (callback) => {
      if (!this.connected()) {
        return process.nextTick(() => { callback(new Error('too early: mediaserver is not connected')) ;}) ;
      }
      if (!this.sip[family][proto].address) {
        return process.nextTick(() => { callback(new Error('too early: mediaserver is not ready')) ;}) ;
      }

      // generate a unique id to track the endpoint during creation
      let uri;
      const uuid = generateUuid.v4() ;
      const hasDtls = opts.dtls && this.hasCapability([family, 'dtls']);
      if (hasDtls) {
        uri = `sips:drachtio@${this.sip[family]['dtls'].address};transport=tls`;
      }
      else {
        uri = `sip:drachtio@${this.sip[family]['udp'].address}`;
      }
      let dialog, conn ;

      debug(`MediaServer#createEndpoint: sending ${opts.is3pcc ? '3ppc' : ''} INVITE to uri ${uri} with id ${uuid}`);

      Object.assign(opts.headers, {
        'User-Agent': `drachtio-fsmrf:${uuid}`,
        'X-esl-outbound': `${this.listenAddress}:${this.listenPort}`
      });

      this.srf.createUAC(uri, {
        headers: opts.headers,
        localSdp: opts.remoteSdp
      })
        .then((dlg) => {
          debug(`MediaServer#createEndpoint - createUAC produced dialog for ${uuid}`) ;
          dialog = dlg ;
          if (conn) produceEndpoint.bind(this)(conn, dialog);
          return dlg ;
        })
        .catch((err) => {
          debug(`MediaServer#createEndpoint - createUAC returned error for ${uuid}`) ;
          this.pendingConnections.delete(uuid) ;
          produceError(new Error(`{err.status} ${err.reason}`));
        });

      const connectionTimeout = setTimeout(() => {
        delete this.pendingConnections.delete(uuid);
        produceError(new Error('Connection timeout')) ;
        debug(`MediaServer#createEndpoint - connection timeout for ${uuid}`) ;
      }, 10000) ;

      const connectCallback = (c) => {
        debug(`MediaServer#createEndpoint - connectCallback invoked for ${uuid}`) ;
        clearTimeout(connectionTimeout);
        conn = c ;
        if (!opts.is3pcc) conn.execute('answer');
        if (dialog) produceEndpoint.bind(this)(conn, dialog) ;
      } ;

      const produceEndpoint = (conn, dialog) => {
        debug(`MediaServer#createEndpoint - produceEndpoint for ${uuid}`);
        const endpoint = new Endpoint(conn, dialog, this, opts);
        endpoint.once('ready', () => {
          debug(`MediaServer#createEndpoint - returning endpoint for uuid ${uuid}`);
          callback(null, endpoint);
        });
      };

      const produceError = (err) => {
        callback(err);
      };

      this.pendingConnections.set(uuid, connectCallback.bind(this));
    };

    if (callback) {
      __x(callback);
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, endpoint) => {
        if (err) return reject(err);
        resolve(endpoint);
      });
    });
  }

  /**
   * connects an incoming call to the media server, producing both an Endpoint and a SIP Dialog upon success
   * @param  {Object}   req  - drachtio request object for incoming call
   * @param  {Object}   res  - drachtio response object for incoming call
   * @param  {MediaServer~EndpointOptions}   [opts] - options for creating endpoint and responding to caller
   * @param  {MediaServer~connectCallerCallback} callback   callback invoked on completion of operation
   * @return {Promise|Mediaserver} returns a Promise if no callback supplied; otherwise
   * a reference to the mediaserver object
  */
  connectCaller(req, res, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts ;
      opts = {} ;
    }
    opts = opts || {} ;

    const __x = (callback) => {
      async.waterfall([
        function createEndpoint(callback) {
          this.createEndpoint({
            remoteSdp: req.body,
            codecs: opts.codecs
          }, callback) ;
        }.bind(this),
        function respondToCaller(endpoint, callback) {
          this.srf.createUAS(req, res, {
            localSdp: endpoint.local.sdp,
            headers: opts.headers
          }, (err, dialog) => {
            if (err) return callback(err);
            callback(null, {endpoint, dialog}) ;
          }) ;
        }.bind(this)
      ], (err, pair) => {
        callback(err, pair) ;
      }) ;
    };

    if (callback) {
      __x(callback);
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, pair) => {
        if (err) return reject(err);
        resolve(pair);
      });
    });
  }

  /**
   * creates a conference on the media server.
   * @param  {String}   [name] - conference name; if not supplied a unique name will be generated
   * @param {MediaServer~conferenceCreateOptions}  [opts] - conference-level configuration options
   * @param {MediaServer~createConferenceCallback} [callback] - callback invoked when conference is created
   * @return {Promise|Mediaserver} returns a Promise if no callback supplied; otherwise
   * a reference to the mediaserver object
   */
  createConference(name, opts, callback) {
    if (typeof name !== 'string') {
      callback = opts;
      opts = name;
      name = `anon-${generateUuid.v4()}`;
    }
    if (typeof opts === 'function') {
      callback = opts ;
      opts = {} ;
    }
    opts = opts || {} ;

    assert.equal(typeof name, 'string', '\'name\' is a required parameter') ;
    assert.ok(typeof opts === 'object', 'opts param must be an object') ;

    const __x = (callback) => {
      /* Steps for creating a conference:
         (1) Check to see if a conference of that name already exists - return error if so
         (2) Create the conference  control leg (endpoint)
         (3) Create the conference
      */
      async.waterfall([
        (callback) => {               // verify conference does not already exist
          this.api(`conference ${name} list count`, (result) => {
            debug(`return from conference list: ${result}`) ;
            if (typeof result === 'string' &&
              (result.match(/^No active conferences/) || result.match(/^Conference.*not found/))) {
              return callback(null) ;
            }
            //callback(null) ;
            callback(new Error('conference exists')) ;
          });
        },
        (callback) => {               // create an endpoint on the media server
          debug(`MediaServer#createConference: create endpoint for conference ${name}`) ;
          this.createEndpoint((err, endpoint) => {
            if (err) return callback(err);
            callback(null, endpoint) ;
          });
        },
        (endpoint, callback) => {     // create the conference on Freeswitch using the control leg
          opts.flags = Object.assign({}, opts.flags, {
            endconf: true,
            mute: true,
            vmute: true
          });

          debug(`MediaServer#createConference: join endpoint for conference ${name} `) ;
          endpoint.join(name, opts, (err, {memberId, confUuid}) => {
            debug(`MediaServer#createConference: joined endpoint for conference ${name} `) ;
            callback(err, endpoint, confUuid);
          });
        }
      ], (err, endpoint, confUuid) => {
        if (err) {
          debug(`Error creating conference: ${err}`);
          return callback(err);
        }
        const conference = new Conference(name, confUuid, endpoint, opts);
        debug(`MediaServer#createConference: created conference ${name}:${confUuid}`) ;

        callback(null, conference) ;
      }) ;
    };

    if (callback) {
      __x(callback);
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, conference) => {
        if (err) return reject(err);
        resolve(conference);
      });
    });
  }

  toJSON() {
    return only(this, 'sip maxSessions currentSessions cps cpuIdle fsVersion hostname v4address pendingConnections') ;
  }

  _onError(err) {
    debug(`Mediaserver#_onError: got error from freeswitch connection, attempting reconnect: ${err}`);
  }

  _onHeartbeat(evt) {
    this.maxSessions = parseInt(evt.getHeader('Max-Sessions')) ;
    this.currentSessions = parseInt(evt.getHeader('Session-Count')) ;
    this.cps = parseInt(evt.getHeader('Session-Per-Sec')) ;
    this.hostname = evt.getHeader('FreeSWITCH-Hostname') ;
    this.v4address = evt.getHeader('FreeSWITCH-IPv4') ;
    this.v6address = evt.getHeader('FreeSWITCH-IPv6') ;
    this.fsVersion = evt.getHeader('FreeSWITCH-Version') ;
    this.cpuIdle = parseFloat(evt.getHeader('Idle-CPU')) ;
  }

  _onCreateTimeout(uuid) {
    if (!(uuid in this.pendingConnections)) {
      console.error(`MediaServer#_onCreateTimeout: uuid not found: ${uuid}`) ;
      return ;
    }
    const obj = this.pendingConnections[uuid] ;
    obj.callback(new Error('Connection timeout')) ;
    clearTimeout(obj.createTimeout) ;
    delete this.pendingConnections[uuid] ;
    console.log(`createEndpoint ${uuid} timed out; after removing there are ${_.keys(this.pendingConnections).length} 
      Endpoints in pending create state`) ;
  }

  _onNewCall(conn, id) {
    if (this.logger) {
      // debug trace, if enabled
      const tag = conn.getInfo().getHeader('Channel-Unique-ID') ;
      conn.on('esl::event::**', this._onRawRecv.bind(this, tag)) ;
      wrapConnectionForTracing(this, conn, tag) ;
    }

    const userAgent = conn.getInfo().getHeader('variable_sip_user_agent') ;
    const re = /^drachtio-fsmrf:(.+)$/ ;
    const results = re.exec(userAgent) ;
    if (null === results) {
      console.error(`received INVITE without drachtio-fsmrf header, unexpected User-Agent: ${userAgent}`) ;
      return conn.execute('hangup', 'NO_ROUTE_DESTINATION') ;
    }
    const uuid = results[1] ;
    if (!uuid || !this.pendingConnections.has(uuid)) {
      console.error(`received INVITE with unknown uuid: ${uuid}`) ;
      return conn.execute('hangup', 'NO_ROUTE_DESTINATION') ;
    }

    debug(`MediaServer#_onNewCall: ${this.address} received new call with tracking uuid: ${uuid}`) ;

    const f = this.pendingConnections.get(uuid);
    this.pendingConnections.delete(uuid);
    f(conn);
  }

  _onRawRecv(tag, event, headers, body) {
    const obj = _.find(event.headers, (hdr) => { return hdr.name === 'Event-Name'; }) ;
    if (obj && -1 !== ['RE_SCHEDULE', 'HEARTBEAT'].indexOf(obj.value)) {
      this.logger.write(`\n....skipping ${obj.value}....`) ;
      return ;
    }

    this.logger.write(`\n${moment().format('YYYY-MM-DD:HH:mm:ss')}: RECEIVING ${tag}\n`) ;
    this.logger.write(event.serialize()) ;
    this.logger.write('\n') ;
  }

  _onRawSend(tag, data) {
    this.logger.write(`\n${moment().format('YYYY-MM-DD:HH:mm:ss')}: SENDING ${tag}\n`) ;
    this.logger.write(data) ;
    this.logger.write('\n') ;
  }
}

/**
 * This callback provides the response to an attempt to create an Endpoint on the MediaServer.
 * @callback MediaServer~createEndpointCallback
 * @param {Error} error encountered while attempting to create the endpoint
 * @param {Endpoint} endpoint that was created
 */
/**
 * This callback provides the response to an attempt to create a Conference on the MediaServer.
 * @callback MediaServer~createConferenceCallback
 * @param {Error} error encountered while attempting to create the conference
 * @param {Conference} conference that was created
 */

/**
/**
 * This callback provides the response to an api request
 * @callback Mrf~apiCallback
 * @param {string} response - body of the response from freeswitch
 */

/**
 * This callback provides the response to an attempt connect a caller to the MediaServer.
 * @callback MediaServer~connectCallerCallback
 * @param {Error} err - error encountered while attempting to create the endpoint
 * @param {Endpoint} ep - endpoint that was created
 * @param {Dialog} dialog - sip dialog that was created
 */

/** returns true if the MediaServer is in the 'connected' state
*   @name MediaServer#connected
*   @method
*/

delegate(MediaServer.prototype, '_conn')
  .method('connected') ;

/**
 * Options governing the creation of a conference
 * @typedef {Object} MediaServer~conferenceCreateOptions
 * @property {string} [pin] entry pin for the conference
 * @property {string} [profile=default] conference profile to use
 * @property {Object} [flags] parameters governing the connection of the endpoint to the conference
 * @property {boolean} [flags.waitMod=false] Members will wait (with music) until a member with the 'moderator' flag
 * set enters the conference
 * @property {boolean} [flags.audioAlways=false] Do not use energy detection to choose which participants to mix;
 * instead always mix audio from all members
 * @property {boolean} [flags.videoBridgeFirstTwo=false] In mux mode, If there are only 2 people in conference,
 * you will see only the other member
 * @property {boolean} [flags.videoMuxingPersonalCanvas=false] In mux mode, each member will get their own canvas
 * and they will not see themselves
 * @property {boolean} [flags.videoRequiredForCanvas=false] Only video participants will be shown
 * on the canvas (no avatars)
 */

/**
 * Arguments provided when creating an Endpoint on a MediaServer
 * @typedef {Object} MediaServer~EndpointOptions
 * @property {String} [remoteSdp] remote session description protocol
 * (if not provided, an initially inactive Endpoint will be created)
 * @property {String[]} [codecs] - array of codecs, in preferred order (e.g. ['PCMU','G722','PCMA'])
 */

/**
 * connect event triggered when connection is made to the freeswitch media server.
 * @event MediaServer#connect
 */
/**
 * ready event triggered after connecting to the server and verifying
 * it is properly configured and ready to accept calls.
 * @event MediaServer#ready
 */
/**
 * Error event triggered when connection to freeswitch media server fails.
 *
 * @event MediaServer#error
 * @type {object}
 * @property {String} message - Indicates the reason the connection failed
 */

module.exports = exports = MediaServer ;
