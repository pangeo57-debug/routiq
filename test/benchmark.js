'use strict';
/**
 * Quality benchmark — `npm run bench`.
 *
 * The test suite says whether the scheduler is CORRECT. This says how GOOD it
 * is, on data nobody here designed, and against an optimum it proves rather
 * than assumes. Run it before and after a change to the scheduler: the numbers
 * are what tell you whether the change was an improvement or noise.
 *
 * Two sources of instances:
 *
 *  - Solomon's 1987 VRPTW benchmarks (see test/data/README.md). Independently
 *    authored, deliberately hard time windows, three different geographies.
 *    Their published best-known solutions are NOT comparable — those use 10 to
 *    19 vehicles and RoutePal has at most six days — so each instance is cut
 *    down to what six days can hold.
 *  - Our own scenarios, which mirror how the app is actually used.
 *
 * The headline number is the DETOUR: total driving divided by the shortest
 * possible tour of exactly the same stops, computed exactly (Held-Karp) for
 * days up to 12 stops. 1.00 means the visit order could not be bettered.
 * It is a fair measure because it holds the day assignment fixed and asks only
 * whether the ordering was right.
 */

const fs = require('fs');
const path = require('path');
const { loadApp, student, settings } = require('./harness');

// ---------------------------------------------------------------------------

function parseSolomon(file) {
  const lines = fs.readFileSync(path.join(__dirname, 'data', file), 'utf8').split('\n');
  const rows = [];
  for (const line of lines) {
    const p = line.trim().split(/\s+/).map(Number);
    if (p.length === 7 && p.every(n => !Number.isNaN(n))) {
      rows.push({ id: p[0], x: p[1], y: p[2], demand: p[3], ready: p[4], due: p[5], service: p[6] });
    }
  }
  return { depot: rows[0], customers: rows.slice(1) };
}

/**
 * Solomon coordinates are a plane in arbitrary units; RoutePal works in
 * lat/lon. One unit becomes one kilometre at Patras' latitude, so distances
 * keep the instance's proportions and travel times stay realistic.
 */
const KM_PER_DEG_LAT = 111.32;
const toLatLon = (p) => ({
  lat: 38.246 + p.y / KM_PER_DEG_LAT,
  lon: 21.734 + p.x / (KM_PER_DEG_LAT * Math.cos(38.246 * Math.PI / 180)),
});

/** Exact shortest tour home -> stops -> home. Held-Karp; exact, not a heuristic. */
function optimalTour(points, home, dist) {
  const n = points.length;
  if (n === 0) return 0;
  if (n === 1) return dist(home, points[0]) * 2;
  if (n > 12) return null;                       // 2^12 * 12^2 is the practical limit
  const size = 1 << n;
  const dp = Array.from({ length: size }, () => new Float64Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) dp[1 << i][i] = dist(home, points[i]);
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last)) || dp[mask][last] === Infinity) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const m2 = mask | (1 << next);
        const cand = dp[mask][last] + dist(points[last], points[next]);
        if (cand < dp[m2][next]) dp[m2][next] = cand;
      }
    }
  }
  let best = Infinity;
  for (let last = 0; last < n; last++) best = Math.min(best, dp[size - 1][last] + dist(points[last], home));
  return best;
}

// ---------------------------------------------------------------------------

async function runInstance(name, sts, cfg, coords) {
  const app = loadApp({ seed: 12345 });          // reproducible: same numbers every run
  const S = app.Scheduler, A = app.App;
  app.setState({ students: sts, settings: cfg, coords,
    travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });

  const t0 = Date.now();
  const r = await S.runMultiAttempt(sts, cfg, coords, 3, false);
  await S.alnsOptimize(r.schedule, sts, cfg, coords, 4000);
  S.saRepair(r.schedule, sts, cfg, r);
  await S.guardedPass(r.schedule, cfg, (sch) => S.lnsRepair(sch, sts, cfg, 2000));
  S.enforceConstraints(r.schedule, sts, cfg);
  S.collapseForceMergeFragments(r.schedule, sts, cfg);
  S.tidyDays(r.schedule, sts, cfg);
  S.compactDays(r.schedule, sts, cfg);
  const ms = Date.now() - t0;

  const { auditSchedule } = require('./invariants');
  const violations = auditSchedule(S, r.schedule, sts, cfg).length;

  const dist = (a, b) => S.haversineKm(a, b) * 1.4;
  let km = 0, optKm = 0, exactDays = 0, idle = 0, stops = 0;
  for (const d of cfg.workDays) {
    const sl = (r.schedule[d] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
    if (!sl.length) continue;
    km += S.dayKm(sl, d, cfg);
    idle += S.dayIdle(sl, d, cfg);
    stops += sl.length;
    const pts = sl.map(s => coords[s.studentId]).filter(Boolean);
    const opt = optimalTour(pts, coords.home, dist);
    if (opt != null) { optKm += opt; exactDays++; }
  }
  const want = sts.reduce((a, s) => a + s.lessonsPerWeek, 0);
  return { name, placed: A._countPlaced(r.schedule), want, km, optKm, exactDays,
           idle, stops, violations, ms };
}

function solomonCase(file, nCustomers, days) {
  const { depot, customers } = parseSolomon(file);
  const picked = customers.slice(0, nCustomers);
  const workDays = Array.from({ length: days }, (_, i) => i + 1);
  // Solomon windows are in minutes from 0; compress them into a working day so
  // the shape of the constraints survives but the clock stays a real one.
  const span = Math.max(...customers.map(c => c.due)) || 1;
  const toClock = (v) => 8 * 60 + Math.round((v / span) * 12 * 60);   // 08:00-20:00
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const dayHours = {};
  for (const d of workDays) dayHours[d] = { start: '08:00', end: '20:00' };
  const cfg = settings({ workDays, dayHours, travelMargin: 2,
    homeAddress: 'depot', avgCitySpeedKmh: 40 });

  const coords = { home: toLatLon(depot) };
  const sts = picked.map((c) => {
    const dur = 60;
    const start = Math.min(toClock(c.ready), 19 * 60);
    const end = Math.max(Math.min(toClock(c.due) + dur, 20 * 60), start + dur);
    const st = student('c' + c.id, { days: workDays, lessonsPerWeek: 1, lessonDuration: dur,
      window: { start: hhmm(start), end: hhmm(end) } });
    coords[st.id] = toLatLon(c);
    return st;
  });
  return { sts, cfg, coords };
}

// ---------------------------------------------------------------------------

(async () => {
  const cases = [];

  for (const [file, n, days] of [['C101.txt', 30, 5], ['R101.txt', 30, 5], ['RC101.txt', 30, 5]]) {
    const { sts, cfg, coords } = solomonCase(file, n, days);
    cases.push([`solomon ${file.replace('.txt', '')} (${n} stops, ${days} days)`, sts, cfg, coords]);
  }

  // Our own shape: a real tutor's week.
  {
    const sts = Array.from({ length: 22 }, (_, i) => student('s' + i, {
      lessonsPerWeek: (i % 3) + 1, lessonDuration: [60, 90, 120][i % 3],
      days: [1, 2, 3, 4, 5].filter(d => (i + d) % 4 !== 0),
      window: { start: `${15 + (i % 4)}:00`, end: '22:00' },
    }));
    const cfg = settings({ workDays: [1, 2, 3, 4, 5] });
    const coords = { home: { lat: 38.246, lon: 21.734 } };
    sts.forEach((s, i) => { coords[s.id] = (i % 6 === 0)
      ? { lat: 38.246 + 0.09 + ((i * 13) % 20) / 1000, lon: 21.734 + 0.10 + ((i * 7) % 20) / 1000 }
      : { lat: 38.246 + ((i * 13) % 30) / 2000, lon: 21.734 + ((i * 7) % 30) / 2000 }; });
    cases.push(['ours: tutor week, a few outliers', sts, cfg, coords]);
  }

  console.log('RoutePal quality benchmark\n');
  console.log('  instance                              served    km   detour   idle  bad   time');
  console.log('  ' + '-'.repeat(76));
  const all = [];
  for (const [name, sts, cfg, coords] of cases) {
    const r = await runInstance(name, sts, cfg, coords);
    all.push(r);
    const detour = r.optKm > 0 ? (r.km / r.optKm) : null;
    console.log('  ' + name.padEnd(38) +
      `${r.placed}/${r.want}`.padStart(6) +
      `${r.km.toFixed(0)}`.padStart(6) +
      (detour ? `x${detour.toFixed(3)}` : '   —').padStart(9) +
      `${r.idle}m`.padStart(7) +
      `${r.violations}`.padStart(5) +
      `${(r.ms / 1000).toFixed(0)}s`.padStart(7));
  }
  const totKm = all.reduce((a, r) => a + r.km, 0);
  const totOpt = all.reduce((a, r) => a + r.optKm, 0);
  const bad = all.reduce((a, r) => a + r.violations, 0);
  console.log('  ' + '-'.repeat(76));
  console.log(`\n  overall detour vs exact optimum: x${(totKm / totOpt).toFixed(3)}` +
    `   (1.000 = the visit order could not be bettered)`);
  console.log(`  constraint violations: ${bad}` + (bad ? '   <-- THIS MUST BE ZERO' : ''));
  console.log(`  days measured exactly: ${all.reduce((a, r) => a + r.exactDays, 0)}\n`);
  process.exit(bad ? 1 : 0);
})();
