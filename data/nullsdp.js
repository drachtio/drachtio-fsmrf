exports = module.exports = produceSdp ;

function produceSdp( address, port ) {

  var sdp = ['v=0', 
    'o=- 1111 0 IN IP4 {{ip-address}}',
    's=drachtio session',
    'c=IN IP4 0.0.0.0',
    't=0 0',
    'm=audio 50000 RTP/AVP 0',
    'a=inactive\r\n'] ;

  return sdp.join('\r\n').replace('{{ip-address}}', address).replace('{{port}}', port) ;
}

