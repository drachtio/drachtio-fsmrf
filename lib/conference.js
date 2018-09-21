const Emitter = require('events').EventEmitter ;
const assert = require('assert') ;
const only = require('only') ;
const _ = require('lodash') ;
const async = require('async') ;
const debug = require('debug')('drachtio:fsmrf') ;

const State = {
  NOT_CREATED: 1,
  CREATED: 2,
  DESTROYED: 3
};

function unhandled(evt) {
  debug(`unhandled conference event: ${evt.getHeader('Action')}`) ;
}

/**
 * An audio or video conference mixer.  Conferences may be created on the fly by simply joining an endpoint
 * to a named conference without explicitly creating a Conference object.  The main purpose of the Conference
 * object is to enable the ability to create a conference on the media server without having an inbound call
 * (e.g., to create a scheduled conference at a particular point in time).
 *
 * Note: This constructor should not be called directly: rather, call MediaServer#createConference
 * to create an instance of an Endpoint on a MediaServer
 * @constructor
 * @param {String}   name conference name
 * @param {String}   uuid conference uuid
 * @param {Endpoint} endpoint - endpoint that provides the control connection for the conference
 * @param {Conference~createOptions}  [opts] - conference-level configuration options
 */
class Conference extends Emitter {
  constructor(name, uuid, endpoint, opts) {
    super() ;

    debug('Conference#ctor');
    opts = opts || {} ;

    this._endpoint = endpoint ;

    /**
     * conference name
     * @type {string}
     */

    this.name = name ;

    /**
     * conference unique id
     * @type {string}
     */
    this.uuid = uuid ;

    /**
     * file that conference is currently being recorded to
     * @type {String}
     */
    this.recordFile = null ;

    /**
     * conference state
     * @type {Number}
     */
    this.state = State.CREATED ;

    /**
     * true if conference is locked
     * @type {Boolean}
     */
    this.locked = false ;

    /**
     * member ID of the conference control leg
     * @type {Number}
     */
    this.memberId = this.endpoint.conf.memberId ;

    /**
     * current participants in the conference, keyed by member ID
     * @type {Map}
     */
    this.participants = new Map() ;

    /**
     * max number of members allowed (-1 means no limit)
     * @type {Number}
     */
    this.maxMembers = -1 ;

    // used to track play commands in progress
    this._playCommands = {} ;

    this.endpoint.filter('Conference-Unique-ID', this.uuid);

    this.endpoint.conn.on('esl::event::CUSTOM::*', this.__onConferenceEvent.bind(this)) ;

    if (opts.maxMembers) {
      this.endpoint.api('conference', `${name} set max_members ${opts.maxMembers}`) ;
      this.maxMembers = opts.maxMembers ;
    }
  }

  get endpoint() {
    return this._endpoint ;
  }

  get mediaserver() {
    return this.endpoint.mediaserver ;
  }

  /**
   * destroy the conference, releasing all legs
   * @param  {Conference~operationCallback} callback - callback invoked when conference has been destroyed
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  destroy(callback) {
    debug(`Conference#destroy - destroying conference ${this.name}`);
    const __x = (callback) => {
      this.endpoint.destroy(callback) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * retrieve the current number of participants in the conference
   * @return {Promise} promise that resolves with the count of participants (including control leg)
   */
  getSize() {
    return this.list('count')
      .then((evt) => {
        try {
          return parseInt(evt.getBody()) ;
        } catch (err) {
          throw new Error(`unexpected (non-integer) response to conference list summary: ${err}`);
        }
      });
  }

  /**
 * get a conference parameter value
 * @param  {String}   param - parameter to retrieve
 * @param  {Conference~mediaOperationCallback} [callback] - callback invoked when operation completes
 * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
 * a reference to the Conference object
   */
  get(...args) { return confOperations.get(this, ...args); }
  /**
 * set a conference parameter value
 * @param  {String}   param - parameter to set
 * @param  {String}   value - value
 * @param  {Conference~mediaOperationCallback} [callback] - callback invoked when operation completes
 * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
 * a reference to the Conference object
   */
  set(...args) { return confOperations.set(this, ...args); }

  /**
 * adjust the automatic gain control for the conference
 * @param  {Number|String}   level - 'on', 'off', or a numeric level
 * @param  {Conference~mediaOperationCallback} [callback] - callback invoked when operation completes
 * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
 * a reference to the Conference object
   */
  agc(...args) { return confOperations.agc(this, ...args); }

  /**
   * check the status of the conference recording
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  chkRecord(...args) { return confOperations.chkRecord(this, ...args); }

  /**
   * deaf all the non-moderators in the conference
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  deaf(...args) { return confOperations.deaf(this, ...args); }

  /**
   * undeaf all the non-moderators in the conference
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  undeaf(...args) { return confOperations.undeaf(this, ...args); }

  /**
   * mute all the non-moderators in the conference
   * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  mute(...args) { return confOperations.mute(this, ...args); }
  /**
   * unmute all the non-moderators in the conference
   * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  unmute(...args) { return confOperations.unmute(this, ...args); }

  /**
   * lock the conference
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  lock(...args) { return confOperations.lock(this, ...args); }

  /**
   * unlock the conference
   * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  unlock(...args) { return confOperations.unlock(this, ...args); }

  /**
   * list members
   * @param  {Conference~mediaOperationsCallback} [cb] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  list(...args) { return confOperations.list(this, ...args); }

  /**
   * start recording the conference
   * @param  {String}   file - filepath to record to
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  startRecording(file, callback) {
    assert.ok(typeof file === 'string', '\'file\' parameter must be provided') ;

    const __x = (callback) => {
      this.recordFile = file ;
      this.endpoint.api('conference ', `${this.name} recording start ${file}`, (err, evt) => {
        if (err) return callback(err, evt);
        const body = evt.getBody() ;
        const regexp = new RegExp(`^Record file ${file}\n$`);
        if (regexp.test(body)) {
          return callback(null, body);
        }
        callback(new Error(body));
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, ...results) => {
        if (err) return reject(err);
        resolve(...results);
      });
    });
  }

  /**
   * pause the recording
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  pauseRecording(file, callback) {
    const __x = (callback) => {
      this.recordFile = file ;
      this.endpoint.api('conference ', `${this.name} recording pause ${this.recordFile}`, (err, evt) => {
        if (err) return callback(err, evt);
        const body = evt.getBody() ;
        const regexp = new RegExp(`^Pause recording file ${file}\n$`);
        if (regexp.test(body)) {
          return callback(null, body);
        }
        callback(new Error(body));
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, ...results) => {
        if (err) return reject(err);
        resolve(...results);
      });
    });
  }

  /**
   * resume the recording
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  resumeRecording(file, callback) {
    const __x = (callback) => {
      this.recordFile = file ;
      this.endpoint.api('conference ', `${this.name} recording resume ${this.recordFile}`, (err, evt) => {
        if (err) return callback(err, evt);
        const body = evt.getBody() ;
        const regexp = new RegExp(`^Resume recording file ${file}\n$`);
        if (regexp.test(body)) {
          return callback(null, body);
        }
        callback(new Error(body));
      });
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, ...results) => {
        if (err) return reject(err);
        resolve(...results);
      });
    });
  }

  /**
   * stop the conference recording
   * @param  {Conference~mediaOperationsCallback} [callback] - callback invoked when media operations completes
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  stopRecording(file, callback) {
    const __x = (callback) => {
      this.endpoint.api('conference ', `${this.name} recording stop ${this.recordFile}`, (err, evt) => {
        if (err) return callback(err, evt);
        const body = evt.getBody() ;
        const regexp = new RegExp(`^Stopped recording file ${file}`);
        if (regexp.test(body)) {
          return callback(null, body);
        }
        callback(new Error(body));
      }) ;
      this.recordFile = null ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, ...results) => {
        if (err) return reject(err);
        resolve(...results);
      });
    });
  }

  /**
   * play an audio file or files into the conference
   * @param  {string|Array}   file file (or array of files) to play
   * @param  {Conference~playOperationCallback} [callback] - callback invoked when the files have completed playing
   * @return {Promise|Conference} returns a Promise if no callback supplied; otherwise
   * a reference to the Conference object
   */
  play(file, callback) {
    assert.ok('string' === typeof file || _.isArray(file),
      'file param is required and must be a string or array') ;

    const __x = (callback) => {
      const files = typeof file === 'string' ? [file] : file ;

      // each call to conference play queues the file up;
      // i.e. the callback returns immediately upon successful queueing,
      // not when the file has finished playing
      const queued = [] ;
      async.eachSeries(files, (f, callback) => {
        this.endpoint.api('conference', `${this.name} play ${f}`, (err, result) => {
          if (err) return callback(err);

          if (result && result.body && -1 !== result.body.indexOf(' not found.')) {
            debug(`file ${f} was not queued because it was not found, or conference is empty`);
          }
          else {
            queued.push(f) ;
          }
          callback(null) ;
        }) ;
      }, () => {
        debug(`files have been queued for playback into conference: ${queued}`) ;
        if (queued.length > 0) {
          const firstFile = queued[0] ;
          const obj = {
            remainingFiles: queued.slice(1),
            seconds: 0,
            milliseconds: 0,
            samples: 0,
            done: callback
          };
          this._playCommands[firstFile] = this._playCommands[firstFile] || [] ;
          this._playCommands[firstFile].push(obj) ;
        }
        else {
          // no files actually got queued, so execute the callback
          debug('Conference#play: no files were queued for callback, so invoking callback immediately') ;
          callback(null, {
            seconds: 0,
            milliseconds: 0,
            samples: 0
          }) ;
        }
      }) ;
    };

    if (callback) {
      __x(callback) ;
      return this ;
    }

    return new Promise((resolve, reject) => {
      __x((err, ...results) => {
        if (err) return reject(err);
        resolve(...results);
      });
    });
  }

  _onAddMember(evt) {
    debug(`Conference#_onAddMember: ${JSON.stringify(this)}`) ;
    const size = parseInt(evt.getHeader('Conference-Size')); //includes control leg
    const newMemberId = parseInt(evt.getHeader('Member-ID'))  ;
    const memberType = evt.getHeader('Member-Type') ;
    const memberGhost = evt.getHeader('Member-Ghost') ;
    const channelUuid = evt.getHeader('Channel-Call-UUID') ;
    const obj = {
      memberId: newMemberId,
      type: memberType,
      ghost: memberGhost,
      channelUuid: channelUuid
    } ;
    this.participants.set(newMemberId, obj) ;

    debug(`Conference#_onAddMember: added member ${newMemberId} to ${this.name} size is ${size}`) ;
  }

  _onDelMember(evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    const size = parseInt(evt.getHeader('Conference-Size'));  // includes control leg
    this.participants.delete(memberId) ;
    debug(`Conference#_onDelMember: removed member ${memberId} from ${this.name} size is ${size}`) ;
  }
  _onStartTalking(evt) {
    debug(`Conf ${this.name}:${this.uuid} member ${evt.getHeader('Member-ID')} started talking`) ;
  }
  _onStopTalking(evt) {
    debug(`Conf ${this.name}:${this.uuid}  member ${evt.getHeader('Member-ID')} stopped talking`) ;
  }
  _onMuteDetect(evt) {
    debug(`Conf ${this.name}:${this.uuid}  muted member ${evt.getHeader('Member-ID')} is talking`) ;
  }
  _onUnmuteMember(evt) {
    debug(`Conf ${this.name}:${this.uuid}  member ${evt.getHeader('Member-ID')} has been unmuted`) ;
  }
  _onMuteMember(evt) {
    debug(`Conf ${this.name}:${this.uuid}  member ${evt.getHeader('Member-ID')} has been muted`) ;
  }
  _onKickMember(evt) {
    debug(`Conf ${this.name}:${this.uuid}  member ${evt.getHeader('Member-ID')} has been kicked`) ;
  }
  _onDtmfMember(evt) {
    debug(`Conf ${this.name}:${this.uuid}  member ${evt.getHeader('Member-ID')} has entered DTMF`) ;
  }
  _onStartRecording(evt) {
    debug(`Conference#_onStartRecording: ${this.name}:${this.uuid}  ${JSON.stringify(evt)}`);
    const err = evt.getHeader('Error');
    if (err) {
      const path = evt.getHeader('Path');
      console.log(`Conference#_onStartRecording: failed to start recording to ${path}: ${err}`);
    }
  }
  _onStopRecording(evt) {
    debug(`Conference#_onStopRecording: ${this.name}:${this.uuid}  ${JSON.stringify(evt)}`);
  }
  _onPlayFile(evt) {
    const confName = evt.getHeader('Conference-Name') ;
    const file = evt.getHeader('File') ;
    debug(`conference-level play has started: ${confName}: ${file}`);
  }
  _onPlayFileMember(evt) {
    debug(`member-level play for member ${evt.getHeader('Member-ID')} has completed`) ;
  }
  _onPlayFileDone(evt) {
    const confName = evt.getHeader('Conference-Name') ;
    const file = evt.getHeader('File') ;
    const seconds = parseInt(evt.getHeader('seconds')) ;
    const milliseconds = parseInt(evt.getHeader('milliseconds')) ;
    const samples = parseInt(evt.getHeader('samples')) ;

    debug(`conference-level play has completed: ${confName}: ${file}
      ${seconds} seconds, ${milliseconds} milliseconds, ${samples} samples`);

    // check if the caller registered a callback for this play done
    const el = this._playCommands[file] ;
    if (el) {
      assert(_.isArray(el), 'Conference#onPlayFileDone: this._playCommands must be an array') ;
      const obj = el[0] ;
      obj.seconds += seconds ;
      obj.milliseconds += milliseconds ;
      obj.samples += samples ;

      if (0 === obj.remainingFiles.length) {

        // done playing all files in this request
        obj.done(null, {
          seconds: obj.seconds,
          milliseconds: obj.milliseconds,
          samples: obj.samples
        }) ;
      }
      else {
        const firstFile = obj.remainingFiles[0] ;
        obj.remainingFiles = obj.remainingFiles.slice(1) ;
        this._playCommands[firstFile] = this._playCommands[firstFile] || [] ;
        this._playCommands[firstFile].push(obj) ;
      }

      this._playCommands[file] = this._playCommands[file].slice(1) ;
      if (0 === this._playCommands[file].length) {
        //done with all queued requests for this file
        delete this._playCommands[file] ;
      }
    }
  }

  _onLock(evt) {
    debug(`conference has been locked:  ${JSON.stringify(evt)}`) ;
  }
  _onUnlock(evt) {
    debug(`conference has been unlocked:  ${JSON.stringify(evt)}`) ;
  }
  _onTransfer(evt) {
    debug(`member has been transferred to another conference: ${JSON.stringify(evt)}`) ;
  }
  _onRecord(evt) {
    debug(`conference record has started or stopped: ${evt}`) ;
  }

  __onConferenceEvent(evt) {
    const eventName = evt.getHeader('Event-Subclass') ;
    if (eventName === 'conference::maintenance') {
      const action = evt.getHeader('Action') ;
      debug(`Conference#__onConferenceEvent: conference event action: ${action}`) ;

      //invoke a handler for this action, if we have defined one
      (Conference.prototype[`_on${_.upperFirst(_.camelCase(action))}`] || unhandled).bind(this, evt)() ;

    }
    else {
      debug(`Conference#__onConferenceEvent: got unhandled custom event: ${eventName}`) ;
    }
  }

  toJSON() {
    return only(this, 'name state uuid memberId confConn endpoint maxMembers locked recordFile') ;
  }
  toString() {
    return this.toJSON().toString() ;
  }
}
/**
 * This callback is invoked whenever any media command has completed
 * @callback Conference~mediaOperationCallback
 * @param {Error} err  error returned, if any
 * @param {String} response - response to the command
 */
/**
 * This callback is invoked when a command has completed
 * @callback Conference~operationCallback
 * @param {Error} err  error returned, if any
 */

/**
 * This callback is invoked when a playback to conference command completes with a play done event of the final file.
 * @callback Conference~playOperationCallback
 * @param {Error} err  error returned, if any
 * @param {Conference~playbackResults} [results] - results describing the duration of media played
 */
/**
 * This object describes the options when creating a conference
 * @typedef {Object} Conference~createOptions
 * @property {number} maxMembers - maximum number of members to allow in the conference
 */
/**
 * This object describes the results of a playback into conference operation
 * @typedef {Object} Conference~playbackResults
 * @property {number} seconds - total seconds of media played
 * @property {number} milliseconds - total milliseconds of media played
 * @property {number} samples - total number of samples played
 */

exports = module.exports = Conference ;

const confOperations = {} ;

// conference unary operations
['agc', 'list', 'lock', 'unlock', 'mute', 'deaf', 'unmute', 'undeaf', 'chkRecord'].forEach((op) => {
  confOperations[op] = (conference, args, callback) => {
    assert(conference instanceof Conference);
    if (typeof args === 'function') {
      callback = args ;
      args = '' ;
    }
    args = args || '';
    if (Array.isArray(args)) args = args.join(' ');

    debug(`Conference#${_.startCase(op)} conference ${conference.name} ${args}`);
    const __x = (callback) => {
      conference.endpoint.api('conference', `${conference.name} ${op} ${args}`, (err, evt) => {
        if (err) return callback(err, evt);
        const body = evt.getBody() ;
        if (-1 !== ['lock', 'unlock', 'mute', 'deaf', 'unmute', 'undeaf'].indexOf(op)) {
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

confOperations.set = (conference, param, value, callback) => {
  assert(conference instanceof Conference);
  debug(`Conference#setParam: conference ${conference.name} set ${param} ${value}`);
  const __x = (callback) => {
    conference.endpoint.api('conference', `${conference.name} set ${param} ${value}`, (err, evt) => {
      if (err) return callback(err, evt);
      const body = evt.getBody() ;
      return callback(err, body);
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


confOperations.get = (conference, param, value, callback) => {
  assert(conference instanceof Conference);
  debug(`Conference#getParam: conference ${conference.name} get ${param} ${value}`);
  const __x = (callback) => {
    conference.endpoint.api('conference', `${conference.name} get ${param}`, (err, evt) => {
      if (err) return callback(err, evt);
      const body = evt.getBody() ;
      const res = /^\d+$/.test(body) ? parseInt(body) : body;
      return callback(err, res);
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

