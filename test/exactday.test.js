'use strict';
// Small days are solved exactly: the cost equals the best of every visit order.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, cityCoords } = require('./harness');

function perms(a) { if (a.length <= 1) return [a]; return a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map(p => [x, ...p])); }

test('days of up to 7 stops: the solver\'s day costs exactly the best of all orders', async () => {
  let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let compared = 0;
  for (let trial = 0; trial < 6; trial++) {
    const app = loadApp({ seed: trial + 1 });
    const S = app.Scheduler;
    const n = 5 + (trial % 3);
    const sts = Array.from({ length: n }, (_, i) => {
      const a = 14 * 60 + Math.floor(rnd() * 8) * 30;
      return student('c' + i, { address: 'Δ' + i, lessonDuration: 45, days: [1], window: { start: S.toTime(a), end: S.toTime(Math.min(22 * 60, a + 150 + Math.floor(rnd() * 4) * 60)) } });
    });
    const cfg = settings({ workDays: [1], dayHours: { 1: { start: '14:00', end: '22:00' } } });
    app.setState({ students: sts, settings: cfg, coords: cityCoords(sts), schedule: {} });
    const sol = await S.solveDay(sts, cfg, 1, { budgetMs: 300 });
    let bestAll = Infinity;
    for (const p of perms(sts.map((_, i) => i))) {
      const laid = S.relayoutDay(p.map(i => S._lessonSlot(sts[i], 45)), 1, sts, cfg);
      if (laid && !S.verifySchedule({ 1: laid }, sts, cfg).length) bestAll = Math.min(bestAll, S.dayCost(laid, 1, cfg));
    }
    if (bestAll === Infinity) continue;                       // nobody's order fits everyone: not this test
    assert.ok(sol && sol.slots.length === n, 'everyone placed');
    assert.equal(sol.exact, true, 'proven by branch and bound');
    compared++;
    assert.ok(Math.abs(S.dayCost(sol.slots, 1, cfg) - bestAll) < 1e-6, `trial ${trial}: ${S.dayCost(sol.slots, 1, cfg)} vs best of all orders ${bestAll}`);
  }
  assert.ok(compared >= 4, `only ${compared} days compared`);
});
