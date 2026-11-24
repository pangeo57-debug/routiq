'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot, cityCoords } = require('./harness');

// Tuesday 24/11/2026. Ana is cancelled 15:00-17:00; Bo can come Tuesdays 14-18
// and normally comes Thursday; Cy has no lesson this week to move and can come.
function world() {
  const app = loadApp();
  const sts = [student('ana', { name: 'Άννα', address: 'Α 1', days: [2], window: { start: '14:00', end: '20:00' }, lessonDuration: 120 }),
    student('bo', { name: 'Μπο', address: 'Β 2', days: [2, 4], window: { start: '14:00', end: '18:00' }, lessonDuration: 60, price: 25 }),
    student('cy', { name: 'Κυ', address: 'Γ 3', days: [2], window: { start: '15:00', end: '19:00' }, lessonDuration: 60 }),
    student('dee', { name: 'Ντι', address: 'Δ 4', days: [2], window: { start: '17:00', end: '20:00' }, lessonDuration: 60 })];
  app.setState({ settings: settings({ workDays: [2, 4], dayHours: { 2: { start: '14:00', end: '21:00' }, 4: { start: '14:00', end: '21:00' } } }),
    students: sts, coords: cityCoords(sts), jobs: [],
    schedule: { 2: [slot('ana', '15:00', '17:00'), slot('dee', '18:00', '19:00')], 4: [slot('bo', '16:00', '17:00')] } });
  return app;
}

describe('a lesson cancelled for one day, and who could take its place', () => {
  test('cancelling touches that date only: the week plan and other weeks stay', () => {
    const app = world(), D = app.DayFill;
    D.cancel('2026-11-24', 'ana', '15:00');
    assert.deepStrictEqual(Array.from(D.lessonsOn('2026-11-24'), x => x.studentId), ['dee']);
    assert.deepStrictEqual(Array.from(D.lessonsOn('2026-12-01'), x => x.studentId), ['ana', 'dee'], 'next Tuesday as usual');
    assert.equal(app.state.schedule[2].length, 2, 'the week plan is untouched');
    D.restore('2026-11-24', 'ana', '15:00');
    assert.equal(D.lessonsOn('2026-11-24').length, 2);
  });
  test('the options fit in the gap, keep the next lesson on time, and say what they cost', () => {
    const app = world(), D = app.DayFill;
    D.cancel('2026-11-24', 'ana', '15:00');
    const r = D.options('2026-11-24', '15:00');
    const singles = r.options.filter(o => !o.pair);
    const ids = Array.from(singles, o => o.st.id);
    assert.ok(ids.includes('bo') && ids.includes('cy'), ids.join());
    assert.ok(!ids.includes('dee'), 'already on that day');
    assert.ok(!ids.includes('ana'), 'not the one who cancelled');
    for (const o of r.options) assert.ok(app.Scheduler.toMin(o.end) <= app.Scheduler.toMin('18:00'), 'the 18:00 lesson stays on time');
    const bo = singles.find(o => o.st.id === 'bo');
    assert.ok(bo.from && bo.from.date === '2026-11-26', 'Bo is brought forward from Thursday');
    assert.equal(bo.from.alone, true);
    assert.ok(D.pros(bo).some(x => /Πέμπτη μένει ελεύθερη/.test(x)), D.pros(bo).join(' | '));
    const cy = singles.find(o => o.st.id === 'cy');
    assert.equal(cy.extra, true);
  });
  test('choosing one moves it for that date only, and frees its own day that week; undo gives it back', () => {
    const app = world(), D = app.DayFill;
    D.cancel('2026-11-24', 'ana', '15:00');
    const bo = D.options('2026-11-24', '15:00').options.find(o => !o.pair && o.st.id === 'bo');
    D.apply('2026-11-24', bo);
    assert.deepStrictEqual(Array.from(D.lessonsOn('2026-11-24'), x => x.studentId), ['bo', 'dee']);
    assert.equal(D.lessonsOn('2026-11-26').length, 0, 'Thursday is free this week');
    assert.equal(D.lessonsOn('2026-12-03').length, 1, 'and back the week after');
    D.unapply('2026-11-24', 'bo');
    assert.equal(D.lessonsOn('2026-11-26').length, 1);
  });
  test('Home shows the real day', () => {
    const app = world(), D = app.DayFill;
    D.cancel('2026-11-24', 'ana', '15:00');
    assert.deepStrictEqual(Array.from(app.App._todayAgenda('2026-11-24').filter(x => x.kind === 'lesson'), x => x.id), ['dee']);
  });
});

describe('a stretch long enough for two', () => {
  test('a pair is offered that fits the stretch with the next lesson on time, and choosing it moves both', () => {
    const app = world(), D = app.DayFill, S = app.Scheduler;
    D.cancel('2026-11-24', 'ana', '15:00');                      // 15:00-17:00 free, next lesson 18:00
    const r = D.options('2026-11-24', '15:00');
    const pair = r.options.find(o => o.pair);
    assert.ok(pair, 'a pair is among the options');
    const [a, b] = pair.pair;
    assert.ok(S.toMin(a.end) <= S.toMin(b.start), 'the second after the first');
    assert.ok(S.toMin(b.end) <= S.toMin('18:00'), 'the next lesson stays on time');
    assert.ok(D.pros(pair).some(x => /2 ραντεβού/.test(x)));
    D.apply('2026-11-24', pair);
    const ids = Array.from(D.lessonsOn('2026-11-24'), x => x.studentId);
    assert.ok(ids.includes(a.st.id) && ids.includes(b.st.id) && ids.includes('dee'));
  });
});
