MOCHA_OPTS= --check-leaks --bail
REPORTER = spec
NODE_ENV = test
MOCHA = ./node_modules/.bin/mocha --reporter $(REPORTER) $(MOCHA_OPTS)

check: test

test: 
	for file in ./test/unit/*.js; do NODE_ENV=test $(MOCHA) $$file; done

debug-test: 
	for file in ./test/unit/*.js; do NODE_ENV=test, DEBUG=* $(MOCHA) $$file; done

.PHONY:	check test 