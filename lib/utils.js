const transform = require('sdp-transform');
const assert = require('assert');
const debug = require('debug')('drachtio:fsmrf') ;

const obj = {} ;
module.exports = obj;

obj.parseBodyText = (txt) => {
  return txt.split('\n').reduce((obj, line) => {
    const data = line.split(': ');
    const key = data.shift();
    const value = decodeURIComponent(data.shift());

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

function sortFunctor(codecs, rtp) {
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
  }
}

obj.modifySdpCodecOrder = (sdp, codecList) => {
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

