'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

function world() {
  const app = loadApp();
  const sts = [student('a', { name: 'Γιώργος Παπάς', phone: '6941234567' }), student('b', { name: 'Ελένη' })];
  app.setState({ settings: settings({ teacherName: 'Μαρία' }), students: sts, coords: {}, jobs: [],
    schedule: { 1: [slot('a', '15:00', '16:00')], 2: [slot('b', '17:00', '18:00')] } });
  return app;
}

describe('telling clients whose times changed', () => {
  test('the first week is taken as known: nobody is listed', () => {
    const app = world();
    assert.deepStrictEqual(Array.from(app.Notify.changed(), r => r.st.id), []);
  });
  test('a moved lesson lists that client only, with before and after', () => {
    const app = world();
    app.Notify.changed();                                    // baseline
    app.state.schedule[1] = [slot('a', '17:00', '18:00')];
    const rows = app.Notify.changed();
    assert.deepStrictEqual(Array.from(rows, r => r.st.id), ['a']);
    assert.match(rows[0].before, /15:00–16:00/); assert.match(rows[0].now, /17:00–18:00/);
    const msg = app.Notify.message(rows[0]);
    assert.match(msg, /Γιώργος/); assert.match(msg, /17:00–18:00/); assert.match(msg, /Μέχρι τώρα: .*15:00–16:00/);
  });
  test('telling a client, or telling everyone, clears them', () => {
    const app = world();
    app.Notify.changed();
    app.state.schedule[1] = [slot('a', '17:00', '18:00')];
    app.state.schedule[2] = [slot('b', '19:00', '20:00')];
    app.Notify.markTold('a');
    assert.deepStrictEqual(Array.from(app.Notify.changed(), r => r.st.id), ['b']);
    app.Notify.markAll();
    assert.equal(app.Notify.changed().length, 0);
  });
  test('the person\'s own message is used, with the blanks filled in', () => {
    const app = world();
    app.Notify.changed();
    app.state.schedule[1] = [slot('a', '17:00', '18:00')];
    app.state.settings.changeMessage = '{name}, νέα ώρα: {new} — {me}';
    const msg = app.Notify.message(app.Notify.changed()[0]);
    assert.match(msg, /^Γιώργος, νέα ώρα: .*17:00–18:00 — Μαρία$/);
  });
});
