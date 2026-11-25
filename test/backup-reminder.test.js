'use strict';
// Data lives on the phone only: Home asks for a copy, now and then.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

test('asks when there is no copy or it is two weeks old; not with no clients; "later" waits a week', () => {
  const app = loadApp();
  const localStorage = app.ctx.localStorage;
  app.setState({ students: [], settings: settings() });
  assert.equal(app.App.backupDue(), null, 'nothing to lose yet');
  app.setState({ students: [student('a')] });
  assert.deepEqual(app.App.backupDue(), { days: null }, 'never saved');
  const now = Date.now();
  localStorage.setItem('rp_last_backup', String(now - 3 * 864e5));
  assert.equal(app.App.backupDue(now), null, 'a recent copy');
  localStorage.setItem('rp_last_backup', String(now - 20 * 864e5));
  assert.deepEqual(app.App.backupDue(now), { days: 20 });
  localStorage.setItem('rp_backup_snooze', String(now + 7 * 864e5));
  assert.equal(app.App.backupDue(now), null, 'later: not this week');
});
