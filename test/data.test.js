'use strict';
/**
 * Data integrity: persistence, migration, and referential integrity.
 * Each test corresponds to a bug that caused (or could cause) real data loss.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

/**
 * Drive App.saveStudent by stubbing the form fields it reads. Returns the app
 * so the caller can inspect state afterwards.
 */
function saveStudentForm(app, fields) {
  const values = Object.assign({
    'st-name': 'Name', 'st-addr': 'Some Street 1', 'st-subject': 'Μαθηματικά',
    'st-dur': '60', 'st-freq': '1', 'st-type': 'solo', 'st-group': '',
    'st-paired': '', 'st-notes': '', 'st-mergemode': 'off', 'st-mergesize': '2',
  }, fields);

  app.ctx.document.getElementById = (id) => {
    if (id in values) return { value: values[id], style: {}, classList: { add() {}, remove() {} } };
    return {
      style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', disabled: false,
      classList: { add() {}, remove() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, remove() {},
      querySelectorAll: () => [], querySelector: () => null,
    };
  };
  app.App._editingExceptions = [];
  app.App.saveStudent();
  return app;
}

describe('pairing integrity', () => {
  test('re-pairing clears the previous partner\'s link', () => {
    const app = loadApp();
    const A = student('A', { pairedWith: 'B' });
    const B = student('B', { pairedWith: 'A' });
    const C = student('C');
    app.setState({ students: [A, B, C], settings: settings(), coords: {}, schedule: {} });
    app.state.editingStudentId = 'A';

    saveStudentForm(app, { 'st-name': 'A', 'st-paired': 'C' });

    const get = id => app.state.students.find(s => s.id === id);
    assert.strictEqual(get('B').pairedWith, null, 'B must not still point at A');
    assert.strictEqual(get('C').pairedWith, 'A', 'C should now be paired back to A');
  });

  test('deleting a student clears their partner\'s link and removes their lessons', () => {
    const app = loadApp();
    const A = student('A', { pairedWith: 'B' });
    const B = student('B', { pairedWith: 'A' });
    app.setState({
      students: [A, B], settings: settings(), coords: { A: { lat: 1, lon: 1 } },
      schedule: { 1: [
        { studentId: 'A', studentName: 'A', start: '15:00', end: '16:00', duration: 60 },
        { studentId: 'B', studentName: 'B', start: '17:00', end: '18:00', duration: 60 },
      ] },
    });
    app.App.confirm = (_t, _x, cb) => cb();  // auto-accept the confirmation
    app.App.deleteStudent('A');

    assert.strictEqual(app.state.students.length, 1);
    assert.strictEqual(app.state.students[0].pairedWith, null, 'B\'s dangling link must be cleared');
    assert.ok(!app.state.schedule[1].some(s => s.studentId === 'A'),
      'deleted student must not keep a ghost lesson');
    assert.ok(!('A' in app.state.coords), 'their coordinates should be dropped too');
  });
});

describe('backup round trip', () => {
  test('export includes coordinates, so import cannot wipe them', () => {
    const app = loadApp();
    app.setState({
      students: [student('A')], settings: settings(),
      coords: { home: { lat: 38.2, lon: 21.7 }, A: { lat: 38.3, lon: 21.8 } },
      schedule: {},
    });

    let written = null;
    app.ctx.Blob = function Blob(parts) { written = parts[0]; };
    app.App.exportData();

    const data = JSON.parse(written);
    assert.ok(data.coords, 'export must contain coords');
    assert.strictEqual(Object.keys(data.coords).length, 2);
    assert.ok(data.students && data.settings, 'and still contain students/settings');
  });
});

describe('migration from older saved data', () => {
  test('settings missing dayHours/blockedSlots are backfilled, not crashed on', () => {
    const app = loadApp();
    const defs = app.defaultSettings();

    // A profile as saved by a much older build.
    const legacy = { teacherName: 'X', homeAddress: 'Y', workDays: [1, 2], language: 'el' };
    app.setState({ settings: legacy });

    // Same backfill App.init performs.
    for (const k in defs) {
      if (app.state.settings[k] === undefined || app.state.settings[k] === null) {
        app.state.settings[k] = defs[k];
      }
    }
    if (!app.state.settings.dayHours || typeof app.state.settings.dayHours !== 'object') {
      app.state.settings.dayHours = defs.dayHours;
    }
    for (const d of app.state.settings.workDays) {
      const dh = app.state.settings.dayHours[d];
      if (!dh || !dh.start || !dh.end) {
        app.state.settings.dayHours[d] = (defs.dayHours && defs.dayHours[d]) || { start: '15:00', end: '22:00' };
      }
    }

    assert.ok(Array.isArray(app.state.settings.blockedSlots), 'blockedSlots must exist');
    for (const d of [1, 2]) {
      assert.ok(app.state.settings.dayHours[d] && app.state.settings.dayHours[d].start,
        `dayHours[${d}] must be usable`);
    }

    // The scheduler reads settings.dayHours[day] unguarded — this must not throw.
    const st = student('s1', { days: [1] });
    assert.doesNotThrow(() =>
      app.Scheduler.findSlotFixed(st, 1, [], app.state.settings, 60));
  });
});

describe('availability exceptions round trip', () => {
  test('a day with no exceptions stays fully available', () => {
    const app = loadApp();
    app.setState({ settings: settings() });
    const av = app.App.computeAvailabilityFromExceptions([]);
    for (const d of app.state.settings.workDays) {
      assert.ok(av[d] && av[d].on, `day ${d} should remain available`);
    }
  });

  test('an exception narrows the day rather than disabling it', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ settings: cfg });
    // Unavailable 15:00-17:00 → should still be available afterwards.
    const av = app.App.computeAvailabilityFromExceptions([{ day: 1, start: '15:00', end: '17:00' }]);
    assert.ok(av[1] && av[1].on, 'the day should not be switched off entirely');
    assert.ok(app.Scheduler.toMin(av[1].start) >= app.Scheduler.toMin('17:00'),
      `expected availability to start at/after 17:00, got ${av[1].start}`);
  });

  test('an all-day exception marks the day unavailable', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ settings: cfg });
    const av = app.App.computeAvailabilityFromExceptions([{ day: 1, start: '15:00', end: '22:00' }]);
    assert.ok(!av[1] || !av[1].on, 'a full-day block should switch the day off');
  });

  test('a day cut into two windows reports the one it has to discard', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ settings: cfg });
    // 15:00-17:00 free, blocked 17:00-18:00, 18:00-22:00 free. The schema keeps
    // one window per day, so the 2h morning gap loses to the 4h evening one —
    // but the user must be told, not silently robbed of two usable hours.
    const dropped = [];
    const av = app.App.computeAvailabilityFromExceptions(
      [{ day: 1, start: '17:00', end: '18:00' }], dropped);
    assert.equal(av[1].start, '18:00');
    assert.equal(av[1].end, '22:00');
    assert.equal(dropped.length, 1, 'the discarded window should be reported');
    assert.equal(dropped[0].start, '15:00');
    assert.equal(dropped[0].end, '17:00');
  });

  test('nothing is reported when only one window survives', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ settings: cfg });
    const dropped = [];
    app.App.computeAvailabilityFromExceptions([{ day: 1, start: '15:00', end: '17:00' }], dropped);
    assert.equal(dropped.length, 0);
  });
});

describe('storage failures', () => {
  test('a failed save is reported, not swallowed', () => {
    const app = loadApp();
    // localStorage fills up (a few MB) and Safari in private mode rejects
    // writes outright. Swallowing that is the worst outcome for an app whose
    // data lives only on this device: the user is told the student is saved,
    // closes the app, and it is gone.
    app.ctx.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    const warned = [];
    app.ctx.document.getElementById = () => ({ appendChild(){}, });
    app.ctx.document.createElement = () => ({ className:'', style:{}, children:[],
      set textContent(v){ warned.push(v); }, get textContent(){ return ''; },
      set innerHTML(v){}, get innerHTML(){ return ''; },
      appendChild(c){ this.children.push(c); }, remove(){} });

    const ok = app.Storage.set('rp_students', [{ id: 's1' }]);

    assert.equal(ok, false, 'the caller must be able to tell the write failed');
    assert.ok(warned.some(w => w && w.length), 'and the user must be told');
  });

  test('a successful save reports success', () => {
    const app = loadApp();
    assert.equal(app.Storage.set('rp_students', [{ id: 's1' }]), true);
  });
});
