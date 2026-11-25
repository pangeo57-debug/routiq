'use strict';
// Fixed hours at another place (a tutoring centre Mon 15-18): the person must
// get there on time and leaves from there; the km count.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, cityCoords } = require('./harness');

function world() {
  const app = loadApp({ seed: 5, genetic: true });
  const days = [1, 2, 3, 4, 5];
  const sts = Array.from({ length: 10 }, (_, i) => student('f' + i, { name: 'F' + i, address: 'Οδός ' + i,
    lessonsPerWeek: 1 + (i % 2), lessonDuration: 60, days, window: { start: '14:00', end: '21:00' } }));
  const coords = cityCoords(sts);
  const centre = { lat: coords.f3.lat + 0.03, lon: coords.f3.lon + 0.03 };
  const block = { day: 1, start: '15:00', end: '18:00', reason: 'Φροντιστήριο', id: 'x1', address: 'Κέντρο', lat: centre.lat, lon: centre.lon };
  coords['blk:x1'] = { ...centre };
  const cfg = settings({ workDays: days, blockedSlots: [block] });
  app.setState({ students: sts, settings: cfg, coords, schedule: {} });
  return { app, S: app.Scheduler, sts, cfg, coords };
}

test('a week planned around it keeps the stretch free, reaches it in time, and counts the trip', async () => {
  const { S, sts, cfg, coords } = world();
  const fx = S.fixedSplit(sts, {}, cfg);
  assert.equal(fx.ids.length, 1);
  assert.equal(fx.settings.blockedSlots.length, 0, 'during planning it is an appointment, not a blocked stretch');
  const out = await S.optimizeWeek({ students: fx.students, settings: fx.settings, coords, attempts: 1, warm: fx.schedule, timeScale: 0.05, geneticMs: 1500 });
  const mon = out.schedule[1] || [];
  const blk = mon.find(sl => sl.studentId === 'blk:x1');
  assert.ok(blk, 'it is in the plan');
  assert.equal(blk.start, '15:00'); assert.equal(blk.end, '18:00');
  assert.equal(S.verifySchedule(out.schedule, fx.students, fx.settings).length, 0, 'the plan is legal, the trip there included');
  const week = S.fixedJoin(out.schedule);
  assert.ok(!(week[1] || []).some(sl => String(sl.studentId).startsWith('blk:')), 'taken out again afterwards');
  assert.equal(S.verifySchedule(week, sts, cfg).length, 0, 'nothing sits in the stretch');
  const lessons = (week[1] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
  if (lessons.length) {
    const plain = S.dayKm(lessons, 1, { ...cfg, blockedSlots: [] });
    assert.ok(S.dayKm(lessons, 1, cfg) > plain, 'the km include going to the centre and back');
  }
});
