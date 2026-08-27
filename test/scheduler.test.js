'use strict';
/**
 * Scheduler correctness. Every test here maps to a bug that actually shipped —
 * a regression suite, not a specification exercise.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, cityCoords, slot } = require('./harness');
const { auditSchedule, totalPlaced } = require('./invariants');

/**
 * Assert a list of problems is empty. Values crossing the vm boundary carry the
 * sandbox's own Array prototype, so deepStrictEqual against a plain [] fails on
 * identity alone — copy into a native array first.
 */
function assertClean(issues, msg) {
  assert.deepStrictEqual(Array.from(issues || []), [], msg);
}

/** Run the same phase order runAndNotify uses, so tests cover the real pipeline. */
async function runPipeline(app, students, cfg, coords, { budget = 800 } = {}) {
  const S = app.Scheduler;
  app.setState({ coords, students, settings: cfg,
    travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
  const r = await S.runMultiAttempt(students, cfg, coords, 2, false);
  await S.alnsOptimize(r.schedule, students, cfg, coords, budget);
  S.saRepair(r.schedule, students, cfg, r);
  await S.lnsRepair(r.schedule, students, cfg, budget);
  S.enforceConstraints(r.schedule, students, cfg);
  S.collapseForceMergeFragments(r.schedule, students, cfg);
  return r.schedule;
}

describe('blocked times (how a split working day is expressed)', () => {
  test('a block at the start of the day does not kill the whole day', () => {
    const app = loadApp();
    const st = student('s1', { days: [1], window: { start: '09:00', end: '21:00' } });
    const cfg = settings({
      workDays: [1], dayHours: { 1: { start: '09:00', end: '21:00' } },
      blockedSlots: [{ day: 1, start: '09:00', end: '13:00' }],
    });
    app.setState({ coords: { home: { lat: 38.2466, lon: 21.7346 } }, students: [st], settings: cfg });

    const found = app.Scheduler.findSlotFixed(st, 1, [], cfg, 60);
    assert.ok(found, 'should find a slot after the block, 8 hours are free');
    assert.ok(app.Scheduler.toMin(found.start) >= app.Scheduler.toMin('13:00'),
      `expected a slot at/after 13:00, got ${found.start}`);
  });

  test('optimizer does not relocate lessons into a blocked break', async () => {
    const app = loadApp();
    const sts = [student('a', { days: [1], window: { start: '09:00', end: '21:00' } }),
                 student('b', { days: [1], window: { start: '09:00', end: '21:00' } })];
    const cfg = settings({
      workDays: [1], dayHours: { 1: { start: '09:00', end: '21:00' } },
      blockedSlots: [{ day: 1, start: '09:30', end: '11:00' }],
    });
    const coords = cityCoords(sts);
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });

    const sched = { 1: [slot('a', '14:00', '15:00'), slot('b', '15:10', '16:10')] };
    await app.Scheduler.alnsOptimize(sched, sts, cfg, coords, 600);

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
  });

  test('the initial search itself respects blocked breaks, without the safety net', async () => {
    // enforceConstraints repairs blocked-time violations, which would mask a
    // regression in the placement search. Check the search's own output before
    // any repair pass runs.
    const app = loadApp();
    const sts = Array.from({ length: 8 }, (_, i) => student('s' + i, { days: [1] }));
    const cfg = settings({
      workDays: [1], dayHours: { 1: { start: '09:00', end: '21:00' } },
      blockedSlots: [{ day: 1, start: '09:00', end: '12:00' },
                     { day: 1, start: '15:00', end: '16:00' }],
    });
    sts.forEach(s => { s.availability = { 1: { on: true, start: '09:00', end: '21:00' } }; });
    const coords = cityCoords(sts);
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });

    const r = await app.Scheduler.runMultiAttempt(sts, cfg, coords, 2, false);

    const inBlock = (r.schedule[1] || []).filter(s =>
      app.Scheduler.isBlocked(app.Scheduler.toMin(s.start), app.Scheduler.toMin(s.end), 1, cfg));
    assertClean(inBlock.map(s => `${s.studentId} ${s.start}-${s.end}`),
      'placement search must not put lessons inside blocked time');
    assert.ok((r.schedule[1] || []).length > 0,
      'and it must still place lessons in the free hours around the blocks');
  });

  test('full pipeline respects blocked breaks', async () => {
    const app = loadApp();
    const sts = Array.from({ length: 10 }, (_, i) => student('s' + i, { lessonsPerWeek: 1 }));
    const cfg = settings({
      blockedSlots: [{ day: 1, start: '17:00', end: '18:00' },
                     { day: 3, start: '19:00', end: '20:00' }],
    });
    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));
    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
  });
});

describe('core invariants under load', () => {
  test('20 students, mixed durations, pair + double lesson', async () => {
    const app = loadApp();
    const sts = Array.from({ length: 20 }, (_, i) =>
      student('s' + i, { lessonDuration: [60, 60, 90][i % 3], lessonsPerWeek: (i % 2) + 1 }));
    sts[0].pairedWith = 's1'; sts[1].pairedWith = 's0';
    sts[4].forceMerge = true; sts[4].mergeMode = 'always'; sts[4].lessonsPerWeek = 2;

    const cfg = settings();
    const sched = await runPipeline(app, sts, cfg, cityCoords(sts), { budget: 1200 });

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    assert.ok(totalPlaced(sched, cfg.workDays) > 0, 'should place at least some lessons');
  });

  test('students with narrow windows are never placed outside them', async () => {
    const app = loadApp();
    const sts = [
      student('early', { window: { start: '15:00', end: '16:30' } }),
      student('late', { window: { start: '20:00', end: '22:00' } }),
      student('mid', { window: { start: '17:00', end: '19:00' } }),
    ];
    const cfg = settings();
    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));
    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
  });

  test('a student available on only one day is respected', async () => {
    const app = loadApp();
    const sts = [student('only-fri', { days: [5] }), student('any')];
    const cfg = settings();
    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));
    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    for (const d of [1, 2, 3, 4]) {
      assert.ok(!(sched[d] || []).some(s => s.studentId === 'only-fri'),
        `only-fri must not appear on day ${d}`);
    }
  });

  test('overbooked day drops lessons rather than producing an invalid schedule', async () => {
    const app = loadApp();
    // 10 one-hour lessons into a single 3-hour day: most cannot fit.
    const sts = Array.from({ length: 10 }, (_, i) =>
      student('s' + i, { days: [1], window: { start: '17:00', end: '20:00' } }));
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '17:00', end: '20:00' } } });
    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));
    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg),
      'an incomplete schedule is fine; an invalid one is not');
  });
});

describe('merged blocks (δίωρο)', () => {
  test('a forceMerge student gets one contiguous block, no gap', async () => {
    const app = loadApp();
    const sts = [student('merged', { forceMerge: true, mergeMode: 'always', lessonsPerWeek: 2 })];
    const cfg = settings();
    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));

    const all = cfg.workDays.flatMap(d => (sched[d] || []).map(s => ({ d, s })));
    const mine = all.filter(x => x.s.studentId === 'merged');
    assert.strictEqual(mine.length, 1, 'should be a single block, not fragments');
    const b = mine[0].s;
    assert.strictEqual(app.Scheduler.toMin(b.end) - app.Scheduler.toMin(b.start), 120,
      `expected a contiguous 120min block, got ${b.start}-${b.end}`);
  });

  test('collapseForceMergeFragments does not create an overlap', () => {
    const app = loadApp();
    const sts = [student('F', { forceMerge: true, lessonsPerWeek: 2 }), student('X')];
    const cfg = settings({ workDays: [1] });
    app.setState({ coords: cityCoords(sts), students: sts, settings: cfg,
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });

    // Fragments with another student's lesson sitting between them.
    const sched = { 1: [
      slot('F', '15:00', '16:00'),
      slot('X', '16:15', '17:15'),
      slot('F', '17:30', '18:30'),
    ] };
    app.Scheduler.collapseForceMergeFragments(sched, sts, cfg);
    const errs = auditSchedule(app.Scheduler, sched, sts, cfg)
      .filter(e => /overlap|two lessons same day/.test(e));
    assertClean(errs, 'collapsing must not swallow another lesson');
  });
});

describe('groups and pairs', () => {
  test('both members of a pair must be free, not just the one it is filed under', async () => {
    const app = loadApp();
    const a = student('A');
    const b = student('B', { window: { start: '20:00', end: '22:00' } }); // much narrower
    a.pairedWith = 'B'; b.pairedWith = 'A';
    const cfg = settings();
    const sched = await runPipeline(app, [a, b], cfg, cityCoords([a, b]));
    assertClean(auditSchedule(app.Scheduler, sched, [a, b], cfg));
  });

  test('paired students are never scheduled separately', async () => {
    const app = loadApp();
    const a = student('A'), b = student('B');
    a.pairedWith = 'B'; b.pairedWith = 'A';
    const cfg = settings();
    const sched = await runPipeline(app, [a, b], cfg, cityCoords([a, b]));

    const solo = cfg.workDays.flatMap(d => sched[d] || [])
      .filter(s => (s.studentId === 'A' || s.studentId === 'B') && !s.isGroup && !s.pairedStudentId);
    assert.strictEqual(solo.length, 0, 'a paired student should not get a solo slot');
  });
});

describe('verifySchedule (the app\'s own safety net)', () => {
  const setup = () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1] });
    const sts = [student('A', { days: [1] }), student('B', { days: [1] })];
    app.setState({ coords: cityCoords(sts), students: sts, settings: cfg,
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
    return { app, cfg, sts };
  };

  test('catches a lesson inside a blocked time', () => {
    const { app, sts } = setup();
    const cfg = settings({ workDays: [1], blockedSlots: [{ day: 1, start: '16:00', end: '17:00' }] });
    app.setState({ settings: cfg });
    const sched = { 1: [slot('A', '16:00', '17:00')] };
    assert.ok(Array.from(app.Scheduler.verifySchedule(sched, sts, cfg)).length > 0);
  });

  test('catches an impossible travel time', () => {
    const { app, cfg, sts } = setup();
    app.setState({ coords: { home: { lat: 38.24, lon: 21.73 },
      A: { lat: 38.24, lon: 21.73 }, B: { lat: 38.60, lon: 22.10 } } });
    const sched = { 1: [slot('A', '15:00', '16:00'), slot('B', '16:01', '17:01')] };
    assert.ok(Array.from(app.Scheduler.verifySchedule(sched, sts, cfg)).some(m => /μετακίνησ/.test(m)));
  });

  test('does not cry wolf on a valid schedule', () => {
    const { app, cfg, sts } = setup();
    const sched = { 1: [slot('A', '15:00', '16:00'), slot('B', '16:30', '17:30')] };
    assertClean(app.Scheduler.verifySchedule(sched, sts, cfg));
  });

  test('does not flag a legitimate merged block as a double booking', () => {
    const { app, cfg } = setup();
    const sts = [student('A', { days: [1], lessonsPerWeek: 2, forceMerge: true })];
    app.setState({ students: sts });
    const sched = { 1: [slot('A', '15:00', '17:00', { duration: 120, mergedCount: 2, merged: true })] };
    assertClean(app.Scheduler.verifySchedule(sched, sts, cfg));
  });
});

describe('distance maths', () => {
  test('haversine matches a known real-world distance', () => {
    const app = loadApp();
    // Patras centre → Rio, ~7.1km great-circle.
    const km = app.Scheduler.haversineKm({ lat: 38.2466, lon: 21.7346 }, { lat: 38.2937, lon: 21.7897 });
    assert.ok(km > 6.8 && km < 7.4, `expected ~7.1km, got ${km.toFixed(2)}`);
  });

  test('identical points are zero, never NaN', () => {
    const app = loadApp();
    const p = { lat: 38.25, lon: 21.74 };
    assert.strictEqual(app.Scheduler.haversineKm(p, p), 0);
  });

  test('a real road matrix is preferred over straight-line estimates', () => {
    const app = loadApp();
    app.setState({
      coords: { home: { lat: 38.24, lon: 21.73 }, s1: { lat: 38.25, lon: 21.74 } },
      settings: settings(),
      travelMatrixPeak: {
        coordIds: ['home', 's1'],
        durations: [[0, 900], [900, 0]],   // 15 min by road
        distances: [[0, 8000], [8000, 0]], // 8 km by road
      },
    });
    assert.strictEqual(app.Scheduler.travelEstMin('home', 'H', 's1', 'a', 1), 15);
    assert.strictEqual(app.Scheduler.travelEstKm('home', 'H', 's1', 'a', 1), 8);
  });

  test('falls back to a straight-line estimate when no matrix exists', () => {
    const app = loadApp();
    app.setState({
      coords: { home: { lat: 38.24, lon: 21.73 }, s1: { lat: 38.30, lon: 21.80 } },
      settings: settings(), travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null,
    });
    assert.ok(app.Scheduler.travelEstMin('home', 'H', 's1', 'a', 1) > 0);
  });
});
