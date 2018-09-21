const esl = require('modesl') ;
const assert = require('assert') ;
const MediaServer = require('./mediaserver') ;
const Emitter = require('events').EventEmitter ;
const os = require('os');
const parseBodyText = require('./utils').parseBodyText;
const debug = require('debug')('drachtio:fsmrf') ;

/**
 * Creates a media resource framework instance.
 * @constructor
 * @param {Srf} srf Srf instance
 * @param {Mrf~createOptions} [opts] configuration options
 */
class Mrf extends Emitter {

  constructor(srf, opts) {
    super() ;

    opts = opts || {} ;

    this._srf = srf ;
    this.debugDir = opts.debugDir ;
    this.debugSendonly = opts.sendonly ;
    this.mediaservers = [] ;
    this.localAddresses = [];
    this.customEvents = opts.customEvents || [];

    const interfaces = os.networkInterfaces();
    for (const k in interfaces) {
      for (const k2 in interfaces[k]) {
        const address = interfaces[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
          this.localAddresses.push(address.address);
        }
      }
    }
  }

  get srf() {
    return this._srf ;
  }

  /**
   * connect to a specified media server
   * @param  {Mrf~ConnectOptions}   opts options describing media server to connect to
   * @param  {Mrf~ConnectCallback} [callback] callback
   * @return {Promise} if no callback is specified
   */
  connect(opts, callback) {
    assert.equal(typeof opts, 'object', 'argument \'opts\' must be provided with connection options') ;
    assert.equal(typeof opts.address, 'string', `argument \'opts.address\' containing 
      media server address is required`) ;

    const address = opts.address ;
    const port = opts.port || 8021 ;
    const secret = opts.secret || 'ClueCon' ;
    const listenPort = opts.listenPort || 0 ; // 0 means any available port
    const listenAddress = opts.listenAddress || this.localAddresses[0] || '0.0.0.0' ;

    function _onError(callback, err) {
      callback(err);
    }

    const __x = (callback) => {
      const listener = _onError.bind(this, callback) ;
      debug(`Mrf#connect - connecting to ${address}:${port}`);
      const conn = new esl.Connection(address, port, secret, () => {

        //...until we have initially connected and created a MediaServer object (which takes over error reporting)
        debug('initial connection made');
        conn.removeListener('error', listener) ;

        const ms = new MediaServer(conn, this, listenAddress, listenPort) ;
        this.mediaservers.push(ms) ;

        ms.once('ready', () => {
          debug(`Mrf#connect - media server is ready for action!`);
          callback(null, ms) ;
        }) ;
      });

      conn.on('error', listener);
      conn.on('esl::event::raw::text/rude-rejection', _onError.bind(this, callback, new Error('acl-error')));
    };

    if (callback) return __x(callback) ;

    return new Promise((resolve, reject) => {
      __x((err, mediaserver) => {
        if (err) return reject(err);
        resolve(mediaserver);
      });
    });
  }

}

/**
/**
 * This callback provides the response to a connection attempt to a freeswitch server
 * @callback Mrf~ConnectCallback
 * @param {Error} err connection error, if any
 * @param {MediaServer} ms - MediaServer instance
 */


/**
 * Arguments provided when connecting to a freeswitch media server
 * @typedef {Object} Mrf~ConnectOptions
 * @property {String} address - hostname or IP address to connect to
 * @property {Number} [port=8021] - TCP port to connect to (freeswitch event socket)
 * @property {String} [secret=ClueCon] - freeswitch authentication secret
 * @property {String} [listenAddress=auto-discovered public IP address or 127.0.0.1] -
 * local TCP address to listen for external connections from the freeswitch media server
 * @property {Number} [listenPort=8085] -  local TCP port to listen for external
 * connections from the freeswitch media server
 */

/**
 * Options governing the creation of an mrf instance
 * @typedef {Object} Mrf~createOptions
 * @property {string} [debugDir] directory into which message trace files;
 the presence of this param will enable debug tracing
 */


Mrf.utils = {parseBodyText};

module.exports = exports = Mrf ;
