'use strict';
/**
 * Day-planner benchmark — `npm run bench:tsptw`.
 *
 * Dumas et al. (1995) TSPTW instances: one vehicle, N customers with time
 * windows, minimise total travel time. The day a plumber or a nurse plans
 * is this problem, so here the literature's numbers can be set beside ours.
 *
 * The planner measured is Scheduler.planDay — the "Plan the day" button —
 * at the budget the app gives it, unless --budget says otherwise.
 * Every tour is re-checked against the raw instance by test/tsptw.js, which
 * uses nothing from the app, and a result counts only if that check passes.
 *
 *   npm run bench:tsptw                       n20, one instance per width (5)
 *   npm run bench:tsptw -- --size 40          n40, one per width
 *   npm run bench:tsptw -- --size 20 --all    all 25 of n20
 *   npm run bench:tsptw -- --only n20w60.003
 *   npm run bench:tsptw -- --budget 8000      ALNS budget in ms (app: 4000)
 */

const fixtures = require('./harness');
const { loadApp } = fixtures;
const T = require('./tsptw');

const SEED = 12345;
const WIDTHS = ['20', '40', '60', '80', '100'];

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

function chosen() {
  if (arg('--only')) return arg('--only').split(',');
  const size = arg('--size') || '20';
  const sets = process.argv.includes('--all') ? ['001', '002', '003', '004', '005'] : ['001'];
  return WIDTHS.flatMap(w => sets.map(s => `n${size}w${w}.${s}`));
}

async function run(name) {
  const inst = T.parseInstance(name);
  const best = T.parseSolution(name);

  // Self-checks before any number is trusted: the checker must accept the
  // published tour at the published cost, and the windows handed to the app
  // must not cut that tour off.
  const vb = T.verifyTour(inst, best.tour);
  if (!vb.valid || vb.cost !== best.cost)
    throw new Error(`${name}: checker gives the published tour ${vb.valid ? 'cost ' + vb.cost : vb.errors[0]}, file says ${best.cost}`);
  const fits = T.fitsDayWindows(inst, best.tour);
  const triangle = T.triangleViolations(inst);

  const { jobs, cfg, coords, date, matrix, zeroLegs } = T.toDay(inst, fixtures);
  const app = loadApp({ seed: SEED });
  app.setState({ jobs, settings: cfg, coords, students: [], schedule: {},
    travelMatrixPeak: matrix, travelMatrixOffPeak: null, travelMatrix: null });
  const budget = Number(arg('--budget')) || undefined;
  const t0 = Date.now();
  const plan = await app.Scheduler.planDay(jobs, cfg, coords, date, budget ? { budgetMs: budget } : {});
  const ms = Date.now() - t0;

  const tour = plan.stops.map(s => Number(s.job.id.slice(1)));
  const check = T.verifyTour(inst, tour);
  return { name, n: inst.n - 1, placed: tour.length, check, best: best.cost, fits, triangle, zeroLegs,
    appIssues: (plan.issues || []).length, ms };
}

(async () => {
  const names = chosen();
  const rows = [];
  for (const name of names) {
    process.stderr.write(`  ${name} ...\r`);
    rows.push(await run(name));
  }
  process.stderr.write('                 \r');

  console.log('\nTSPTW, Dumas et al. (1995) — Scheduler.planDay against best-known tours\n');
  console.log('  one vehicle, depart depot at 0, back by its due time, waiting free,');
  console.log('  objective = total travel time; integer data, times x10, nothing rounded.');
  console.log('  Checked against the raw instance by code that is not the app\'s.\n');
  console.log('  instance       stops    check     cost vs best     gap      time');
  console.log('  ' + '-'.repeat(68));
  for (const r of rows) {
    const c = r.check;
    console.log('  ' + r.name.padEnd(15) + `${r.placed}/${r.n}`.padEnd(9) + (c.valid ? 'VALID' : 'INVALID').padEnd(10) +
      `${c.cost} vs ${r.best}`.padEnd(15) +
      (c.valid ? `${c.cost >= r.best ? '+' : ''}${((c.cost / r.best - 1) * 100).toFixed(2)}%` : '—').padStart(8) +
      `${(r.ms / 1000).toFixed(1)}s`.padStart(9));
    if (!c.valid) {
      console.log(`                 late ${c.late}, missing ${c.missing}`);
      c.errors.slice(0, 4).forEach(e => console.log('                   ' + e));
    }
    if (!r.fits) console.log('                 note: the windows given to the app cut off the best-known tour');
    if (r.zeroLegs) console.log(`                 note: ${r.zeroLegs} legs of length 0, each 0.2 units in the app`);
    if (r.appIssues) console.log(`                 note: the app itself reports ${r.appIssues} issue(s) with its plan`);
  }
  console.log('  ' + '-'.repeat(68));
  const valid = rows.filter(r => r.check.valid);
  const gaps = valid.map(r => (r.check.cost / r.best - 1) * 100);
  const hits = valid.filter(r => r.check.cost <= r.best).length;
  console.log(`  valid ${valid.length}/${rows.length}` +
    (valid.length ? `, best-known reached ${hits}/${valid.length}, mean gap +${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2)}%` +
      `, worst +${Math.max(...gaps).toFixed(2)}%` : ''));
  const tri = rows.filter(r => r.triangle).length;
  if (tri) console.log(`  ${tri}/${rows.length} matrices break the triangle inequality (integer rounding), so the\n` +
    '  depot bounds in the windows could cut off some valid tours; none cuts off\n' +
    '  the best-known one (checked per instance, a note above if it did).');
  console.log(`  mean time ${(rows.reduce((a, r) => a + r.ms, 0) / rows.length / 1000).toFixed(1)}s per day\n`);
  console.log('  The app starts every stop but a day\'s first on a 5-minute mark (0.5');
  console.log('  instance units here). That is the app\'s rule, kept: it can only make a');
  console.log('  window harder to meet, never easier.\n');
  process.exit(rows.length - valid.length ? 1 : 0);
})();
