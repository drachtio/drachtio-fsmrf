const test = require('tape') ;
const { parseBodyText } = require('../lib/utils');

// build a uuid_dump-style body from key/value pairs
const dump = (pairs) => pairs.map(([k, v]) => `${k}: ${v}`).join('\n');

test('parseBodyText: parses well-formed channel variables', (t) => {
  const obj = parseBodyText(dump([
    ['variable_local_media_ip', '172.20.11.122'],
    ['variable_dtmf_type', 'rfc2833']
  ]));
  t.equal(obj['variable_local_media_ip'], '172.20.11.122', 'plain value parsed');
  t.equal(obj['variable_dtmf_type'], 'rfc2833', 'plain value parsed');
  t.end();
});

test('parseBodyText: decodes valid percent-encoded values', (t) => {
  const obj = parseBodyText(dump([['variable_x', 'a%20b%2Fc']]));
  t.equal(obj['variable_x'], 'a b/c', 'valid %XX sequences are decoded');
  t.end();
});

test('parseBodyText: coerces rtp/playback counters to integers', (t) => {
  const obj = parseBodyText(dump([
    ['variable_rtp_audio_in_raw_bytes', '12345'],
    ['variable_rtp_video_out_media_packet_count', '42'],
    ['variable_playback_last_offset_pos', '7']
  ]));
  t.equal(obj['variable_rtp_audio_in_raw_bytes'], 12345, 'rtp_audio coerced to number');
  t.equal(typeof obj['variable_rtp_audio_in_raw_bytes'], 'number', 'rtp_audio is a number');
  t.equal(obj['variable_rtp_video_out_media_packet_count'], 42, 'rtp_video coerced to number');
  t.equal(obj['variable_playback_last_offset_pos'], 7, 'playback coerced to number');
  t.end();
});

// regression: a single channel variable containing a stray '%' (not a valid %XX
// escape) used to throw 'URIError: URI malformed' from decodeURIComponent,
// aborting the entire uuid_dump parse and failing Endpoint.modify (re-INVITE -> 500).
test('parseBodyText: does not throw on a stray percent sign', (t) => {
  const body = dump([
    ['variable_rtp_local_sdp_str', 'v=0...'],
    ['variable_caller_name', '50% off SALE'],
    ['variable_dtmf_type', 'rfc2833']
  ]);
  t.doesNotThrow(() => parseBodyText(body), 'stray % does not crash the parser');
  t.end();
});

test('parseBodyText: falls back to the raw value when decoding fails', (t) => {
  const obj = parseBodyText(dump([
    ['variable_caller_name', '50% off SALE'],   // stray %
    ['variable_some_url', 'http://x/a%zz'],      // % followed by non-hex
    ['variable_trailing', 'value%']             // lone % at end of string
  ]));
  t.equal(obj['variable_caller_name'], '50% off SALE', 'stray % value kept raw');
  t.equal(obj['variable_some_url'], 'http://x/a%zz', 'bad %XX value kept raw');
  t.equal(obj['variable_trailing'], 'value%', 'trailing % value kept raw');
  t.end();
});

test('parseBodyText: one undecodable variable does not affect the others', (t) => {
  const obj = parseBodyText(dump([
    ['variable_rtp_local_sdp_str', 'v=0...'],
    ['variable_caller_name', 'bad%value'],      // undecodable
    ['variable_local_media_ip', '172.20.11.122'],
    ['variable_rtp_audio_in_raw_bytes', '999']
  ]));
  t.equal(obj['variable_rtp_local_sdp_str'], 'v=0...', 'preceding variable parsed');
  t.equal(obj['variable_caller_name'], 'bad%value', 'undecodable variable kept raw');
  t.equal(obj['variable_local_media_ip'], '172.20.11.122', 'following variable still parsed');
  t.equal(obj['variable_rtp_audio_in_raw_bytes'], 999, 'following counter still coerced');
  t.end();
});

test('parseBodyText: handles values that themselves contain ": "', (t) => {
  // existing behaviour: split(': ') keeps only the first segment as the value
  const obj = parseBodyText('variable_rtcp: 31825 IN IP4 172.20.11.122');
  t.equal(obj['variable_rtcp'], '31825 IN IP4 172.20.11.122', 'value with no ": " preserved whole');
  t.end();
});
