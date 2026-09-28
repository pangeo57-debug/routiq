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
  S.tidyDays(r.schedule, students, cfg);
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

  // Four hours hold two two-hour lessons only if the drive between them costs
  // nothing. It does not — so with the working hours taken literally the answer
  // is ONE per day. The original version of this test asserted four, and passed
  // only because the scheduler quietly allowed a 15-minute overrun; it was
  // documenting the defect the user later reported as "it breaks the limits I
  // set". The tolerance is now the user's to grant, so both answers are tested.
  test('two-hour lessons fill a four-hour day as far as the drive allows', async () => {
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
    assert.equal(totalPlaced(sched, cfg.workDays), 2,
      'one two-hour lesson per four-hour day, since the second would overrun');

    // Grant the quarter of an hour and the second lesson fits again.
    const loose = loadApp();
    const cfgLoose = Object.assign({}, cfg, { endFlexMin: 15 });
    const schedLoose = await runPipeline(loose, sts, cfgLoose, cityCoords(sts));
    assertClean(auditSchedule(loose.Scheduler, schedLoose, sts, cfgLoose));
    assert.equal(totalPlaced(schedLoose, cfgLoose.workDays), 4,
      'with the tolerance the user asked for, both fit');
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

describe('swapping two lessons by hand', () => {
  function twoLessons(app, { gapStart = '17:00', cfgOv = {}, stOv = [{}, {}] } = {}) {
    const sts = [1, 2].map(i => student('s' + i,
      Object.assign({ days: [1], lessonsPerWeek: 1, lessonDuration: 60 }, stOv[i - 1])));
    const cfg = settings(Object.assign(
      { workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } }, cfgOv));
    app.setState({ students: sts, settings: cfg,
      coords: { home: { lat: 38.240, lon: 21.730 },
                s1: { lat: 38.246, lon: 21.734 }, s2: { lat: 38.252, lon: 21.741 } } });
    app.state.schedule = { 1: [
      { studentId: 's1', studentName: 's1', address: 'addr-s1', start: '15:00', end: '16:00', duration: 60 },
      { studentId: 's2', studentName: 's2', address: 'addr-s2',
        start: gapStart, end: `${Number(gapStart.slice(0, 2)) + 1}:00`, duration: 60 },
    ]};
    return { sts, cfg };
  }
  const order = (app) => app.state.schedule[1]
    .slice().sort((a, b) => app.Scheduler.toMin(a.start) - app.Scheduler.toMin(b.start))
    .map(s => `${s.studentId}@${s.start}`).join(' ');

  test('two lessons on the same day actually trade places', () => {
    const app = loadApp();
    twoLessons(app);
    // Both free all afternoon, an hour of slack between them: nothing stands
    // in the way. This was refused every single time — the overlap check took
    // only one of the two off the board, so each looked like it collided with
    // the other sitting at the time it was moving into.
    app.App._performSlotSwap(1, 0, 1, 1);
    assert.ok(order(app).startsWith('s2@15:00'), `the swap must go through, got ${order(app)}`);
    assert.ok(order(app).includes('s1@'), 's1 keeps its lesson, at a recomputed time');
  });

  test('a swap is judged only on the problems it introduces', () => {
    const app = loadApp();
    const { cfg } = twoLessons(app);
    // Pre-existing dent in the schedule, nothing to do with this swap.
    app.state.schedule[1].push({ studentId: 's1', studentName: 's1', address: 'addr-s1',
      start: '20:00', end: '21:00', duration: 60 });
    app.App._performSlotSwap(1, 0, 1, 1);
    assert.ok(order(app).startsWith('s2@15:00'),
      'an already-imperfect schedule must not freeze every further edit');
  });

  test('lessons of different lengths swap, each keeping its own duration', () => {
    const app = loadApp();
    // The point of recomputing the day rather than copying start times: a
    // 90-minute lesson moved to where a 60-minute one was runs into the next
    // one, and simply swapping the clock times would either refuse it or cut
    // somebody's lesson short.
    const { sts, cfg } = twoLessons(app, { stOv: [{}, { lessonDuration: 90 }] });
    const s2slot = app.state.schedule[1].find(s => s.studentId === 's2');
    s2slot.duration = 90; s2slot.end = '18:30';

    app.App._performSlotSwap(1, 0, 1, 1);

    const S = app.Scheduler;
    const a = app.state.schedule[1].find(s => s.studentId === 's1');
    const b = app.state.schedule[1].find(s => s.studentId === 's2');
    assert.equal(S.toMin(a.end) - S.toMin(a.start), 60, 's1 stays a 60-minute lesson');
    assert.equal(S.toMin(b.end) - S.toMin(b.start), 90, 's2 stays a 90-minute lesson');
    assert.ok(S.toMin(b.start) < S.toMin(a.start), 's2 now comes first');
    assertClean(auditSchedule(S, app.state.schedule, sts, cfg));
  });

  test('a swap near a reserved break lands after it, not inside it', () => {
    const app = loadApp();
    const { sts, cfg } = twoLessons(app,
      { cfgOv: { blockedSlots: [{ day: 1, start: '17:00', end: '18:00' }] } });
    app.App._performSlotSwap(1, 0, 1, 1);
    // Recomputing the day means the break is worked around rather than the
    // swap being refused — but nothing may end up inside it.
    for (const sl of app.state.schedule[1]) {
      assert.ok(!app.Scheduler.isBlocked(
        app.Scheduler.toMin(sl.start), app.Scheduler.toMin(sl.end), 1, cfg),
        `${sl.studentId} ended up inside the break at ${sl.start}`);
    }
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('a swap nobody has room for is refused', () => {
    const app = loadApp();
    // s1 is free only until 16:30, so it cannot take the later position no
    // matter how the day is re-timed.
    const { sts, cfg } = twoLessons(app, { stOv: [{ window: { start: '15:00', end: '16:30' } }, {}] });
    const before = order(app);
    app.App._performSlotSwap(1, 0, 1, 1);
    assert.equal(order(app), before, 'nothing may move when the swap cannot be made legal');
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('the swap leaves the schedule valid, checked independently', () => {
    const app = loadApp();
    const { sts, cfg } = twoLessons(app);
    app.App._performSlotSwap(1, 0, 1, 1);
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });
});

describe('editing the schedule by hand', () => {
  // The swap bug lived here: a manual-edit path with no test at all, broken in
  // every case, found only because a user hit it. These are the rest of that
  // family — moving a lesson to another day, and adding or removing a break.
  function threeInARow(app, { cfgOv = {}, stOv = {} } = {}) {
    const sts = [1, 2, 3].map(i => student('s' + i,
      Object.assign({ days: [1, 2], lessonsPerWeek: 1, lessonDuration: 60 }, stOv)));
    const cfg = settings(Object.assign({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '22:00' }, 2: { start: '15:00', end: '22:00' } } }, cfgOv));
    app.setState({ students: sts, settings: cfg,
      coords: { home: { lat: 38.240, lon: 21.730 }, s1: { lat: 38.246, lon: 21.734 },
                s2: { lat: 38.252, lon: 21.741 }, s3: { lat: 38.258, lon: 21.748 } } });
    app.state.schedule = { 1: [
      { studentId: 's1', studentName: 's1', address: 'addr-s1', start: '15:00', end: '16:00', duration: 60 },
      { studentId: 's2', studentName: 's2', address: 'addr-s2', start: '16:10', end: '17:10', duration: 60 },
      { studentId: 's3', studentName: 's3', address: 'addr-s3', start: '17:20', end: '18:20', duration: 60 },
    ], 2: [] };
    return { sts, cfg };
  }
  const layout = (app, d) => (app.state.schedule[d] || []).slice()
    .sort((a, b) => app.Scheduler.toMin(a.start) - app.Scheduler.toMin(b.start))
    .map(s => `${s.studentId}@${s.start}`).join(' ');

  test('a lesson moved to another day lands on a valid time there', () => {
    const app = loadApp();
    const { sts, cfg } = threeInARow(app);
    app.App._performSlotMoveToDay(1, app.state.schedule[1][1], 2);
    assert.equal(layout(app, 2), 's2@15:00', 'it should be placed, not dropped');
    assert.ok(!layout(app, 1).includes('s2'), 'and removed from the day it left');
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('a move to a day the student is not available on is refused', () => {
    const app = loadApp();
    const { sts, cfg } = threeInARow(app, { cfgOv: { workDays: [1, 2, 3],
      dayHours: { 1: { start: '15:00', end: '22:00' }, 2: { start: '15:00', end: '22:00' },
                  3: { start: '15:00', end: '22:00' } } } });
    app.state.schedule[3] = [];
    const before = layout(app, 1);
    app.App._performSlotMoveToDay(1, app.state.schedule[1][0], 3);   // nobody is free on day 3
    assert.equal(layout(app, 1), before, 'the lesson must stay where it was');
    assert.equal(layout(app, 3), '', 'and must not appear on a day nobody is free');
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('adding a break pushes the rest of the day later, and is honoured', () => {
    const app = loadApp();
    const { sts, cfg } = threeInARow(app);
    app.App.addBreakAfter(1, '16:00', 30);

    assert.equal(app.state.settings.blockedSlots.length, 1);
    assert.equal(app.state.settings.blockedSlots[0].start, '16:00');
    assert.equal(app.state.settings.blockedSlots[0].end, '16:30');
    // s2 was at 16:10, inside the new break — it has to move past it, plus the
    // drive from s1.
    const s2 = app.state.schedule[1].find(s => s.studentId === 's2');
    assert.ok(app.Scheduler.toMin(s2.start) >= app.Scheduler.toMin('16:30'),
      `s2 should start after the break, got ${s2.start}`);
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('a break nobody has room for is refused without leaving a trace', () => {
    const app = loadApp();
    const { sts, cfg } = threeInARow(app, { stOv: { window: { start: '15:00', end: '18:30' } } });
    const before = layout(app, 1);
    app.App.addBreakAfter(1, '16:00', 180);   // would push s3 past everyone's window
    assert.equal(layout(app, 1), before, 'nothing may move when the break is refused');
    assert.equal(app.state.settings.blockedSlots.length, 0,
      'and a refused break must not be saved anyway');
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('removing a break gives the time straight back', () => {
    const app = loadApp();
    const { sts, cfg } = threeInARow(app);
    app.App.addBreakAfter(1, '16:00', 30);
    const pushed = app.Scheduler.toMin(app.state.schedule[1].find(s => s.studentId === 's3').start);

    app.App.removeBreak(0);

    assert.equal(app.state.settings.blockedSlots.length, 0);
    const back = app.Scheduler.toMin(app.state.schedule[1].find(s => s.studentId === 's3').start);
    assert.ok(back < pushed, `s3 should move back earlier, ${pushed} -> ${back}`);
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });
});

describe('untangling a day that bounces between areas', () => {
  // Two clusters ~10km apart. Availability windows dictate the time order, and
  // time order dictates the driving order, so a day can legally end up going
  // Rio, Patra, Rio, Patra.
  function twoClusters(app, order) {
    const sts = order.map((cluster, i) => student('s' + i, {
      days: [1], lessonsPerWeek: 1, lessonDuration: 60,
      window: { start: '15:00', end: '21:00' },
    }));
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '21:00' } } });
    const coords = { home: { lat: 38.246, lon: 21.734 } };
    sts.forEach((s, i) => {
      coords[s.id] = order[i] === 'A'
        ? { lat: 38.246 + i / 2000, lon: 21.734 }
        : { lat: 38.336 + i / 2000, lon: 21.790 };
    });
    app.setState({ students: sts, settings: cfg, coords });
    // Lay the day out legally first. Stops 10km apart cannot be back to back
    // on the hour, and a starting schedule with impossible travel makes the
    // whole comparison meaningless.
    const raw = sts.map((s, i) => ({
      studentId: s.id, studentName: s.id, address: 'addr-' + s.id,
      start: `${15 + i}:00`, end: `${16 + i}:00`, duration: 60,
    }));
    app.state.schedule = { 1: app.Scheduler.relayoutDay(raw, 1, sts, cfg) || raw };
    return { sts, cfg };
  }

  test('a Rio-Patra-Rio-Patra day is untangled', () => {
    const app = loadApp();
    const { sts, cfg } = twoClusters(app, ['A', 'B', 'A', 'B']);
    const S = app.Scheduler;
    const before = S.dayKm(app.state.schedule[1], 1, cfg);

    const res = S.tidyDays(app.state.schedule, sts, cfg);

    const after = S.dayKm(app.state.schedule[1], 1, cfg);
    assert.ok(res.moves > 0, 'it should find something to fix');
    assert.ok(after < before - 1, `expected a real saving, ${before.toFixed(1)} -> ${after.toFixed(1)}`);
    // The two areas should now be visited in two runs, not four.
    const seq = app.state.schedule[1].slice()
      .sort((a, b) => S.toMin(a.start) - S.toMin(b.start))
      .map(s => app.state.coords[s.studentId].lat > 38.3 ? 'B' : 'A').join('');
    assert.ok(/^A+B+$|^B+A+$/.test(seq), `expected the areas grouped, got ${seq}`);
    assertClean(auditSchedule(S, app.state.schedule, sts, cfg));
  });

  test('an already-sensible day is left alone', () => {
    const app = loadApp();
    const { sts, cfg } = twoClusters(app, ['A', 'A', 'B', 'B']);
    const S = app.Scheduler;
    const before = JSON.stringify(app.state.schedule[1]);
    const res = S.tidyDays(app.state.schedule, sts, cfg);
    assert.equal(res.moves, 0, 'nothing to gain, so nothing should move');
    assert.equal(JSON.stringify(app.state.schedule[1]), before);
  });

  test('untangling never breaks a constraint', () => {
    const app = loadApp();
    const { sts, cfg } = twoClusters(app, ['A', 'B', 'A', 'B']);
    // The middle student is only free late, so the obvious untangling is illegal.
    sts[1].availability[1] = { on: true, start: '18:00', end: '21:00' };
    app.Scheduler.tidyDays(app.state.schedule, sts, cfg);
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
  });

  test('dayDetour scores a straight run at 1.0 and a zig-zag above it', () => {
    const app = loadApp();
    const { cfg } = twoClusters(app, ['A', 'A', 'B', 'B']);
    const straight = app.Scheduler.dayDetour(app.state.schedule[1], 1, cfg);
    const { cfg: cfg2 } = twoClusters(app, ['A', 'B', 'A', 'B']);
    const zigzag = app.Scheduler.dayDetour(app.state.schedule[1], 1, cfg2);
    assert.ok(straight.ratio < 1.05, `a sensible day should score ~1.0, got ${straight.ratio}`);
    assert.ok(zigzag.ratio > 1.3, `a bouncing day should score well above 1, got ${zigzag.ratio}`);
  });
});

describe('dead time in the middle of a day', () => {
  // The complaint: "it still leaves huge gaps sometimes." compactDays pulls
  // lessons earlier but never reorders, so a hole stays open whenever the NEXT
  // student is not free earlier — even when someone later in the day is free
  // all afternoon and could simply move up.
  function holeInTheAfternoon(app) {
    const mk = (id, s, e) => student(id,
      { days: [1], lessonsPerWeek: 1, lessonDuration: 60, window: { start: s, end: e } });
    const sts = [mk('A', '15:00', '16:00'), mk('B', '20:00', '22:00'), mk('C', '15:00', '22:00')];
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ students: sts, settings: cfg, coords: { home: { lat: 38.240, lon: 21.730 },
      A: { lat: 38.246, lon: 21.734 }, B: { lat: 38.252, lon: 21.741 }, C: { lat: 38.249, lon: 21.737 } } });
    app.state.schedule = { 1: [
      { studentId: 'A', studentName: 'A', address: 'addr-A', start: '15:00', end: '16:00', duration: 60 },
      { studentId: 'B', studentName: 'B', address: 'addr-B', start: '20:00', end: '21:00', duration: 60 },
      { studentId: 'C', studentName: 'C', address: 'addr-C', start: '21:05', end: '22:05', duration: 60 },
    ]};
    return { sts, cfg };
  }

  test('a flexible lesson is moved up to fill a four-hour hole', () => {
    const app = loadApp();
    const { sts, cfg } = holeInTheAfternoon(app);
    const S = app.Scheduler;

    S.compactDays(app.state.schedule, sts, cfg);
    const beforeIdle = S.dayIdle(app.state.schedule[1], 1, cfg);
    assert.ok(beforeIdle > 200, `the hole should be there to start with, got ${beforeIdle}`);

    S.tidyDays(app.state.schedule, sts, cfg);

    const afterIdle = S.dayIdle(app.state.schedule[1], 1, cfg);
    assert.ok(afterIdle < beforeIdle - 45,
      `expected the hole to shrink, ${beforeIdle} -> ${afterIdle}`);
    // C is free all afternoon and should now come second, not last.
    const seq = app.state.schedule[1].slice()
      .sort((a, b) => S.toMin(a.start) - S.toMin(b.start)).map(s => s.studentId).join('');
    assert.equal(seq, 'ACB');
    assertClean(auditSchedule(S, app.state.schedule, sts, cfg));
  });

  test('waiting that nobody can avoid is left alone, not faked away', () => {
    const app = loadApp();
    // Only two students, and B genuinely cannot come before 20:00. There is no
    // arrangement without a wait, and the pass must not invent one.
    const mk = (id, s, e) => student(id,
      { days: [1], lessonsPerWeek: 1, lessonDuration: 60, window: { start: s, end: e } });
    const sts = [mk('A', '15:00', '16:00'), mk('B', '20:00', '22:00')];
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ students: sts, settings: cfg, coords: { home: { lat: 38.240, lon: 21.730 },
      A: { lat: 38.246, lon: 21.734 }, B: { lat: 38.252, lon: 21.741 } } });
    app.state.schedule = { 1: [
      { studentId: 'A', studentName: 'A', address: 'addr-A', start: '15:00', end: '16:00', duration: 60 },
      { studentId: 'B', studentName: 'B', address: 'addr-B', start: '20:00', end: '21:00', duration: 60 },
    ]};
    app.Scheduler.tidyDays(app.state.schedule, sts, cfg);
    assertClean(auditSchedule(app.Scheduler, app.state.schedule, sts, cfg));
    assert.equal(app.state.schedule[1].find(s => s.studentId === 'B').start, '20:00',
      'B cannot be moved earlier and must not be');
  });

  test('an hour of waiting outweighs a couple of kilometres', () => {
    const app = loadApp();
    const { cfg } = holeInTheAfternoon(app);
    const S = app.Scheduler;
    const slots = app.state.schedule[1];
    // Same stops, so the same driving — the cost must still separate them.
    assert.ok(S.dayCost(slots, 1, cfg) > S.dayKm(slots, 1, cfg),
      'waiting has to cost something, or a four-hour hole looks free');
    const oneHourOfWaiting = 60 * S.IDLE_KM_PER_MIN;
    assert.ok(oneHourOfWaiting > 2 && oneHourOfWaiting < 10,
      `an hour of waiting should be worth a few km, got ${oneHourOfWaiting}`);
  });
});

describe('traffic by time of day, not just by day', () => {
  // The app fetches BOTH a peak and an off-peak matrix from HERE on every run
  // and used off-peak only on Saturdays, so a 21:00 Tuesday lesson was charged
  // rush-hour traffic. Wrong with data already in hand.
  //
  // Synthetic matrices here: peak legs take 60 minutes, off-peak 10. Real
  // traffic differences are nothing like that large — the exaggeration just
  // makes which matrix was used unmistakable.
  function withMatrices(app) {
    const ids = ['home', 's1', 's2'];
    const mat = (secs) => ({
      coordIds: ids,
      durations: ids.map(() => ids.map(() => secs)),
      distances: ids.map(() => ids.map(() => secs * 10)),
    });
    app.setState({
      travelMatrixPeak: mat(3600),      // 60 min
      travelMatrixOffPeak: mat(600),    // 10 min
      settings: settings(), coords: {},
    });
  }
  const drive = (app, day, atMin) =>
    app.Scheduler.travelEstMin('s1', 'a1', 's2', 'a2', day, atMin);

  test('a rush-hour journey uses the peak matrix', () => {
    const app = loadApp(); withMatrices(app);
    assert.equal(drive(app, 2, 17 * 60), 60, 'Tuesday 17:00 is rush hour');
  });

  test('an evening journey on a weekday no longer pays rush-hour traffic', () => {
    const app = loadApp(); withMatrices(app);
    assert.equal(drive(app, 2, 21 * 60), 10,
      'a 21:00 Tuesday lesson was charged peak traffic before this');
  });

  test('an early-afternoon journey does not pay rush-hour traffic either', () => {
    const app = loadApp(); withMatrices(app);
    assert.equal(drive(app, 2, 15 * 60), 10);
  });

  test('Saturday stays off-peak all day', () => {
    const app = loadApp(); withMatrices(app);
    assert.equal(drive(app, 6, 17 * 60), 10, 'Saturday afternoon is not a commute');
  });

  test('a caller with no time still gets the old behaviour', () => {
    const app = loadApp(); withMatrices(app);
    // Guessing a time for a caller that does not know one would be worse than
    // the conservative answer.
    assert.equal(drive(app, 2, undefined), 60);
  });

  test('with only one matrix available nothing changes', () => {
    const app = loadApp();
    const ids = ['home', 's1', 's2'];
    app.setState({
      travelMatrixPeak: { coordIds: ids,
        durations: ids.map(() => ids.map(() => 1800)), distances: null },
      travelMatrixOffPeak: null, settings: settings(), coords: {},
    });
    assert.equal(drive(app, 2, 21 * 60), 30, 'OSRM has no traffic data at all');
  });

  test('the day cost reflects when each leg is actually driven', () => {
    const app = loadApp(); withMatrices(app);
    const S = app.Scheduler, cfg = app.state.settings;
    const mk = (start) => [
      { studentId: 's1', address: 'a1', start, end: `${Number(start.slice(0,2))+1}:00`, duration: 60 },
      { studentId: 's2', address: 'a2', start: `${Number(start.slice(0,2))+2}:00`,
        end: `${Number(start.slice(0,2))+3}:00`, duration: 60 },
    ];
    const rushHour = S.dayKm(mk('17:00'), 2, cfg);
    const evening  = S.dayKm(mk('20:00'), 2, cfg);
    assert.ok(evening < rushHour,
      `a later day should cost less to drive, got ${evening} vs ${rushHour}`);
  });
});

describe('explaining why a gap is there', () => {
  // The gaps that survive are forced by when people are free — measured:
  // adding dead time to the optimizer's objective changed the result by exactly
  // zero minutes across 10 paired scenarios. So the useful thing is not to keep
  // optimising, it is to name the constraint the user could negotiate.
  function dayWith(app, nextWindow, blocked) {
    const sts = [
      student('A', { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }),
      student('B', { days: [1], lessonsPerWeek: 1, lessonDuration: 60,
        window: nextWindow || { start: '15:00', end: '22:00' } }),
    ];
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } },
      blockedSlots: blocked || [] });
    app.setState({ students: sts, settings: cfg, coords: { home: { lat: 38.240, lon: 21.730 },
      A: { lat: 38.246, lon: 21.734 }, B: { lat: 38.252, lon: 21.741 } } });
    return { sts, cfg,
      prev: { studentId: 'A', address: 'addr-A', start: '15:00', end: '16:00' } };
  }
  const at = (start) => ({ studentId: 'B', address: 'addr-B', start,
    end: `${Number(start.slice(0,2)) + 1}:00` });

  test('a gap caused by the next student names them and their window', () => {
    const app = loadApp();
    const { sts, cfg, prev } = dayWith(app, { start: '19:00', end: '22:00' });
    const why = app.Scheduler.explainGap(prev, at('19:00'), 1, sts, cfg);
    assert.ok(why, 'a three-hour wait deserves an explanation');
    assert.equal(why.kind, 'availability');
    assert.equal(why.name, 'B');
    assert.equal(why.from, '19:00');
    assert.ok(why.wasted > 150, `should report the wasted time, got ${why.wasted}`);
  });

  test('a gap caused by a reserved break says so instead', () => {
    const app = loadApp();
    const { sts, cfg, prev } = dayWith(app, null, [{ day: 1, start: '16:00', end: '18:00' }]);
    const why = app.Scheduler.explainGap(prev, at('18:00'), 1, sts, cfg);
    assert.ok(why);
    assert.equal(why.kind, 'break');
    assert.equal(why.end, '18:00');
  });

  test('a normal handover is not explained as a problem', () => {
    const app = loadApp();
    const { sts, cfg, prev } = dayWith(app);
    // Straight after the drive and the margin — nothing to explain.
    const drive = app.Scheduler.travelEstMin('A', 'addr-A', 'B', 'addr-B', 1, 16 * 60);
    const start = app.Scheduler.toTime(16 * 60 + drive + (cfg.travelMargin ?? 2));
    assert.equal(app.Scheduler.explainGap(prev, { studentId: 'B', address: 'addr-B',
      start, end: '18:00' }, 1, sts, cfg), null);
  });

  test('a couple of minutes is not reported as a gap', () => {
    const app = loadApp();
    const S = app.Scheduler;
    const { sts, cfg, prev } = dayWith(app);
    const drive = S.travelEstMin('A', 'addr-A', 'B', 'addr-B', 1, 16 * 60);
    const couldStart = 16 * 60 + drive + (cfg.travelMargin ?? 2);
    // B is free from two minutes after the earliest possible handover. That is
    // a real constraint, but reporting "B is not free before 16:07" under every
    // lesson would be noise, not information.
    sts[1].availability[1] = { on: true, start: S.toTime(couldStart + 2), end: '22:00' };
    app.setState({ students: sts });
    const next = { studentId: 'B', address: 'addr-B',
      start: S.toTime(couldStart + 2), end: S.toTime(couldStart + 62) };
    assert.equal(S.explainGap(prev, next, 1, sts, cfg), null);

    // Half an hour later, though, is worth explaining.
    sts[1].availability[1] = { on: true, start: S.toTime(couldStart + 30), end: '22:00' };
    const later = { studentId: 'B', address: 'addr-B',
      start: S.toTime(couldStart + 30), end: S.toTime(couldStart + 90) };
    assert.ok(S.explainGap(prev, later, 1, sts, cfg), 'a 30-minute wait should be explained');
  });

  test('the explanation checks every member of a paired block', () => {
    const app = loadApp();
    const { sts, cfg, prev } = dayWith(app);
    // The block is filed under B, but C is the one who cannot come earlier.
    sts.push(student('C', { days: [1], lessonsPerWeek: 1,
      window: { start: '20:00', end: '22:00' } }));
    app.setState({ students: sts });
    const why = app.Scheduler.explainGap(prev,
      { ...at('20:00'), pairedStudentId: 'C' }, 1, sts, cfg);
    assert.equal(why.kind, 'availability');
    assert.equal(why.name, 'C', 'blaming the wrong person would send the user to argue with B');
  });
});

describe('travel time from the lesson before', () => {
  // Found by the benchmark, not by this suite: our own fixtures never had
  // travel times large enough relative to the gaps between lessons, so an
  // unreachable placement always happened to look reachable.
  function twoFarApart(app, blockedSlots) {
    const sts = [
      student('near', { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }),
      student('far',  { days: [1], lessonsPerWeek: 1, lessonDuration: 60 }),
    ];
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '08:00', end: '20:00' } },
      blockedSlots: blockedSlots || [], avgCitySpeedKmh: 40 });
    app.setState({ students: sts, settings: cfg, coords: {
      home: { lat: 38.246, lon: 21.734 },
      near: { lat: 38.250, lon: 21.740 },
      far:  { lat: 38.700, lon: 22.200 },   // ~an hour away
    }});
    return { sts, cfg };
  }

  test('a slot is not offered when there is no time to drive to it', () => {
    const app = loadApp();
    const { sts, cfg } = twoFarApart(app);
    const S = app.Scheduler;
    const existing = [{ studentId: 'near', studentName: 'near', address: 'addr-near',
      start: '08:00', end: '09:00', duration: 60 }];

    const slot = S.findSlotFixed(sts[1], 1, existing, cfg, 60);

    assert.ok(slot, 'the day is long enough, a slot should exist');
    const drive = S.travelEstMin('near', 'addr-near', 'far', 'addr-far', 1);
    assert.ok(drive > 30, `the fixture must actually be far away, got ${drive} min`);
    assert.ok(S.toMin(slot.start) >= S.toMin('09:00') + drive,
      `offered ${slot.start} after a lesson ending 09:00 with a ${drive} min drive`);
  });

  test('a candidate taken from the end of a break still respects the drive', () => {
    const app = loadApp();
    // The break's end is a candidate start time in its own right. That is the
    // path that used to skip the check on what comes before it entirely.
    const { sts, cfg } = twoFarApart(app, [{ day: 1, start: '09:00', end: '10:00' }]);
    const S = app.Scheduler;
    const existing = [{ studentId: 'near', studentName: 'near', address: 'addr-near',
      start: '08:00', end: '09:00', duration: 60 }];

    const slot = S.findSlotFixed(sts[1], 1, existing, cfg, 60);

    const drive = S.travelEstMin('near', 'addr-near', 'far', 'addr-far', 1);
    assert.ok(S.toMin(slot.start) >= S.toMin('09:00') + drive,
      `offered ${slot.start}: the break ends at 10:00 but the drive takes ${drive} min`);
  });

  test('a candidate at the start of the window respects the drive too', () => {
    const app = loadApp();
    const { sts, cfg } = twoFarApart(app);
    const S = app.Scheduler;
    // 'far' is only free from 09:05 — the window start is the natural candidate,
    // and it is five minutes after a lesson an hour's drive away.
    sts[1].availability[1] = { on: true, start: '09:05', end: '20:00' };
    const existing = [{ studentId: 'near', studentName: 'near', address: 'addr-near',
      start: '08:00', end: '09:00', duration: 60 }];

    const slot = S.findSlotFixed(sts[1], 1, existing, cfg, 60);

    const drive = S.travelEstMin('near', 'addr-near', 'far', 'addr-far', 1);
    assert.ok(!slot || S.toMin(slot.start) >= S.toMin('09:00') + drive,
      `offered ${slot && slot.start}, which is unreachable`);
  });

  test('a lesson far in the past does not push the next one later', () => {
    const app = loadApp();
    const { sts, cfg } = twoFarApart(app);
    const S = app.Scheduler;
    // The fix must not over-correct: a morning lesson has no bearing on an
    // evening one beyond the drive itself.
    const existing = [{ studentId: 'near', studentName: 'near', address: 'addr-near',
      start: '08:00', end: '09:00', duration: 60 }];
    sts[1].availability[1] = { on: true, start: '18:00', end: '20:00' };
    const slot = S.findSlotFixed(sts[1], 1, existing, cfg, 60);
    assert.ok(slot, 'an evening slot must still be offered');
    assert.equal(slot.start, '18:00', 'and at the earliest the student is free');
  });
});

describe('a student free in two stretches of one day', () => {
  // Being busy 17:00-18:30 leaves BOTH 15:00-17:00 and 18:30-22:00 usable.
  // Availability used to survive as a single window — the largest — so the
  // earlier stretch was simply thrown away.
  function twoStretches(app, n, gap) {
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '22:00' }, 2: { start: '15:00', end: '22:00' } } });
    app.setState({ settings: cfg, coords: { home: { lat: 38.24, lon: 21.73 } } });
    const sts = Array.from({ length: n }, (_, i) => {
      const st = student('s' + i, { days: [1, 2], lessonsPerWeek: 1, lessonDuration: 60 });
      st.availabilityExceptions = [1, 2].map(d => ({ day: d, ...gap }));
      st.availability = app.App.computeAvailabilityFromExceptions(st.availabilityExceptions);
      return st;
    });
    sts.forEach((s, i) => { app.state.coords[s.id] = { lat: 38.24 + i / 900, lon: 21.73 + i / 900 }; });
    app.setState({ students: sts });
    return { sts, cfg };
  }

  test('both stretches are kept, with the larger still named by start/end', () => {
    const app = loadApp();
    const { sts } = twoStretches(app, 1, { start: '17:00', end: '18:30' });
    const av = sts[0].availability[1];
    assert.deepStrictEqual(Array.from(av.windows.map(w => Array.from(w))),
      [[15 * 60, 17 * 60], [18 * 60 + 30, 22 * 60]]);
    // start/end keep their old meaning so anything not reading windows still
    // sees a real, legal window rather than one spanning the busy hour.
    assert.equal(av.start, '18:30');
    assert.equal(av.end, '22:00');
  });

  test('the scheduler offers slots in the earlier stretch too', () => {
    const app = loadApp();
    const { sts, cfg } = twoStretches(app, 1, { start: '17:00', end: '18:30' });
    const S = app.Scheduler;
    const slot = S.findSlotFixed(sts[0], 1, [], cfg, 60);
    assert.ok(slot, 'a slot should be found');
    assert.equal(slot.start, '15:00', 'the earliest usable moment is in the first stretch');
  });

  test('nothing is ever placed inside the stated gap', async () => {
    const app = loadApp({ seed: 3 });
    const { sts, cfg } = twoStretches(app, 8, { start: '17:00', end: '18:30' });
    const S = app.Scheduler;
    const sched = await runPipeline(app, sts, cfg, app.state.coords);

    assertClean(auditSchedule(S, sched, sts, cfg));
    for (const d of cfg.workDays) {
      for (const sl of (sched[d] || [])) {
        assert.ok(S.toMin(sl.end) <= S.toMin('17:00') || S.toMin(sl.start) >= S.toMin('18:30'),
          `${sl.studentId} sits at ${sl.start}-${sl.end}, inside the hours they said they cannot do`);
      }
    }
  });

  test('an end-of-day overrun never eats into a stated gap', () => {
    const app = loadApp();
    const { sts } = twoStretches(app, 1, { start: '17:00', end: '18:30' });
    const S = app.Scheduler;
    // The tolerance is off by default now, so neither of these may overrun.
    assert.equal(S.fitsAvailability(sts[0], 1, S.toMin('16:10'), S.toMin('17:10')), false);
    assert.equal(S.fitsAvailability(sts[0], 1, S.toMin('21:10'), S.toMin('22:10')), false);

    // Turn it on and it applies to the END OF THE DAY only. Running ten
    // minutes into an hour someone said they are busy is not a rounding error,
    // whatever the setting says.
    app.state.settings.endFlexMin = 15;
    assert.equal(S.fitsAvailability(sts[0], 1, S.toMin('16:10'), S.toMin('17:10')), false,
      'the middle-of-day gap is never negotiable');
    assert.equal(S.fitsAvailability(sts[0], 1, S.toMin('21:10'), S.toMin('22:10')), true);
  });

  test('both stretches actually get used when the day is busy', async () => {
    const app = loadApp({ seed: 3 });
    const { sts, cfg } = twoStretches(app, 8, { start: '17:00', end: '18:30' });
    const sched = await runPipeline(app, sts, cfg, app.state.coords);
    const early = cfg.workDays.flatMap(d => (sched[d] || []))
      .filter(sl => app.Scheduler.toMin(sl.start) < app.Scheduler.toMin('17:00'));
    assert.ok(early.length > 0,
      'the stretch before the gap must be used, not written off as it used to be');
  });
});

describe('a teacher working a split shift', () => {
  test('two intervals become outer hours plus a break in the gap', () => {
    const app = loadApp();
    app.setState({ settings: settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } }) });
    app.App.setDayIntervals(1, [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }]);

    assert.deepStrictEqual(Object.assign({}, app.state.settings.dayHours[1]),
      { start: '09:00', end: '21:00' });
    const auto = app.state.settings.blockedSlots.filter(b => b.auto === 'hours');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].start, '13:00');
    assert.equal(auto[0].end, '17:00');
  });

  test('re-editing the hours does not disturb a break the user added', () => {
    const app = loadApp();
    app.setState({ settings: settings({ workDays: [1], dayHours: { 1: { start: '09:00', end: '21:00' } } }) });
    app.state.settings.blockedSlots = [{ day: 1, start: '20:00', end: '20:30', reason: 'mine' }];
    app.App.setDayIntervals(1, [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }]);
    app.App.setDayIntervals(1, [{ start: '10:00', end: '12:00' }, { start: '18:00', end: '21:00' }]);

    const mine = app.state.settings.blockedSlots.filter(b => b.reason === 'mine');
    assert.equal(mine.length, 1, 'the hand-added break must survive');
    assert.equal(app.state.settings.blockedSlots.filter(b => b.auto === 'hours').length, 1,
      'and the previous auto break must be replaced, not stacked');
  });

  test('overlapping intervals collapse into one', () => {
    const app = loadApp();
    app.setState({ settings: settings({ workDays: [1] }) });
    app.App.setDayIntervals(1, [{ start: '09:00', end: '14:00' }, { start: '13:00', end: '18:00' }]);
    assert.equal(app.state.settings.blockedSlots.filter(b => b.auto === 'hours').length, 0);
    assert.deepStrictEqual(Object.assign({}, app.state.settings.dayHours[1]),
      { start: '09:00', end: '18:00' });
  });

  test('the split reads back exactly as it was entered', () => {
    const app = loadApp();
    app.setState({ settings: settings({ workDays: [1] }) });
    const given = [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }];
    app.App.setDayIntervals(1, given);
    assert.deepStrictEqual(Array.from(app.App.dayIntervals(1)).map(x => Object.assign({}, x)), given);
  });

  test('no lesson lands in the middle of a split shift', async () => {
    const app = loadApp({ seed: 5 });
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '09:00', end: '21:00' } } });
    app.setState({ settings: cfg, coords: { home: { lat: 38.24, lon: 21.73 } }, students: [] });
    app.App.setDayIntervals(1, [{ start: '09:00', end: '13:00' }, { start: '17:00', end: '21:00' }]);

    const sts = Array.from({ length: 10 }, (_, i) =>
      student('s' + i, { days: [1], lessonsPerWeek: 1, lessonDuration: 60,
        window: { start: '09:00', end: '21:00' } }));
    sts.forEach((s, i) => { app.state.coords[s.id] = { lat: 38.24 + i / 900, lon: 21.73 + i / 900 }; });
    app.setState({ students: sts });

    const sched = await runPipeline(app, sts, cfg, app.state.coords);

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    const S = app.Scheduler;
    for (const sl of (sched[1] || [])) {
      assert.ok(S.toMin(sl.end) <= S.toMin('13:00') || S.toMin(sl.start) >= S.toMin('17:00'),
        `${sl.studentId} at ${sl.start}-${sl.end} falls in the middle of the split shift`);
    }
    assert.ok((sched[1] || []).length > 0, 'and the day must still be used');
  });
});

describe('suggesting two clients who could share a session', () => {
  // The one lever that actually creates capacity. Everything else moves work
  // around a fixed amount of time; two people in one session buys an hour back.
  function pool(app, extra) {
    const cfg = settings({ workDays: [1, 2, 3] });
    const mk = (id, subject, dur, win) => {
      const st = student(id, { days: [1, 2, 3], lessonsPerWeek: 1, lessonDuration: dur, window: win });
      st.subject = subject;
      return st;
    };
    const sts = [
      mk('A', 'Μαθηματικά', 60, { start: '15:00', end: '19:00' }),
      mk('B', 'Μαθηματικά', 60, { start: '17:00', end: '22:00' }),   // overlaps A
      mk('C', 'Φυσική', 60, { start: '15:00', end: '22:00' }),        // different subject
      mk('D', 'Μαθηματικά', 90, { start: '15:00', end: '22:00' }),    // different length
      mk('E', 'Μαθηματικά', 60, { start: '15:00', end: '22:00' }),    // far away
      mk('F', 'Μαθηματικά', 60, { start: '08:00', end: '09:00' }),    // no overlap with anyone
      // K matches E on everything except where they live. Without K, nothing
      // in this pool could pair with E at all and the distance rule would go
      // untested — which is exactly what the first version of these tests did.
      mk('K', 'Μαθηματικά', 60, { start: '15:00', end: '22:00' }),
    ].concat(extra || []);
    const coords = { home: { lat: 38.240, lon: 21.730 },
      A: { lat: 38.245, lon: 21.735 }, B: { lat: 38.246, lon: 21.736 },
      C: { lat: 38.247, lon: 21.737 }, D: { lat: 38.248, lon: 21.738 },
      E: { lat: 38.900, lon: 22.500 }, F: { lat: 38.245, lon: 21.735 },
      K: { lat: 38.244, lon: 21.734 } };
    app.setState({ students: sts, settings: cfg, coords });
    return { sts, cfg, coords };
  }

  test('proposes the pair that can actually work', () => {
    const app = loadApp();
    const { sts, cfg, coords } = pool(app);
    const pairs = app.Scheduler.suggestPairs(sts, cfg, coords, []);
    assert.ok(pairs.some(p => [p.a.id, p.b.id].sort().join() === 'A,B'),
      'A and B overlap, match and live next door');
    assert.deepStrictEqual(Array.from(pairs[0].days), [1, 2, 3]);
  });

  test('never proposes a pair that would not make sense', () => {
    const app = loadApp();
    const { sts, cfg, coords } = pool(app);
    const involved = new Set(app.Scheduler.suggestPairs(sts, cfg, coords, []).flatMap(p => [p.a.id, p.b.id]));
    assert.ok(!involved.has('C'), 'different subject');
    assert.ok(!involved.has('D'), 'different lesson length');
    assert.ok(!involved.has('E'),
      'E and K match on subject, length and hours; only the 70km between them rules it out');
    assert.ok(!involved.has('F'), 'no free time in common');
  });

  test('an already-paired client is left alone', () => {
    const app = loadApp();
    const { sts, cfg, coords } = pool(app);
    sts.find(s => s.id === 'A').pairedWith = 'C';
    const involved = new Set(app.Scheduler.suggestPairs(sts, cfg, coords, []).flatMap(p => [p.a.id, p.b.id]));
    assert.ok(!involved.has('A'), 'someone already paired must not be proposed again');
  });

  test('nobody is proposed twice, so the whole list can be accepted at once', () => {
    const app = loadApp();
    const extra = ['G', 'H', 'I'].map(id => {
      const st = student(id, { days: [1, 2, 3], lessonsPerWeek: 1, lessonDuration: 60 });
      st.subject = 'Μαθηματικά';
      return st;
    });
    const { sts, cfg, coords } = pool(app, extra);
    extra.forEach((s, i) => { coords[s.id] = { lat: 38.245 + i / 5000, lon: 21.735 }; });
    const pairs = app.Scheduler.suggestPairs(sts, cfg, coords, []);
    const ids = pairs.flatMap(p => [p.a.id, p.b.id]);
    assert.equal(new Set(ids).size, ids.length, 'a client appears in at most one proposal');
  });

  test('clients who cannot be placed are proposed first', () => {
    const app = loadApp();
    const extra = ['G', 'H'].map(id => {
      const st = student(id, { days: [1, 2, 3], lessonsPerWeek: 1, lessonDuration: 60 });
      st.subject = 'Μαθηματικά';
      return st;
    });
    const { sts, cfg, coords } = pool(app, extra);
    extra.forEach((s, i) => { coords[s.id] = { lat: 38.2451 + i / 8000, lon: 21.7351 }; });
    const pairs = app.Scheduler.suggestPairs(sts, cfg, coords, ['G', 'H']);
    assert.ok(pairs.length >= 1);
    assert.equal(pairs[0].helps, 2, 'the pair that rescues two unplaced clients should lead');
  });

  test('a created pair is scheduled only where BOTH are free', async () => {
    const app = loadApp({ seed: 11 });
    const { sts, cfg, coords } = pool(app);
    // A is free 15:00-19:00, B from 17:00. Their shared time is 17:00-19:00 and
    // the session must land inside it — pairing must not widen either window.
    sts.find(s => s.id === 'A').pairedWith = 'B';
    sts.find(s => s.id === 'B').pairedWith = 'A';
    const sched = await runPipeline(app, sts, cfg, coords);

    assertClean(auditSchedule(app.Scheduler, sched, sts, cfg));
    const S = app.Scheduler;
    const shared = cfg.workDays.flatMap(d => (sched[d] || []))
      .filter(sl => sl.isGroup || sl.pairedStudentId);
    assert.ok(shared.length > 0, 'the pair should get a session');
    for (const sl of shared) {
      assert.ok(S.toMin(sl.start) >= S.toMin('17:00') && S.toMin(sl.end) <= S.toMin('19:00') + 15,
        `shared session at ${sl.start}-${sl.end} falls outside the hours both are free`);
    }
  });

  test('pairing frees up enough room to place more clients', async () => {
    const app = loadApp({ seed: 4 });
    // One short day, six clients wanting an hour each: only some fit.
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '18:00' } } });
    const sts = Array.from({ length: 6 }, (_, i) => {
      const st = student('p' + i, { days: [1], lessonsPerWeek: 1, lessonDuration: 60,
        window: { start: '15:00', end: '18:00' } });
      st.subject = 'Μαθηματικά';
      return st;
    });
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2450 + i / 20000, lon: 21.7350 }; });
    app.setState({ students: sts, settings: cfg, coords });
    const before = app.Scheduler.countTotal(await runPipeline(app, sts, cfg, coords));

    const pairs = app.Scheduler.suggestPairs(sts, cfg, coords, []);
    assert.ok(pairs.length > 0, 'clients this similar and this close should pair');
    for (const p of pairs) {
      sts.find(s => s.id === p.a.id).pairedWith = p.b.id;
      sts.find(s => s.id === p.b.id).pairedWith = p.a.id;
    }
    const after = app.Scheduler.countTotal(await runPipeline(app, sts, cfg, coords));

    assert.ok(after > before,
      `pairing should fit more people into the same three hours, got ${before} -> ${after}`);
  });
});

describe('planning one date, for work that does not repeat', () => {
  // A plumber has five jobs tomorrow and nothing the week after. Until now the
  // app could not hold that at all: the whole model is a template of weekdays.
  // The design point is that this adds no second scheduler — one day's jobs
  // become one-session clients on one weekday and the existing pipeline runs.
  const MONDAY = '2026-09-28';

  function jobs(app, extra) {
    const cfg = settings({ workDays: [1, 2, 3, 4, 5],
      dayHours: Object.fromEntries([1,2,3,4,5].map(d => [d, { start: '08:00', end: '18:00' }])) });
    const list = [
      { id: 'j1', name: 'Leak', address: 'a1', durationMin: 60, date: MONDAY },
      { id: 'j2', name: 'Boiler', address: 'a2', durationMin: 45, durationMax: 120, date: MONDAY },
      { id: 'j3', name: 'Tap', address: 'a3', durationMin: 30, date: MONDAY,
        window: { start: '14:00', end: '18:00' } },
      { id: 'j4', name: 'Radiator', address: 'a4', durationMin: 90, date: MONDAY },
      { id: 'j5', name: 'Another day', address: 'a5', durationMin: 60, date: '2026-09-29' },
    ].concat(extra || []);
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    list.forEach((j, i) => { coords[j.id] = { lat: 38.240 + i / 300, lon: 21.730 + i / 400 }; });
    app.setState({ jobs: list, settings: cfg, coords, students: [], schedule: {},
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
    return { list, cfg, coords };
  }

  test('only the chosen date is planned', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = jobs(app);
    const plan = await app.Scheduler.planDay(list, cfg, coords, MONDAY);
    assert.equal(plan.stops.length, 4);
    assert.ok(!plan.stops.some(x => x.job.id === 'j5'), 'a job dated another day must not appear');
    assert.deepStrictEqual(Array.from(plan.unplanned), []);
  });

  test('a job with a range is booked for the longer estimate', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = jobs(app);
    const S = app.Scheduler;
    const plan = await S.planDay(list, cfg, coords, MONDAY);
    const boiler = plan.stops.find(x => x.job.id === 'j2');
    // Running over costs the next customer their slot; finishing early costs
    // nobody anything.
    assert.equal(S.toMin(boiler.end) - S.toMin(boiler.start), 120);
  });

  test('a customer time window is honoured', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = jobs(app);
    const S = app.Scheduler;
    const plan = await S.planDay(list, cfg, coords, MONDAY);
    const tap = plan.stops.find(x => x.job.id === 'j3');
    assert.ok(S.toMin(tap.start) >= S.toMin('14:00'), `booked at ${tap.start}, before the window opens`);
    assert.ok(S.toMin(tap.end) <= S.toMin('18:00') + 15);
  });

  test('the day obeys working hours, travel and breaks', async () => {
    const app = loadApp({ seed: 2 });
    const cfgOv = { workDays: [1], dayHours: { 1: { start: '08:00', end: '18:00' } },
      blockedSlots: [{ day: 1, start: '12:00', end: '13:00' }] };
    const { list, cfg, coords } = jobs(app);
    Object.assign(cfg, cfgOv);
    const S = app.Scheduler;
    const plan = await S.planDay(list, cfg, coords, MONDAY);
    assert.equal(plan.issues.length, 0, `the verifier found: ${Array.from(plan.issues).join(' | ')}`);
    for (const x of plan.stops) {
      assert.ok(!S.isBlocked(S.toMin(x.start), S.toMin(x.end), 1, cfg),
        `${x.job.name} at ${x.start} lands in the reserved break`);
      assert.ok(S.toMin(x.start) >= S.toMin('08:00') && S.toMin(x.end) <= S.toMin('18:00') + 15);
    }
    // And enough time to drive between them.
    for (let i = 1; i < plan.stops.length; i++) {
      const a = plan.stops[i - 1], b = plan.stops[i];
      const need = S.travelEstMin(a.job.id, a.address, b.job.id, b.address, 1) + (cfg.travelMargin ?? 2);
      assert.ok(S.toMin(b.start) >= S.toMin(a.end) + need,
        `${a.job.name} → ${b.job.name}: ${S.toMin(b.start) - S.toMin(a.end)} min for a ${need} min drive`);
    }
  });

  test('what does not fit is reported, not dropped quietly', async () => {
    const app = loadApp({ seed: 2 });
    // Six two-hour jobs will not fit in a ten-hour day once travel is counted.
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: 'x' + i, name: 'Job ' + i, address: 'ax' + i, durationMin: 120, date: MONDAY }));
    const { cfg, coords } = jobs(app, many);
    const plan = await app.Scheduler.planDay(app.state.jobs, cfg, coords, MONDAY);
    assert.ok(plan.unplanned.length > 0, 'an overbooked day must say what is left over');
    const ids = new Set(plan.stops.map(x => x.job.id));
    assert.ok(plan.unplanned.every(j => !ids.has(j.id)), 'nothing can be both planned and left over');
  });

  test('a job marked done is not planned again', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = jobs(app);
    list[0].done = true;
    const plan = await app.Scheduler.planDay(list, cfg, coords, MONDAY);
    assert.ok(!plan.stops.some(x => x.job.id === 'j1'));
  });

  test('a Sunday borrows Saturday hours rather than refusing', async () => {
    const app = loadApp({ seed: 2 });
    const { cfg, coords } = jobs(app);
    cfg.workDays = [6]; cfg.dayHours = { 6: { start: '09:00', end: '15:00' } };
    const sunday = [{ id: 's1', name: 'Emergency', address: 'as', durationMin: 60, date: '2026-09-27' }];
    coords.s1 = { lat: 38.245, lon: 21.735 };
    assert.equal(app.Scheduler.weekdayOf('2026-09-27'), 6, 'Sunday maps onto the Saturday slot');
    const plan = await app.Scheduler.planDay(sunday, cfg, coords, '2026-09-27');
    assert.equal(plan.stops.length, 1, 'a Sunday callout must still be plannable');
  });

  test('planning a day leaves the weekly schedule untouched', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = jobs(app);
    // The weekly roster and its schedule are a separate world and must survive
    // intact — mixing the two lists would make every existing rule ambiguous.
    const weekly = [student('w1', { lessonsPerWeek: 1 })];
    const weeklySchedule = { 1: [{ studentId: 'w1', studentName: 'w1', address: 'addr-w1',
      start: '15:00', end: '16:00', duration: 60 }] };
    app.setState({ students: weekly, schedule: weeklySchedule });
    const before = JSON.stringify(app.state.schedule);

    await app.Scheduler.planDay(list, cfg, coords, MONDAY);

    assert.equal(JSON.stringify(app.state.schedule), before, 'the weekly schedule must not move');
    assert.equal(app.state.students.length, 1, 'and the roster must not gain the jobs');
  });

  test('an empty day is an empty plan, not an error', async () => {
    const app = loadApp({ seed: 2 });
    const { cfg, coords } = jobs(app);
    const plan = await app.Scheduler.planDay([], cfg, coords, MONDAY);
    assert.deepStrictEqual(Array.from(plan.stops), []);
    assert.equal(plan.km, 0);
  });

  test('a nonsense date is refused rather than guessed at', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = jobs(app);
    assert.equal(await app.Scheduler.planDay(list, cfg, coords, 'not-a-date'), null);
  });
});

// ---------------------------------------------------------------------------
// The limits the user typed are the limits they get
// ---------------------------------------------------------------------------

describe('the working day the user set is not overridden by the app', () => {
  // Both of these shipped. The user's report was "it leaves huge gaps and
  // breaks the time limits I set, all by itself" — two separate defects, both
  // of them the app quietly substituting its own numbers for theirs.

  test('a lesson may not run past the end of the working day', async () => {
    const app = loadApp({ seed: 3 });
    const S = app.Scheduler;
    // The day ends at 21:00 and everything before 20:00 is blocked, so the
    // only room left is exactly one hour. The lesson needs seventy minutes.
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '17:00', end: '21:00' } },
      blockedSlots: [{ day: 1, start: '17:00', end: '20:00', reason: 'x' }] });
    const sts = [student('a', { days: [1], window: { start: '17:00', end: '23:00' },
      lessonDuration: 70 })];
    const coords = cityCoords(sts);
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });

    const r = await S.runMultiAttempt(sts, cfg, coords, 3, false);
    const placed = r.schedule[1] || [];
    // It used to be placed 20:00–21:10: a hard-coded 15-minute tolerance let
    // the scheduler overshoot the one number the user had set by hand.
    assert.ok(placed.every(sl => S.toMin(sl.end) <= S.toMin('21:00')),
      `nothing may end after 21:00, got ${placed.map(s => s.start + '-' + s.end).join(', ')}`);
    assert.deepStrictEqual(Array.from(auditSchedule(S, r.schedule, sts, cfg)), []);
  });

  test('the tolerance comes back only when the user asks for it', async () => {
    const app = loadApp({ seed: 3 });
    const S = app.Scheduler;
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '17:00', end: '21:00' } },
      blockedSlots: [{ day: 1, start: '17:00', end: '20:00', reason: 'x' }],
      endFlexMin: 15 });
    const sts = [student('a', { days: [1], window: { start: '17:00', end: '23:00' },
      lessonDuration: 70 })];
    const coords = cityCoords(sts);
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });

    const r = await S.runMultiAttempt(sts, cfg, coords, 3, false);
    assert.equal((r.schedule[1] || []).length, 1, 'with 15 minutes of slack it fits');
    assert.equal(r.schedule[1][0].end, '21:10');
  });

  test('the default for an existing user is strict, not the old 15 minutes', () => {
    const app = loadApp();
    app.setState({ settings: settings() });           // no endFlexMin at all
    assert.equal(app.Scheduler.endFlex(), 0);
  });
});

describe('planning a day the user has not configured', () => {
  const SATURDAY = '2026-10-03';

  function workdayHours(app) {
    const cfg = settings({ workDays: [1, 2, 3, 4, 5] });
    cfg.dayHours = Object.fromEntries([1, 2, 3, 4, 5]
      .map(d => [d, { start: '09:00', end: '14:00' }]));
    const list = [
      { id: 'j1', name: 'A', address: 'a1', durationMin: 60, date: SATURDAY },
      { id: 'j2', name: 'B', address: 'a2', durationMin: 60, date: SATURDAY },
    ];
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    list.forEach((j, i) => { coords[j.id] = { lat: 38.24 + i / 300, lon: 21.73 + i / 400 }; });
    app.setState({ settings: cfg, coords, students: [], jobs: list, schedule: {},
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
    return { list, cfg, coords };
  }

  test('borrows the hours the user actually works instead of inventing a day', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = workdayHours(app);
    const plan = await app.Scheduler.planDay(list, cfg, coords, SATURDAY, { budgetMs: 200 });
    // The old fallback was a hard-coded 08:00–20:00, so a user whose days run
    // 09:00–14:00 was handed a job starting at 08:00.
    assert.ok(plan.stops.length > 0, 'the day should still be plannable');
    for (const s of plan.stops) {
      assert.ok(app.Scheduler.toMin(s.start) >= app.Scheduler.toMin('09:00'),
        `${s.job.name} starts at ${s.start}, before any hour the user works`);
      assert.ok(app.Scheduler.toMin(s.end) <= app.Scheduler.toMin('14:00'),
        `${s.job.name} ends at ${s.end}, after any hour the user works`);
    }
  });

  test('and says that it borrowed them', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = workdayHours(app);
    const plan = await app.Scheduler.planDay(list, cfg, coords, SATURDAY, { budgetMs: 200 });
    assert.equal(plan.hours.assumed, true, 'a borrowed working day must be flagged, not silent');
    assert.equal(plan.hours.start, '09:00');
    assert.equal(plan.hours.end, '14:00');
  });

  test('a configured day is used exactly, and not flagged', async () => {
    const app = loadApp({ seed: 2 });
    const { list, cfg, coords } = workdayHours(app);
    const MONDAY_ = '2026-09-28';
    const l = list.map(j => ({ ...j, date: MONDAY_ }));
    const plan = await app.Scheduler.planDay(l, cfg, coords, MONDAY_, { budgetMs: 200 });
    assert.equal(plan.hours.assumed, false);
    assert.equal(plan.hours.start, '09:00');
  });
});

describe('the day plan explains its holes', () => {
  const FRIDAY = '2026-10-02';

  test('waiting forced by a customer window is named as such', async () => {
    const app = loadApp({ seed: 3 });
    const cfg = settings({ workDays: [1, 2, 3, 4, 5] });
    cfg.dayHours = { 5: { start: '08:00', end: '18:00' } };
    cfg.blockedSlots = [];
    const list = [
      { id: 'k1', name: 'Morning', address: 'a', durationMin: 60, date: FRIDAY,
        window: { start: '08:00', end: '10:00' } },
      { id: 'k2', name: 'Afternoon', address: 'b', durationMin: 60, date: FRIDAY,
        window: { start: '16:00', end: '18:00' } },
    ];
    const coords = { home: { lat: 38.24, lon: 21.73 } };
    list.forEach((j, i) => { coords[j.id] = { lat: 38.24 + i / 200, lon: 21.73 + i / 200 }; });
    app.setState({ settings: cfg, coords, students: [], schedule: {},
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });

    const plan = await app.Scheduler.planDay(list, cfg, coords, FRIDAY, { budgetMs: 300 });
    assert.equal(plan.stops.length, 2);
    // Six hours of nothing in the middle of the day looks like a broken app
    // until it says whose decision it was.
    assert.equal(plan.waits.length, 1, 'the hole must be reported');
    assert.equal(plan.waits[0].reason, 'window');
    assert.ok(plan.waits[0].minutes > 240, `got ${plan.waits[0].minutes} minutes`);
  });

  test('travel and the safety margin are not counted as waiting', async () => {
    const app = loadApp({ seed: 3 });
    const cfg = settings({ workDays: [5] });
    cfg.dayHours = { 5: { start: '08:00', end: '18:00' } };
    cfg.blockedSlots = [];
    const list = [];
    for (let i = 0; i < 4; i++)
      list.push({ id: 'n' + i, name: 'J' + i, address: 'a' + i, durationMin: 60, date: FRIDAY });
    const coords = { home: { lat: 38.24, lon: 21.73 } };
    list.forEach((j, i) => { coords[j.id] = { lat: 38.24 + i * 0.004, lon: 21.73 + i * 0.004 }; });
    app.setState({ settings: cfg, coords, students: [], schedule: {},
      travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });

    const plan = await app.Scheduler.planDay(list, cfg, coords, FRIDAY, { budgetMs: 300 });
    assert.equal(plan.stops.length, 4);
    assert.deepStrictEqual(Array.from(plan.waits), [],
      'a back-to-back day has no waiting to report');
  });
});

// ---------------------------------------------------------------------------
// Closing a hole with work from another day
// ---------------------------------------------------------------------------

describe('a long gap survives only if nobody can go in it', () => {
  // Everything else closes gaps within a single day: compactDays pulls lessons
  // earlier, tidyDays reorders them, and lnsRepair only places students who are
  // still short of lessons. Nothing moved an already-placed lesson across days,
  // so a hole on Monday that could only be filled from Tuesday stayed open.

  function world(over = {}) {
    const app = loadApp();
    const cfg = settings(Object.assign({
      workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '21:00' }, 2: { start: '15:00', end: '21:00' } },
    }, over.cfg || {}));
    const sts = over.students || [
      student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
      student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
      student('free',  { days: [1, 2], window: { start: '15:00', end: '21:00' } }),
    ];
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 2000, lon: 21.7305 + i / 2000 }; });
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    return { app, cfg, sts };
  }

  // Monday: 15:00–16:00, then nothing until 19:00. Tuesday holds one lesson
  // whose student is free on Monday all afternoon.
  const holed = () => ({
    1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
        slot('late',  '19:00', '20:00', { address: 'addr-late' })],
    2: [slot('free',  '15:00', '16:00', { address: 'addr-free' })],
  });

  test('fills the hole from another day', () => {
    const { app, cfg, sts } = world();
    const sched = holed();
    const r = app.Scheduler.fillGaps(sched, sts, cfg);

    assert.equal(r.moved.length, 1, 'the movable lesson should have moved');
    assert.equal(r.moved[0].from, 2);
    assert.equal(r.moved[0].to, 1);
    const monday = sched[1].map(s => s.studentId);
    assert.ok(monday.includes('free'), `Monday is ${JSON.stringify(monday)}`);
    assert.deepStrictEqual(Array.from(sched[2]), [], 'and left Tuesday');
  });

  test('without dropping anyone or breaking a rule', () => {
    const { app, cfg, sts } = world();
    const sched = holed();
    const placedBefore = app.Scheduler.countTotal(sched);
    app.Scheduler.fillGaps(sched, sts, cfg);
    assert.equal(app.Scheduler.countTotal(sched), placedBefore,
      'a placement lost to tidy up a gap is a bad trade at any price');
    assert.deepStrictEqual(Array.from(auditSchedule(app.Scheduler, sched, sts, cfg)), []);
  });

  test('refuses when the student does not work that day', () => {
    const { app, cfg, sts } = world({
      students: [
        student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
        student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
        student('free',  { days: [2], window: { start: '15:00', end: '21:00' } }),
      ],
    });
    const sched = holed();
    assert.equal(app.Scheduler.fillGaps(sched, sts, cfg).moved.length, 0);
    assert.equal(sched[2].length, 1, 'their Tuesday lesson stays put');
  });

  test('refuses when it would give someone two lessons in one day', () => {
    const { app, cfg, sts } = world();
    const sched = holed();
    // 'free' is already on Monday, so bringing their Tuesday lesson over too
    // is not closing a gap, it is a double booking.
    sched[1].push(slot('free', '20:30', '21:00', { address: 'addr-free', duration: 30 }));
    sched[1].sort((a, b) => app.Scheduler.toMin(a.start) - app.Scheduler.toMin(b.start));
    assert.equal(app.Scheduler.fillGaps(sched, sts, cfg).moved.length, 0);
  });

  test('leaves a short gap alone', () => {
    const { app, cfg, sts } = world();
    const S = app.Scheduler;
    // A hole a 30-minute lesson genuinely fits into, but not a long one. The
    // test proves the threshold is the reason it is refused, rather than the
    // arithmetic quietly making the move impossible anyway: with the threshold
    // lowered, the very same move goes through.
    const build = () => ({
      1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
          slot('late',  '16:40', '17:40', { address: 'addr-late' })],
      2: [slot('free',  '15:00', '15:30', { address: 'addr-free', duration: 30 })],
    });
    const sched = build();
    const before = JSON.stringify(sched);
    assert.equal(S.fillGaps(sched, sts, cfg).moved.length, 0, 'too short to be worth it');
    assert.equal(JSON.stringify(sched), before);

    const keep = S.GAP_FILL_MIN;
    try {
      S.GAP_FILL_MIN = 5;
      const loose = build();
      assert.equal(S.fillGaps(loose, sts, cfg).moved.length, 1,
        'the move itself is legal — only the threshold was stopping it');
    } finally { S.GAP_FILL_MIN = keep; }
  });

  test('never moves a lesson two people share', () => {
    const { app, cfg } = world();
    const sts = [
      student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
      student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
      student('p1', { days: [1, 2], window: { start: '15:00', end: '21:00' }, pairedWith: 'p2' }),
      student('p2', { days: [1, 2], window: { start: '15:00', end: '21:00' }, pairedWith: 'p1' }),
    ];
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 2000, lon: 21.7305 + i / 2000 }; });
    app.setState({ coords, students: sts, settings: cfg });
    const sched = {
      1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
          slot('late',  '19:00', '20:00', { address: 'addr-late' })],
      2: [slot('p1', '15:00', '16:00', { address: 'addr-p1',
            pairedStudentId: 'p2', isGroup: true, groupMemberIds: ['p1', 'p2'] })],
    };
    assert.equal(app.Scheduler.fillGaps(sched, sts, cfg).moved.length, 0,
      'a shared session cannot be moved by considering one occupant');
  });

  test('refuses a move that costs more driving than the waiting is worth', () => {
    const app = loadApp();
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '21:00' }, 2: { start: '15:00', end: '21:00' } } });
    const sts = [
      student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
      student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
      student('far',   { days: [1, 2], window: { start: '15:00', end: '21:00' } }),
      student('stay',  { days: [2], window: { start: '15:00', end: '21:00' } }),
    ];
    // Two clusters. Monday's work and home are in one; Tuesday's are together
    // in the other. 'far' could legally fill Monday's hole — the drive fits
    // inside it — but Tuesday has to be driven out there for 'stay' anyway, so
    // the move buys a tidier Monday with a round trip across the city.
    const coords = {
      home:  { lat: 38.2400, lon: 21.7300 },
      early: { lat: 38.2405, lon: 21.7305 },
      late:  { lat: 38.2410, lon: 21.7310 },
      far:   { lat: 38.2750, lon: 21.7650 },
      stay:  { lat: 38.2760, lon: 21.7660 },
    };
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });

    const sched = {
      1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
          slot('late',  '19:00', '20:00', { address: 'addr-late' })],
      2: [slot('far',  '15:00', '16:00', { address: 'addr-far' }),
          slot('stay', '16:30', '17:30', { address: 'addr-stay' })],
    };
    const before = JSON.stringify(sched);
    assert.equal(app.Scheduler.fillGaps(sched, sts, cfg).moved.length, 0,
      'a tidier Monday is not worth a trip across the city');
    assert.equal(JSON.stringify(sched), before);
  });

  test('a schedule with no long gaps comes back untouched', async () => {
    const app = loadApp({ seed: 5 });
    const cfg = settings({ workDays: [1, 2, 3] });
    const sts = Array.from({ length: 9 }, (_, i) =>
      student('s' + i, { days: [1, 2, 3], window: { start: '15:00', end: '22:00' },
        lessonsPerWeek: 1 }));
    const coords = cityCoords(sts);
    const sched = await runPipeline(app, sts, cfg, coords);
    const before = JSON.stringify(sched);
    const r = app.Scheduler.fillGaps(sched, sts, cfg);
    assert.equal(r.moved.length, 0);
    assert.equal(JSON.stringify(sched), before, 'a tight week must not be disturbed');
  });
});

// ---------------------------------------------------------------------------
// Things that silently switched the optimizer off
// ---------------------------------------------------------------------------

describe('the optimizer is not disabled by the working hours', () => {
  // Found by auditing rather than by a bug report, and it was the expensive
  // one: alnsOptimize laid every candidate day out starting at the exact
  // opening of the working day, so if the first student in that arrangement
  // was not free yet, the whole arrangement was declared infeasible. A tutor
  // whose hours begin at 15:00 while the students are at school until 17:00
  // therefore got NO optimization at all — the search rejected everything it
  // generated.

  function town(app, openAt) {
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: openAt, end: '22:00' } } });
    const sts = [
      student('a', { days: [1], window: { start: '17:00', end: '22:00' } }),
      student('b', { days: [1], window: { start: '17:00', end: '22:00' } }),
      student('c', { days: [1], window: { start: '17:00', end: '22:00' } }),
    ];
    // a and c are neighbours out of town; b is next door to home. Visiting
    // a, b, c in that order crosses the city twice for nothing.
    const coords = { home: { lat: 38.240, lon: 21.730 },
      a: { lat: 38.300, lon: 21.790 }, c: { lat: 38.302, lon: 21.792 },
      b: { lat: 38.241, lon: 21.731 } };
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    return { cfg, sts, coords };
  }
  const badOrder = () => ({ 1: [
    slot('a', '17:00', '18:00', { address: 'addr-a' }),
    slot('b', '18:20', '19:20', { address: 'addr-b' }),
    slot('c', '19:40', '20:40', { address: 'addr-c' }),
  ]});

  async function optimisedKm(openAt) {
    const app = loadApp({ seed: 7 });
    const { cfg, sts, coords } = town(app, openAt);
    const S = app.Scheduler;
    const sched = badOrder();
    const km = () => S.dayKm(sched[1].slice()
      .sort((x, y) => S.toMin(x.start) - S.toMin(y.start)), 1, cfg);
    const before = km();
    await S.alnsOptimize(sched, sts, cfg, coords, 3000);
    assert.deepStrictEqual(Array.from(auditSchedule(S, sched, sts, cfg)), []);
    return { before, after: km() };
  }

  test('a day that opens before anyone is free still gets optimized', async () => {
    const open15 = await optimisedKm('15:00');
    assert.ok(open15.after < open15.before * 0.75,
      `the crossing should be removed: ${open15.before.toFixed(1)} -> ${open15.after.toFixed(1)} km`);
  });

  test('and reaches the same answer as a day that opens when they are', async () => {
    // The user's opening time is not information about the route. Two tutors
    // with identical students must get identical routes.
    const [wide, tight] = [await optimisedKm('15:00'), await optimisedKm('17:00')];
    assert.equal(wide.after.toFixed(1), tight.after.toFixed(1),
      `opening earlier must not cost quality: ${wide.after.toFixed(1)} vs ${tight.after.toFixed(1)}`);
  });
});

describe('the optimizer uses the same travel times as everything else', () => {
  // travelEstMin has always been time-aware; the optimizer simply never told
  // it what time it was, so every journey it costed came back at rush-hour
  // length. Testing the helper alone passes on the broken build — this project
  // has shipped three bugs that lived in the CALL, not the function — so this
  // goes through alnsOptimize and watches what it does with a morning.
  const MIN = 60;
  function morning(app) {
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '09:00', end: '13:00' } } });
    const sts = ['a', 'b', 'c'].map(id =>
      student(id, { days: [1], window: { start: '09:00', end: '13:00' }, lessonDuration: 60 }));
    // Distances: a and c are neighbours, b sits next to home. Order a,b,c
    // crosses town twice. Peak claims every leg takes an hour, off-peak five
    // minutes — so under peak timings three lessons cannot fit the morning at
    // all, and the optimizer rejects every arrangement it generates.
    const ids = ['home', 'a', 'b', 'c'];
    const pos = { home: 0, a: 10, b: 0.5, c: 10.2 };
    const dist = ids.map(i => ids.map(j => Math.abs(pos[i] - pos[j]) * 1000));
    const mk = (secs) => ({ coordIds: ids,
      durations: ids.map((i, x) => ids.map((j, y) => (x === y ? 0 : secs))),
      distances: dist });
    app.setState({ students: sts, settings: cfg,
      coords: { home: { lat: 38.24, lon: 21.73 }, a: { lat: 38.33, lon: 21.73 },
                b: { lat: 38.245, lon: 21.73 }, c: { lat: 38.332, lon: 21.73 } },
      travelMatrixPeak: mk(60 * MIN), travelMatrixOffPeak: mk(5 * MIN), travelMatrix: null });
    return { cfg, sts };
  }

  test('a morning is optimized using its own travel times, not rush hour', async () => {
    const app = loadApp({ seed: 4 });
    const { cfg, sts } = morning(app);
    const S = app.Scheduler;
    const sched = { 1: [
      slot('a', '09:00', '10:00', { address: 'addr-a' }),
      slot('b', '10:05', '11:05', { address: 'addr-b' }),
      slot('c', '11:10', '12:10', { address: 'addr-c' }),
    ]};
    const km = () => S.dayKm(sched[1].slice()
      .sort((x, y) => S.toMin(x.start) - S.toMin(y.start)), 1, cfg);
    const before = km();
    await S.alnsOptimize(sched, sts, cfg, {}, 3000);
    assert.ok(km() < before * 0.8,
      `the double crossing should go: ${before.toFixed(1)} -> ${km().toFixed(1)} km`);
  });

  test('and the helper itself still answers by time of day', () => {
    const app = loadApp();
    const { cfg } = morning(app);
    const S = app.Scheduler;
    assert.equal(S.travelEstMin('a', 'addr-a', 'b', 'addr-b', 1, S.toMin('10:00')), 5);
    assert.equal(S.travelEstMin('a', 'addr-a', 'b', 'addr-b', 1, S.toMin('17:00')), 60);
    assert.equal(S.travelEstMin('a', 'addr-a', 'b', 'addr-b', 1), 60, 'no time given: assume the worst');
  });
});

// ---------------------------------------------------------------------------
// Caching the things the search asks for two million times
// ---------------------------------------------------------------------------

describe('travel and time caches answer exactly what the slow path would', () => {
  // A cache that is merely fast is worthless; these check it is also the same.
  // Measured first: a 24-client search made 2,000,000 travelEstMin calls
  // against a few hundred distinct journeys, and haversineKm alone was 40% of
  // the scheduler's CPU.

  function world(withMatrix) {
    const app = loadApp();
    const sts = Array.from({ length: 8 }, (_, i) => student('s' + i));
    const cfg = settings({ workDays: [1, 2, 3, 4, 5, 6] });
    const coords = cityCoords(sts);
    const ids = ['home', ...sts.map(s => s.id)];
    // ASYMMETRIC on purpose: real road matrices are (one-way streets), and a
    // symmetric fixture cannot tell a cache that ignores direction from one
    // that respects it.
    const mk = (mult) => ({ coordIds: ids,
      durations: ids.map((_, a) => ids.map((__, b) => (a === b ? 0 : (a * 3 + b) * 60 * mult))),
      distances: ids.map((_, a) => ids.map((__, b) => (a === b ? 0 : (a * 3 + b) * 100 * mult))) });
    app.setState({ students: sts, settings: cfg, coords,
      travelMatrixPeak: withMatrix ? mk(2) : null,
      travelMatrixOffPeak: withMatrix ? mk(1) : null, travelMatrix: null });
    return { app, sts, cfg, coords, ids };
  }

  for (const withMatrix of [false, true]) {
    test(`same answers ${withMatrix ? 'with' : 'without'} a travel matrix`, () => {
      const { app, sts, ids } = world(withMatrix);
      const S = app.Scheduler;
      // Every combination that changes which matrix is consulted: day (Saturday
      // is special), and either side of rush hour, plus no time at all.
      const times = [null, S.toMin('09:00'), S.toMin('15:59'), S.toMin('16:00'),
                     S.toMin('19:59'), S.toMin('20:00'), S.toMin('23:00')];
      const names = [...ids, 'never-seen-before'];
      const cases = [];
      for (const a of names) for (const b of names)
        for (const d of [1, 5, 6]) for (const t of times)
          cases.push([a, 'addr-' + a, b, 'addr-' + b, d, t]);

      const slow = cases.map(c => [S._travelEstMinUncached(...c), S._travelEstKmUncached(...c)]);
      S.beginTravelCache();
      try {
        // Twice over, so a second hit is checked as well as the first fill.
        for (let pass = 0; pass < 2; pass++) {
          cases.forEach((c, i) => {
            assert.equal(S.travelEstMin(...c), slow[i][0],
              `minutes differ for ${JSON.stringify(c)} on pass ${pass}`);
            assert.equal(S.travelEstKm(...c), slow[i][1],
              `km differ for ${JSON.stringify(c)} on pass ${pass}`);
          });
        }
      } finally { S.endTravelCache(); }
      assert.ok(cases.length > 500, `worth checking: ${cases.length} combinations`);
    });
  }

  test('the cache does not outlive the run that opened it', () => {
    const { app } = world(false);
    const S = app.Scheduler;
    S.beginTravelCache();
    S.travelEstMin('s1', 'addr-s1', 's2', 'addr-s2', 1, 600);
    S.endTravelCache();
    assert.equal(S._travel, null,
      'a cache that survives the run would answer with distances to where someone used to live');
  });

  test('moving a client during a run is not served from a stale entry', () => {
    // The guarantee is structural — the cache is opened and closed around one
    // run, and coordinates cannot change inside one. This pins that down: with
    // no cache open, a coordinate change is visible immediately.
    const { app } = world(false);
    const S = app.Scheduler;
    const near = S.travelEstKm('home', 'h', 's1', 'addr-s1', 1);
    app.state.coords.s1 = { lat: 39.5, lon: 22.5 };
    const far = S.travelEstKm('home', 'h', 's1', 'addr-s1', 1);
    assert.ok(far > near * 5, `${near.toFixed(1)} -> ${far.toFixed(1)} km must be seen`);
  });

  test('a rebuilt matrix cannot be served the old index', () => {
    const { app, ids } = world(true);
    const S = app.Scheduler;
    const first = S.travelEstMin('s1', 'a', 's2', 'b', 1, S.toMin('17:00'));
    // A fresh matrix with the ids in a DIFFERENT ORDER, and values that depend
    // on position — so an index built for the old matrix reads the wrong cell
    // and returns the wrong number rather than coincidentally the right one.
    const rev = ids.slice().reverse();
    app.state.travelMatrixPeak = { coordIds: rev,
      durations: rev.map((_, a) => rev.map((__, b) => (a === b ? 0 : (a * 3 + b) * 60))),
      distances: rev.map((_, a) => rev.map((__, b) => (a === b ? 0 : (a * 3 + b) * 100))) };
    const ia = rev.indexOf('s1'), ib = rev.indexOf('s2');
    const want = (ia * 3 + ib);
    assert.equal(S.travelEstMin('s1', 'a', 's2', 'b', 1, S.toMin('17:00')), want,
      'the new matrix must be read with its own index');
    assert.notEqual(first, want, 'the fixture should have made these distinguishable');
  });

  test('parsing a time is memoized without changing what it returns', () => {
    const app = loadApp();
    const S = app.Scheduler;
    for (const [txt, want] of [['00:00', 0], ['09:05', 545], ['17:30', 1050], ['23:59', 1439]]) {
      assert.equal(S.toMin(txt), want);
      assert.equal(S.toMin(txt), want, 'and again, from the memo');
    }
    // Malformed input must go on behaving exactly as it did, not be remembered
    // as a real answer.
    assert.ok(Number.isNaN(S.toMin('nonsense')));
    assert.ok(Number.isNaN(S.toMin('nonsense')));
  });
});

// ---------------------------------------------------------------------------
// Saying why a gap is there
// ---------------------------------------------------------------------------

describe('a gap names the constraint that caused it', () => {
  // The user's report was "it leaves huge gaps". Some of those gaps are
  // unavoidable — but the screen said nothing about them, so an unavoidable
  // gap and a broken scheduler looked identical. explainGap read av.start,
  // the opening of a student's LARGEST free stretch, which since multi-window
  // availability shipped is not necessarily the stretch the lesson sits in.

  function day1(app, over = {}) {
    const S = app.Scheduler;
    const cfg = settings(Object.assign({ workDays: [1],
      dayHours: { 1: { start: '15:00', end: '22:00' } } }, over));
    const first = student('first', { days: [1], window: { start: '15:00', end: '22:00' } });
    const split = student('split', { days: [1], window: { start: '15:00', end: '16:00' } });
    // Free for an hour that is over before we could arrive, then again at 20:00.
    split.availability[1] = { on: true, start: '15:00', end: '16:00',
      windows: [[S.toMin('15:00'), S.toMin('16:00')], [S.toMin('20:00'), S.toMin('22:00')]] };
    const sts = [first, split];
    app.setState({ students: sts, settings: cfg,
      coords: { home: { lat: 38.240, lon: 21.730 },
        first: { lat: 38.241, lon: 21.731 }, split: { lat: 38.242, lon: 21.732 } },
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    return { cfg, sts };
  }

  test('a wait caused by a later free stretch is attributed to it', () => {
    const app = loadApp();
    const { cfg, sts } = day1(app);
    const why = app.Scheduler.explainGap(
      slot('first', '15:00', '16:00', { address: 'addr-first' }),
      slot('split', '20:00', '21:00', { address: 'addr-split' }), 1, sts, cfg);
    assert.ok(why, 'a four-hour wait must not come back unexplained');
    assert.equal(why.kind, 'availability');
    assert.equal(why.name, 'split');
    // 20:00, the start of the stretch the lesson actually sits in — not 15:00,
    // the start of the one it does not.
    assert.equal(why.from, '20:00');
  });

  test('no reason is reported when the lesson simply could have been earlier', () => {
    const app = loadApp();
    const S = app.Scheduler;
    const { cfg, sts } = day1(app);
    // Widen the first stretch so it CAN host the lesson right after the drive.
    sts[1].availability[1].windows = [[S.toMin('15:00'), S.toMin('18:00')],
                                      [S.toMin('20:00'), S.toMin('22:00')]];
    const why = S.explainGap(
      slot('first', '15:00', '16:00', { address: 'addr-first' }),
      slot('split', '20:00', '21:00', { address: 'addr-split' }), 1, sts, cfg);
    assert.equal(why, null,
      'inventing a constraint that is not there would excuse a bad schedule');
  });

  test('a break the user reserved is named as the break', () => {
    const app = loadApp();
    const S = app.Scheduler;
    const { cfg, sts } = day1(app, { blockedSlots: [{ day: 1, start: '16:00', end: '19:00' }] });
    sts[1].availability[1].windows = [[S.toMin('15:00'), S.toMin('22:00')]];
    const why = S.explainGap(
      slot('first', '15:00', '16:00', { address: 'addr-first' }),
      slot('split', '19:00', '20:00', { address: 'addr-split' }), 1, sts, cfg);
    assert.ok(why, 'the reserved break is the reason and should be said');
    assert.equal(why.kind, 'break');
    assert.equal(why.end, '19:00');
  });

  test('clearing a break can land inside a busy hour, and the answer is the later one', () => {
    const app = loadApp();
    const S = app.Scheduler;
    // One pass is not enough here. Availability first says 17:00; the break
    // then pushes to 17:10; and at 17:10 the half-hour lesson no longer fits
    // before that stretch closes at 17:35, so the real answer is the 19:00
    // stretch. A single pass would report the break — a constraint that has
    // already stopped being the binding one.
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } },
      blockedSlots: [{ day: 1, start: '16:00', end: '17:10' }] });
    const first = student('first', { days: [1], window: { start: '15:00', end: '22:00' } });
    const split = student('split', { days: [1], window: { start: '15:00', end: '22:00' },
      lessonDuration: 30 });
    split.availability[1] = { on: true, start: '19:00', end: '22:00',
      windows: [[S.toMin('15:00'), S.toMin('15:30')],
                [S.toMin('17:00'), S.toMin('17:35')],
                [S.toMin('19:00'), S.toMin('22:00')]] };
    const sts = [first, split];
    app.setState({ students: sts, settings: cfg,
      coords: { home: { lat: 38.240, lon: 21.730 },
        first: { lat: 38.241, lon: 21.731 }, split: { lat: 38.242, lon: 21.732 } },
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });

    const why = S.explainGap(
      slot('first', '15:00', '16:00', { address: 'addr-first' }),
      slot('split', '19:00', '19:30', { address: 'addr-split', duration: 30 }), 1, sts, cfg);
    assert.ok(why);
    assert.equal(why.kind, 'availability', `got ${JSON.stringify(why)}`);
    assert.equal(why.from, '19:00');
  });

  test('a break and a free stretch that push each other resolve to the later one', () => {
    const app = loadApp();
    const S = app.Scheduler;
    // Clearing the break lands at 18:00, inside an hour the student is busy;
    // their next stretch opens at 19:30. Reporting the break would name a
    // constraint that is no longer the binding one.
    const { cfg, sts } = day1(app, { blockedSlots: [{ day: 1, start: '16:00', end: '18:00' }] });
    sts[1].availability[1].windows = [[S.toMin('15:00'), S.toMin('15:30')],
                                      [S.toMin('19:30'), S.toMin('22:00')]];
    const why = S.explainGap(
      slot('first', '15:00', '16:00', { address: 'addr-first' }),
      slot('split', '19:30', '20:30', { address: 'addr-split' }), 1, sts, cfg);
    assert.ok(why);
    assert.equal(why.kind, 'availability');
    assert.equal(why.from, '19:30');
  });
});

// ---------------------------------------------------------------------------
// The shared layout primitives
// ---------------------------------------------------------------------------

describe('one answer to "where may this lesson go"', () => {
  // Five functions used to lay out a day, each with its own copy of these
  // steps, and they drifted: rebuildDay pinned the first lesson to the opening
  // of the working day and rejected every arrangement whose first student was
  // not free yet — switching the optimizer off for a month — while
  // relayoutDay, doing the same job, had it right the whole time.

  test('occupantIds names everyone a shared session ties up', () => {
    const S = loadApp().Scheduler;
    assert.deepStrictEqual(Array.from(S.occupantIds(slot('solo', '15:00', '16:00'))), ['solo']);
    assert.deepStrictEqual(
      Array.from(S.occupantIds(slot('a', '15:00', '16:00', { pairedStudentId: 'b' }))), ['a', 'b']);
    assert.deepStrictEqual(
      Array.from(S.occupantIds(slot('a', '15:00', '16:00',
        { groupMemberIds: ['a', 'b', 'c'], pairedStudentId: 'b' }))), ['a', 'b', 'c'],
      'a group lists its own members rather than the pair field');
  });

  test('a slot naming somebody who is not on the roster is left alone', () => {
    const S = loadApp().Scheduler;
    const byId = { a: student('a') };
    assert.equal(S.occupantsOf(slot('a', '15:00', '16:00', { pairedStudentId: 'ghost' }), byId), null,
      'guessing at a missing occupant is how a partner gets booked when busy');
    assert.equal(S.occupantsOf(slot('a', '15:00', '16:00'), byId).length, 1);
  });

  test('earliestLegal alternates between free stretches and breaks', () => {
    const S = loadApp().Scheduler;
    const m = (t) => S.toMin(t);
    // Free 15:00-15:30 and 17:00-17:35; a break until 17:10. Snapping into the
    // second stretch lands at 17:00, inside the break; clearing the break
    // lands at 17:10, where a 30-minute lesson no longer fits before 17:35.
    const wins = [[m('15:00'), m('15:30')], [m('17:00'), m('17:35')], [m('19:00'), m('22:00')]];
    const breaks = [{ start: m('16:00'), end: m('17:10') }];
    assert.equal(S.earliestLegal(wins, breaks, m('16:02'), 30), m('19:00'),
      'one pass of either check answers 17:00 or 17:10, and both are wrong');
    // With a shorter lesson the second stretch does work, after the break.
    assert.equal(S.earliestLegal(wins, breaks, m('16:02'), 20), m('17:10'));
    // Nothing left in the day.
    assert.equal(S.earliestLegal(wins, breaks, m('21:50'), 30), null);
  });

  test('usableWindows drops stretches too short to hold the lesson', () => {
    const app = loadApp();
    const S = app.Scheduler;
    const st = student('a', { days: [1], window: { start: '15:00', end: '22:00' } });
    st.availability[1] = { on: true, start: '19:00', end: '22:00',
      windows: [[S.toMin('15:00'), S.toMin('15:20')], [S.toMin('19:00'), S.toMin('22:00')]] };
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    app.setState({ students: [st], settings: cfg });

    assert.equal(S.usableWindows([st], 1, 20, cfg).wins.length, 2, 'both hold 20 minutes');
    assert.equal(S.usableWindows([st], 1, 60, cfg).wins.length, 1, 'only the evening holds an hour');
    assert.equal(S.usableWindows([st], 1, 600, cfg), null, 'nothing holds ten hours');
  });

  test('breaksOn reads only the day asked for', () => {
    const S = loadApp().Scheduler;
    const cfg = settings({ blockedSlots: [
      { day: 1, start: '16:00', end: '17:00' }, { day: 2, start: '18:00', end: '19:00' }] });
    // Compared as JSON: objects built inside the vm sandbox carry ITS Object
    // prototype, so deepStrictEqual fails on identity even when every field
    // matches. This is written up in LESSONS.md and still caught me out.
    assert.equal(JSON.stringify(S.breaksOn(1, cfg)), JSON.stringify([{ start: 960, end: 1020 }]));
    assert.equal(S.breaksOn(3, cfg).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Filling a gap by hand: "who fits here?"
// ---------------------------------------------------------------------------

describe('choosing who goes into a gap', () => {
  // fillGaps closes a hole on its own when a move is a clear win. This is the
  // other half: the user looks at a hole and asks who fits, then picks.

  function world(extra = []) {
    const app = loadApp();
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '21:00' }, 2: { start: '15:00', end: '21:00' } } });
    const sts = [
      student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
      student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
      student('mover', { days: [1, 2], window: { start: '15:00', end: '21:00' } }),   // placed on Tuesday
      student('short', { days: [1, 2], window: { start: '15:00', end: '21:00' } }),   // has no lesson yet
      ...extra,
    ];
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 2000, lon: 21.7305 + i / 2000 }; });
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    const sched = {
      1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
          slot('late',  '19:00', '20:00', { address: 'addr-late' })],
      2: [slot('mover', '15:00', '16:00', { address: 'addr-mover' })],
    };
    return { app, cfg, sts, sched };
  }
  const M = (t) => t;

  test('offers both a lesson from another day and someone with none', () => {
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    const c = S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00'));
    const byId = Object.fromEntries(Array.from(c).map(x => [x.studentId, x]));
    assert.equal(byId.mover.kind, 'move');
    assert.equal(byId.mover.fromDay, 2);
    assert.equal(byId.short.kind, 'unplaced');
    assert.equal(byId.short.fromDay, null);
  });

  test('someone with no lesson is listed before someone who would just be shuffled', () => {
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.equal(c[0].kind, 'unplaced', `got ${c.map(x => x.kind).join(', ')}`);
  });

  test('everything offered fits inside the gap and breaks no rule', () => {
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    const from = S.toMin('16:00'), to = S.toMin('19:00');
    for (const c of Array.from(S.gapCandidates(sched, sts, cfg, 1, from, to))) {
      assert.ok(S.toMin(c.start) >= from && S.toMin(c.end) <= to, `${c.name} sticks out of the gap`);
      const trial = JSON.parse(JSON.stringify(sched));
      assert.ok(S.applyGapCandidate(trial, sts, cfg, 1, c), `${c.name} was offered but cannot be applied`);
      assert.deepStrictEqual(Array.from(auditSchedule(S, trial, sts, cfg)), [],
        `${c.name} produced an invalid week`);
    }
  });

  test('a student not free that day is not offered', () => {
    const { app, cfg, sts, sched } = world([student('tue', { days: [2], window: { start: '15:00', end: '21:00' } })]);
    sched[2].push(slot('tue', '16:10', '17:10', { address: 'addr-tue' }));
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.ok(!c.some(x => x.studentId === 'tue'), 'they only work Tuesdays');
  });

  test('a lesson longer than the gap is not offered', () => {
    const { app, cfg, sts, sched } = world([student('long', { days: [1, 2], lessonDuration: 240,
      window: { start: '15:00', end: '21:00' } })]);
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.ok(!c.some(x => x.studentId === 'long'));
  });

  test('someone already on that day is not offered a second lesson', () => {
    const { app, cfg, sts, sched } = world();
    sched[1].push(slot('short', '20:00', '20:30', { address: 'addr-short', duration: 30 }));
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.ok(!c.some(x => x.studentId === 'short'));
  });

  test('a shared session is never offered as a move', () => {
    const { app, cfg, sts, sched } = world();
    sched[2][0] = slot('mover', '15:00', '16:00', { address: 'addr-mover',
      pairedStudentId: 'short', isGroup: true, groupMemberIds: ['mover', 'short'] });
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.ok(!c.some(x => x.kind === 'move'), 'a paired lesson cannot travel on one occupant');
  });

  test('someone in a pair or group is not offered a lesson on their own', () => {
    // Placing one half of a pair alone leaves the other without their shared
    // session, which is exactly what pairing exists to prevent.
    const { app, cfg, sts, sched } = world([
      student('half', { days: [1, 2], pairedWith: 'other', window: { start: '15:00', end: '21:00' } }),
      student('other', { days: [1, 2], pairedWith: 'half', window: { start: '15:00', end: '21:00' } }),
    ]);
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.ok(!c.some(x => x.studentId === 'half' || x.studentId === 'other'),
      `a paired student was offered alone: ${c.map(x => x.studentId)}`);
  });

  test('among people with no lesson, the one who fits earliest is listed first', () => {
    // 'late' is available only from 17:30; 'early' from 15:00. In the roster
    // order 'late' comes first, so only an explicit sort puts 'early' on top.
    const { app, cfg, sts, sched } = world([
      student('latecomer', { days: [1, 2], window: { start: '17:30', end: '21:00' } }),
      student('earlybird', { days: [1, 2], window: { start: '15:00', end: '21:00' } }),
    ]);
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')))
      .filter(x => x.kind === 'unplaced');
    const times = c.map(x => S.toMin(x.start));
    assert.ok(times.length >= 3);
    assert.deepStrictEqual(times.slice(), times.slice().sort((a, b) => a - b),
      `not in time order: ${c.map(x => x.studentId + '@' + x.start).join(', ')}`);
  });

  test('someone with no lesson stays above a move even when the move fits earlier', () => {
    // Filling a hole with a person who had nothing beats shuffling a lesson
    // that already existed — even if the shuffle would start sooner.
    const { app, cfg, sts, sched } = world();
    sts.find(x => x.id === 'short').availability[1] =
      { on: true, start: '17:00', end: '21:00', windows: [[1020, 1260]] };
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:30')));
    const kinds = c.map(x => x.kind);
    assert.ok(kinds.includes('move') && kinds.includes('unplaced'), kinds.join(','));
    assert.equal(c[0].kind, 'unplaced', `got ${c.map(x => x.kind + ':' + x.start).join(' ')}`);
    const mv = c.find(x => x.kind === 'move'), un = c.find(x => x.kind === 'unplaced');
    assert.ok(S.toMin(mv.start) < S.toMin(un.start), 'the fixture must make the move start earlier');
  });

  test('an empty answer is an empty list, not an error', () => {
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    // A gap of ten minutes: nothing fits.
    const c = S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('16:10'));
    assert.equal(c.length, 0);
  });

  test('applying moves the lesson and removes it from its old day', () => {
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')))
      .find(x => x.studentId === 'mover');
    const placedBefore = S.countTotal(sched);
    assert.equal(S.applyGapCandidate(sched, sts, cfg, 1, c), true);
    assert.ok(sched[1].some(x => x.studentId === 'mover'));
    assert.ok(!sched[2].some(x => x.studentId === 'mover'), 'left its old day');
    assert.equal(S.countTotal(sched), placedBefore, 'a move must not change how many are placed');
  });

  test('applying an unplaced student adds a lesson', () => {
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')))
      .find(x => x.studentId === 'short');
    const before = S.countTotal(sched);
    assert.equal(S.applyGapCandidate(sched, sts, cfg, 1, c), true);
    assert.equal(S.countTotal(sched), before + 1);
  });

  test('an offer that no longer fits is refused when applied', () => {
    // The list was drawn a moment ago; the schedule may have changed since.
    const { app, cfg, sts, sched } = world();
    const S = app.Scheduler;
    const c = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')))
      .find(x => x.studentId === 'short');
    // Someone else takes the gap first.
    sched[1].push(slot('mover', c.start, c.end, { address: 'addr-mover' }));
    sched[1].sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
    const snapshot = JSON.stringify(sched);
    assert.equal(S.applyGapCandidate(sched, sts, cfg, 1, c), false);
    assert.equal(JSON.stringify(sched), snapshot, 'a refused offer must change nothing');
  });
});

// ---------------------------------------------------------------------------
// A short second look at the other days, after a gap is filled by hand
// ---------------------------------------------------------------------------

describe('refining the rest of the week after a gap is filled', () => {
  // Day 1 is the one the user just worked on. It is deliberately in a BAD
  // order too, so that if it were not protected the refinement would happily
  // "improve" it — which would be the app overruling the user a second after
  // asking them.

  function town() {
    const app = loadApp({ seed: 7 });
    const cfg = settings({ workDays: [1, 2, 3],
      dayHours: Object.fromEntries([1, 2, 3].map(d => [d, { start: '15:00', end: '22:00' }])) });
    const mk = (id, day) => student(id, { days: [day], window: { start: '17:00', end: '22:00' } });
    const sts = [mk('a1', 1), mk('b1', 1), mk('c1', 1), mk('a2', 2), mk('b2', 2), mk('c2', 2)];
    // In each day, a and c are neighbours out of town and b is next door to
    // home: visiting a, b, c in that order crosses the city twice for nothing.
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    for (const d of ['1', '2']) {
      coords['a' + d] = { lat: 38.300, lon: 21.790 };
      coords['c' + d] = { lat: 38.302, lon: 21.792 };
      coords['b' + d] = { lat: 38.241, lon: 21.731 };
    }
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    // Times leave the real drive between them, so the starting point is a
    // VALID schedule in a bad order rather than an impossible one — the audit
    // below would otherwise blame the refinement for the fixture.
    const day = (n) => [
      slot('a' + n, '17:00', '18:00', { address: 'addr-a' + n }),
      slot('b' + n, '18:35', '19:35', { address: 'addr-b' + n }),
      slot('c' + n, '20:10', '21:10', { address: 'addr-c' + n }),
    ];
    return { app, cfg, sts, sched: { 1: day(1), 2: day(2), 3: [] } };
  }
  const km = (S, sch, d, cfg) => S.dayKm(sch[d].slice()
    .sort((x, y) => S.toMin(x.start) - S.toMin(y.start)), d, cfg);

  test('the other days improve', async () => {
    const { app, cfg, sched } = town();
    const S = app.Scheduler;
    const before = km(S, sched, 2, cfg);
    const r = await S.refineExcept(sched, app.state.students, cfg, 1, 2500);
    assert.equal(r.adopted, true, `reason: ${r.reason}`);
    assert.ok(km(S, sched, 2, cfg) < before * 0.8,
      `the crossing on day 2 should go: ${before.toFixed(1)} -> ${km(S, sched, 2, cfg).toFixed(1)} km`);
    assert.ok(r.changed > 0);
  });

  test('the day the user worked on is left exactly as they made it', async () => {
    const { app, cfg, sched } = town();
    const S = app.Scheduler;
    const pinned = JSON.stringify(sched[1]);
    await S.refineExcept(sched, app.state.students, cfg, 1, 2500);
    assert.equal(JSON.stringify(sched[1]), pinned,
      'day 1 was in a bad order too, and must not have been touched');
  });

  test('it keeps everyone placed and breaks no rule', async () => {
    const { app, cfg, sts, sched } = town();
    const S = app.Scheduler;
    const placed = S.countTotal(sched);
    await S.refineExcept(sched, sts, cfg, 1, 2500);
    assert.equal(S.countTotal(sched), placed);
    assert.deepStrictEqual(Array.from(auditSchedule(S, sched, sts, cfg)), []);
  });

  test('a schedule already in good order comes back untouched', async () => {
    const { app, cfg, sts, sched } = town();
    const S = app.Scheduler;
    // Put day 2 in the good order first.
    sched[2] = [slot('b2', '17:00', '18:00', { address: 'addr-b2' }),
                slot('a2', '18:30', '19:30', { address: 'addr-a2' }),
                slot('c2', '19:33', '20:33', { address: 'addr-c2' })];
    await S.refineExcept(sched, sts, cfg, 1, 1500);   // let it settle once
    const settled = JSON.stringify(sched);
    const r = await S.refineExcept(sched, sts, cfg, 1, 1500);
    assert.equal(r.adopted, false);
    assert.equal(JSON.stringify(sched), settled, 'a second pass over a settled week must change nothing');
  });

  test('if the user changes something while it thinks, their change wins', async () => {
    // The passes yield to the browser, so a swap can happen mid-way. Adopting
    // the result would silently undo it.
    const { app, cfg, sts, sched } = town();
    const S = app.Scheduler;
    const pending = S.refineExcept(sched, sts, cfg, 1, 1500);
    sched[2][0].start = '17:05';                        // the user edits while it runs
    sched[2][0].end = '18:05';
    const edited = JSON.stringify(sched);
    const r = await pending;
    assert.equal(r.adopted, false);
    assert.match(r.reason, /meanwhile/);
    assert.equal(JSON.stringify(sched), edited, 'the edit must survive');
  });

  test('a refinement that would lose someone is thrown away', async () => {
    // None of the real passes makes a week worse, so a pass is forced to: it
    // quietly drops a lesson. Placing fewer people is the one outcome worse
    // than any gap, and verifySchedule does not notice a lesson that is
    // simply absent — only the score comparison does.
    const { app, cfg, sts, sched } = town();
    const S = app.Scheduler;
    S.tidyDays = (sch) => { sch[2].pop(); return { moves: 0 }; };
    const before = JSON.stringify(sched);
    const r = await S.refineExcept(sched, sts, cfg, 1, 1500);
    assert.equal(r.adopted, false);
    assert.equal(JSON.stringify(sched), before, 'nothing may change when the result is worse');
  });

  test('a refinement that would break a rule is thrown away', async () => {
    // A pass is forced to move a lesson before its student is free. The
    // number placed and the distance are unchanged, so only verifySchedule
    // can see that anything is wrong.
    const { app, cfg, sts, sched } = town();
    const S = app.Scheduler;
    S.tidyDays = (sch) => {
      const l = sch[2].find(x => x.studentId === 'b2');
      l.start = '15:00'; l.end = '16:00';               // b2 is free from 17:00
      return { moves: 0 };
    };
    const before = JSON.stringify(sched);
    const r = await S.refineExcept(sched, sts, cfg, 1, 1500);
    assert.equal(r.adopted, false, `an invalid week was adopted: ${r.reason}`);
    assert.equal(JSON.stringify(sched), before);
  });

  test('with only one day there is nothing to refine', async () => {
    const { app, sts, sched } = town();
    const S = app.Scheduler;
    const cfg1 = settings({ workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } });
    const r = await S.refineExcept({ 1: sched[1] }, sts, cfg1, 1, 500);
    assert.equal(r.adopted, false);
    assert.equal(r.changed, 0);
  });

  test('choosing someone for a gap triggers the refinement, pinned to that day', async () => {
    const app = loadApp();
    const S = app.Scheduler;
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '21:00' }, 2: { start: '15:00', end: '21:00' } } });
    const sts = [
      student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
      student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
      student('short', { days: [1, 2], window: { start: '15:00', end: '21:00' } }),
    ];
    const coords = { home: { lat: 38.24, lon: 21.73 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 2000, lon: 21.7305 + i / 2000 }; });
    app.setState({ coords, students: sts, settings: cfg, jobs: [],
      schedule: { 1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
                      slot('late', '19:00', '20:00', { address: 'addr-late' })], 2: [] },
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });

    const calls = [];
    S.refineExcept = async (...a) => { calls.push(a[3]); return { adopted: false, changed: 0 }; };
    const cand = S.gapCandidates(app.state.schedule, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00'))[0];
    app.state._gapFill = { day: 1, cands: [cand] };
    app.App.applyGapFill(0);
    await new Promise(r => setTimeout(r, 30));
    assert.deepStrictEqual(calls, [1], 'the refinement must be told which day to leave alone');
  });

  test('it is not started while a full calculation is running', async () => {
    const app = loadApp();
    const S = app.Scheduler;
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '21:00' }, 2: { start: '15:00', end: '21:00' } } });
    const sts = [student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
                 student('late', { days: [1], window: { start: '19:00', end: '21:00' } }),
                 student('short', { days: [1, 2], window: { start: '15:00', end: '21:00' } })];
    const coords = { home: { lat: 38.24, lon: 21.73 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 2000, lon: 21.7305 + i / 2000 }; });
    app.setState({ coords, students: sts, settings: cfg, jobs: [],
      schedule: { 1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
                      slot('late', '19:00', '20:00', { address: 'addr-late' })], 2: [] },
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    let called = false;
    S.refineExcept = async () => { called = true; return { adopted: false }; };
    const cand = S.gapCandidates(app.state.schedule, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00'))[0];
    app.state._gapFill = { day: 1, cands: [cand] };
    app.state._schedulingInProgress = true;
    app.App.applyGapFill(0);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(called, false, 'two things rewriting the schedule at once is how one is lost');
  });
});

// ---------------------------------------------------------------------------
// Gathering the days a change touched
// ---------------------------------------------------------------------------

describe('a change is judged, and left, gathered up', () => {
  // Any move or swap leaves a hole: the lesson that left its day, or the day
  // that had to be re-timed around a lesson of a different length. Until the
  // day is gathered up again, a good change looks worse than it is.

  function week(over = {}) {
    const app = loadApp();
    const cfg = settings(Object.assign({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '22:00' }, 2: { start: '15:00', end: '22:00' } } }, over.cfg || {}));
    const mk = (id, days = [1, 2], from = '15:00') => student(id, { days, lessonDuration: 60,
      window: { start: from, end: '22:00' } });
    const sts = over.students || [mk('early', [1]), mk('late', [1], '17:00'),
      mk('p', [2]), mk('mover', [1, 2]), mk('q', [2])];
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 4000, lon: 21.7305 + i / 4000 }; });
    app.setState({ coords, students: sts, settings: cfg, jobs: [],
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    return { app, cfg, sts };
  }
  const order = (S, sch, d) => (sch[d] || []).slice()
    .sort((a, b) => S.toMin(a.start) - S.toMin(b.start));

  // Day 1 has a hole (16:00 to 17:20). Day 2 is packed, with 'mover' in the
  // middle. Moving 'mover' into day 1's hole leaves day 2 with a hole of its
  // own until 'q' moves up — so the move only pays once day 2 is gathered.
  const fixture = () => ({
    1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
        slot('late', '17:20', '18:20', { address: 'addr-late' })],
    2: [slot('p', '15:00', '16:00', { address: 'addr-p' }),
        slot('mover', '16:05', '17:05', { address: 'addr-mover' }),
        slot('q', '17:10', '18:10', { address: 'addr-q' })],
  });

  test('a move that only pays once the day it left is tidied is taken', () => {
    const { app, cfg, sts } = week();
    const S = app.Scheduler;
    const sched = fixture();
    const r = S.fillGaps(sched, sts, cfg);
    assert.equal(r.moved.length, 1, 'the move is a win after gathering, and was refused before');
    assert.equal(r.moved[0].name, 'mover');
    assert.ok(sched[1].some(x => x.studentId === 'mover'));
  });

  test('and the day it left is closed up, not left with the hole', () => {
    const { app, cfg, sts } = week();
    const S = app.Scheduler;
    const sched = fixture();
    S.fillGaps(sched, sts, cfg);
    const q = order(S, sched, 2).find(x => x.studentId === 'q');
    assert.ok(S.toMin(q.start) < S.toMin('17:10'),
      `q should have moved up into where mover was, but starts at ${q.start}`);
  });

  test('a candidate that is rejected leaves the real schedule untouched', () => {
    // Gathering changes start and end in place. On a shallow copy that reaches
    // the real lesson objects, so a REJECTED experiment used to move somebody.
    //
    // The candidate has to be LEGAL and then lose on cost, or it never reaches
    // the gathering step and the test proves nothing: 'far' can reach Monday's
    // gap, but Tuesday still has to be driven out to 'stay' next door to it,
    // so the trip across the city is not worth a tidier Monday.
    const app = loadApp();
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '21:00' }, 2: { start: '15:00', end: '21:00' } } });
    const sts = [
      student('early', { days: [1], window: { start: '15:00', end: '16:00' } }),
      student('late',  { days: [1], window: { start: '19:00', end: '21:00' } }),
      student('far',   { days: [1, 2], window: { start: '15:00', end: '21:00' } }),
      student('stay',  { days: [2], window: { start: '15:00', end: '21:00' } }),
    ];
    const coords = { home: { lat: 38.240, lon: 21.730 }, early: { lat: 38.2405, lon: 21.7305 },
      late: { lat: 38.241, lon: 21.731 }, far: { lat: 38.275, lon: 21.765 }, stay: { lat: 38.276, lon: 21.766 } };
    app.setState({ coords, students: sts, settings: cfg,
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    const S = app.Scheduler;
    const sched = { 1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
                        slot('late', '19:00', '20:00', { address: 'addr-late' })],
                    2: [slot('far', '15:00', '16:00', { address: 'addr-far' }),
                        slot('stay', '16:30', '17:30', { address: 'addr-stay' })] };
    // Prove the premise: it IS legal, so the refusal comes from the price.
    const legal = Array.from(S.gapCandidates(sched, sts, cfg, 1, S.toMin('16:00'), S.toMin('19:00')));
    assert.ok(legal.some(c => c.studentId === 'far'), 'the fixture must make the move legal');

    const before = JSON.stringify(sched);
    const r = S.fillGaps(sched, sts, cfg);
    assert.equal(r.moved.length, 0);
    assert.equal(JSON.stringify(sched), before, 'a refused move must change nothing at all');
  });

  test('gatherDays touches only the days it is given', () => {
    const { app, cfg, sts } = week();
    const S = app.Scheduler;
    const sched = {
      1: [slot('early', '15:00', '16:00', { address: 'addr-early' }),
          slot('late', '19:00', '20:00', { address: 'addr-late' })],     // a hole, and NOT to be touched
      2: [slot('p', '15:00', '16:00', { address: 'addr-p' }),
          slot('q', '18:00', '19:00', { address: 'addr-q' })],           // a hole, to be closed
    };
    const day1 = JSON.stringify(sched[1]);
    S.gatherDays(sched, sts, cfg, [2]);
    assert.equal(JSON.stringify(sched[1]), day1, 'day 1 was not listed');
    assert.ok(S.toMin(sched[2][1].start) < S.toMin('18:00'), 'day 2 was listed and should have been closed up');
  });

  test('days outside the working week are ignored rather than invented', () => {
    const { app, cfg, sts } = week();
    const r = app.Scheduler.gatherDays({ 1: [], 2: [] }, sts, cfg, [6, 7]);
    assert.equal(r.moves, 0);
  });

  test('frozen lessons keep their order, and the free one still moves', () => {
    // a and c live next to each other, far out; b lives next to home. Visiting
    // a, b, c crosses the city twice. Unfrozen, the best fix trades a and b.
    // With a and b frozen that trade is forbidden — the user swapped them, and
    // putting them back would undo it — yet c is free, and can be lifted in
    // between so the far pair sit together.
    const { app, cfg } = week({ cfg: { workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } },
      students: ['a', 'b', 'c'].map(id => student(id, { days: [1], window: { start: '17:00', end: '22:00' } })) });
    const S = app.Scheduler;
    const sts = app.state.students;
    app.state.coords.a = { lat: 38.300, lon: 21.790 };
    app.state.coords.c = { lat: 38.302, lon: 21.792 };
    app.state.coords.b = { lat: 38.241, lon: 21.731 };
    const mk = () => ({ 1: [slot('a', '17:00', '18:00', { address: 'addr-a' }),
                            slot('b', '18:35', '19:35', { address: 'addr-b' }),
                            slot('c', '20:10', '21:10', { address: 'addr-c' })] });
    const ids = (sch) => order(S, sch, 1).map(x => x.studentId).join('');

    const free = mk(); S.tidyDays(free, sts, cfg);
    assert.ok(ids(free).indexOf('b') < ids(free).indexOf('a'),
      `control: unfrozen, b and a trade places, got ${ids(free)}`);

    const held = mk(); S.tidyDays(held, sts, cfg, new Set(['a', 'b']));
    assert.ok(ids(held).indexOf('a') < ids(held).indexOf('b'),
      `a and b are frozen and must stay in their order, got ${ids(held)}`);
    // "acb" and "cab" are the same drive read backwards; either is right. What
    // matters is that the two far-out addresses now sit side by side.
    assert.equal(Math.abs(ids(held).indexOf('a') - ids(held).indexOf('c')), 1,
      `c should have been lifted next to a, got ${ids(held)}`);
  });

  test('with a lesson frozen, another can be lifted to a better place', () => {
    // 'd' is free only from 19:00 and is frozen in front of 'z'. An exchange
    // can never put z ahead of d; lifting z and putting it down earlier can.
    const { app, cfg } = week({ cfg: { workDays: [1], dayHours: { 1: { start: '15:00', end: '22:00' } } },
      students: [student('x', { days: [1], window: { start: '15:00', end: '22:00' } }),
                 student('d', { days: [1], window: { start: '19:00', end: '22:00' } }),
                 student('z', { days: [1], window: { start: '15:00', end: '22:00' } })] });
    const S = app.Scheduler;
    const sts = app.state.students;
    const sched = { 1: [slot('x', '15:00', '16:00', { address: 'addr-x' }),
                        slot('d', '19:00', '20:00', { address: 'addr-d' }),
                        slot('z', '20:03', '21:03', { address: 'addr-z' })] };
    S.tidyDays(sched, sts, cfg, new Set(['x', 'd']));
    const ids = order(S, sched, 1).map(x => x.studentId).join('');
    assert.equal(ids, 'xzd', `z should have been lifted ahead of d, got ${ids}`);
  });
});

describe('the hand swap and the hand move gather the days they touched', () => {
  const mk = (id, from = '15:00') => student(id, { days: [1, 2], lessonDuration: 45,
    window: { start: from, end: '22:00' } });

  function world() {
    const app = loadApp();
    const cfg = settings({ workDays: [1, 2],
      dayHours: { 1: { start: '15:00', end: '22:00' }, 2: { start: '15:00', end: '22:00' } } });
    // 'd' is free only from 19:00.
    const sts = [mk('x'), mk('y'), mk('d', '19:00'), mk('z')];
    const coords = { home: { lat: 38.240, lon: 21.730 } };
    sts.forEach((s, i) => { coords[s.id] = { lat: 38.2405 + i / 4000, lon: 21.7305 + i / 4000 }; });
    app.setState({ coords, students: sts, settings: cfg, jobs: [],
      travelMatrix: null, travelMatrixPeak: null, travelMatrixOffPeak: null });
    return { app, cfg, sts };
  }
  const s45 = (id, a, b) => slot(id, a, b, { address: 'addr-' + id, duration: 45 });
  const ids = (S, sch, d) => sch[d].slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start))
    .map(x => x.studentId).join('');

  test('a swap that would leave a hole gets it closed, and the swap holds', () => {
    const { app } = world();
    const S = app.Scheduler;
    app.state.schedule = { 1: [s45('x', '15:00', '15:45'), s45('y', '15:48', '16:33'),
                               s45('d', '19:00', '19:45'), s45('z', '19:48', '20:33')], 2: [] };
    // The user swaps y and d. That puts d (free only from 19:00) ahead of y and
    // z, and leaves 15:45 to 19:00 empty with z stuck behind them.
    app.App._performSlotSwap(1, 1, 1, 2);
    const order = ids(S, app.state.schedule, 1);
    assert.ok(order.indexOf('d') < order.indexOf('y'), `the swap must hold: d before y, got ${order}`);
    assert.ok(order.indexOf('z') < order.indexOf('d'),
      `z should have moved up into the hole ahead of d, got ${order}`);
    assert.deepStrictEqual(Array.from(auditSchedule(S, app.state.schedule, app.state.students, app.state.settings)), []);
  });

  test('moving a lesson to another day closes up the day it left', () => {
    const { app } = world();
    const S = app.Scheduler;
    app.state.schedule = { 1: [], 2: [s45('x', '15:00', '15:45'), s45('y', '15:48', '16:33'),
                                    s45('z', '16:36', '17:21')] };
    // x leaves day 2 for day 1, leaving a hole at the very front of day 2.
    app.App._performSlotMoveToDay(2, app.state.schedule[2][0], 1);
    const day2 = app.state.schedule[2].slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
    assert.equal(day2.length, 2);
    assert.equal(day2[0].start, '15:00', `y should have moved up to the start of the day, got ${day2[0].start}`);
    assert.ok(app.state.schedule[1].some(x => x.studentId === 'x'), 'and x arrived on day 1');
  });
});
