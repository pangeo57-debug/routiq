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

/**
 * Run the same phase order runAndNotify uses, so tests cover the real
 * pipeline.
 *
 * Keep this in step with runAndNotify. It had already drifted once: guardedPass
 * and compactDays were added to the app and not here, so every invariant test
 * was checking a schedule the user never actually sees — and compactDays is
 * precisely the phase that rewrites lesson times.
 */
async function runPipeline(app, students, cfg, coords, { budget = 800 } = {}) {
  const S = app.Scheduler;
  app.setState({ coords, students, settings: cfg,
    travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
  const r = await S.runMultiAttempt(students, cfg, coords, 2, false);
  await S.alnsOptimize(r.schedule, students, cfg, coords, budget);
  S.saRepair(r.schedule, students, cfg, r);
  await S.guardedPass(r.schedule, cfg, (sch) => S.lnsRepair(sch, students, cfg, budget));
  S.enforceConstraints(r.schedule, students, cfg);
  S.collapseForceMergeFragments(r.schedule, students, cfg);
  S.compactDays(r.schedule, students, cfg);
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

describe('the constraints hold without the scheduler simply giving up', () => {
  // Respecting every rule is trivial if you place nothing. These two cases have
  // a capacity that can be worked out by hand, so they check BOTH halves at
  // once: no violations, and the free space actually used.

  test('a day chopped into one-hour gaps is filled exactly to its capacity', async () => {
    const app = loadApp();
    // Monday: free only 20:00-21:00                       -> 1 lesson
    // Tuesday: free 15-16, 17-18, 19-20, 21-22            -> 4 lessons
    const cfg = settings({
      workDays: [1, 2],
      blockedSlots: [
        { day: 1, start: '15:00', end: '20:00' }, { day: 1, start: '21:00', end: '22:00' },
        { day: 2, start: '16:00', end: '17:00' }, { day: 2, start: '18:00', end: '19:00' },
        { day: 2, start: '20:00', end: '21:00' },
      ],
    });
    const sts = Array.from({ length: 12 }, (_, i) =>
      student('s' + i, { lessonsPerWeek: 1, lessonDuration: 60, days: [1, 2] }));

    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    assert.equal(totalPlaced(sched, cfg.workDays), 5,
      'five one-hour gaps exist and all five should be used');
  });

  test('two-hour lessons fill a four-hour day exactly twice', async () => {
    const app = loadApp();
    const cfg = settings({
      workDays: [1, 2],
      dayHours: { 1: { start: '16:00', end: '20:00' }, 2: { start: '16:00', end: '20:00' } },
    });
    const sts = Array.from({ length: 10 }, (_, i) => student('s' + i, {
      lessonsPerWeek: 1, lessonDuration: 120, days: [1, 2],
      window: { start: '16:00', end: '20:00' },
    }));

    const sched = await runPipeline(app, sts, cfg, cityCoords(sts));

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    assert.equal(totalPlaced(sched, cfg.workDays), 4,
      'two days of four hours hold exactly four two-hour lessons');
  });

  test('six days, 60 students, pairs and two-hour blocks: still no violation', async () => {
    const app = loadApp();
    const sts = Array.from({ length: 60 }, (_, i) => student('s' + i, {
      lessonsPerWeek: (i % 3) + 1, lessonDuration: [60, 90, 120][i % 3],
      days: [1, 2, 3, 4, 5, 6].filter(d => (i + d) % 3 !== 0),
    }));
    sts[0].pairedWith = 's1'; sts[1].pairedWith = 's0';
    for (const i of [7, 19, 31, 43]) {
      sts[i].forceMerge = true; sts[i].mergeMode = 'always'; sts[i].lessonsPerWeek = 2;
    }
    const cfg = settings({
      workDays: [1, 2, 3, 4, 5, 6],
      dayHours: Object.fromEntries([1, 2, 3, 4, 5, 6].map(d => [d, { start: '15:00', end: '22:00' }])),
      blockedSlots: [{ day: 1, start: '18:00', end: '19:00' },
                     { day: 4, start: '16:00', end: '17:30' },
                     { day: 6, start: '15:00', end: '18:00' }],
    });

    const sched = await runPipeline(app, sts, cfg, cityCoords(sts), { budget: 1200 });

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    assert.ok(totalPlaced(sched, cfg.workDays) > 15, 'and it should still fill the week');
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

  test('optimization reduces distance without dropping any placements', async () => {
    // The optimizer runs AFTER the placement search and must only ever improve
    // the route — a common failure mode in destroy/repair is quietly failing to
    // reinsert something it removed, trading placements for a shorter drive.
    // Placement count is the primary objective; distance only breaks ties.
    const app = loadApp();
    const sts = Array.from({ length: 18 }, (_, i) =>
      student('s' + i, { lessonDuration: [60, 60, 90][i % 3], lessonsPerWeek: (i % 2) + 1 }));
    const cfg = settings();
    const coords = cityCoords(sts);
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
    const S = app.Scheduler;

    const totalKm = (sch) => {
      let km = 0;
      for (const d of cfg.workDays) {
        const sl = (sch[d] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
        let prev = coords.home, prevId = null;
        for (const s of sl) {
          const c = coords[s.studentId] || prev;
          if (prevId !== s.studentId) km += S.haversineKm(prev, c) * 1.4;
          prev = c; prevId = s.studentId;
        }
        if (sl.length) km += S.haversineKm(prev, coords.home) * 1.4;
      }
      return km;
    };

    const r = await S.runMultiAttempt(sts, cfg, coords, 3, false);
    const placedBefore = S.countTotal(r.schedule);
    const kmBefore = totalKm(r.schedule);

    await S.alnsOptimize(r.schedule, sts, cfg, coords, 2000);

    assert.ok(S.countTotal(r.schedule) >= placedBefore,
      `optimizer dropped placements: ${placedBefore} -> ${S.countTotal(r.schedule)}`);
    assert.ok(totalKm(r.schedule) <= kmBefore + 1e-6,
      `optimizer increased distance: ${kmBefore.toFixed(1)} -> ${totalKm(r.schedule).toFixed(1)}`);
    assertClean(auditSchedule(S, r.schedule, sts, cfg));
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

describe('day compaction', () => {
  test('a hole left by a repair pass is closed to travel + margin', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const sts = [1, 2].map(i => student('s' + i,
      { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }));
    app.setState({
      students: sts, settings: cfg,
      coords: { s1: { lat: 38.246, lon: 21.734 }, s2: { lat: 38.252, lon: 21.741 } },
    });
    const sch = { 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
      { studentId: 's2', address: sts[1].address, start: '19:30', end: '20:30' },
    ]};

    app.Scheduler.compactDays(sch, sts, cfg);

    const drive = app.Scheduler.travelEstMin('s1', sts[0].address, 's2', sts[1].address, 1);
    const margin = cfg.travelMargin ?? 2;
    const gap = app.Scheduler.toMin(sch[1][1].start) - app.Scheduler.toMin(sch[1][0].end);
    assert.equal(gap, drive + margin,
      `expected the second lesson ${drive + margin} min after the first, got ${gap}`);
    // The lesson keeps its length — compaction moves, it does not trim.
    assert.equal(app.Scheduler.toMin(sch[1][1].end) - app.Scheduler.toMin(sch[1][1].start), 60);
  });

  test('compaction never pulls a lesson before the student is free', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const sts = [
      student('s1', { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }),
      // Only free from 19:00 — the hole in front of them is not removable.
      student('s2', { days: [1], window: { start: '19:00', end: '22:00' }, lessonsPerWeek: 1, lessonDuration: 60 }),
    ];
    app.setState({ students: sts, settings: cfg,
      coords: { s1: { lat: 38.246, lon: 21.734 }, s2: { lat: 38.252, lon: 21.741 } } });
    const sch = { 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
      { studentId: 's2', address: sts[1].address, start: '19:30', end: '20:30' },
    ]};

    app.Scheduler.compactDays(sch, sts, cfg);
    assert.equal(sch[1][1].start, '19:00', 'should stop at the availability edge, not before it');
  });

  test('compaction respects a break the user reserved', () => {
    const app = loadApp();
    const cfg = settings({
      workDays: [1],
      dayHours: { 1: { start: '15:00', end: '22:00' } },
      blockedSlots: [{ day: 1, start: '16:00', end: '17:00' }],
    });
    const sts = [1, 2].map(i => student('s' + i,
      { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }));
    app.setState({ students: sts, settings: cfg,
      coords: { s1: { lat: 38.246, lon: 21.734 }, s2: { lat: 38.252, lon: 21.741 } } });
    const sch = { 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
      { studentId: 's2', address: sts[1].address, start: '20:00', end: '21:00' },
    ]};

    app.Scheduler.compactDays(sch, sts, cfg);
    assert.equal(sch[1][1].start, '17:00', 'should land after the break, never inside it');
    assert.ok(!app.Scheduler.isBlocked(
      app.Scheduler.toMin(sch[1][1].start), app.Scheduler.toMin(sch[1][1].end), 1, cfg));
  });

  test('two lessons for the same student stay one continuous block', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const st = student('s1', { days: [1], lessonsPerWeek: 2, lessonDuration: 60 });
    st.forceMerge = true;
    app.setState({ students: [st], settings: cfg, coords: { s1: { lat: 38.246, lon: 21.734 } } });
    const sch = { 1: [
      { studentId: 's1', address: st.address, start: '15:00', end: '16:00' },
      { studentId: 's1', address: st.address, start: '16:20', end: '17:20' },
    ]};

    app.Scheduler.compactDays(sch, [st], cfg);
    assert.equal(sch[1][1].start, '16:00', 'a δίωρο gets no travel time and no margin');
    assert.equal(sch[1][1].end, '17:00');
  });

  test('compaction never moves a lesson later', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const sts = [1, 2].map(i => student('s' + i,
      { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }));
    app.setState({ students: sts, settings: cfg,
      coords: { s1: { lat: 38.246, lon: 21.734 }, s2: { lat: 38.252, lon: 21.741 } } });
    // Already tighter than travel time allows — a bad input, but compaction is
    // not the pass that fixes it and must not make it worse by shuffling times.
    const sch = { 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
      { studentId: 's2', address: sts[1].address, start: '16:01', end: '17:01' },
    ]};
    const before = JSON.stringify(sch);
    app.Scheduler.compactDays(sch, sts, cfg);
    assert.equal(JSON.stringify(sch), before);
  });
});

describe('a pass that makes things worse is rejected', () => {
  // Three stops in a line out from home. A two-stop round trip is the same
  // length in either direction, so order only starts to matter at three —
  // visiting the middle one second (s2, s1, s3) is a measurable detour.
  const scenario = (app) => {
    const sts = [1, 2, 3].map(i => student('s' + i, { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }));
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ students: sts, settings: cfg,
      coords: { home: { lat: 38.240, lon: 21.730 },
                s1: { lat: 38.250, lon: 21.730 },
                s2: { lat: 38.260, lon: 21.730 },
                s3: { lat: 38.270, lon: 21.730 } } });
    const inOrder = { 1: sts.map((st, i) => ({
      studentId: st.id, address: st.address,
      start: `1${5 + i}:00`, end: `1${6 + i}:00`,
    })) };
    return { sts, cfg, inOrder };
  };
  // Swap WHO is visited first, keeping the clock times — a schedule is always
  // read in time order, so reordering the array alone changes nothing.
  const swapFirstTwo = (copy) => {
    const a = copy[1];
    [a[0].studentId, a[1].studentId] = [a[1].studentId, a[0].studentId];
    [a[0].address, a[1].address] = [a[1].address, a[0].address];
  };

  test('a pass that costs kilometres for nothing is thrown away', async () => {
    const app = loadApp();
    const { cfg, inOrder: sch } = scenario(app);
    const before = JSON.stringify(sch);

    // A pass that detours through the middle stop — same lessons, longer drive.
    const g = await app.Scheduler.guardedPass(sch, cfg, swapFirstTwo);

    assert.equal(g.kept, false, 'same placements for more km is not an improvement');
    assert.equal(JSON.stringify(sch), before, 'the schedule must be left untouched');
  });

  test('a pass that places one more lesson is kept even if it costs kilometres', async () => {
    const app = loadApp();
    const { sts, cfg } = scenario(app);
    const sch = { 1: [{ studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' }] };

    const g = await app.Scheduler.guardedPass(sch, cfg, (copy) => {
      copy[1].push({ studentId: 's3', address: sts[2].address, start: '16:10', end: '17:10' });
    });

    assert.equal(g.kept, true, 'reaching one more person justifies the drive');
    assert.equal(sch[1].length, 2);
    assert.ok(g.after.km > g.before.km, 'and it did cost km, so this is the real case');
  });

  test('a pass is judged on a copy, so a rejected one leaves nothing behind', async () => {
    const app = loadApp();
    const { cfg, inOrder: sch } = scenario(app);
    await app.Scheduler.guardedPass(sch, cfg, (copy) => {
      swapFirstTwo(copy);
      copy[1][0].end = '99:99';          // vandalise the copy
      copy[2] = [];                     // and add a day that should not survive
    });
    assert.equal(sch[1][0].studentId, 's1');
    assert.equal(sch[1][0].end, '16:00');
    assert.ok(!sch[2], 'a rejected pass must not leak a new day into the schedule');
  });

  test('dropping a lesson is never accepted, however short the week becomes', async () => {
    const app = loadApp();
    const { cfg, inOrder: sch } = scenario(app);
    const g = await app.Scheduler.guardedPass(sch, cfg, (copy) => { copy[1] = []; });
    assert.equal(g.kept, false);
    assert.equal(sch[1].length, 3);
  });

  test('scoreOf counts a group block as everyone in it', () => {
    const app = loadApp();
    const { sts, cfg } = scenario(app);
    const solo = { 1: [{ studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' }] };
    const group = { 1: [{ studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00',
                          isGroup: true, groupMemberCount: 3 }] };
    assert.equal(app.Scheduler.scoreOf(solo, cfg).placed, 1);
    assert.equal(app.Scheduler.scoreOf(group, cfg).placed, 3,
      'otherwise a group of three could be traded away for a shorter drive');
  });
});

describe('reruns never make the schedule worse', () => {
  const worseThan = (app, a, b) => !app.App._isBetterSchedule(a, b) && app.App._isBetterSchedule(b, a);

  test('more lessons placed beats fewer kilometres', () => {
    const app = loadApp();
    assert.ok(app.App._isBetterSchedule({ placed: 20, km: 300 }, { placed: 19, km: 100 }),
      'a shorter week that teaches fewer people is not an improvement');
  });

  test('with the same placements, fewer kilometres wins', () => {
    const app = loadApp();
    assert.ok(app.App._isBetterSchedule({ placed: 20, km: 140 }, { placed: 20, km: 170 }));
    assert.ok(worseThan(app, { placed: 20, km: 170 }, { placed: 20, km: 140 }),
      '170 km must be recognised as worse than 140 km, not merely "not better"');
  });

  test('a rounding-sized difference is not an improvement', () => {
    const app = loadApp();
    assert.ok(!app.App._isBetterSchedule({ placed: 20, km: 139.95 }, { placed: 20, km: 140 }),
      'swapping schedules over 50 metres is churn, not progress');
  });

  test('counts every lesson across every day', () => {
    const app = loadApp();
    assert.equal(app.App._countPlaced({ 1: [1, 2], 3: [1], 5: [] }), 3);
    assert.equal(app.App._countPlaced({}), 0);
    assert.equal(app.App._countPlaced(null), 0);
  });

  test('a schedule referencing a deleted student is not a valid floor', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const sts = [student('s1', { days: [1], lessonsPerWeek: 1, lessonDuration: 60 })];
    app.setState({ students: sts, settings: cfg, coords: { s1: { lat: 38.246, lon: 21.734 } } });
    // s2 was deleted since this schedule was built.
    assert.ok(!app.App._scheduleStillValid({ 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
      { studentId: 's2', address: 'gone', start: '16:10', end: '17:10' },
    ]}), 'a stale schedule must not pin a rerun');
  });

  test('a schedule that breaks the current settings is not a valid floor', () => {
    const app = loadApp();
    // The user has since reserved 15:00-17:00, so the old schedule is illegal.
    const cfg = settings({
      workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } },
      blockedSlots: [{ day: 1, start: '15:00', end: '17:00' }],
    });
    const sts = [student('s1', { days: [1], lessonsPerWeek: 1, lessonDuration: 60 })];
    app.setState({ students: sts, settings: cfg, coords: { s1: { lat: 38.246, lon: 21.734 } } });
    assert.ok(!app.App._scheduleStillValid({ 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
    ]}), 'a schedule violating the new settings must not be restored over a fresh one');
  });

  test('a still-legal schedule is a valid floor', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const sts = [student('s1', { days: [1], lessonsPerWeek: 1, lessonDuration: 60 })];
    app.setState({ students: sts, settings: cfg, coords: { s1: { lat: 38.246, lon: 21.734 } } });
    assert.ok(app.App._scheduleStillValid({ 1: [
      { studentId: 's1', address: sts[0].address, start: '15:00', end: '16:00' },
    ]}));
  });

  test('repeated reruns never report a worse week', async () => {
    // The actual complaint: 140 km, then 170, then 115, then 165. Reruns are
    // randomized searches, so without a floor the result is a lottery. This
    // walks the real phases several times and asserts the sequence only ever
    // improves. Removing either the warm start or the floor makes it fail.
    const app = loadApp();
    const sts = Array.from({ length: 12 }, (_, i) => student('s' + i, { lessonsPerWeek: (i % 2) + 1 }));
    const cfg = settings();
    const coords = cityCoords(sts);
    app.setState({ students: sts, settings: cfg, coords,
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
    const S = app.Scheduler, A = app.App;

    let best = null, bestScore = null;
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const prev = best ? JSON.parse(JSON.stringify(best)) : null;
      const usable = prev && A._scheduleStillValid(prev);

      const r = await S.runMultiAttempt(sts, cfg, coords, 2, false);
      let sched = r.schedule;
      if (usable && !A._isBetterSchedule(
            { placed: A._countPlaced(sched), km: A._estimateTotalKm(sched) },
            { placed: A._countPlaced(prev),  km: A._estimateTotalKm(prev) })) {
        sched = JSON.parse(JSON.stringify(prev));   // warm start
      }
      await S.alnsOptimize(sched, sts, cfg, coords, 400);
      S.enforceConstraints(sched, sts, cfg);
      S.compactDays(sched, sts, cfg);

      let score = { placed: A._countPlaced(sched), km: A._estimateTotalKm(sched) };
      if (usable) {
        const was = { placed: A._countPlaced(prev), km: A._estimateTotalKm(prev) };
        if (A._isBetterSchedule(was, score)) { sched = prev; score = was; }  // floor
      }
      if (bestScore) {
        assert.ok(!A._isBetterSchedule(bestScore, score),
          `run ${i + 1} came back worse: ${JSON.stringify(bestScore)} -> ${JSON.stringify(score)} (${seen.join(' -> ')})`);
      }
      best = sched; bestScore = score;
      seen.push(`${score.placed}/${score.km.toFixed(1)}km`);
    }
  });

  test('an empty schedule is never a floor', () => {
    const app = loadApp();
    app.setState({ students: [], settings: settings() });
    assert.ok(!app.App._scheduleStillValid({}));
    assert.ok(!app.App._scheduleStillValid(null));
  });
});
