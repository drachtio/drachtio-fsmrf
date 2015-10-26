exports = module.exports = produceSdp ;

function produceSdp( address, port ) {

  var sdp = 'v=0\n' +
    'o=‐ 1231232312312312312 123123123123123123 IN IP4 {{ip-address}}\n' + 
    's=drachtio null session\n' +
    'c=IN IP4 0.0.0.0\n' +
    't=0 0\n' +
    'm=audio {{port}} RTP/AVP 0\n' +
    'a=rtpmap:0 pcmu/8000\n' +
    'a=ptime:20\n' +
    'a=inactive' ;

  return sdp.replace('{{ip-address}}', address).replace('{{port}}', port) ;
}
