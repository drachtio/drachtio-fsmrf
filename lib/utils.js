
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
