'use strict';
// Who can share a session, and who can take a freed one: by class and subject, as the person sets it.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, cityCoords } = require('./harness');

test('pairs follow the criteria: same class, same subject, distance; unknown does not rule out', () => {
  const app = loadApp();
  const S = app.Scheduler;
  const mk = (id, o) => student(id, { lessonDuration: 60, lessonsPerWeek: 1, days: [1, 2], window: { start: '15:00', end: '20:00' }, ...o });
  const a = mk('a', { grade: 'b_gym', subject: 'Μαθηματικά' }), b = mk('b', { grade: 'b_gym', subject: 'Μαθηματικά' });
  const c = mk('c', { grade: 'c_lyk', subject: 'Μαθηματικά' }), d = mk('d', { grade: 'b_gym', subject: 'Φυσική' }), e = mk('e', {});
  const cfg = settings({ workDays: [1, 2] });
  const coords = {};
  [a, b, c, d, e].forEach((s, i) => { coords[s.id] = { lat: 38.25 + i * 0.001, lon: 21.73 }; });
  const ok = (x, y, crit) => !!S.pairViability(x, y, cfg, coords, crit);
  const both = { grade: true, subject: true, maxKm: 3 };
  assert.ok(ok(a, b, both));
  assert.ok(!ok(a, c, both), 'another class');
  assert.ok(!ok(a, d, both), 'another subject');
  assert.ok(ok(a, e, both), 'not set: not ruled out');
  assert.ok(ok(a, c, { ...both, grade: false }), 'class not asked for');
  assert.ok(ok(a, d, { ...both, subject: false }), 'subject not asked for');
  assert.ok(!ok(a, b, { ...both, maxKm: 0.05 }), 'too far for the distance chosen');
});

test('a freed stretch can be offered only to the same class and subject', () => {
  const app = loadApp();
  const days = [1, 2, 3, 4, 5];
  const mk = (id, o) => student(id, { name: id, address: 'Οδός ' + id, lessonDuration: 60, lessonsPerWeek: 1, days, window: { start: '14:00', end: '21:00' }, ...o });
  const sts = [mk('gone', { grade: 'b_gym', subject: 'Μαθηματικά' }), mk('same', { grade: 'b_gym', subject: 'Μαθηματικά' }), mk('other', { grade: 'a_lyk', subject: 'Χημεία' })];
  const date = '2026-11-30'; // a Monday
  app.setState({ students: sts, settings: settings({ workDays: days }), coords: cityCoords(sts),
    schedule: { 1: [{ studentId: 'gone', studentName: 'gone', address: 'Οδός gone', start: '16:00', end: '17:00', duration: 60 }] } });
  app.DayFill.cancel(date, 'gone', '16:00');
  const names = (m) => app.DayFill.options(date, '16:00', m).options.filter(o => !o.pair).map(o => o.st.id).sort().join(',');
  assert.equal(names({}), 'other,same');
  assert.equal(names({ grade: true }), 'same');
  assert.equal(names({ subject: true }), 'same');
  assert.ok(app.DayFill.options(date, '16:00', {}).options.find(o => o.st && o.st.id === 'same').alike, 'marked as alike');
});
