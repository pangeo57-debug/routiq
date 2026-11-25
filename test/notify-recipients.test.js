'use strict';
// Messages about times go to the client, the parent, or both, as chosen.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

test('recipients follow the choice; a parent gets the parent message', () => {
  const app = loadApp();
  app.setState({ settings: settings(), students: [] });
  const N = app.Notify;
  const roles = (o) => N.recipients(student('a', { name: 'Ελένη Π', ...o })).map(x => x.role).join(',');
  assert.equal(roles({ phone: '6900000001' }), 'student');
  assert.equal(roles({ phone: '6900000001', parentPhone: '6900000002' }), 'parent', 'automatic: the parent when there is one');
  assert.equal(roles({ phone: '6900000001', parentPhone: '6900000002', sendTo: 'both' }), 'student,parent');
  assert.equal(roles({ phone: '6900000001', parentPhone: '6900000002', sendTo: 'student' }), 'student');
  assert.equal(roles({ phone: '', parentPhone: '6900000002', sendTo: 'student' }), 'parent', 'the only number there is');
  assert.equal(roles({}), '');
  const row = { st: student('a', { name: 'Ελένη Π' }), before: '', now: 'Δευ 17:00' };
  assert.match(N.message(row, 'parent'), /για Ελένη/);
  assert.match(N.message(row, 'student'), /Γεια σου Ελένη/);
});
