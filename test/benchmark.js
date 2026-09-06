'use strict';
/**
 * Quality benchmark — `npm run bench`.
 *
 * The test suite says whether the scheduler is CORRECT. This says how GOOD it
 * is. Run it before and after a change: these numbers are what tell you whether
 * the change was an improvement or noise. Four separate ideas were discarded
 * this way after measuring as noise, and one real bug was found by it.
 *
 * Two halves:
 *
 *  1. Solomon's 1987 VRPTW instances, scored against their published
 *     best-known solutions. An absolute, external yardstick — but read the
 *     caveat printed with the results: we are not solving quite the same
 *     problem, and the numbers must not be quoted as if we were.
 *
 *  2. Our own scenarios, scored against an optimum this file computes exactly
 *     (Held-Karp). Closer to how the app is really used, and the only half
 *     where the day assignment is held fixed so ordering alone is judged.
 *
 * `npm run bench -- --against <git-ref>` runs both builds on identical inputs
 * and prints the difference. Without that, comparing two versions means eyeing
 * two separate runs, and this project has been fooled by that more than once.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtures = require('./harness');
const { loadApp, student, settings } = fixtures;
const { auditSchedule } = require('./invariants');
const Solomon = require('./solomon');

const SEED = 12345;          // every run is reproducible
const INSTANCES = ['C101', 'R101', 'RC101'];

// ---------------------------------------------------------------------------

async function runPipeline(app, sts, cfg, coords, budgets) {
  const S = app.Scheduler;
  const t0 = Date.now();
  const r = await S.runMultiAttempt(sts, cfg, coords, budgets.attempts, false);
  await S.alnsOptimize(r.schedule, sts, cfg, coords, budgets.alns);
  S.saRepair(r.schedule, sts, cfg, r);
  await S.guardedPass(r.schedule, cfg, (sch) => S.lnsRepair(sch, sts, cfg, budgets.lns));
  S.enforceConstraints(r.schedule, sts, cfg);
  S.collapseForceMergeFragments(r.schedule, sts, cfg);
  S.tidyDays(r.schedule, sts, cfg);
  S.compactDays(r.schedule, sts, cfg);
  return { schedule: r.schedule, ms: Date.now() - t0 };
}

/** Exact shortest tour depot -> stops -> depot. Held-Karp, not a heuristic. */
function optimalTour(points, home, d) {
  const n = points.length;
  if (n === 0) return 0;
  if (n === 1) return d(home, points[0]) * 2;
  if (n > 12) return null;
  const size = 1 << n;
  const dp = Array.from({ length: size }, () => new Float64Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) dp[1 << i][i] = d(home, points[i]);
  for (let mask = 1; mask < size; mask++)
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last)) || dp[mask][last] === Infinity) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const m2 = mask | (1 << next), cand = dp[mask][last] + d(points[last], points[next]);
        if (cand < dp[m2][next]) dp[m2][next] = cand;
      }
    }
  let best = Infinity;
  for (let last = 0; last < n; last++) best = Math.min(best, dp[size - 1][last] + d(points[last], home));
  return best;
}

// ---------------------------------------------------------------------------

async function solomonRun(name, maxRoutes) {
  const inst = Solomon.parseInstance(name);
  const best = Solomon.parseSolution(name);

  // Self-check the wiring before trusting any number from it: re-scoring the
  // published solution must reproduce the published cost exactly.
  let check = 0;
  for (const route of best.routes) {
    let prev = 1;
    for (const c of route) { check += Solomon.dist(inst, prev, c + 1); prev = c + 1; }
    check += Solomon.dist(inst, prev, 1);
  }
  if (Math.abs(check - best.cost) > 0.05) {
    throw new Error(`${name}: re-scored the published solution as ${check.toFixed(1)}, ` +
      `file says ${best.cost} — the distance convention is wrong, every number below would be meaningless`);
  }

  const { sts, cfg, coords, days, matrix } = Solomon.toRoutePal(inst, fixtures, maxRoutes);
  const app = loadApp({ seed: SEED });
  app.setState({ students: sts, settings: cfg, coords,
    travelMatrixPeak: matrix, travelMatrixOffPeak: null, travelMatrix: null });

  const { schedule, ms } = await runPipeline(app, sts, cfg, coords,
    { attempts: 2, alns: 20000, lns: 8000 });

  const scored = Solomon.scheduleCost(inst, schedule, days);
  return { name, served: app.Scheduler.countTotal(schedule), total: inst.n - 1,
    ...scored, bestCost: best.cost, bestRoutes: best.routes.length,
    violations: auditSchedule(app.Scheduler, schedule, sts, cfg).length, ms };
}

async function ownRun() {
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

  const app = loadApp({ seed: SEED });
  app.setState({ students: sts, settings: cfg, coords,
    travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
  const { schedule, ms } = await runPipeline(app, sts, cfg, coords,
    { attempts: 3, alns: 15000, lns: 6000 });

  const S = app.Scheduler;
  const d = (a, b) => S.haversineKm(a, b) * 1.4;
  let km = 0, opt = 0, idle = 0, exact = 0;
  for (const day of cfg.workDays) {
    const sl = (schedule[day] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
    if (!sl.length) continue;
    km += S.dayKm(sl, day, cfg);
    idle += S.dayIdle(sl, day, cfg);
    const o = optimalTour(sl.map(s => coords[s.studentId]).filter(Boolean), coords.home, d);
    if (o != null) { opt += o; exact++; }
  }
  return { served: S.countTotal(schedule), want: sts.reduce((a, s) => a + s.lessonsPerWeek, 0),
    km, opt, idle, exact, violations: auditSchedule(S, schedule, sts, cfg).length, ms };
}

async function collect() {
  const solomon = [];
  for (const name of INSTANCES) solomon.push(await solomonRun(name, 25));
  return { solomon, own: await ownRun() };
}

// ---------------------------------------------------------------------------

function report(res) {
  console.log('\nAgainst published best-known solutions (Solomon 1987)\n');
  console.log('  instance   served      routes        distance      vs best   bad');
  console.log('  ' + '-'.repeat(70));
  for (const r of res.solomon) {
    console.log('  ' + r.name.padEnd(10) +
      `${r.served}/${r.total}`.padEnd(11) +
      `${r.routes} vs ${r.bestRoutes}`.padEnd(13) +
      `${r.cost.toFixed(1)} vs ${r.bestCost}`.padEnd(15) +
      `+${(((r.cost / r.bestCost) - 1) * 100).toFixed(0)}%`.padStart(7) +
      `${r.violations}`.padStart(6));
  }
  const over = res.solomon.reduce((a, r) => a + r.overCapacity, 0);
  console.log('  ' + '-'.repeat(70));
  console.log('\n  Read this honestly. Solomon\'s objective is to minimise the number of');
  console.log('  vehicles first and distance second, and to respect a load capacity.');
  console.log('  RoutePal minimises neither vehicle count nor load — it has no concept');
  console.log('  of either — so it spreads work over more routes and the distance gap');
  console.log('  above is partly a different objective, not only worse routing.');
  console.log(`  Routes that would exceed the capacity we ignore: ${over}.`);

  const o = res.own;
  console.log('\nOur own scenario (day assignment held fixed, ordering judged alone)\n');
  console.log(`  lessons placed        ${o.served}/${o.want}`);
  console.log(`  driving               ${o.km.toFixed(1)} km`);
  console.log(`  detour vs exact       x${(o.km / o.opt).toFixed(3)}   (1.000 = the visit order could not be bettered)`);
  console.log(`  waiting               ${o.idle} min`);
  console.log(`  violations            ${o.violations}`);
  console.log(`  days measured exactly ${o.exact}\n`);

  const bad = res.solomon.reduce((a, r) => a + r.violations, 0) + o.violations;
  if (bad) console.log(`  CONSTRAINT VIOLATIONS: ${bad} — this must be zero\n`);
  return bad;
}

function compare(a, b) {
  console.log('\nThis build vs the reference, identical inputs and seed\n');
  console.log('  instance    distance                    served');
  console.log('  ' + '-'.repeat(58));
  a.solomon.forEach((x, i) => {
    const y = b.solomon[i];
    const d = ((x.cost / y.cost) - 1) * 100;
    console.log('  ' + x.name.padEnd(11) +
      `${y.cost.toFixed(1)} -> ${x.cost.toFixed(1)}`.padEnd(22) +
      `${d <= 0 ? '' : '+'}${d.toFixed(1)}%`.padEnd(9) +
      `${y.served} -> ${x.served}`);
  });
  console.log('  ' + '-'.repeat(58));
  console.log(`  ours        ${b.own.km.toFixed(1)} -> ${a.own.km.toFixed(1)} km` +
    `        ${b.own.served} -> ${a.own.served} lessons\n`);
}

(async () => {
  const idx = process.argv.indexOf('--against');
  const asJson = process.argv.includes('--json');
  const res = await collect();

  // In --json mode this process is a sub-run feeding the comparison above it:
  // anything but JSON on stdout and the parent cannot read the result.
  if (asJson) { process.stdout.write(JSON.stringify(res)); return; }
  const bad = report(res);

  if (idx > -1 && process.argv[idx + 1]) {
    const ref = process.argv[idx + 1];
    const tmp = path.join(os.tmpdir(), `routiq-${ref.replace(/[^\w]/g, '_')}.html`);
    fs.writeFileSync(tmp, execSync(`git show ${ref}:routiq.html`, { maxBuffer: 64 * 1024 * 1024 }));
    console.log(`Re-running against ${ref} …\n`);
    const out = execSync(`ROUTIQ_APP_FILE=${tmp} node ${__filename} --json`,
      { maxBuffer: 16 * 1024 * 1024 }).toString();
    compare(res, JSON.parse(out));
  }
  process.exit(bad ? 1 : 0);
})();
