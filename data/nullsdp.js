exports = module.exports = produceSdp ;

function produceSdp( address, port ) {

  var sdp = ['v=0', 
    'o=- 1111 0 IN IP4 ip-address',
    's=drachtio session',
    'c=IN IP4 ip-address',
    't=0 0',
    'm=audio 50000 RTP/AVP 0 101',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-15',
    'a=inactive\r\n'] ;

  return sdp.join('\r\n').replace(/ip-address/g, address).replace(/port/g, port) ;
}

