'use strict';
// One week, one number: Home's km is the sum of the days the week view shows.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot, cityCoords } = require('./harness');

test('Home sums the very km each day shows, rush hour and quiet hours included', async () => {
  const app = loadApp();
  const sts = [student('a', { address: 'Α' }), student('b', { address: 'Β' })];
  const ids = ['home', 'a', 'b'];
  // Two traffic bands that disagree on distance (other roads at rush hour).
  const band = (k) => ({ coordIds: ids, durations: [[0, 600, 900], [600, 0, 700], [900, 700, 0]], distances: [[0, 4000 * k, 6000 * k], [4000 * k, 0, 5000 * k], [6000 * k, 5000 * k, 0]] });
  app.setState({ settings: settings(), students: sts, coords: cityCoords(sts),
    schedule: { 1: [slot('a', '08:00', '09:00'), slot('b', '18:00', '19:00')] },
    travelMatrixPeak: band(1.5), travelMatrixOffPeak: band(1), travelMatrix: band(1) });
  const home = await app.App._kmOf(app.state.schedule);
  const day = app.Scheduler.dayKm(app.state.schedule[1].slice(), 1, app.state.settings);
  assert.ok(Math.abs(home - day) < 1e-9, `Home ${home} vs the day ${day}`);
});

test('the month adds each week once: planning the same week again replaces it', () => {
  const app = loadApp();
  app.setState({ settings: settings(), students: [], jobs: [], coords: {}, schedule: {} });
  app.Storage.saveSavings = () => {};
  const rec = (km) => ({ before: { km: 30, drive: 50, idle: 0, stops: 5 }, after: { km: 30 - km, drive: 40, idle: 0, stops: 5 } });
  app.App.recordSavings('week', null, rec(10));
  app.App.recordSavings('week', null, rec(12));          // same calendar week, planned again
  const m = app.App.monthSavings();
  assert.equal(m.weeks, 1);
  assert.equal(Math.round(m.km), 12);
  assert.equal(app.App.isoWeekOf('2026-01-01T10:00:00'), '2026-W01');
  assert.equal(app.App.monthSavings(new Date(2020, 0, 5)).weeks, 0, 'another month is not counted');
});

test('a long gap spent at home is counted through home, only when the setting says so and the gap holds the trip', () => {
  const app = loadApp();
  const ids = ['home', 'a', 'b'];
  const mat = { coordIds: ids, durations: [[0, 600, 600], [600, 0, 300], [600, 300, 0]], distances: [[0, 6000, 6000], [6000, 0, 2000], [6000, 2000, 0]] };
  const sts = [student('a', { address: 'Α' }), student('b', { address: 'Β' })];
  const cfg = (g) => settings({ travelMargin: 0, homeGapMin: g, homeAddress: 'Home' });
  app.setState({ students: sts, settings: cfg(0), coords: { home: { lat: 38, lon: 21 }, a: { lat: 38.01, lon: 21 }, b: { lat: 38.02, lon: 21 } },
    travelMatrixPeak: mat, travelMatrixOffPeak: mat, travelMatrix: mat });
  const S = app.Scheduler;
  const day = [slot('a', '09:00', '10:00', { address: 'Α' }), slot('b', '13:00', '14:00', { address: 'Β' })];
  assert.equal(S.dayKm(day, 1, cfg(0)), 6 + 2 + 6, 'off: the direct drive');
  assert.equal(S.dayKm(day, 1, cfg(90)), 6 + 6 + 6 + 6, 'a 3 h gap, 90 or more: through home');
  assert.equal(S.dayKm(day, 1, cfg(240)), 6 + 2 + 6, 'a gap shorter than the setting: direct');
  const tight = [slot('a', '09:00', '10:00', { address: 'Α' }), slot('b', '10:15', '11:15', { address: 'Β' })];
  assert.equal(S.dayKm(tight, 1, cfg(15)), 6 + 2 + 6, 'a gap that cannot hold the trip home: direct');
});
