#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'server.js'), 'utf8');

assert.match(source, /Verification URL: \$\{baseUrl\}\/verify/, 'startup should keep the verification URL because wallet and captcha flows use it');
assert.match(source, /Portal URL: \$\{baseUrl\}\/app/, 'startup should advertise the canonical portal URL');
assert.doesNotMatch(source, /Dashboard URL:/, 'startup should not advertise the legacy dashboard alias');
assert.doesNotMatch(source, /Admin Portal URL:/, 'startup should not advertise the legacy admin alias');
assert.match(source, /'\/dashboard': 'dashboard'/, 'legacy dashboard bookmarks should remain compatible');
assert.match(source, /'\/admin': 'admin'/, 'legacy admin bookmarks should remain compatible');

console.log('web startup URL assertions passed');
