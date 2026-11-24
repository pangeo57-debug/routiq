'use strict';
// The genetic week search (js/genetic.js): never a broken week, never a worse one.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, cityCoords } = require('./harness');

function world(over = {}) {
  const app = loadApp({ seed: 7, genetic: true });
  const days = [1, 2, 3, 4, 5];
  const sts = Array.from({ length: 14 }, (_, i) => student('s' + i, { name: 'S' + i, address: 'Οδός ' + i,
    lessonsPerWeek: 1 + (i % 2), lessonDuration: 60, days: days.filter(d => (i + d) % 3 !== 0), window: { start: '15:00', end: '21:00' } }));
  const cfg = settings({ workDays: days, ...over });
  app.setState({ students: sts, settings: cfg, coords: cityCoords(sts), schedule: {} });
  return { app, S: app.Scheduler, sts, cfg };
}

describe('the genetic week search', () => {
  test('its week is legal, keeps every lesson that was in, and is not longer', async () => {
    const { S, sts, cfg, app } = world();
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: app.state.coords, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const before = JSON.parse(JSON.stringify(r.schedule));
    const week = JSON.parse(JSON.stringify(r.schedule));
    await S.geneticWeek(week, sts, cfg, 3000);
    assert.equal(S.verifySchedule(week, sts, cfg).length, 0, 'no rule broken');
    assert.ok(S.countTotal(week) >= S.countTotal(before), 'no lesson lost');
    assert.ok(!S.isBetterStart(before, week, cfg), 'never worse than what it was given');
  });
  test('a week it does not handle yet is left exactly as it was', async () => {
    const { S, sts, cfg, app } = world();
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: app.state.coords, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const d = Object.keys(r.schedule).find(k => r.schedule[k].length);
    r.schedule[d][0] = { ...r.schedule[d][0], locked: true };      // locked, but not through lockSplit
    const was = JSON.stringify(r.schedule);
    const used = await S.geneticWeek(r.schedule, sts, cfg, 2000);
    assert.equal(used, false); assert.equal(JSON.stringify(r.schedule), was);
  });
  test('locked lessons, as the plan button hands them over, stay at their day and time', async () => {
    const { S, sts, cfg, app } = world({ lunchBreak: 30 });
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: app.state.coords, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const locks = [];
    for (const d of Object.keys(r.schedule)) for (const sl of r.schedule[d]) if (locks.length < 3 && !locks.some(l => l.studentId === sl.studentId)) { sl.locked = true; locks.push({ d, studentId: sl.studentId, start: sl.start }); }
    const lk = S.lockSplit(sts, r.schedule, cfg);
    for (const [v, real] of Object.entries(lk.alias)) app.state.coords[v] = app.state.coords[real];
    app.state.idAlias = lk.alias;
    await S.geneticWeek(lk.schedule, lk.students, cfg, 3000);
    const back = S.lockJoin(lk.schedule, lk.alias);
    for (const l of locks) assert.ok((back[l.d] || []).some(sl => sl.studentId === l.studentId && sl.start === l.start && sl.locked), `${l.studentId} ${l.d} ${l.start}`);
    assert.equal(S.verifySchedule(back, sts, cfg).length, 0);
  });
  test('the app runs it by default: 15 s in the quick plan, 45 s in the thorough one', () => {
    const app = loadApp({ genetic: true });
    assert.deepStrictEqual({ ...app.Scheduler.GENETIC_MS }, { quick: 15000, thorough: 45000 });
    assert.deepStrictEqual({ ...loadApp().Scheduler.GENETIC_MS }, { quick: 0, thorough: 0 }, 'off in the other tests');
  });
  test('a pair and a merged block are moved whole, only to days all their people can do', async () => {
    const { S, sts, cfg, app } = world();
    sts[0].pairedWith = 's1'; sts[1].pairedWith = 's0';
    sts[2].mergeMode = 'always'; sts[2].lessonsPerWeek = 2;
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: app.state.coords, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const before = JSON.parse(JSON.stringify(r.schedule));
    const week = JSON.parse(JSON.stringify(r.schedule));
    await S.geneticWeek(week, sts, cfg, 3000);
    assert.equal(S.verifySchedule(week, sts, cfg).length, 0, 'no rule broken');
    assert.ok(!S.isBetterStart(before, week, cfg), 'never worse');
    const slots = Object.values(week).flat();
    const pairs = (x) => x.filter(sl => S.occupantIds(sl).includes('s0') && S.occupantIds(sl).includes('s1')).length;
    assert.equal(pairs(slots), pairs(Object.values(before).flat()), 'the pair still has its lessons together');
    const merged = (x) => x.filter(sl => sl.studentId === 's2').map(sl => S.toMin(sl.end) - S.toMin(sl.start)).sort().join();
    assert.equal(merged(slots), merged(Object.values(before).flat()), 'the merged block keeps its length');
  });
  test('with a slow rush hour its week stays legal, complete and not longer', async () => {
    const { S, sts, cfg, app } = world();
    const ids = ['home', ...sts.map(x => x.id)], c = app.state.coords;
    const d = (a, b) => Math.hypot((c[a].lat - c[b].lat) * 111.32, (c[a].lon - c[b].lon) * 87.7);
    const mat = (f) => ({ coordIds: ids,
      durations: ids.map(a => ids.map(b => Math.round(d(a, b) * 2 * f * 60))),
      distances: ids.map(a => ids.map(b => Math.round(d(a, b) * 1000))) });
    app.setState({ travelMatrixPeak: mat(3), travelMatrixOffPeak: mat(1), travelMatrix: null });
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: c, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const before = JSON.parse(JSON.stringify(r.schedule)), week = JSON.parse(JSON.stringify(r.schedule));
    await S.geneticWeek(week, sts, cfg, 3000);
    assert.equal(S.verifySchedule(week, sts, cfg).length, 0, 'no rule broken');
    assert.ok(S.countTotal(week) >= S.countTotal(before), 'no lesson lost');
    assert.ok(!S.isBetterStart(before, week, cfg), 'never worse than what it was given');
  });
  test('a small week stops when its best has not improved for a while, a long budget unspent', async () => {
    const { S, sts, cfg, app } = world();
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: app.state.coords, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const week = JSON.parse(JSON.stringify(r.schedule));
    await S.geneticWeek(week, sts, cfg, 20000);
    assert.ok(S._geneticLog.usedMs < 20000, 'stopped early: ' + S._geneticLog.usedMs);
    assert.equal(S.verifySchedule(week, sts, cfg).length, 0);
  });
});
