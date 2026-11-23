'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

describe('the week in the phone\'s calendar', () => {
  function world(over = {}) {
    const app = loadApp();
    app.setState({ settings: settings(over), students: [student('k', { name: 'Κοραλίνα' }), student('n', { name: 'Νίκος', cadence: 2, cadenceFrom: '2026-11-30' })],
      coords: {}, jobs: [], schedule: { 2: [slot('k', '17:00', '18:00', { studentName: 'Κοραλίνα', address: 'Ψαρών 11' })], 4: [slot('n', '15:00', '16:00', { studentName: 'Νίκος' })] } });
    return app;
  }
  test('each appointment repeats weekly, with the reminder the person chose', () => {
    const app = world({ remindMin: 120 });
    const ics = app.App.buildWeekICS(app.App.remindMin(), '2026-11-25');
    assert.match(ics, /DTSTART:20261124T170000\r\nDTEND:20261124T180000\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Κοραλίνα/);
    assert.match(ics, /LOCATION:Ψαρών 11/);
    assert.match(ics, /TRIGGER:-PT120M/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  });
  test('a client every 2 weeks starts on one of their weeks and repeats every 2', () => {
    const ics = world().App.buildWeekICS(15, '2026-11-25');
    assert.match(ics, /DTSTART:20261203T150000[\s\S]*?RRULE:FREQ=WEEKLY;INTERVAL=2\r\nSUMMARY:Νίκος/);
  });
  test('the lead time is the person\'s, 15 minutes unless set', () => {
    assert.equal(world().App.remindMin(), 15);
    assert.equal(world({ remindMin: 60 }).App.remindMin(), 60);
  });
});
