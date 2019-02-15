const assert = require('assert') ;
const delegate = require('delegates') ;
const Emitter = require('events').EventEmitter ;
const Conference = require('./conference') ;
const only = require('only') ;
const _ = require('lodash') ;
const async = require('async') ;
const {parseBodyText} = require('./utils');
const debug = require('debug')('drachtio:fsmrf') ;

const State = {
  NOT_CONNECTED: 1,
  EARLY: 2,
  CONNECTED: 3,
  DISCONNECTED: 4
};

const EVENTS_OF_INTEREST = [
  'CHANNEL_EXECUTE',
  'CHANNEL_EXECUTE_COMPLETE',
  'CHANNEL_PROGRESS_MEDIA',
  'CHANNEL_CALLSTATE',
  'CHANNEL_ANSWER',
  'CUSTOM conference::maintenance'
];

/**
 * A media resource on a freeswitch-based MediaServer that is capable of play,
 * record, signal detection, and signal generation
 * Note: This constructor should not be called directly: rather, call MediaServer#createEndpoint
 * to create an instance of an Endpoint on a MediaServer
 * @constructor
 * @param {esl.Connection} conn - outbound connection from a media server for one session
 * @param {Dialog}   dialog - SIP Dialog to Freeswitch
 * @param {MediaServer}   ms - MediaServer that contains this Endpoint
 * @param {Endpoint~createOptions} [opts] configuration options
 */
class Endpoint extends Emitter {
  constructor(conn, dialog, ms, opts) {
    super() ;


    opts = opts || {} ;
    this._customEvents = (opts.customEvents = opts.customEvents || [])
      .map((ev) => `CUSTOM ${ev}`);
    assert(Array.isArray(this._customEvents));

    this._conn = conn ;
    this._ms = ms ;
    this._dialog = dialog ;

    this._dialog.on('destroy', this._onBye.bind(this));

    this.uuid = conn.getInfo().getHeader('Channel-Unique-ID') ;

    /**
     * is secure media being transmitted (i.e. DLTS-SRTP)
     * @type Boolean
     */
    this.secure = /^m=audio\s\d*\sUDP\/TLS\/RTP\/SAVPF/m.test(conn.getInfo().getHeader('variable_switch_r_sdp')) ;

    /**
     * defines the local network connection of the Endpoint
     * @type {Endpoint~NetworkConnection}
     */
    this.local = {} ;
    /**
     * defines the remote network connection of the Endpoint
     * @type {Endpoint~NetworkConnection}
     */
    this.remote = {} ;
    /**
     * defines the SIP signaling parameters of the Endpoint
     * @type {Endpoint~SipInfo}
     */
    this.sip = {} ;

    /**
     * conference name and memberId associated with the conference that the endpoint is currently joined to
     * @type {Object}
     */
    this.conf = {} ;
    this.state = State.NOT_CONNECTED ;

    debug(`Endpoint#ctor creating endpoint with uuid ${this.uuid}, is3pcc: ${opts.is3pcc}`);

    //this._conn.send(`myevents ${this.uuid}\n`);
    //this.conn.subscribe('all');
    this.conn.subscribe(EVENTS_OF_INTEREST.concat(this._customEvents).join(' '));
    this.filter('Unique-ID', this.uuid);

    //this.conn.on(`esl::event::CHANNEL_EXECUTE::${this.uuid}`, this._onChannelExecute.bind(this)) ;
    this.conn.on(`esl::event::CHANNEL_HANGUP::${this.uuid}`, this._onHangup.bind(this)) ;
    this.conn.on(`esl::event::CHANNEL_CALLSTATE::${this.uuid}`, this._onChannelCallState.bind(this)) ;

    this.conn.on(`esl::event::CUSTOM::${this.uuid}`, this._onCustomEvent.bind(this)) ;

    this.conn.on('error', this._onError.bind(this)) ;

    if (!opts.is3pcc) {
      if (opts.codecs) {
        if (typeof opts.codecs === 'string') opts.codecs = [opts.codecs];
        if (opts.codecs.length > 0) {
          this.execute('set', `codec_string=${opts.codecs.join(',')}`) ;
        }
      }
    }
    this.getChannelVariables(true, (err, obj) => {
      if (err) return console.error(`Endpoint: error accessing channel variables: ${err}`);

      this.local.sdp = obj['variable_rtp_local_sdp_str'] ;
      this.local.mediaIp = obj['variable_local_media_ip'] ;
      this.local.mediaPort = obj['variable_local_media_port'] ;

      this.remote.sdp = obj['variable_switch_r_sdp'] ;
      this.remote.mediaIp = obj['variable_remote_media_ip'] ;
      this.remote.mediaPort = obj['variable_remote_media_port'] ;

      this.dtmfType = obj['variable_dtmf_type'] ;
      this.sip.callId = obj['variable_sip_call_id'] ;

      this.state = State.CONNECTED ;
      this._emitReady();
    }) ;
  }

  /**
   * @return {MediaServer} the mediaserver that contains this endpoint
   */
  get mediaserver() {
    return this._ms ;
  }

  /**
   * @return {Srf} the Srf instance used to send SIP signaling to this endpoint and associated mediaserver
   */
  get srf() {
    return this.ms.srf ;
  }

  /**
   * @return {esl.Connection} the Freeswitch outbound connection used to control this Endpoint
   */
  get conn() {
    return this._conn ;
  }

  get dialog() {
    return this._dialog ;
  }

  set dialog(dlg) {
    if (this._dialog = dlg) this._dialog.on('destroy', this._onBye.bind(this)) ;
    return this ;
  }

  /**
   * set a parameter on the Endpoint
   * @param {String|Object} param parameter name or dictionary of param-value pairs
   * @param {String} value parameter value
   * @param {Endpoint~operationCallback} [callback] callback return results
   * @returns {Promise} a promise is returned if no callback is supplied
   */
  set(param, value, callback) { return setOrExport('set', this, param, value, callback); }

  /**
   * export a parameter on the Endpoint
   * @param {String|Object} param parameter name or dictionary of param-value pairs
   * @param {String} value parameter value
   * @param {Endpoint~operationCallback} [callback] callback return results
   * @returns {Promise} a promise is returned if no callback is supplied
   */
  export(param, value, callback) { return setOrExport('export', this, param, value, callback); }

  /**
   * subscribe for custom events
   * @param {String} custom event name (not including 'CUSTOM ' prefix)
   * @param {Funtion} event listener
   */
  addCustomEventListener(event, handler) {
    assert.ok(typeof event === 'string', 'event name must be string type');
    assert.ok(typeof handler === 'function', 'handler must be a function type');
    assert.ok(event.indexOf('CUSTOM ') !== 0,
      'event name should not include \'CUSTOM \' prefix (it is added automatically)');

    const fullEventName = `CUSTOM ${event}`;
    this._customEvents.push(fullEventName);
    this.conn.subscribe(fullEventName);
    this.on(event, handler);
  }

  /**
   * remove a custom event listener
   * @param {String} event name 
   */
  removeCustomEventListener(event) {
    const fullEventName = `CUSTOM ${event}`;
    const idx = this._customEvents.indexOf(fullEventName);
    if (-1 !== idx) this._customEvents.splice(idx, 1);
  }

  /**
   * retrieve channel variables for the endpoint
   * @param  {boolean} [includeMedia] if true, retrieve rtp counters (e.g. variable_rtp_audio_in_raw_bytes, etc)
   * @param  {Endpoint~getChannelVariablesCallback} [callback]  callback function invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  getChannelVariables(includeMedia, callback) {
    if (typeof includeMedia === 'function') {
      callback = includeMedia ;
      includeMedia = false ;
    }

    const __x = (callback) => {
      async.waterfall([
        function setMediaStatsIfRequested(callback) {
          if (includeMedia === true) {
            this.api('uuid_set_media_stats', this.uuid, () => {
              callback(null) ;
            }) ;
          }
          else {
            callback(null) ;
          }
        }.bind(this),
        function getVars(callback) {
          this.api('uuid_dump', this.uuid, (err, event, headers, body) => {
            callback(err, event, headers, body) ;
          }) ;
        }.bind(this)
      ], (err, event, headers, body) => {
        if (err) return callback(err);
        if (headers['Content-Type'] === 'api/response' && 'Content-Length' in headers) {
          var bodyLen = parseInt(headers['Content-Length'], 10) ;
          return callback(null, parseBodyText(body.slice(0, bodyLen))) ;
        }
        callback(null, {}) ;
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });
  }

  _onCustomEvent(evt) {
    const eventName = evt.getHeader('Event-Subclass') ;
    const fullEventName = `CUSTOM ${eventName}`;
    const ev = this._customEvents.find((ev) => ev === fullEventName);
    if (ev) {
      try {
        const args = JSON.parse(evt.getBody());
        debug(`Endpoint#__onCustomEvent: ${ev} - emitting JSON argument ${evt.getBody()}`) ;
        this.emit(eventName, args);
      }
      catch (err) {
        this.emit(eventName, evt.getBody());
        debug(`Endpoint#__onCustomEvent: ${ev} - emitting text argument ${evt.getBody()}`) ;
      }
    }
  }

  /**
   * play an audio file on the endpoint
   * @param  {string|Array}   file file (or array of files) to play
   * @param  {Endpoint~playOperationCallback} [cb]   callback function invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  play(file, callback) {
    assert.ok('string' === typeof file || _.isArray(file), 'file param is required and must be a string or array') ;

    const files = _.isArray(file) ? file : [file] ;

    const __x = (callback) => {
      async.waterfall([
        function setDelimiter(callback) {
          if (1 === files.length) {
            return callback(null);
          }
          this.execute('set', 'playback_delimiter=!', (err, evt) => {
            debug(`Endpoint#play ${this.uuid} playback_delimiter response: ${evt}`) ;
            callback(null);
          }) ;
        }.bind(this),
        function sendPlay(callback) {
          this.execute('playback', files.join('!'), function(err, evt) {
            const result = {
              playbackSeconds: evt.getHeader('variable_playback_seconds'),
              playbackMilliseconds: evt.getHeader('variable_playback_ms'),
            } ;
            callback(null, result) ;
          }) ;
        }.bind(this)
      ], (err, result) => {
        callback(err, result) ;
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  /**
   * This callback is invoked when a media operation has completed
   * @callback Endpoint~playOperationCallback
   * @param {Error} err - error returned from play request
   * @param {object} results - results of the operation
   * @param {String} results.playbackSeconds - number of seconds of audio played
   * @param {String} results.playbackMilliseconds - number of fractional milliseconds of audio played
   */

  /**
   * play an audio file and collect digits
   * @param  {Endpoint~playCollectOptions}   opts - playcollect options
   * @param  {Endpoint~playCollectOperationCallback} [callback] - callback function invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  playCollect(opts, callback) {
    assert(typeof opts, 'object', '\'opts\' param is required') ;
    assert(typeof opts.file, 'string', '\'opts.file\' param is required') ;


    const __x = (callback) => {
      opts.min = opts.min || 0 ;
      opts.max = opts.max || 128 ;
      opts.tries = opts.tries || 1 ;
      opts.timeout = opts.timeout || 120000 ;
      opts.terminators = opts.terminators || '#' ;
      opts.invalidFile = opts.invalidFile || 'silence_stream://250' ;
      opts.varName = opts.varName || 'myDigitBuffer' ;
      opts.regexp = opts.regexp || '\\d+' ;
      opts.digitTimeout = opts.digitTimeout || 8000 ;

      const args = [] ;
      ['min', 'max', 'tries', 'timeout', 'terminators', 'file', 'invalidFile', 'varName', 'regexp', 'digitTimeout']
        .forEach((prop) => {
          args.push(opts[prop]) ;
        }) ;

      this.execute('play_and_get_digits', args.join(' '), (err, evt) => {
        if ('play_and_get_digits' !== evt.getHeader('variable_current_application')) {
          return callback(new Error(evt.getHeader('variable_current_application'))) ;
        }
        callback(null, {
          digits: evt.getHeader(`variable_${opts.varName}`),
          invalidDigits: evt.getHeader(`variable_${opts.varName}_invalid`),
          terminatorUsed: evt.getHeader('variable_read_terminator_used'),
          playbackSeconds: evt.getHeader('variable_playback_seconds'),
          playbackMilliseconds: evt.getHeader('variable_playback_ms'),
        }) ;
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

  }

  /**
   * Speak a phrase that requires grammar rules
   * @param  {string}   text phrase to speak
   * @param  {Endpoint~sayOptions}   opts - say command options
   * @param  {Endpoint~playOperationCallback} [callback] - callback function invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */

  say(text, opts, callback) {
    assert(typeof text, 'string', '\'text\' is required') ;
    assert(typeof opts, 'object', '\'opts\' param is required') ;
    assert(typeof opts.sayType, 'string', '\'opts.sayType\' param is required') ;
    assert(typeof opts.sayMethod, 'string', '\'opts.sayMethod\' param is required') ;

    opts.lang = opts.lang || 'en' ;
    opts.sayType = opts.sayType.toUpperCase() ;
    opts.sayMethod = opts.sayMethod.toLowerCase() ;

    assert.ok(!(opts.sayType in [
      'NUMBER',
      'ITEMS',
      'PERSONS',
      'MESSAGES',
      'CURRENCY',
      'TIME_MEASUREMENT',
      'CURRENT_DATE',
      'CURRENT_TIME',
      'CURRENT_DATE_TIME',
      'TELEPHONE_NUMBER',
      'TELEPHONE_EXTENSION',
      'URL',
      'IP_ADDRESS',
      'EMAIL_ADDRESS',
      'POSTAL_ADDRESS',
      'ACCOUNT_NUMBER',
      'NAME_SPELLED',
      'NAME_PHONETIC',
      'SHORT_DATE_TIME']), 'invalid value for \'sayType\' param: ' + opts.sayType) ;

    assert.ok(!(opts.sayMethod in ['pronounced', 'iterated', 'counted']),
      'invalid value for \'sayMethod\' param: ' + opts.sayMethod) ;

    if (opts.gender) {
      opts.gender = opts.gender.toUpperCase() ;
      assert.ok(opts.gender in ['FEMININE', 'MASCULINE', 'NEUTER'],
        'invalid value for \'gender\' param: ' + opts.gender) ;
    }

    const args = [] ;
    ['lang', 'sayType', 'sayMethod', 'gender'].forEach((prop) => {
      if (opts[prop]) {
        args.push(opts[prop]) ;
      }
    });
    args.push(text) ;

    const __x = (callback) => {
      this.execute('say', args.join(' '), (err, evt) => {
        if ('say' !== evt.getHeader('variable_current_application')) {
          return callback(new Error(`expected response to say but got 
            ${evt.getHeader('variable_current_application')}`)) ;
        }
        debug('Endpoint#say ${this.uuid} response to say command: ', evt) ;
        var result = {
          playbackSeconds: evt.getHeader('variable_playback_seconds'),
          playbackMilliseconds: evt.getHeader('variable_playback_ms'),
        } ;
        callback(null, result) ;
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

  }

  /**
   * Use text-to-speech to speak.
   * @param {string} [opts.ttsEngine] name of the tts engine to use
   * @param {string} [opts.voice] name of the tts voice to use
   * @param {string} [opts.text] text to speak
   * @param  {function} [callback] if provided, callback with signature <code>(err)</code>
   * @return {Endpoint|Promise} if a callback is supplied, a reference to the Endpoint instance.
   * <br/>If no callback is supplied, then a Promise that is resolved
   * when the speak command completes.
   */
  speak(opts, callback) {
    assert(typeof opts, 'object', '\'opts\' param is required') ;
    assert(typeof opts.ttsEngine, 'string', '\'opts.ttsEngine\' param is required') ;
    assert(typeof opts.voice, 'string', '\'opts.voice\' param is required') ;
    assert(typeof opts.text, 'string', '\'opts.text\' param is required') ;

    const __x = (callback) => {
      const args = [opts.ttsEngine, opts.voice, opts.text].join('|');

      this.execute('speak', args, (err, evt) => {
        if ('speak' !== evt.getHeader('variable_current_application')) {
          return callback(new Error(evt.getHeader('variable_current_application'))) ;
        }
        callback(null) ;
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

  }
  /**
   * join an endpoint into a conference
   * @param  {String|Conference}   conf - name of a conference or a Conference instance
   * @param  {Endpoint~confJoinOptions}  [opts] - options governing the connection
   * between the endpoint and the conference
   * @param  {Endpoint~confJoinCallback} [callback]  - callback invoked when join operation is completed
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  join(conf, opts, callback) {
    assert.ok(typeof conf === 'string' || conf instanceof Conference,
      'argument \'conf\' must be either a conference name or a Conference object') ;

    const confName = typeof conf === 'string' ? conf : conf.name ;
    if (typeof opts === 'function') {
      callback = opts ;
      opts = {} ;
    }
    opts = opts || {} ;
    opts.flags = opts.flags || {} ;

    const flags = [] ;
    _.each(opts.flags, (value, key) => {
      if (true === value) flags.push(_.snakeCase(key).replace(/_/g, '-'));
    }) ;

    let args = confName ;
    if (opts.profile) args += '@' + opts.profile;
    if (!!opts.pin || flags.length > 0) args += '+' ;
    if (opts.pin) args += opts.pin ;
    if (flags.length > 0) args += '+flags{' + flags.join('|') + '}' ;

    const __x = (callback) => {
      debug(`Endpoint#join: ${this.uuid} executing conference with args: ${args}`) ;

      this.conn.on('esl::event::CUSTOM::*', this.__onConferenceEvent.bind(this)) ;

      this.execute('conference', args) ;

      assert(!this._joinCallback);

      this._joinCallback = (memberId, confUuid) => {
        debug(`Endpoint#joinConference: ${this.uuid} joined ${confName}:${confUuid} with memberId ${memberId}`) ;
        this._joinCallback = null ;
        this.conf.memberId = memberId ;
        this.conf.name = confName;
        this.conf.uuid = confUuid;

        this.conn.removeAllListeners('esl::event::CUSTOM::*') ;

        callback(null, {memberId, confUuid});
      };
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  /**
   * bridge two endpoints together
   * @param  {Endpoint | string}   other    - an Endpoint or uuid of a channel to bridge with
   * @param  {Endpoint~operationCallback} [callback] - callback invoked when bridge operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  bridge(other, callback) {
    assert.ok(typeof other === 'string' || other instanceof Endpoint,
      'argument \'other\' must be either a uuid or an Endpoint') ;

    const otherUuid = typeof other === 'string' ? other : other.uuid ;

    const __x = (callback) => {
      this.api('uuid_bridge', [this.uuid, otherUuid], (err, event, headers, body) => {
        if (err) return callback(err);

        if (0 === body.indexOf('+OK')) {
          return callback(null) ;
        }
        callback(new Error(body)) ;
      });
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }


  /**
   * Park an endpoint that is currently bridged with another endpoint
   * @param  {Endpoint~operationCallback} [callback] - callback invoked when bridge operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  unbridge(callback) {
    const __x = (callback) => {
      this.api('uuid_transfer', [this.uuid, '-both', 'park', 'inline'], (err, evt) => {
        if (err) return callback(err);
        const body = evt.getBody() ;
        if (0 === body.indexOf('+OK')) {
          return callback(null) ;
        }
        callback(new Error(body)) ;
      });
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  startTranscription(opts, callback) {
    opts = opts || {};
    const __x = (callback) => {
      this.api('uuid_transcribe', [this.uuid, 'start', opts.interim ? 'interim' : 'final'], (err, evt) => {
        if (err) return callback(err);
        const body = evt.getBody() ;
        if (0 === body.indexOf('+OK')) {
          return callback(null) ;
        }
        callback(new Error(body)) ;
      });
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  stopTranscription(callback) {
    const __x = (callback) => {
      this.api('uuid_transcribe', [this.uuid, 'stop'], (err, evt) => {
        if (err) return callback(err);
        const body = evt.getBody() ;
        if (0 === body.indexOf('+OK')) {
          return callback(null) ;
        }
        callback(new Error(body)) ;
      });
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }
  /**
   * call a freeswitch api method
   * @param  {string}   command    command name
   * @param  {string}   [args]     command arguments
   * @param  {Endpoint~mediaOperationsCallback} [callback] callback function
   * @return {Promise|Endpoint}    if no callback specified, a Promise that resolves with the response is returned
   * otherwise a reference to the endpoint object
   */
  api(command, args, callback) {
    if (typeof args === 'function') {
      callback = args ;
      args = [] ;
    }

    const __x = (callback) => {
      debug(`Endpoint#api ${command} ${args}`);
      this._conn.api(command, args, (...response) => {
        debug(`Endpoint#api response: ${JSON.stringify(response).slice(0, 512)}`);
        callback(null, ...response);
      });
    } ;

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });
  }

  /**
   * execute a freeswitch application
   * @param  {string}     app        application name
   * @param  {string}   [arg]      application arguments, if any
   * @param  {Endpoint~mediaOperationsCallback} [callback] callback function
   * @return {Promise|Endpoint}    if no callback specified, a Promise that resolves with the response is returned
   * otherwise a reference to the endpoint object
   */
  execute(app, arg, callback) {
    if (typeof arg === 'function') {
      callback = arg ;
      arg = '';
    }

    const __x = (callback) => {
      debug(`Endpoint#execute ${app} ${arg}`);
      this._conn.execute(app, arg, (evt) => {
        callback(null, evt);
      });
    } ;

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, response) => {
        if (err) return reject(err);
        resolve(response);
      });
    });

  }

  executeAsync(app, arg, callback) {
    return this._conn.execute(app, arg, callback);
  }

  /**
   * Releases an Endpoint and associated resources
   * @param  {Endpoint~operationsCallback} [callback] callback function invoked after endpoint has been released
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  destroy(callback) {
    const __x = (callback) => {
      if (State.CONNECTED !== this.state) {
        return callback(new Error(
          `endpoint ${this.uuid} could not be deleted because it is not connected: ${this.state}`));
      }
      this.state = State.DISCONNECTED ;

      this.dialog.once('destroy', () => {
        debug(`Endpoint#destroy - received BYE for ${this.uuid}`);
        callback(null) ;
      });

      debug(`Endpoint#destroy: executing hangup on ${this.uuid}`);
      this.execute('hangup', (err, evt) => {
        this.conn.disconnect() ;
      });
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // endpoint applications

  /**
   * record the full call
   * @file  {string} file - file to record to
   * @param  {endpointOperationCallback} [callback] - callback invoked with response to record command
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  recordSession(...args) { return endpointApps.recordSession(this, ...args); }

  /**
   * record to a file from the endpoint's input stream
   * @param  {string}   file     file to record to
   * @param  {Endpoint~recordOptions}   opts - record command options
   * @param  {endpointRecordCallback} [callback] - callback invoked with response to record command
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  record(file, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts ;
      opts = {} ;
    }
    opts = opts || {} ;

    const args = [] ;
    ['timeLimitSecs', 'silenceThresh', 'silenceHits'].forEach((p) => {
      if (opts[p]) {
        args.push(opts[p]);
      }
    });

    const __x = (callback) => {
      this.execute('record', `${file} ${args.join(' ')}`, (err, evt) => {
        if (err) return callback(err, evt);
        const application = evt.getHeader('Application');
        if ('record' !== application) {
          return callback(new Error(`unexpected application in record response: ${application}`)) ;
        }

        callback(null, {
          terminatorUsed: evt.getHeader('variable_playback_terminator_used'),
          recordSeconds: evt.getHeader('variable_record_seconds'),
          recordMilliseconds: evt.getHeader('variable_record_ms'),
          recordSamples: evt.getHeader('variable_record_samples'),
        }) ;
      }) ;
    } ;

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // conference member operations

  /**
   * mute the member
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  confMute(...args) { return confOperations.mute(this, ...args); }

  /**
   * unmute the member
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  confUnmute(...args) { return confOperations.unmute(this, ...args); }

  /**
   * deaf the member
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */

  confDeaf(...args) { return confOperations.deaf(this, ...args);  }
  /**
   * undeaf the member
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  confUndeaf(...args) { return confOperations.undeaf(this, ...args);  }

  /**
   * kick the member out of the conference
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  confKick(...args) { return confOperations.kick(this, ...args); }

  /**
   * kick the member out of the conference without exit sound
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the Endpoint object
   */
  confHup(...args) { return confOperations.hup(this, ...args); }

  /**
   * play a file to the member
   * @param string file - file to play
   * @param {Endpoint~playOptions} [opts] - play options
   * @param  {Endpoint~mediaOperationCallback} [callback] - callback invoked when operation completes
   * @return {Promise|Endpoint} returns a Promise if no callback supplied; otherwise
   * a reference to the ConferenceConnection object
   */
  confPlay(...args) { return confOperations.play(this, ...args); }

  /**
   * transfer a member to a new conference
   * @param  {String}   newConf - name of new conference to transfer to
   * @param  {ConferenceConnection~mediaOperationsCallback} [cb] - callback invoked when transfer has completed
   */
  transfer(...args) { return confOperations.transfer(this, ...args); }

  __onConferenceEvent(evt) {
    const eventName = evt.getHeader('Event-Subclass') ;

    if (eventName === 'conference::maintenance') {
      const action = evt.getHeader('Action') ;
      debug(`Endpoint#__onConferenceEvent: conference event action: ${action}`) ;

      //invoke a handler for this action, if we have defined one
      (Endpoint.prototype['_on' + _.upperFirst(_.camelCase(action))] || this._unhandled).bind(this, evt)() ;

    }
    else {
      debug(`Endpoint#__onConferenceEvent: got unhandled custom event: ${eventName}`) ;
    }
  }

  _onAddMember(evt) {
    let memberId = -1;
    const confUuid = evt.getHeader('Conference-Unique-ID');
    try {
      memberId = parseInt(evt.getHeader('Member-ID'));
    } catch (err) {
      debug(`Endpoint#_onAddMember: error parsing memberId as an int: ${memberId}`);
    }
    debug(`Endpoint#_onAddMember: memberId ${memberId} conference uuid ${confUuid}`) ;
    assert.ok(typeof this._joinCallback, 'function');
    this._joinCallback(memberId, confUuid) ;
  }

  _unhandled(evt) {
    debug(`unhandled Conference event for endpoint ${this.uuid} with action: ${evt.getHeader('Action')}`) ;
  }

  _onError(err) {
    if (err.errno && (err.errno === 'ECONNRESET' || err.errno === 'EPIPE') && this.state === State.DISCONNECTED) {
      debug('ignoring connection reset error during teardown of connection') ;
      return ;
    }
    console.error(`Endpoint#_onError: uuid: ${this.uuid}: ${err}`) ;
  }

  _onChannelCallState(evt) {
    const channelCallState = evt.getHeader('Channel-Call-State')  ;

    debug(`Endpoint#_onChannelCallState ${this.uuid}: Channel-Call-State: ${channelCallState}`) ;
    if (State.NOT_CONNECTED === this.state && 'EARLY' === channelCallState) {
      this.state = State.EARLY ;

      // if we are using DLTS-SRTP, the 200 OK has been sent at this point;
      // however, answer will not be sent by FSW until the handshake.
      // We need to invoke the callback provided in the constructor now
      // in order to allow the calling app to access the endpoint.
      if (this.secure) {
        this.getChannelVariables(true, (obj) => {
          this.local.sdp = obj['variable_rtp_local_sdp_str'] ;
          this.local.mediaIp = obj['variable_local_media_ip'] ;
          this.local.mediaPort = obj['variable_local_media_port'] ;

          this.remote.sdp = obj['variable_switch_r_sdp'] ;
          this.remote.mediaIp = obj['variable_remote_media_ip'] ;
          this.remote.mediaPort = obj['variable_remote_media_port'] ;

          this.dtmfType = obj['variable_dtmf_type'] ;
          this.sip.callId = obj['variable_sip_call_id'] ;

          this.emitReady() ;
        }) ;
      }
    }

    this.emit('channelCallState', {state: channelCallState});
  }

  _emitReady() {
    if (!this._ready) {
      this._ready = true ;
      setImmediate(() => {
        this.emit('ready');
      });
    }
  }

  _onHangup(evt) {
    if (State.DISCONNECTED !== this.state) {
      this.conn.disconnect();
    }
    this.state = State.DISCONNECTED ;
    this.emit('hangup', evt) ;
  }

  _onBye(evt) {
    debug('Endpoint#_onBye: got BYE from media server') ;
    this.emit('destroy') ;
  }

  toJSON() {
    return only(this, 'sip local remote uuid') ;
  }

  toString() {
    return this.toJSON().toString() ;
  }
}

/**
 * Options governing the creation of an Endpoint
 * @typedef {Object} Endpoint~createOptions
 * @property {string} [debugDir] directory into which message trace files;
 * the presence of this param will enable debug tracing
 * @property {string|array} [codecs] preferred codecs; array order indicates order of preference
 *
 */

/**
 * This callback is invoked when an endpoint has been created and is ready for commands.
 * @callback Endpoint~createCallback
 * @param {Error} error
 * @param {Endpoint} ep the Endpoint
 */

/**
 * Options governing a play command
 * @typedef {Object} Endpoint~playCollectOptions
 * @property {String} file - file to play as a prompt
 * @property {number} [min=0] minimum number of digits to collect
 * @property {number} [max=128] maximum number of digits to collect
 * @property {number} [tries=1] number of times to prompt before returning failure
 * @property {String} [invalidFile=silence_stream://250] file or prompt to play when invalid digits are entered
 * @property {number} [timeout=120000] total timeout in millseconds to wait for digits after prompt completes
 * @property {String} [terminators=#] one or more keys which, if pressed, will terminate
 * digit collection and return collected digits
 * @property {String} [varName=myDigitBuffer] name of freeswitch variable to use to collect digits
 * @property {String} [regexp=\\d+] regular expression to use to govern digit collection
 * @property {number} [digitTimeout=8000] inter-digit timeout, in milliseconds
 */
/**
 * Options governing a record command
 * @typedef {Object} Endpoint~recordOptions
 * @property {number} [timeLimitSecs] max duration of recording in seconds
 * @property {number} [silenceThresh] energy levels below this are considered silence
 * @property {number} [silenceHits] number of packets of silence after which to terminate the recording
 */

/**
 * This callback is invoked when a media operation has completed
 * @callback Endpoint~playCollectOperationCallback
 * @param {Error} err - error returned from play request
 * @param {object} results - results of the operation
 * @param {String} results.digits - digits collected, if any
 * @param {String} results.terminatorUsed - termination key pressed, if any
 * @param {String} results.playbackSeconds - number of seconds of audio played
 * @param {String} results.playbackMilliseconds - number of fractional milliseconds of audio played
 */

/**
 * This callback is invoked when an operation has completed on the endpoint
 * @callback Endpoint~operationCallback
 * @param {Error} err - error returned from play request
 */
/**
 * This callback is invoked when a freeswitch command has completed on the endpoint
 * @callback Endpoint~mediaOperationsCallback
 * @param {Error} err - error returned from play request
 * @param {object} results freeswitch results
 */

/**
 * Speak a phrase that requires grammar rules
 * @param  {string}   text phrase to speak
 * @param  {Endpoint~sayOptions}   opts - say command options
 * @param  {Endpoint~playOperationCallback} cb - callback function invoked when operation completes
 */

/**
 * Options governing a say command
 * @typedef {Object} Endpoint~sayOptions
 * @property {String} sayType describes the type word or phrase that is being spoken;
 * must be one of the following: 'number', 'items', 'persons', 'messages', 'currency', 'time_measurement',
 * 'current_date', 'current_time', 'current_date_time', 'telephone_number', 'telephone_extensio', 'url',
 * 'ip_address', 'email_address', 'postal_address', 'account_number', 'name_spelled',
 * 'name_phonetic', 'short_date_time'.
 * @property {String} sayMethod method of speaking; must be one of the following: 'pronounced', 'iterated', 'counted'.
 * @property {String} [lang=en] language to speak
 * @property {String} [gender] gender of voice to use, if provided must be one of: 'feminine','masculine','neuter'.
 */

/**
 * Options governing a join operation between an endpoint and a conference
 * @typedef {Object} Endpoint~confJoinOptions
 * @property {string} [pin] entry pin for the conference
 * @property {string} [profile=default] conference profile to use
 * @property {Object} [flags] parameters governing the connection of the endpoint to the conference
 * @property {boolean} [flags.mute=false] enter the conference muted
 * @property {boolean} [flags.deaf=false] enter the conference deaf'ed (can not hear)
 * @property {boolean} [flags.muteDetect=false] Play the mute_detect_sound when
 * talking detected by this conferee while muted
 * @property {boolean} [flags.distDtmf=false] Send any DTMF from this member to all participants
 * @property {boolean} [flags.moderator=false] Flag member as a moderator
 * @property {boolean} [flags.nomoh=false] Disable music on hold when this member is the only member in the conference
 * @property {boolean} [flags.endconf=false] Ends conference when all
 * members with this flag leave the conference after profile param endconf-grace-time has expired
 * @property {boolean} [flags.mintwo=false] End conference when it drops below
 * 2 participants after a member enters with this flag
 * @property {boolean} [flags.ghost=false] Do not count member in conference tally
 * @property {boolean} [flags.joinOnly=false] Only allow joining a conference that already exists
 * @property {boolean} [flags.positional=false] Process this member for positional audio on stereo outputs
 * @property {boolean} [flags.noPositional=false] Do not process this member for positional audio on stereo outputs
 * @property {boolean} [flags.joinVidFloor=false] Locks member as the video floor holder
 * @property {boolean} [flags.noMinimizeEncoding] Bypass the video transcode minimizer
 * and encode the video individually for this member
 * @property {boolean} [flags.vmute=false] Enter conference video muted
 * @property {boolean} [flags.secondScreen=false] Open a 'view only' connection to the conference,
 * without impacting the conference count or data.
 * @property {boolean} [flags.waitMod=false] Members will wait (with music) until a member
 * with the 'moderator' flag set enters the conference
 * @property {boolean} [flags.audioAlways=false] Do not use energy detection to choose which
 * participants to mix; instead always mix audio from all members
 * @property {boolean} [flags.videoBridgeFirstTwo=false] In mux mode, If there are only 2 people
 * in conference, you will see only the other member
 * @property {boolean} [flags.videoMuxingPersonalCanvas=false] In mux mode, each member will get their own canvas
 * and they will not see themselves
 * @property {boolean} [flags.videoRequiredForCanvas=false] Only video participants will be
 * shown on the canvas (no avatars)
 */
/**
 * This callback is invoked when a join operation between an Endpoint and a conference has completed
 * @callback Endpoint~joinOperationCallback
 * @param {Error} err - error returned from join request
 * @param {ConferenceConnection} conn - object representing the connection of this participant to the conference
 */

/**
 * This callback is invoked when an endpoint has been destroyed / released.
 * @callback Endpoint~destroyCallback
 * @param {Error} error, if any
 */


/** execute a freeswitch application on the endpoint
* @method Endpoint#execute
* @param {string} app - application to execute
* @param {string | Array} [args] - arguments
* @param {Endpoint~mediaOperationCallback} cb - callback invoked when a
* CHANNEL_EXECUTE_COMPLETE is received for  the application
 */
/** returns true if the Endpoint is in the 'connected' state
*   @name Endpoint#connected
*   @method
*/

/** modify the endpoint by changing attributes of the media connection
*   @name Endpoint#modify
*   @method
*   @param  {string} sdp - 'hold', 'unhold', or a session description protocol
*   @param  {Endpoint~modifyCallback} [callback] - callback invoked when operation has completed
*/
/**
 * This callback provides the response to a join request.
 * @callback Endpoint~confJoinCallback
 * @param {Error} err  error returned from freeswitch, if any
 * @param {Object} obj an object containing {memberId, conferenceUuid} properties
 */
/**
 * This callback provides the response to a modifySession request.
 * @callback Endpoint~modifyCallback
 * @param {Error} err  non-success sip response code received from far end
 */
/**
 * This callback provides the response to a endpoint operation request of some kind.
 * @callback Endpoint~endpointOperationCallback
 * @param {Error} err - null if operation succeeds; otherwises provides an indication of the error
 */
/**
 * This callback is invoked when the response is received to a command executed on the endpoint
 * @callback Endpoint~mediaOperationCallback
 * @param {Error} err  error returned from freeswitch, if any
 * @param {Object} response - response to the command
 */
/**
 * This callback is invoked when the response is received to a command executed on the endpoint
 * @callback Endpoint~getChannelVariablesCallback
 * @param {Error} err  error returned from freeswitch, if any
 * @param {Object} obj - an object with key-value pairs where the key is channel variable name
 * and the value is the associated value
 */

/**
 * Information describing either the local or remote end of a connection to an Endpoint
 * @typedef {Object} Endpoint~NetworkConnection
 * @property {String} sdp - session description protocol offered
 */
/**
 * Information describing the SIP Dialog that established the Endpoint
 * @typedef {Object} Endpoint~SipInfo
 * @property {String} callId - SIP Call-ID
 */
/**
 * destroy event triggered when the Endpoint is destroyed by the media server.
 * @event Endpoint#destroy
 */


delegate(Endpoint.prototype, '_conn')
  .method('connected')
  .method('filter') ;

delegate(Endpoint.prototype, '_dialog')
  .method('request')
  .method('modify') ;

module.exports = exports = Endpoint ;

const confOperations = {} ;

// conference member unary operations
['mute', 'unmute', 'deaf', 'undeaf', 'kick', 'hup', 'tmute', 'vmute', 'unvmute',
  'vmute-snap', 'saymember', 'dtmf'].forEach((op) => {
  confOperations[op] = (endpoint, args, callback) => {
    assert(endpoint instanceof Endpoint);
    if (typeof args === 'function') {
      callback = args ;
      args = '' ;
    }
    args = args || '';
    if (Array.isArray(args)) args = args.join(' ');

    debug(`Endpoint#conf${_.startCase(op)} endpoint ${endpoint.uuid} memberId ${endpoint.conf.memberId}`);
    const __x = (callback) => {
      if (!endpoint.conf.memberId) return callback(new Error('Endpoint not in conference'));
      endpoint.api('conference', `${endpoint.conf.name} ${op} ${endpoint.conf.memberId} ${args}`, (err, evt) => {
        if (err) return callback(err, evt);
        const body = evt.getBody() ;
        if (-1 !== ['mute', 'deaf', 'unmute', 'undeaf', 'kick', 'tmute', 'vmute', 'unvmute',
          'vmute-snap', 'dtmf'].indexOf(op)) {
          if (/^OK\s+/.test(body)) return callback(err, body);
          return callback(new Error(body));
        }
        return callback(err, evt);
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  };
});

// alias
Endpoint.prototype.unjoin = Endpoint.prototype.confKick ;

confOperations.play = (endpoint, file, opts, callback) => {
  debug(`Endpoint#confPlay endpoint ${endpoint.uuid} memberId ${endpoint.conf.memberId}`);
  assert.ok(typeof file === 'string', '\'file\' is required and must be a file to play') ;

  if (typeof opts === 'function') {
    callback = opts ;
    opts = {} ;
  }
  opts = opts || {} ;

  const __x = (callback) => {
    if (!endpoint.conf.memberId) return callback(new Error('Endpoint not in conference'));

    const args = [] ;
    if (opts.vol) args.push('vol=' + opts.volume) ;
    if (opts.fullScreen) args.push('full-screen=' + opts.fullScreen) ;
    if (opts.pngMs) args.push('png_ms=' + opts.pngMs) ;
    const s1 = args.length ? args.join(',') + ' ' : '';
    const cmdArgs = `${endpoint.conf.name} play ${file} ${s1} ${endpoint.conf.memberId}`;

    endpoint.api('conference', cmdArgs, (err, evt) => {
      const body = evt.getBody() ;
      if (/Playing file.*to member/.test(body)) return callback(null, evt);
      callback(new Error(body));
    });
  };

  if (callback) {
    __x(callback) ;
    return this ;
  }

  return new Promise((resolve, reject) => {
    __x((err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
};

confOperations.transfer = (endpoint, newConf, callback) => {
  const confName = newConf instanceof Conference ? newConf.name : newConf;
  assert.ok(typeof confName === 'string', '\'newConf\' is required and is the name of the conference to transfer to') ;

  const __x = (callback) => {
    if (!endpoint.conf.memberId) return callback(new Error('Endpoint not in conference'));

    endpoint.api('conference', `${endpoint.conf.name} transfer ${confName} ${endpoint.conf.memberId}`, (err, evt) => {
      if (err) return callback(err, evt);
      const body = evt.getBody() ;
      if (/^OK Member.*sent to conference/.test(body)) return callback(null, body);
      callback(new Error(body));
    }) ;
  };

  if (callback) {
    __x(callback) ;
    return this ;
  }

  return new Promise((resolve, reject) => {
    __x((err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
};

function setOrExport(which, endpoint, param, value, callback) {
  assert(which === 'set' || which === 'export');
  assert(typeof param === 'string' ||
    (typeof param === 'object' && (typeof value == 'function' || typeof value === 'undefined')));

  const obj = {} ;
  if (typeof param === 'string') obj[param] = value ;
  else {
    Object.assign(obj, param) ;
    callback = value ;
  }

  const __x = (callback) => {
    async.eachOf(obj, (value, key, callback) => {
      endpoint.execute(which, `${key}=${value}`, callback);
    }, (err) => {
      callback(err);
    }) ;
  } ;

  if (callback) {
    __x(callback) ;
    return endpoint ;
  }

  return new Promise((resolve, reject) => {
    __x((err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

const endpointApps = {} ;

_.each({
  'recordSession': 'record_session'
}, (value, key) => {
  endpointApps[key] = (endpoint, ...args) => {
    const len = args.length ;
    let argList = args ;
    let callback = null ;

    if (typeof args[len - 1] === 'function') {
      argList = args.slice(0, len - 1);
      callback = args[len - 1];
    }
    const __x = (callback) => {
      endpoint.execute(value, argList.join(' '), callback);
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  };
});

