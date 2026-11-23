'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

describe('every 2 or 4 weeks', () => {
  test('a client on a 2-week rhythm shows on their weeks only, counted from when it was set', () => {
    const app = loadApp();
    const C = app.Cadence;
    const st = student('a', { cadence: 2, cadenceFrom: '2026-11-25' });   // a Wednesday
    assert.equal(C.onWeek(st, '2026-11-23'), true, 'same week (Monday)');
    assert.equal(C.onWeek(st, '2026-11-30'), false);
    assert.equal(C.onWeek(st, '2026-12-07'), true);
    assert.equal(C.onWeek(student('b'), '2026-11-30'), true, 'weekly clients every week');
    assert.equal(C.onWeek(student('c', { cadence: 4, cadenceFrom: '2026-11-23' }), '2026-12-21'), true);
    assert.equal(C.onWeek(student('c', { cadence: 4, cadenceFrom: '2026-11-23' }), '2026-12-14'), false);
  });
  test('Home leaves them out on their off week', () => {
    const app = loadApp();
    app.setState({ settings: settings(), students: [student('a', { cadence: 2, cadenceFrom: '2026-11-23' }), student('b')], coords: {}, jobs: [],
      schedule: { 1: [slot('a', '15:00', '16:00'), slot('b', '17:00', '18:00')] } });
    const ids = (d) => Array.from(app.App._todayAgenda(d), x => x.id);
    assert.deepStrictEqual(ids('2026-11-23'), ['a', 'b']);
    assert.deepStrictEqual(ids('2026-11-30'), ['b']);
  });
});
