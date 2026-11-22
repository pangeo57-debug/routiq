'use strict';
/**
 * The same person is not put on two days in a row — as far as the week allows.
 * The rule belongs to the moves a person makes (repair options), not to
 * verifySchedule: the optimizer does not know it, and warnings on every
 * existing schedule would be noise.
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

describe('when the rule applies', () => {
  const app = loadApp();
  const S = app.Scheduler;
  const cfg = settings({});

  test('only to someone with more than one lesson a week, and while the week has room', () => {
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 1 }), cfg), false);
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 2 }), cfg), true);
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 3 }), cfg), true, 'Mon/Wed/Fri');
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 4 }), cfg), false, 'cannot be spread over five days');
  });

  test('how many lessons fit on days that are not next to each other', () => {
    assert.equal(S._maxSpread([1, 2, 3, 4, 5]), 3);
    assert.equal(S._maxSpread([1, 3, 5]), 3);
    assert.equal(S._maxSpread([1, 2]), 1);
    assert.equal(S._maxSpread([1, 2, 3, 4, 5, 6]), 3);
  });

  test('the setting turns it off, and a person can differ from the setting', () => {
    const off = settings({ avoidConsecutiveDays: false });
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 2 }), off), false);
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 2, spacing: 'on' }), off), true);
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 2, spacing: 'off' }), cfg), false);
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 4, spacing: 'on' }), cfg), true, 'asked for, so held to it');
  });

  test('a setting never saved counts as on', () => {
    const none = settings({});
    delete none.avoidConsecutiveDays;
    assert.equal(S.spacingApplies(student('a', { lessonsPerWeek: 2 }), none), true);
  });
});

describe('spacingViolations', () => {
  test('finds Tuesday + Wednesday, not Monday + Wednesday', () => {
    const app = loadApp();
    const sts = [student('G', { lessonsPerWeek: 2 })];
    const bad = { 1: [], 2: [slot('G', '16:00', '17:00')], 3: [slot('G', '16:00', '17:00')], 4: [], 5: [] };
    const ok = { 1: [slot('G', '16:00', '17:00')], 2: [], 3: [slot('G', '16:00', '17:00')], 4: [], 5: [] };
    const { cfg, S } = week(app, { sts, sched: bad });
    const v = S.spacingViolations(bad, sts, cfg);
    assert.equal(v.length, 1);
    assert.deepStrictEqual(Array.from(v[0].days), [2, 3]);
    assert.equal(v[0].name, 'G');
    assert.deepStrictEqual(Array.from(S.spacingViolations(ok, sts, cfg)), []);
  });

  test('Friday and Monday are not consecutive; Saturday and Sunday are', () => {
    const app = loadApp();
    const sts = [student('G', { lessonsPerWeek: 2, days: [0, 1, 5, 6] })];
    const fm = { 0: [], 1: [slot('G', '16:00', '17:00')], 5: [slot('G', '16:00', '17:00')], 6: [] };
    const { cfg, S } = week(app, { days: [0, 1, 5, 6], sts, sched: fm, extra: { avoidConsecutiveDays: true } });
    assert.deepStrictEqual(Array.from(S.spacingViolations(fm, sts, cfg)), []);
    const ss = { 0: [slot('G', '16:00', '17:00')], 1: [], 5: [], 6: [slot('G', '16:00', '17:00')] };
    assert.equal(S.spacingViolations(ss, sts, cfg).length, 1);
    // Sunday then Monday is the end of one week and the start of the next
    const sm = { 0: [slot('G', '16:00', '17:00')], 1: [slot('G', '16:00', '17:00')], 5: [], 6: [] };
    assert.deepStrictEqual(Array.from(S.spacingViolations(sm, sts, cfg)), []);
  });

  test('verifySchedule does not report it: the optimizer does not know the rule', () => {
    const app = loadApp();
    const sts = [student('G', { lessonsPerWeek: 2 })];
    const bad = { 1: [], 2: [slot('G', '16:00', '17:00')], 3: [slot('G', '16:00', '17:00')], 4: [], 5: [] };
    const { cfg, S } = week(app, { sts, sched: bad });
    assert.deepStrictEqual(Array.from(S.verifySchedule(bad, sts, cfg)), []);
  });
});

describe('in the repair options', () => {
  test('an option that makes two days in a row says so, and comes after one that does not', () => {
    const app = loadApp();
    // Monday has 90 minutes and B uses 60 of them, so A can only get in by
    // swapping with B. B can go to Tuesday (then it sits Tuesday + Wednesday)
    // or to Friday (clean). Same driving either way: the rule decides.
    const sts = [
      student('A', { days: [1, 2] }),
      student('B', { days: [1, 2, 5], lessonsPerWeek: 2 }),
    ];
    const sched = {
      1: [slot('B', '15:00', '16:00')], 2: [slot('A', '15:00', '16:00')],
      3: [slot('B', '15:00', '16:00')], 4: [], 5: [],
    };
    // B's second lesson is on Wednesday: Tuesday would be next to it, Friday is not.
    sts[1].availability[3] = { on: true, start: '15:00', end: '22:00' };
    const { cfg, S } = week(app, { sts, sched, extra: { dayHours: Object.fromEntries([1, 2, 3, 4, 5].map(d => [d, { start: '15:00', end: d === 1 ? '16:30' : '22:00' }])) } });
    const r = S.findRescheduleOptions(sched, sts, cfg, { studentId: 'A', day: 2, start: '15:00' }, 1, '15:00');
    const swaps = Array.from(r.options).filter(o => o.kind === 'swap');
    assert.ok(swaps.length >= 1, 'a swap is offered: ' + JSON.stringify(Array.from(r.options).map(o => o.kind)));
    assert.equal(swaps[0].spacing.length, 0, 'the clean swap is first');
    const flagged = swaps.find(o => o.spacing.length);
    assert.ok(flagged, 'the swap that puts B on Tuesday next to Wednesday is still offered, but flagged');
    assert.equal(flagged.spacing[0].name, 'B');
    assert.deepStrictEqual(Array.from(flagged.spacing[0].days), [2, 3]);
    assert.ok(Array.from(r.options).indexOf(flagged) > Array.from(r.options).indexOf(swaps[0]), 'after the clean one');
    assert.equal(swaps[0].moves.find(m => m.studentId === 'B').toDay, 5, 'the clean one sends B to Friday');
    for (const o of Array.from(r.options)) assert.ok(Array.isArray(o.spacing));
  });

  test('a pair that was already consecutive is not blamed on the move', () => {
    const app = loadApp();
    const sts = [student('G', { lessonsPerWeek: 2 }), student('B', { days: [1, 2] })];
    const sched = {
      1: [slot('B', '16:00', '17:00')], 2: [slot('G', '16:00', '17:00')],
      3: [slot('G', '16:00', '17:00')], 4: [], 5: [],
    };
    const { cfg, S } = week(app, { sts, sched });
    // G is already on Tuesday + Wednesday. Moving G's Tuesday lesson to Monday
    // fixes it; moving B (not G) around changes nothing about G.
    const r = S.findRescheduleOptions(sched, sts, cfg, { studentId: 'B', day: 1, start: '16:00' }, 2, null);
    for (const o of Array.from(r.options)) assert.equal(o.spacing.length, 0, 'not caused by this move');
  });
});

describe('the panel and the settings', () => {
  test('the panel names the consecutive days an option would make', () => {
    const app = loadApp();
    const sts = [student('G', { lessonsPerWeek: 2, days: [1, 2, 3, 4, 5] }), student('B', { days: [1, 2] })];
    // G moves from Thursday to Tuesday: next to its Wednesday lesson.
    const sched = { 1: [], 2: [slot('B', '15:00', '16:00')], 3: [slot('G', '15:00', '16:00')], 4: [slot('G', '15:00', '16:00')], 5: [] };
    week(app, { sts, sched });
    const els = {};
    app.ctx.document.getElementById = (id) => els[id] || (els[id] = {
      style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {} });
    app.Toast.show = () => {};
    assert.equal(app.App.openRescheduleOptions({ studentId: 'G', day: 4, start: '15:00' }, 2, null), true);
    assert.match(els['rs-list'].innerHTML, /⚠/);
  });

  test('the student form offers the override, and the settings screen the switch', () => {
    const app = loadApp();
    app.setState({ students: [], settings: settings({}), coords: {}, schedule: {} });
    const html = app.App.buildStudentForm(null);
    assert.ok(html.indexOf('id="st-spacing"') > html.indexOf('<details id="st-more"'), 'under "more options"');
    assert.match(html, /<option value="on"/);
    assert.equal(app.defaultSettings().avoidConsecutiveDays, true);
  });
});
