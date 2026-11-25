'use strict';
// Errors are kept on the phone, short, and leave only inside a report the person sends.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./harness');

test('keeps the last 15 errors, counts repeats, and holds no more than the message and the place in code', () => {
  const app = loadApp();
  const E = app.ctx.ErrorLog || app.ErrorLog;
  assert.ok(E, 'ErrorLog reachable');
  E.clear();
  E.add('x is undefined', 'https://example.test/js/app.js:120');
  E.add('x is undefined', 'https://example.test/js/app.js:120');
  for (let i = 0; i < 20; i++) E.add('e' + i, '');
  const l = E.list();
  assert.equal(l.length, 15);
  assert.ok(!l.some(e => /example\.test/.test(e.where)), 'no address of the site, only the file');
  assert.match(E.text(), /e19/);
  E.clear(); E.add('boom', 'app.js:1'); E.add('boom', 'app.js:1');
  assert.match(E.text(), /×2/);
});
