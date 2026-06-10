const transform = require('sdp-transform');
const assert = require('assert');
const debug = require('debug')('drachtio:fsmrf') ;


const parseDecibels = (db) => {
  if (!db) return 0;
  if (typeof db === 'number') {
    return db;
  }
  else if (typeof db === 'string') {
    const match = db.match(/([+-]?\d+(\.\d+)?)\s*db/i);
    if (match) {
      return Math.trunc(parseFloat(match[1]));
    } else {
      return 0;
    }
  } else {
    return 0;
  }
};


// decode a channel-variable value, tolerating values that are not valid
// percent-encoded strings. FreeSWITCH channel variables (e.g. variable_sip_h_*
// copied from carrier SIP headers) may contain a literal '%' that is not part of
// a valid %XX escape, which makes decodeURIComponent throw 'URIError: URI malformed'.
// Throwing here aborts the entire uuid_dump parse (and thus operations such as
// Endpoint.modify), so fall back to the raw value instead of crashing.
const safeDecodeURIComponent = (key, rawValue) => {
  if (undefined === rawValue) return rawValue;
  try {
    return decodeURIComponent(rawValue);
  } catch (err) {
    console.error(`parseBodyText: failed to decodeURIComponent channel var '${key}' ` +
      `(value: '${rawValue}'): ${err.message} - using raw value`);
    return rawValue;
  }
};

const parseBodyText = (txt) => {
  return txt.split('\n').reduce((obj, line) => {
    const data = line.split(': ');
    const key = data.shift();
    const value = safeDecodeURIComponent(key, data.shift());

    if (0 === key.indexOf('variable_rtp_audio') ||
      0 === key.indexOf('variable_rtp_video')  ||
      0 === key.indexOf('variable_playback')) {
      obj[key] = parseInt(value, 10);
    }
    else if (key && key.length > 0) {
      obj[key] = value;
    }

    return obj;
  }, {});
};

const sortFunctor = (codecs, rtp) => {
  const DEFAULT_SORT_ORDER = 999;
  const rtpMap = new Map();
  rtpMap.set(0, 'PCMU');
  rtpMap.set(8, 'PCMA');
  rtpMap.set(18, 'G.729');
  rtpMap.set(18, 'G729');
  rtp.forEach((r) => {
    if (r.codec && r.payload) {
      const name = r.codec.toUpperCase();
      if (name !== 'TELEPHONE-EVENT') rtpMap.set(r.payload, name);
    }
  });

  function score(pt) {
    const n = parseInt(pt);
    if (!rtpMap.has(n)) {
      return DEFAULT_SORT_ORDER;
    }
    const name = rtpMap.get(n);
    if (codecs.includes(name)) {
      return codecs.indexOf(name);
    }
    return DEFAULT_SORT_ORDER;
  }
  return function(a, b) {
    return score(a) - score(b);
  };
};

const modifySdpCodecOrder = (sdp, codecList) => {
  assert(Array.isArray(codecList));

  try {
    const codecs = codecList.map((c) => c.toUpperCase());
    const obj = transform.parse(sdp);
    debug(`parsed SDP: ${JSON.stringify(obj)}`);

    for (let i = 0; i < obj.media.length; i++) {
      const sortFn = sortFunctor(codecs, obj.media[i].rtp);
      debug(`obj.media[i].payloads: ${obj.media[i].payloads}`);
      if (typeof obj.media[i].payloads === 'string') {
        const payloads = obj.media[i].payloads.split(' ');
        debug(`initial list: ${payloads}`);
        payloads.sort(sortFn);
        debug(`resorted payloads: ${payloads}, for codec list ${codecs}`);
        obj.media[i].payloads = payloads.join(' ');
      }
    }
    return transform.write(obj);
  } catch (err) {
    console.log(err, `Error parsing SDP: ${sdp}`);
    return sdp;
  }
};

const pick = (obj, keys) => {
  const list = keys.split(' ');
  return list.reduce((acc, key) => { if (key in obj) acc[key] = obj[key]; return acc; }, {});
};

module.exports = {
  parseDecibels,
  parseBodyText,
  sortFunctor,
  modifySdpCodecOrder,
  pick
};

