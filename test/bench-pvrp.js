'use strict';
/**
 * Week-planner benchmark: single-vehicle PVRP — `npm run bench:pvrp`.
 *
 * One person, every client once in a horizon of days, on any day; a load
 * limit per day; minimise the total distance. Three instances of Cordeau,
 * Gendreau & Laporte (1997) whose best-known costs are published, two of them
 * proven optimal (see test/data/pvrp/README.md).
 *
 * The app plans a week, so the instance is written as one:
 *  · each day of the horizon is a working day (Mon-Fri, then the next week's
 *    Mon-Fri: the app treats a weekend day differently);
 *  · the load limit is the length of the day: a client of demand q is an
 *    appointment of q·K minutes, a day of capacity Q lasts Q·K minutes;
 *  · driving takes no time (the problem has none), but the app counts at
 *    least a minute per drive, so a day can hold a little less than Q —
 *    stricter, never looser; the check below uses the instance's own Q;
 *  · distances are the Euclidean ones, in a matrix the app reads as km.
 * Every plan is re-checked against the raw instance by code that is not the
 * app's: each client exactly once, no day over its load, and the cost.
 *
 *   npm run bench:pvrp                      p03 (50 clients, 5 days)
 *   npm run bench:pvrp -- --only p03,p06,p09
 *   npm run bench:pvrp -- --mode quick      the app's quick plan (default: thorough)
 *   npm run bench:pvrp -- --genetic 30000   the genetic stage's budget in ms (0 = off)
 */
const fs = require('fs');
const path = require('path');
const fixtures = require('./harness');

const BEST = { p03: { cost: 524.61, optimal: true }, p06: { cost: 835.26, optimal: true }, p09: { cost: 826.14, optimal: false } };
const DAYNUM = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12];
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };

function parse(name) {
  const L = fs.readFileSync(path.join(__dirname, 'data', 'pvrp', name + '.txt'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(/\s+/).map(Number));
  const [, m, n, t] = L[0];
  if (m !== 1) throw new Error(name + ': not a single-vehicle instance');
  const Q = L[1][1];
  const pts = L.slice(1 + t, 2 + t + n).map(r => ({ i: r[0], x: r[1], y: r[2], q: r[4], f: r[5] }));
  return { name, n, t, Q, pts };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Independent check: every client once, loads within Q, and the cost. */
function verify(inst, days) {
  const errors = [], seen = new Map();
  let cost = 0;
  const depot = inst.pts[0];
  days.forEach((tour, d) => {
    let load = 0, prev = depot;
    for (const i of tour) {
      const p = inst.pts[i];
      seen.set(i, (seen.get(i) || 0) + 1);
      load += p.q; cost += dist(prev, p); prev = p;
    }
    if (tour.length) cost += dist(prev, depot);
    if (load > inst.Q) errors.push(`day ${d + 1}: load ${load} > ${inst.Q}`);
  });
  for (let i = 1; i <= inst.n; i++) if (seen.get(i) !== 1) errors.push(`client ${i} visited ${seen.get(i) || 0} times`);
  return { valid: !errors.length, cost, errors };
}

async function run(name, mode) {
  const inst = parse(name);
  const K = Math.floor(1380 / inst.Q);              // the day must fit in 24 hours
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const days = DAYNUM.slice(0, inst.t);
  const dayHours = Object.fromEntries(days.map(d => [d, { start: '00:00', end: hm(inst.Q * K) }]));
  const cfg = fixtures.settings({ workDays: days, dayHours, travelMargin: 0, timeGrid: 1, maxPerDay: 0, homeAddress: 'depot', avoidConsecutiveDays: false });
  const KM = 111.32, LON = KM * Math.cos(38 * Math.PI / 180);
  const place = (p) => ({ lat: 38 + p.y / KM, lon: 21 + p.x / LON });
  const coords = { home: place(inst.pts[0]) };
  const sts = inst.pts.slice(1).map(p => {
    const id = 'c' + p.i; coords[id] = place(p);
    const availability = Object.fromEntries(days.map(d => [d, { on: true, start: '00:00', end: hm(inst.Q * K), windows: [[0, inst.Q * K]] }]));
    return fixtures.student(id, { name: id, address: '', lessonsPerWeek: 1, lessonDuration: Math.max(1, p.q * K), availability, availabilityMode: 'manual' });
  });
  const ids = ['home', ...sts.map(s => s.id)];
  const ptOf = (id) => id === 'home' ? inst.pts[0] : inst.pts[Number(id.slice(1))];
  const durations = ids.map(() => ids.map(() => 0));
  const distances = ids.map(a => ids.map(b => Math.round(dist(ptOf(a), ptOf(b)) * 1000)));
  const app = fixtures.loadApp({ seed: 12345 });
  app.Scheduler.IDLE_KM_PER_MIN = 0; app.Scheduler.GAP_PENALTY_PER_MIN = 0;
  app.setState({ students: sts, settings: cfg, coords, schedule: {},
    travelMatrixPeak: { coordIds: ids, durations, distances }, travelMatrixOffPeak: null, travelMatrix: null });
  const S = app.Scheduler;
  const t0 = Date.now();
  const quick = mode === 'quick' ? { attempts: 1, timeScale: 0.25, p1: { backtrackMs: 3000, repairMs: 1500 } } : { attempts: 2 };
  const gen = arg('--genetic') != null ? { geneticMs: Number(arg('--genetic')) } : {};
  let out = await S.optimizeWeek({ students: sts, settings: cfg, coords, warm: null, ...quick, ...gen });
  const again = await S.optimizeWeek({ students: sts, settings: cfg, coords, warm: out.schedule, skipPhase1: true, ...(mode === 'quick' ? { attempts: 0, timeScale: 0.25 } : { attempts: 0 }), ...gen });
  if (S.isBetterStart(again.schedule, out.schedule, cfg)) out = again;
  const ms = Date.now() - t0;
  const tours = days.map(d => (out.schedule[d] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start)).map(sl => Number(sl.studentId.slice(1))));
  return { name, n: inst.n, t: inst.t, check: verify(inst, tours), best: BEST[name], ms, placed: tours.reduce((a, x) => a + x.length, 0) };
}

(async () => {
  const names = (arg('--only') || 'p03').split(',');
  const mode = arg('--mode') || 'thorough';
  console.log(`\nSingle-vehicle PVRP (Cordeau et al. 1997) — RoutePal's week planner, ${mode} mode\n`);
  console.log('  instance  clients days  placed   check    cost vs best            gap     time');
  for (const name of names) {
    const r = await run(name, mode);
    const c = r.check;
    console.log(`  ${r.name.padEnd(9)} ${String(r.n).padStart(5)} ${String(r.t).padStart(4)}  ${String(r.placed).padStart(3)}/${r.n}  ${(c.valid ? 'VALID' : 'INVALID').padEnd(8)} ` +
      `${c.cost.toFixed(2)} vs ${r.best.cost.toFixed(2)}${r.best.optimal ? ' (opt)' : ' (bks)'}`.padEnd(30) +
      `${c.valid ? ((c.cost / r.best.cost - 1) * 100 >= 0 ? '+' : '') + ((c.cost / r.best.cost - 1) * 100).toFixed(2) + '%' : '—'}`.padStart(8) + `${(r.ms / 1000).toFixed(0)}s`.padStart(8));
    if (!c.valid) c.errors.slice(0, 4).forEach(e => console.log('            ' + e));
  }
  console.log('');
})();
