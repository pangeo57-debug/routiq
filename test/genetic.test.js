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
    const { S, sts, cfg, app } = world({ lunchBreak: 30 });
    const r = await S.optimizeWeek({ students: sts, settings: cfg, coords: app.state.coords, attempts: 1, timeScale: 0.25, geneticMs: 0 });
    const was = JSON.stringify(r.schedule);
    const used = await S.geneticWeek(r.schedule, sts, cfg, 2000);
    assert.equal(used, false); assert.equal(JSON.stringify(r.schedule), was);
  });
  test('the app runs it by default: 15 s in the quick plan, 45 s in the thorough one', () => {
    const app = loadApp({ genetic: true });
    assert.deepStrictEqual({ ...app.Scheduler.GENETIC_MS }, { quick: 15000, thorough: 45000 });
    assert.deepStrictEqual({ ...loadApp().Scheduler.GENETIC_MS }, { quick: 0, thorough: 0 }, 'off in the other tests');
  });
});
