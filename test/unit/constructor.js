var assert = require('assert');
var should = require('should');
var Mrf = require('../../lib/mrf') ;
var drachtio = require('drachtio') ;
var app = drachtio() ;
var debug = require('debug')('drachtio-fsmrf') ;

describe('MRF', function(){
  it('should throw if no drachtio app supplied', function(){
    var badConstructor = function() { 
      var mrf = new Mrf(); 
    } ;
    badConstructor.should.throw() ;
  }) ;

  it('should not throw if drachtio app supplied', function(){
    var goodConstructor = function() { 
      var mrf = new Mrf(app); 
    } ;
    goodConstructor.should.not.throw() ;
  }) ;

  it('should throw if #connect does not specify an ip address to connect to', function(){
    var badConnect = function() {
      var mrf = new Mrf(app) ;
      debug('calling connect') ;
      mrf.connect({}, function(){}) ;
    } ;
    badConnect.should.throw() ;
  }) ;

  it('should call error callback if connection fails', function(done){
    var mrf = new Mrf(app) ;
    mrf.connect({
      address: '127.0.0.1',
      port: 8333
    }, function() {
      done('unexpected result - should not have connected!!') ;
    }, function(err) {
      done() ;      
    }) ;
  }) ;

  it('should connect successfully to freeswitch', function(done){
    var mrf = new Mrf(app) ;
    mrf.connect({
      address: '127.0.0.1'
    }, function(ms) {
      ms.api('status', function(status){
        debug('status: ', status) ;
        ms.disconnect() ;
        done() ;
      }) ;
      ms.on('error', function(err){
        done(err) ;
      }) ;
    }, function(err) {
      done(err) ;
    }) ;
  }) ;
}) ;
