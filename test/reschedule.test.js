'use strict';
/**
 * Smart rescheduling: when a move does not fit, up to three ways to make it
 * fit, cheapest drive first, applied all-or-nothing and undoable.
 *
 * Everything is placed at ONE position, so there is no driving between
 * lessons and the layouts below depend only on the clock. The one test about
 * driving moves a client away on purpose.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

const HOME = { lat: 38.24, lon: 21.73 };
const HERE = { lat: 38.241, lon: 21.731 };

function week(app, { days = [1, 2], hours = ['15:00', '18:30'], sts, sched, coords }) {
  const cfg = settings({
    workDays: days,
    dayHours: Object.fromEntries(days.map(d => [d, { start: hours[0], end: hours[1] }])),
  });
  const c = coords || Object.assign({ home: HOME }, Object.fromEntries(sts.map(s => [s.id, HERE])));
  app.setState({ coords: c, settings: cfg, students: sts, schedule: sched });
  return { cfg, sts, sched, S: app.Scheduler };
}
const ref = (id, day, start) => ({ studentId: id, day, start });
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const kinds = (r) => Array.from(r.options).map(o => o.kind);

describe('findRescheduleOptions', () => {
  test('level 1: another gap on the wanted day, and nothing is changed', () => {
    const app = loadApp();
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1] })];
    const sched = { 1: [slot('B', '16:00', '17:00')], 2: [slot('A', '16:00', '17:00')] };
    const { cfg, S } = week(app, { sts, sched });
    const before = JSON.stringify(sched);
    const r = S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '16:00'), 1, '16:00');
    assert.ok(r.options.length >= 1);
    const o = r.options.find(x => x.kind === 'relocate');
    assert.ok(o, 'a relocation is offered');
    assert.equal(o.level, 1);
    assert.equal(o.moves.length, 1);
    assert.equal(o.moves[0].toDay, 1);
    assert.notEqual(o.moves[0].toStart, '16:00', 'not the blocked time');
    assert.equal(JSON.stringify(sched), before, 'finding options changes nothing');
  });

  test('level 2: when no gap is big enough the blocker trades places', () => {
    const app = loadApp();
    // Monday has 90 minutes and B uses 60 of them: no gap fits a 60-minute lesson.
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1, 2] })];
    const sched = { 1: [slot('B', '15:00', '16:00')], 2: [slot('A', '15:00', '16:00')] };
    const { cfg, S } = week(app, { sts, sched, hours: ['15:00', '16:30'] });
    const r = S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '15:00'), 1, '15:00');
    const swap = Array.from(r.options).find(o => o.kind === 'swap');
    assert.ok(swap, 'a swap is offered: ' + JSON.stringify(kinds(r)));
    assert.equal(swap.level, 2);
    assert.equal(swap.partner.studentId, 'B');
    assert.equal(swap.moves.length, 2);
    const res = S.applyRescheduleOption(sched, sts, cfg, swap);
    assert.ok(res.ok);
    assert.deepStrictEqual(sched[1].map(x => x.studentId), ['A']);
    assert.deepStrictEqual(sched[2].map(x => x.studentId), ['B']);
    assert.deepStrictEqual(Array.from(S.verifySchedule(sched, sts, cfg)), []);
  });

  test('level 3: a neighbour shifted by 15 or 30 minutes opens the gap', () => {
    const app = loadApp();
    // Gaps of 30 and 45 minutes, neither fits 60; shifting B or C joins them.
    // Nobody else is free on another day, so only a shift can work.
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1] }), student('C', { days: [1] })];
    const sched = { 1: [slot('B', '15:30', '16:30'), slot('C', '17:15', '18:15')], 2: [slot('A', '15:00', '16:00')] };
    const { cfg, S } = week(app, { sts, sched });
    const r = S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '15:00'), 1, null);
    assert.ok(r.options.length >= 1, 'something is offered');
    for (const o of Array.from(r.options)) {
      assert.equal(o.kind, 'shift');
      assert.ok([15, 30].includes(Math.abs(o.shiftMin)), 'shift is 15 or 30 minutes');
      const [, partnerMove] = o.moves;
      assert.equal(partnerMove.fromDay, partnerMove.toDay, 'the neighbour stays on its day');
      const trial = S._applyMoves(sched, cfg, o.moves);
      assert.deepStrictEqual(Array.from(S.verifySchedule(trial, sts, cfg)), [], 'the result is legal');
    }
  });

  test('a shift never leaves the neighbour\'s own availability', () => {
    const app = loadApp();
    // B is only free 15:30-17:00, so B cannot go earlier; C is free all day.
    const sts = [
      student('A', { days: [1, 2] }),
      student('B', { days: [1], window: { start: '15:30', end: '17:00' } }),
      student('C', { days: [1] }),
    ];
    const sched = { 1: [slot('B', '15:30', '16:30'), slot('C', '17:15', '18:15')], 2: [slot('A', '15:00', '16:00')] };
    const { cfg, S } = week(app, { sts, sched });
    const r = S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '15:00'), 1, null);
    assert.ok(r.options.length >= 1);
    for (const o of Array.from(r.options)) {
      const trial = S._applyMoves(sched, cfg, o.moves);
      assert.deepStrictEqual(Array.from(S.verifySchedule(trial, sts, cfg)), []);
      if (o.partner.studentId === 'B') assert.ok(o.shiftMin > 0, 'B can only go later');
    }
  });

  test('a locked lesson is never a partner', () => {
    const app = loadApp();
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1, 2] })];
    const sched = { 1: [slot('B', '15:00', '16:00', { locked: true })], 2: [slot('A', '15:00', '16:00')] };
    const { cfg, S } = week(app, { sts, sched, hours: ['15:00', '16:30'] });
    const r = S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '15:00'), 1, '15:00');
    assert.equal(r.options.length, 0);
    assert.ok(r.notes.includes('no_option'));
  });

  test('at most three options, cheapest drive first', () => {
    const app = loadApp();
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1, 2] }), student('C', { days: [1, 2] })];
    const far = { lat: 38.29, lon: 21.79 };
    const coords = { home: HOME, A: HERE, B: far, C: HERE };
    const sched = { 1: [slot('B', '16:00', '17:00'), slot('C', '17:00', '18:00')], 2: [slot('A', '16:00', '17:00')] };
    const { cfg, S } = week(app, { sts, sched, coords, hours: ['15:00', '21:00'] });
    const r = S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '16:00'), 1, '16:30');
    const d = Array.from(r.options).map(o => o.deltaTravelMin);
    assert.ok(r.options.length >= 1 && r.options.length <= 3);
    assert.deepStrictEqual(d, d.slice().sort((a, b) => a - b), 'ascending by extra driving');
    for (const o of Array.from(r.options)) assert.equal(typeof o.deltaTravelMin, 'number');
  });

  test('says why when the day cannot work at all', () => {
    const app = loadApp();
    const sts = [student('A', { days: [2] }), student('B', { days: [1] })];
    const sched = { 1: [slot('B', '16:00', '17:00')], 2: [slot('A', '16:00', '17:00')] };
    const { cfg, S } = week(app, { sts, sched });
    assert.ok(S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '16:00'), 1).notes.includes('unavailable'));
    assert.ok(S.findRescheduleOptions(sched, sts, cfg, ref('A', 2, '09:00'), 1).notes.includes('no_lesson'));
  });

  test('accepts the lesson as a "studentId|day|start" string too', () => {
    const app = loadApp();
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1] })];
    const sched = { 1: [slot('B', '16:00', '17:00')], 2: [slot('A', '16:00', '17:00')] };
    const { cfg, S } = week(app, { sts, sched });
    const r = S.findRescheduleOptions(sched, sts, cfg, 'A|2|16:00', 1, '16:00');
    assert.ok(r.options.length >= 1);
  });
});

describe('applyRescheduleOption', () => {
  function setup(app) {
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1, 2] })];
    const sched = { 1: [slot('B', '15:00', '16:00')], 2: [slot('A', '15:00', '16:00')] };
    const w = week(app, { sts, sched, hours: ['15:00', '16:30'] });
    const swap = Array.from(w.S.findRescheduleOptions(sched, sts, w.cfg, ref('A', 2, '15:00'), 1, '15:00').options)
      .find(o => o.kind === 'swap');
    return Object.assign(w, { swap });
  }

  test('applies both halves together and Undo restores the exact week', () => {
    const app = loadApp();
    const { S, sts, cfg, sched, swap } = setup(app);
    const before = JSON.stringify(sched);
    const r = S.applyRescheduleOption(sched, sts, cfg, swap);
    assert.ok(r.ok);
    assert.notEqual(JSON.stringify(sched), before);
    S.restoreDays(sched, r.before);
    assert.equal(JSON.stringify(sched), before);
  });

  test('an offer gone stale changes nothing at all', () => {
    const app = loadApp();
    const { S, sts, cfg, sched, swap } = setup(app);
    // Somebody moves B in the meantime.
    sched[1] = [slot('B', '15:30', '16:30')];
    const before = JSON.stringify(sched);
    const r = S.applyRescheduleOption(sched, sts, cfg, swap);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stale');
    assert.equal(JSON.stringify(sched), before, 'no half-applied week');
  });

  test('an offer that would now break a rule is refused, whole', () => {
    const app = loadApp();
    const { S, sts, cfg, sched, swap } = setup(app);
    // B becomes unavailable on Tuesday after the options were drawn.
    sts[1].availability[2].on = false;
    const before = JSON.stringify(sched);
    const r = S.applyRescheduleOption(sched, sts, cfg, swap);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'illegal');
    assert.equal(JSON.stringify(sched), before);
  });
});

describe('the panel', () => {
  function fixture(app) {
    const sts = [student('A', { days: [1, 2] }), student('B', { days: [1, 2] })];
    const sched = { 1: [slot('B', '15:00', '16:00')], 2: [slot('A', '15:00', '16:00')] };
    week(app, { sts, sched, hours: ['15:00', '16:30'] });
    const els = {};
    app.ctx.document.getElementById = (id) => els[id] || (els[id] = {
      style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {}, contains() { return false; } } });
    const toasts = [];
    app.Toast.show = (...a) => { toasts.push(a); };
    return { els, toasts, sched };
  }

  test('a refused move opens the panel instead of an error', () => {
    const app = loadApp();
    const { els, toasts } = fixture(app);
    const shown = app.App.openRescheduleOptions(ref('A', 2, '15:00'), 1, '15:00');
    assert.equal(shown, true);
    assert.ok(els['rs-list'].innerHTML.includes('App.applyRescheduleOption(0)'));
    assert.equal(toasts.length, 0, 'no error toast');
  });

  test('a locked lesson in the way: still offered, saying it unlocks it', () => {
    const app = loadApp();
    fixture(app);
    app.state.schedule[1][0].locked = true;
    assert.equal(app.App.openRescheduleOptions(ref('A', 2, '15:00'), 1, '15:00'), true);
    const o = app.state._reschedule.res.options[0];
    assert.equal(o.level, 5);
    assert.ok(o.unlocked.length >= 1);
  });

  test('with nothing to offer it returns false so the caller keeps its own message', () => {
    const app = loadApp();
    fixture(app);
    assert.equal(app.App.openRescheduleOptions(ref('A', 2, '15:00'), 6, null), false, 'Saturday is not a working day');
  });

  test('Apply changes the week and the Undo on the toast puts it back', () => {
    const app = loadApp();
    const { toasts } = fixture(app);
    const before = JSON.stringify(app.state.schedule);
    assert.ok(app.App.openRescheduleOptions(ref('A', 2, '15:00'), 1, '15:00'));
    app.App.applyRescheduleOption(0);
    assert.notEqual(JSON.stringify(app.state.schedule), before);
    const done = toasts[toasts.length - 1];
    assert.equal(done[1], 'success');
    assert.equal(typeof done[3].run, 'function', 'the toast carries Undo');
    done[3].run();
    assert.equal(JSON.stringify(app.state.schedule), before);
  });

  test('Undo refuses when the week changed since, instead of erasing newer work', () => {
    const app = loadApp();
    const { toasts } = fixture(app);
    assert.ok(app.App.openRescheduleOptions(ref('A', 2, '15:00'), 1, '15:00'));
    app.App.applyRescheduleOption(0);
    const undo = toasts[toasts.length - 1][3];
    app.state.schedule[1] = app.state.schedule[1].concat([slot('Z', '16:05', '16:25', { duration: 20 })]);
    const mid = JSON.stringify(app.state.schedule);
    undo.run();
    assert.equal(JSON.stringify(app.state.schedule), mid);
    assert.equal(toasts[toasts.length - 1][1], 'error');
  });
});
