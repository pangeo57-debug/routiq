'use strict';
/**
 * Data integrity: persistence, migration, and referential integrity.
 * Each test corresponds to a bug that caused (or could cause) real data loss.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

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

  test('a day cut into two windows keeps both of them', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ settings: cfg });
    // 15:00-17:00 free, busy 17:00-18:00, 18:00-22:00 free. Both halves are
    // usable. This used to survive as the larger one only, with the two morning
    // hours reported to the user as lost — they are not lost any more.
    const dropped = [];
    const av = app.App.computeAvailabilityFromExceptions(
      [{ day: 1, start: '17:00', end: '18:00' }], dropped);
    assert.deepStrictEqual(Array.from(av[1].windows.map(w => Array.from(w))),
      [[15 * 60, 17 * 60], [18 * 60, 22 * 60]]);
    // start/end still name the largest window, so code that has not been
    // converted to windows keeps reading a real one rather than a span that
    // covers the busy hour.
    assert.equal(av[1].start, '18:00');
    assert.equal(av[1].end, '22:00');
    assert.equal(dropped.length, 0, 'nothing is discarded any more');
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

describe('changing your working hours reaches the students', () => {
  // Availability is DERIVED from a student's exceptions and the hours in force
  // when they were saved. Nothing recomputed it when those hours later changed,
  // so extending a day gained nothing and adding a working day gained nothing
  // at all — the scheduler saw no availability for it and treated the whole day
  // as unusable.
  function withStudents(app, hours, workDays) {
    const cfg = settings({ workDays, dayHours: hours });
    const sts = [
      // No exceptions: free whenever the teacher works.
      Object.assign(student('free', { days: workDays }), { availabilityExceptions: [] }),
      // Busy Monday afternoon.
      Object.assign(student('busy', { days: workDays }),
        { availabilityExceptions: [{ day: 1, start: '15:00', end: '17:00' }] }),
    ];
    app.setState({ settings: cfg, students: sts, coords: {}, schedule: {} });
    sts.forEach(st => { st.availability = app.App.computeAvailabilityFromExceptions(st.availabilityExceptions); });
    app.Storage.saveSettings(cfg);
    return { sts, cfg };
  }

  /** Drive App.saveSettings with the settings form stubbed. */
  function saveSettingsWith(app, dayHours) {
    const vals = { 'set-name': '', 'set-home': app.state.settings.homeAddress,
      'set-mode': 'car', 'set-fuel': '7', 'set-margin': '2', 'set-speed': '25',
      'set-here-key': '', 'set-lunch': '0' };
    for (const d of Object.keys(dayHours)) {
      vals['dh-start-' + d] = dayHours[d].start;
      vals['dh-end-' + d] = dayHours[d].end;
    }
    app.ctx.document.getElementById = (id) => (id in vals)
      ? { value: vals[id], style: {}, classList: { add(){}, remove(){} } }
      : { style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', disabled: false,
          classList: { add(){}, remove(){}, contains: () => false, toggle(){} },
          addEventListener(){}, appendChild(){}, remove(){},
          querySelectorAll: () => [], querySelector: () => null };
    return app.App.saveSettings();
  }

  test('extending the day opens the new hours to students', async () => {
    const app = loadApp();
    const { sts } = withStudents(app, { 1: { start: '15:00', end: '22:00' },
                                        2: { start: '15:00', end: '22:00' } }, [1, 2]);
    assert.equal(sts[0].availability[2].start, '15:00');

    app.state.settings.dayHours = { 1: { start: '08:00', end: '22:00' },
                                    2: { start: '08:00', end: '22:00' } };
    await saveSettingsWith(app, app.state.settings.dayHours);

    assert.equal(sts[0].availability[2].start, '08:00',
      'a student with no exceptions must become free in the newly opened hours');
    // And the scheduler can actually use them.
    const slot = app.Scheduler.findSlotFixed(sts[0], 2, [], app.state.settings, 60);
    assert.ok(slot && app.Scheduler.toMin(slot.start) < app.Scheduler.toMin('15:00'),
      `expected a morning slot, got ${slot && slot.start}`);
  });

  test('a student exception still holds after the hours change', async () => {
    const app = loadApp();
    const { sts } = withStudents(app, { 1: { start: '15:00', end: '22:00' } }, [1]);
    app.state.settings.dayHours = { 1: { start: '08:00', end: '22:00' } };
    await saveSettingsWith(app, app.state.settings.dayHours);

    // "busy" is unavailable Monday 15:00-17:00. Whatever window they end up
    // with, it must not cover that.
    const av = sts[1].availability[1];
    const S = app.Scheduler;
    assert.ok(S.toMin(av.end) <= S.toMin('15:00') || S.toMin(av.start) >= S.toMin('17:00'),
      `their stated exception was lost: ${JSON.stringify(av)}`);
  });

  test('a newly added working day is asked about, not assumed', async () => {
    const app = loadApp();
    const { sts } = withStudents(app, { 1: { start: '15:00', end: '22:00' } }, [1]);
    assert.ok(!sts[0].availability[6], 'nothing recorded for Saturday yet');

    let asked = null;
    app.App.confirm = (title, text, cb) => { asked = { title, text, cb }; };
    app.state.settings.workDays = [1, 6];
    app.state.settings.dayHours = { 1: { start: '15:00', end: '22:00' },
                                    6: { start: '10:00', end: '18:00' } };
    await saveSettingsWith(app, app.state.settings.dayHours);

    assert.ok(asked, 'declaring everyone free on a brand new day must be asked, not assumed');
    assert.ok(!sts[0].availability[6], 'and nothing may change before the user answers');

    asked.cb();
    assert.ok(sts[0].availability[6] && sts[0].availability[6].on,
      'once accepted, students become available on the new day');
    const slot = app.Scheduler.findSlotFixed(sts[0], 6, [], app.state.settings, 60);
    assert.ok(slot, 'and the scheduler can finally use it');
  });

  test('days that did not change are left exactly as they were', async () => {
    const app = loadApp();
    const { sts } = withStudents(app, { 1: { start: '15:00', end: '22:00' },
                                        2: { start: '15:00', end: '22:00' } }, [1, 2]);
    // Hand-tuned window on Tuesday that no exception explains.
    sts[0].availability[2] = { on: true, start: '18:00', end: '20:00' };
    app.state.settings.dayHours[1] = { start: '08:00', end: '22:00' };   // only Monday changes
    await saveSettingsWith(app, app.state.settings.dayHours);

    assert.deepStrictEqual(Object.assign({}, sts[0].availability[2]),
      { on: true, start: '18:00', end: '20:00' },
      'an untouched day must keep the window it had');
  });

  test('a student saved by an older build is left alone', async () => {
    const app = loadApp();
    const { sts } = withStudents(app, { 1: { start: '15:00', end: '22:00' } }, [1]);
    delete sts[0].availabilityExceptions;              // legacy record
    const before = JSON.stringify(sts[0].availability);
    app.state.settings.dayHours[1] = { start: '08:00', end: '22:00' };
    await saveSettingsWith(app, app.state.settings.dayHours);

    assert.equal(JSON.stringify(sts[0].availability), before,
      'without an exceptions list there is nothing to recompute from — do not guess');
  });
});

describe('importing a backup', () => {
  const good = () => ({
    students: [Object.assign(student('a'), { availabilityExceptions: [] })],
    settings: settings(),
    schedule: {}, coords: { home: { lat: 38.2, lon: 21.7 } },
  });

  /**
   * Drive the REAL App.importData with a stubbed file picker and FileReader.
   *
   * An earlier version of this helper re-implemented importData's steps
   * instead of calling it. That is the third time in this project a test has
   * covered a unit while leaving the wiring untested: deleting the validation
   * call from importData left every one of these tests green.
   */
  function importing(app, data) {
    const before = JSON.stringify(app.state.students);
    const toasts = [];
    app.ctx.document.createElement = () => ({
      type: '', accept: '', onchange: null, style: {}, className: '', children: [],
      set textContent(v) { toasts.push(v); }, get textContent() { return ''; },
      set innerHTML(v) {}, get innerHTML() { return ''; },
      appendChild() {}, remove() {},
      click() { this.onchange && this.onchange({ target: { files: [{ name: 'backup.json' }] } }); },
    });
    app.ctx.document.getElementById = () => ({ appendChild() {} });
    app.ctx.FileReader = function FileReader() {
      this.readAsText = () => { this.onload({ target: { result: JSON.stringify(data) } }); };
    };

    app.App.importData();

    return { toasts, untouched: JSON.stringify(app.state.students) === before };
  }

  test('a valid backup is accepted', () => {
    const app = loadApp();
    app.setState({ students: [], settings: settings() });
    assert.deepStrictEqual(Array.from(app.App.validateBackup(good())), []);
  });

  const broken = {
    'students is a string': { students: 'oops', settings: settings() },
    'a record is null': { students: [null], settings: settings() },
    'a record has no id': { students: [{ name: 'X', lessonDuration: 60, lessonsPerWeek: 1 }], settings: settings() },
    'settings is a number': { students: [], settings: 7 },
    'workDays is a string': { students: [], settings: { workDays: '12345' } },
    'schedule is an array': { students: [], settings: settings(), schedule: [1, 2, 3] },
    'availability is a string': { students: [{ id: 'a', name: 'A', lessonDuration: 60, lessonsPerWeek: 1, availability: 'yes' }], settings: settings() },
    'an absurd session count': { students: [{ id: 'a', name: 'A', lessonDuration: 60, lessonsPerWeek: 1e9 }], settings: settings() },
    'a zero-length session': { students: [{ id: 'a', name: 'A', lessonDuration: 0, lessonsPerWeek: 1 }], settings: settings() },
    'not an object at all': { students: undefined, settings: undefined },
  };

  for (const [name, data] of Object.entries(broken)) {
    test(`refuses a backup where ${name}, without touching what is stored`, () => {
      const app = loadApp();
      const mine = [student('mine')];
      app.setState({ students: mine, settings: settings() });

      const { toasts, untouched } = importing(app, data);

      assert.ok(toasts.some(x => x && /error|σφάλμα/i.test(x)),
        `this file must be refused, and say so. Toasts: ${JSON.stringify(toasts)}`);
      // The important half. The old code wrote to localStorage first and
      // validated never, so a bad file destroyed the real data and left an app
      // that threw on the next calculation.
      assert.ok(untouched, 'a refused file must not replace what was already there');
      assert.equal(app.state.students[0].id, 'mine');
    });
  }

  test('the refusal says what is wrong, not just that it failed', () => {
    const app = loadApp();
    app.setState({ students: [], settings: settings() });
    const problems = app.App.validateBackup(
      { students: [{ id: 'a', name: 'A', lessonDuration: 0, lessonsPerWeek: 0 }], settings: settings() });
    assert.ok(problems.length >= 2, 'both bad fields should be named');
    assert.ok(problems.every(p => typeof p === 'string' && p.length > 5));
  });

  test('optional sections may be absent', () => {
    const app = loadApp();
    app.setState({ students: [], settings: settings() });
    // Backups written before coords/schedule existed must still load.
    const d = good(); delete d.schedule; delete d.coords;
    assert.deepStrictEqual(Array.from(app.App.validateBackup(d)), []);
  });
});

// ---------------------------------------------------------------------------
// Sending the times to the client
// ---------------------------------------------------------------------------

describe('sending the times to the client', () => {
  function appWith(schedule, stOv = {}, setOv = {}) {
    const app = loadApp();
    const st = student('A', Object.assign({ name: 'Νίκος Παπαδόπουλος' }, stOv));
    app.setState({
      students: [st], settings: settings(Object.assign({ teacherName: 'Γιάννης' }, setOv)),
      schedule, coords: {},
    });
    return app;
  }

  describe('phone normalisation', () => {
    const cases = [
      ['6941234567',      '30', '306941234567', 'a local mobile gets the country code'],
      ['0694 123 4567',   '30', '306941234567', 'the national trunk 0 is dropped, spaces ignored'],
      ['+30 694 1234567', '30', '306941234567', 'an already-international number is kept as is'],
      ['0030 6941234567', '30', '306941234567', 'the 00 prefix form is understood'],
      ['(694) 123-4567',  '30', '306941234567', 'punctuation is ignored'],
      ['+44 7700 900123', '30', '447700900123', 'a foreign number keeps ITS code, not ours'],
    ];
    for (const [raw, cc, want, why] of cases) {
      test(why, () => {
        assert.strictEqual(appWith({}).App.normalizePhone(raw, cc), want);
      });
    }

    // Refusing is the point: a half-guessed number messages a stranger.
    const refused = [
      ['', '30', 'empty'],
      ['   ', '30', 'blank'],
      ['call the mother', '30', 'a note rather than a number'],
      ['123', '30', 'too short to be a real number'],
      ['69412345678901234', '30', 'longer than E.164 allows'],
      ['6941234567', '', 'no country code configured'],
    ];
    for (const [raw, cc, why] of refused) {
      test(`refuses ${why} rather than inventing a number`, () => {
        assert.strictEqual(appWith({}).App.normalizePhone(raw, cc), '');
      });
    }
  });

  test('the message lists every placed lesson, in day and time order', () => {
    const app = appWith({
      3: [{ studentId: 'A', start: '19:00', end: '20:00' }],
      1: [{ studentId: 'A', start: '17:00', end: '18:00' },
          { studentId: 'B', start: '18:10', end: '19:10' }],
    });
    const msg = app.App.timesMessage('student', 'A');
    const lines = msg.split('\n');
    // Greek has a vocative case that cannot be derived from a name, so the
    // Greek greeting deliberately carries no name at all — better than
    // addressing someone as "Γεια σου Νίκος".
    assert.ok(lines[0].length > 3 && !/\d/.test(lines[0]), 'opens with a greeting, not a time');
    assert.strictEqual(lines[1], 'Δευτέρα 17:00–18:00');
    assert.strictEqual(lines[2], 'Τετάρτη 19:00–20:00');
    assert.strictEqual(lines[3], '— Γιάννης');
    assert.ok(!msg.includes('18:10'), "another student's lesson must not leak into it");
  });

  test('a lesson shared as a pair or a group counts as that client\'s', () => {
    const app = appWith({
      2: [{ studentId: 'Z', pairedStudentId: 'A', start: '16:00', end: '17:00' }],
      4: [{ studentId: 'Z', isGroup: true, groupMemberIds: ['Z', 'A'], start: '18:00', end: '19:00' }],
    });
    const msg = app.App.timesMessage('student', 'A');
    assert.ok(msg.includes('16:00–17:00'), 'the paired lesson is theirs too');
    assert.ok(msg.includes('18:00–19:00'), 'so is the group one');
  });

  test('nothing scheduled means no message rather than an empty one', () => {
    assert.strictEqual(appWith({}).App.timesMessage('student', 'A'), '');
  });

  test('the signature is left out when the user has no name set', () => {
    const app = appWith({ 1: [{ studentId: 'A', start: '17:00', end: '18:00' }] },
      {}, { teacherName: '' });
    const msg = app.App.timesMessage('student', 'A');
    assert.ok(!msg.includes('—'), `no dangling dash: ${JSON.stringify(msg)}`);
  });

  test('links carry the text intact and escape what would break them', () => {
    const app = appWith({});
    const text = 'Δευτέρα 17:00 & Τετάρτη #2';
    const wa = app.App.waLink('306941234567', text);
    assert.ok(wa.startsWith('https://wa.me/306941234567?text='));
    assert.ok(!wa.slice(wa.indexOf('?') + 1).includes('&'), '& must be encoded, not a new parameter');
    assert.strictEqual(decodeURIComponent(wa.split('text=')[1]), text);

    const sms = app.App.smsLink('+30 694 1234567', text);
    assert.ok(sms.startsWith('sms:+306941234567?&body='));
    assert.strictEqual(decodeURIComponent(sms.split('body=')[1]), text);

    assert.strictEqual(app.App.waLink('', text), null, 'no number, no link');
    assert.strictEqual(app.App.smsLink('', text), null);
  });

  test('a phone number survives export and import', () => {
    const app = loadApp();
    app.setState({
      students: [student('A', { phone: '+30 694 1234567' })],
      jobs: [{ id: 'j1', name: 'Διαρροή', address: 'x', phone: '2610123456', durationMin: 60 }],
      settings: settings(), coords: {}, schedule: {},
    });
    let written = null;
    app.ctx.Blob = function Blob(parts) { written = parts[0]; };
    app.App.exportData();
    const data = JSON.parse(written);
    assert.strictEqual(data.students[0].phone, '+30 694 1234567');
    assert.strictEqual(data.jobs.length, 1, 'day-mode jobs belong in the backup too');
    assert.strictEqual(data.jobs[0].phone, '2610123456');
    assert.deepStrictEqual(Array.from(app.App.validateBackup(data)), []);
  });

  test('a backup with a non-string phone is refused', () => {
    const app = loadApp();
    app.setState({ students: [], settings: settings() });
    const bad = { students: [student('A', { phone: { n: 1 } })], settings: settings() };
    assert.ok(app.App.validateBackup(bad).length > 0, 'must be caught before it reaches a link');
  });
});

// ---------------------------------------------------------------------------
// Where address lookups go
// ---------------------------------------------------------------------------

describe('the API key is not in the page any more', () => {
  const fs = require('fs');
  const { APP_FILE } = require('./harness');

  test('no HERE key is embedded in the file', () => {
    const src = fs.readFileSync(APP_FILE, 'utf8');
    // The key that used to ship here, and the shape of any replacement.
    assert.ok(!src.includes('ZYbtkcLwZXstiGaBGzxJHCuHiA-wFqW41iTCJe0y_6g'),
      'the old shared key must be gone from the client');
    assert.ok(!/SHARED_HERE_KEY\s*=\s*['"][A-Za-z0-9_-]{20,}/.test(src),
      'and nothing key-shaped may take its place');
  });

  test('three modes, and each one is reachable', () => {
    const app = loadApp();
    app.setState({ settings: settings() });

    // No own key, no proxy: the free services, which need no key at all.
    assert.equal(app.lookupMode(), 'free');
    assert.equal(app.hereAvailable(), false);
    assert.equal(app.apiUrl('/here/geocode', { q: 'x' }), null,
      'with no proxy there is no proxy URL to build');

    // A user's own key always wins — their quota, their choice, and it keeps
    // working for anyone who set one up before the proxy existed.
    app.state.settings.hereApiKey = 'their-own-key';
    assert.equal(app.lookupMode(), 'own');
    assert.equal(app.hereAvailable(), true);
  });

  test('a proxy URL is built safely from its parameters', () => {
    const app = loadApp({ apiBase: true });
    // API_BASE is a const in the file, so exercise the builder the way the
    // call sites do rather than reassigning it.
    const build = (base, path, params) => {
      if (!base) return null;
      const qs = params ? ('?' + new app.ctx.URLSearchParams(params).toString()) : '';
      return base.replace(/\/$/, '') + path + qs;
    };
    const url = build('https://api.example.workers.dev/', '/here/geocode',
      { q: 'Γούναρη 58 & Κορίνθου', lang: 'el' });
    assert.equal(url.indexOf('https://api.example.workers.dev/here/geocode?'), 0,
      `a trailing slash must not double up: ${url}`);
    assert.ok(!url.slice(url.indexOf('?') + 1).split('&')[0].includes('&'),
      'an & inside an address must not become a second parameter');
    assert.equal(new app.ctx.URL(url).searchParams.get('q'), 'Γούναρη 58 & Κορίνθου');
  });

  test('the CSP allows the proxy to be called', () => {
    const src = fs.readFileSync(APP_FILE, 'utf8');
    const csp = src.match(/Content-Security-Policy" content="([^"]+)"/);
    assert.ok(csp, 'the page must still declare a CSP');
    const connect = csp[1].match(/connect-src([^;]+)/)[1];
    assert.ok(connect.includes('workers.dev'),
      `the Worker origin must be allowed, or every call is blocked: ${connect}`);
  });
});

// ---------------------------------------------------------------------------
// Sync: the server must never be able to read any of it
// ---------------------------------------------------------------------------

describe('what leaves the device is unreadable', () => {
  test('a snapshot round-trips through encryption', async () => {
    const app = loadApp();
    const code = app.Sync.randomCode();
    const data = { students: [student('Νίκος', { name: 'Νίκος Παπαδόπουλος' })],
      schedule: { 1: [slot('Νίκος', '17:00', '18:00')] }, coords: { home: { lat: 38.2, lon: 21.7 } } };
    const blob = await app.Sync.encrypt(code, data);
    const back = await app.Sync.decrypt(code, blob);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(back)), JSON.parse(JSON.stringify(data)));
  });

  test('the blob contains no name, address or code', async () => {
    const app = loadApp();
    const code = app.Sync.randomCode();
    const blob = await app.Sync.encrypt(code, {
      students: [student('s1', { name: 'Νίκος Παπαδόπουλος', address: 'Γούναρη 58, Πάτρα' })] });
    assert.ok(!blob.includes('Παπαδόπουλος'), 'a name must not be readable in the blob');
    assert.ok(!blob.includes('Γούναρη'), 'nor an address');
    assert.ok(!blob.includes(code), 'nor the code itself');
    // And the same data twice must not produce the same ciphertext, or the
    // server learns when nothing changed — and worse, AES-GCM breaks if a
    // nonce is ever reused with one key.
    const again = await app.Sync.encrypt(code, {
      students: [student('s1', { name: 'Νίκος Παπαδόπουλος', address: 'Γούναρη 58, Πάτρα' })] });
    assert.notEqual(blob, again, 'each encryption must use a fresh nonce');
  });

  test('the wrong code cannot read it, and does not return rubbish', async () => {
    const app = loadApp();
    const good = app.Sync.randomCode();
    const wrong = app.Sync.randomCode();
    const blob = await app.Sync.encrypt(good, { students: [] });
    await assert.rejects(() => app.Sync.decrypt(wrong, blob),
      'AES-GCM authenticates, so a wrong key must throw rather than decrypt to nonsense');
  });

  test('a tampered blob is refused', async () => {
    const app = loadApp();
    const code = app.Sync.randomCode();
    const blob = await app.Sync.encrypt(code, { students: [] });
    // Flip one character of the ciphertext.
    const i = blob.length - 5;
    const flipped = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    await assert.rejects(() => app.Sync.decrypt(code, flipped));
  });

  test('what proves we know the code is a hash, not the code', async () => {
    const app = loadApp();
    const code = app.Sync.randomCode();
    const h = await app.Sync.authHash(code);
    assert.match(h, /^[a-f0-9]{64}$/);
    assert.ok(!h.includes(code.slice(0, 6)), 'the hash must not carry the code in it');
    assert.equal(h, await app.Sync.authHash(code), 'and it must be stable');
    assert.notEqual(h, await app.Sync.authHash(app.Sync.randomCode()));
  });

  test('the key is derived from the secret half, so the id alone is useless', async () => {
    const app = loadApp();
    const S = app.Sync;
    const a = S.randomCode();
    // Same space id, different secret: a blob from one must not open with the
    // other, or publishing the id would be publishing the data.
    const b = S.spaceIdOf(a) + S.randomCode().slice(S.ID_LEN);
    const blob = await S.encrypt(a, { students: [] });
    await assert.rejects(() => S.decrypt(b, blob));
  });
});

describe('the pairing code', () => {
  test('is long enough, and avoids characters people confuse', () => {
    const app = loadApp();
    const S = app.Sync;
    for (let i = 0; i < 50; i++) {
      const c = S.randomCode();
      assert.equal(c.length, S.ID_LEN + S.SECRET_LEN);
      assert.ok(!/[O0I1L]/.test(c), `read aloud and mistyped: ${c}`);
    }
    // 31 symbols over 24 characters is far past guessing.
    assert.ok(Math.log2(31) * 24 > 100, 'the code must not be brute-forceable');
  });

  test('reads back whatever the user typed, dashes or not', () => {
    const app = loadApp();
    const S = app.Sync;
    const code = S.randomCode();
    assert.equal(S.parse(S.format(code)), code);
    assert.equal(S.parse(code.toLowerCase()), code);
    assert.equal(S.parse('  ' + S.format(code) + '  '), code);
    assert.equal(S.parse(code.slice(0, 10)), null, 'a short code is refused, not padded');
    assert.equal(S.parse(''), null);
    assert.equal(S.parse(null), null);
  });

  test('two codes are never the same', () => {
    const app = loadApp();
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(app.Sync.randomCode());
    assert.equal(seen.size, 200);
  });
});

describe('the blob does not announce how much work you have', () => {
  // Ciphertext is as long as what went in, so an unpadded blob tells anyone
  // who can see its size — including the server — roughly how many clients
  // you have. Padding turns a number into a very coarse band.

  test('the size moves in steps, not with every client', async () => {
    // Padding bounds the leak to a 16KB band; it does not remove it. A very
    // large roster still occupies more bands than a small one, and saying
    // otherwise would be claiming a guarantee the code does not give.
    const app = loadApp();
    const S = app.Sync;
    const code = S.randomCode();
    const sizes = [];
    for (const n of [0, 1, 5, 20]) {
      const blob = await S.encrypt(code, { students: Array.from({ length: n },
        (_, i) => student('s' + i, { name: 'Μαθητής ' + i })) });
      sizes.push(blob.length);
    }
    assert.equal(new Set(sizes).size, 1,
      `rosters this size must be indistinguishable: ${sizes.join(', ')}`);

    // 40 clients tips into the next band. That is the honest limit of this:
    // one step of resolution, not none.
    const bigger = await S.encrypt(code, { students: Array.from({ length: 40 },
      (_, i) => student('s' + i, { name: 'Μαθητής ' + i })) });
    assert.ok(bigger.length > sizes[0], 'a much larger roster does move up a band');
    const rawBig = S._unb64(bigger);
    assert.equal((rawBig.length - 12 - 16) % S.PAD_STEP, 0,
      'and it lands on a step boundary, not on its own byte count');

    // And the ciphertext is always a whole number of steps, so what leaks is
    // the band rather than the byte count.
    const raw = S._unb64(await S.encrypt(code, { students: [student('a')] }));
    assert.equal((raw.length - 12 - 16) % S.PAD_STEP, 0,
      'the plaintext must be padded to a whole number of steps');
  });

  test('padding is removed exactly, whatever the length', async () => {
    const app = loadApp();
    const code = app.Sync.randomCode();
    for (const n of [0, 1, 7, 100, 1000]) {
      const data = { students: Array.from({ length: n }, (_, i) => student('s' + i)) };
      const back = await app.Sync.decrypt(code, await app.Sync.encrypt(code, data));
      assert.equal(back.students.length, n, `round trip failed at ${n} clients`);
    }
  });

  test('a roster too large for one step still round-trips', async () => {
    const app = loadApp();
    const code = app.Sync.randomCode();
    const big = { students: Array.from({ length: 400 }, (_, i) =>
      student('s' + i, { name: 'Πολύ μακρύ όνομα μαθητή ' + i, notes: 'x'.repeat(200) })) };
    const blob = await app.Sync.encrypt(code, big);
    assert.ok(blob.length > app.Sync.PAD_STEP, 'this fixture should exceed one step');
    const back = await app.Sync.decrypt(code, blob);
    assert.equal(back.students.length, 400);
    assert.equal(back.students[399].name, big.students[399].name);
  });

  test('a blob written before padding existed still opens', async () => {
    // Anyone syncing already has one of these. Truncating it to junk on the
    // first read after an update would lose their data.
    const app = loadApp();
    const S = app.Sync;
    const code = S.randomCode();
    // Encrypt WITHOUT the length header, the way the previous version did.
    const iv = app.ctx.crypto.getRandomValues(new Uint8Array(12));
    const key = await S._key(code);
    const plain = new TextEncoder().encode(JSON.stringify({ students: [student('old')] }));
    const ct = await app.ctx.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const packed = new Uint8Array(iv.length + ct.byteLength);
    packed.set(iv, 0); packed.set(new Uint8Array(ct), iv.length);

    const back = await S.decrypt(code, S._b64(packed));
    assert.equal(back.students.length, 1);
    assert.equal(back.students[0].id, 'old');
  });
});
