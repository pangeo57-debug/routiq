'use strict';
/**
 * Level 4: put the lesson on the wanted day and re-plan THAT day only, plus
 * the per-day overview (green / yellow / orange) that the move panel shows.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

const HERE = { lat: 38.241, lon: 21.731 };
function week(app, { days = [1, 2, 3, 4, 5], sts, sched, extra = {} }) {
  const cfg = settings(Object.assign({ workDays: days }, extra));
  app.setState({ coords: Object.assign({ home: { lat: 38.24, lon: 21.73 } },
    Object.fromEntries(sts.map(s => [s.id, HERE]))), settings: cfg, students: sts, schedule: sched });
  return { cfg, S: app.Scheduler };
}
const hours = (end) => Object.fromEntries([1, 2, 3, 4, 5].map(d => [d, { start: '15:00', end: d === 3 ? end : '22:00' }]));

describe('replanDayOptions', () => {
  // Wednesday 15:00-18:00. B and C sit at 15:30 and 16:45, leaving no hour
  // anywhere. Sliding B to 15:00 and C to 17:00 opens 16:00-17:00 for G.
  // B and C can only be on Wednesday, so no swap to another day exists.
  function scene(app, extraC = {}) {
    const sts = [
      student('G', { days: [1, 2, 3] }),
      student('B', { days: [3] }),
      student('C', Object.assign({ days: [3] }, extraC)),
    ];
    const sched = { 1: [slot('G', '15:00', '16:00')], 2: [], 3: [slot('B', '15:30', '16:30'), slot('C', '16:45', '17:45')], 4: [], 5: [] };
    return Object.assign({ sts, sched }, week(app, { sts, sched, extra: { dayHours: hours('18:00'), travelMargin: 0 } }));
  }

  test('levels 1-3 find nothing, level 4 re-plans Wednesday', () => {
    const app = loadApp();
    const { sts, sched, cfg, S } = scene(app);
    const simple = S.findRescheduleOptions(sched, sts, cfg, { studentId: 'G', day: 1, start: '15:00' }, 3, null);
    assert.equal(simple.options.filter(o => o.level <= 2).length, 0, 'no gap and no swap');
    const l4 = S.replanDayOptions(sched, sts, cfg, { studentId: 'G', day: 1, start: '15:00' }, 3, null);
    assert.ok(l4.length >= 1, 'a re-plan is found');
    const o = l4[0];
    assert.equal(o.level, 4);
    assert.equal(o.kind, 'replan');
    assert.equal(o.moves[0].studentId, 'G');
    assert.ok(o.moves.length >= 2, 'it names who else moves');
    for (const m of o.moves.slice(1)) assert.equal(m.toDay, 3, 'the others stay on Wednesday');
    assert.ok(o.displacedMin > 0);
    const r = S.applyRescheduleOption(sched, sts, cfg, o);
    assert.equal(r.ok, true);
    assert.deepStrictEqual(Array.from(S.verifySchedule(sched, sts, cfg)), []);
    assert.equal(sched[1].length, 0);
    assert.equal(sched[3].length, 3);
    S.restoreDays(sched, r.before);
    assert.equal(sched[1].length, 1, 'undo puts it back');
  });

  test('a locked lesson is never moved', () => {
    const app = loadApp();
    const { sts, sched, cfg, S } = scene(app);
    sched[3][1].locked = true;
    for (const o of S.replanDayOptions(sched, sts, cfg, { studentId: 'G', day: 1, start: '15:00' }, 3, null))
      assert.ok(!o.moves.some(m => m.studentId === 'C'), 'C is locked');
  });

  test('nobody is moved outside their own hours', () => {
    const app = loadApp();
    const { sts, sched, cfg, S } = scene(app);
    sts[2].availability[3] = { on: true, start: '16:45', end: '18:00' };
    sts[1].availability[3] = { on: true, start: '15:30', end: '18:00' };
    const opts = S.replanDayOptions(sched, sts, cfg, { studentId: 'G', day: 1, start: '15:00' }, 3, null);
    assert.ok(opts.length >= 1, 'they can still go later');
    for (const o of opts) {
      const b = o.moves.find(m => m.studentId === 'B'), c = o.moves.find(m => m.studentId === 'C');
      if (b) assert.ok(S.toMin(b.toStart) >= S.toMin('15:30'), 'B not before 15:30');
      if (c) assert.ok(S.toMin(c.toStart) >= S.toMin('16:45'), 'C not before 16:45');
    }
  });
});

describe('dayChoices', () => {
  test('one line per working day, coloured by what it takes', () => {
    const app = loadApp();
    const sts = [
      student('G', { days: [1, 2, 3, 4] }),
      student('B', { days: [3] }),
      student('C', { days: [3] }),
    ];
    const sched = { 1: [slot('G', '15:00', '16:00')], 2: [], 3: [slot('B', '15:30', '16:30'), slot('C', '16:45', '17:45')], 4: [], 5: [] };
    const { cfg, S } = week(app, { sts, sched, extra: { dayHours: hours('18:00'), travelMargin: 0 } });
    const rows = Object.fromEntries(Array.from(S.dayChoices(sched, sts, cfg, { studentId: 'G', day: 1, start: '15:00' })).map(r => [r.day, r]));
    assert.equal(rows[1].status, 'current');
    assert.equal(rows[2].status, 'free');
    assert.equal(rows[3].status, 'replan');
    assert.equal(rows[4].status, 'free');
    assert.equal(rows[5].status, 'off', 'G is not free on Friday');
  });

  test('a day that only works by making two days in a row is marked', () => {
    const app = loadApp();
    const sts = [student('G', { days: [1, 2, 3, 4, 5], lessonsPerWeek: 2 })];
    const sched = { 1: [slot('G', '15:00', '16:00')], 2: [], 3: [slot('G', '15:00', '16:00')], 4: [], 5: [] };
    const { cfg, S } = week(app, { sts, sched });
    const rows = Object.fromEntries(Array.from(S.dayChoices(sched, sts, cfg, { studentId: 'G', day: 1, start: '15:00' })).map(r => [r.day, r]));
    assert.equal(rows[2].spacing, true, 'Tuesday sits next to Wednesday');
    assert.equal(rows[4].spacing, true, 'Thursday too');
    assert.equal(rows[5].spacing, false, 'Friday is clean');
    assert.equal(rows[3].status, 'off', 'already there on Wednesday');
  });
});

describe('the day chooser panel', () => {
  test('shows every day with its colour, opens a day, applies a re-plan', () => {
    const app = loadApp();
    const sts = [student('G', { days: [1, 2, 3] }), student('B', { days: [3] }), student('C', { days: [3] })];
    const sched = { 1: [slot('G', '15:00', '16:00')], 2: [slot('B', '15:00', '22:00')], 3: [slot('B', '15:30', '16:30'), slot('C', '16:45', '17:45')], 4: [], 5: [] };
    sts[1].availability[2] = { on: true, start: '15:00', end: '22:00' };
    week(app, { sts, sched, extra: { dayHours: hours('18:00'), travelMargin: 0 } });
    const els = {};
    app.ctx.document.getElementById = (id) => els[id] || (els[id] = {
      style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {} });
    app.Toast.show = () => {};
    assert.equal(app.App.openDayChooser({ studentId: 'G', day: 1, start: '15:00' }), true);
    const html = els['rs-list'].innerHTML;
    assert.match(html, /App\.showDayOptions\(3\)/, 'Wednesday can be opened');
    assert.match(html, /var\(--orange/, 'orange for a re-plan');
    app.App.showDayOptions(3);
    assert.match(els['rs-list'].innerHTML, /App\.applyRescheduleOption\(0\)/);
    app.App.applyRescheduleOption(0);
    const st = app.state;
    assert.equal(st.schedule[1].length, 0);
    assert.ok(st.schedule[3].some(x => x.studentId === 'G'));
  });
});
