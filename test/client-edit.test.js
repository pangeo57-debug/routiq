'use strict';
// A change to a client shows in the week at once: name, address, subject.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

test('name, address and subject follow the client into the week; a pair shows both names', () => {
  const app = loadApp();
  const a = student('a', { name: 'Ελένη', address: 'Παλιά 1' }), b = student('b', { name: 'Τάκης', address: 'Ψαρών 2' });
  app.setState({ students: [a, b], settings: settings(), schedule: {
    1: [{ studentId: 'a', studentName: 'Ελένη', address: 'Παλιά 1', subject: '', start: '15:00', end: '16:00' }],
    2: [{ studentId: 'b', studentName: 'Ελένη & Τάκης', address: 'Ψαρών 2', groupMemberIds: ['a', 'b'], start: '17:00', end: '18:00' }] } });
  const renamed = { ...a, name: 'Ελένη Π.', address: 'Νέα 5', subject: 'Φυσική' };
  app.state.students[0] = renamed;
  app.App._clientChanged(renamed);
  const s1 = app.state.schedule[1][0], s2 = app.state.schedule[2][0];
  assert.equal(s1.studentName, 'Ελένη Π.'); assert.equal(s1.address, 'Νέα 5'); assert.equal(s1.subject, 'Φυσική');
  assert.equal(s2.studentName, 'Ελένη Π. & Τάκης'); assert.equal(s2.address, 'Ψαρών 2', 'the pair meets at the other one’s place');
});

test('a change that the week no longer holds asks for a new plan; one it still holds does not', () => {
  const app = loadApp();
  const a = student('a', { name: 'Άννα', days: [1], window: { start: '15:00', end: '20:00' } });
  app.setState({ students: [a], settings: settings({ workDays: [1] }), coords: {},
    schedule: { 1: [{ studentId: 'a', studentName: 'Άννα', address: a.address, start: '16:00', end: '17:00', duration: 60 }] } });
  const before = new Set(app.Scheduler.verifyWithFixed(app.state.schedule, app.state.students, app.state.settings));
  assert.equal(app.App._weekNeedsPlan(a, before, []), false, 'nothing changed that matters');
  const late = student('a', { name: 'Άννα', days: [1], window: { start: '18:00', end: '20:00' } });
  app.state.students[0] = late;
  assert.equal(app.App._weekNeedsPlan(late, before, []), true, 'her hours moved past her lesson');
});
