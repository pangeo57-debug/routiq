'use strict';
// Profession presets: a starting point the person can change, never forced.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, settings } = require('./harness');

describe('profession presets', () => {
  test('every profession in the list has a preset with sane values', () => {
    const app = loadApp();
    const profs = app.getProfessions().map(p => p.value);
    for (const p of profs) {
      const pr = app.Professions.preset(p);
      assert.ok(pr.durations.includes(pr.dur), `${p}: the default length is one of its buttons`);
      assert.ok(pr.perWeek >= 1 && pr.perWeek <= 7, p);
      assert.ok(pr.days.every(d => d >= 1 && d <= 7), p);
      for (const [a, b] of pr.hours) assert.ok(app.Scheduler.toMin(b) > app.Scheduler.toMin(a), `${p}: ${a}-${b}`);
    }
  });

  test('applying writes hours with a break the way the hours editor does', () => {
    const app = loadApp();
    const s = app.Professions.apply(settings({ blockedSlots: [{ day: 2, start: '12:00', end: '13:00', reason: 'mine' }] }), 'physiotherapy');
    assert.deepStrictEqual(Array.from(s.workDays), [1, 2, 3, 4, 5]);
    assert.deepStrictEqual({ ...s.dayHours[1] }, { start: '08:00', end: '21:00' });
    const gaps = s.blockedSlots.filter(b => b.auto === 'hours' && b.day === 1);
    assert.equal(gaps.length, 1); assert.equal(gaps[0].start, '14:00'); assert.equal(gaps[0].end, '17:00');
    assert.ok(s.blockedSlots.some(b => b.reason === 'mine'), 'the person\'s own blocked times stay');
    assert.equal(s.defaultLessonDuration, 45); assert.equal(s.travelMargin, 10); assert.equal(s.avoidConsecutiveDays, true);
  });

  test('the person\'s own length buttons win; nonsense falls back to the profession\'s', () => {
    const app = loadApp();
    const P = app.Professions;
    assert.deepStrictEqual(Array.from(P.durations(settings({ profession: 'cleaning' }))), [180, 240, 300]);
    assert.deepStrictEqual(Array.from(P.durations(settings({ profession: 'cleaning', durationChoices: [120, 60, 60] }))), [60, 120]);
    assert.deepStrictEqual(Array.from(P.parseDurations('45, 60 90,abc')), [45, 60, 90]);
    assert.equal(P.parseDurations('nothing'), null);
    assert.equal(P.defaultPerWeek(settings({ profession: 'tutor' })), 2);
    assert.equal(P.defaultPerWeek(settings({ profession: 'tutor', defaultPerWeek: 3 })), 3);
  });

  test('a service sets its own length, and the person can override it', () => {
    const app = loadApp();
    const P = app.Professions;
    assert.equal(P.serviceDuration(settings({ profession: 'beauty' }), 'beauty_hair'), 120);
    assert.equal(P.serviceDuration(settings({ profession: 'beauty', serviceDurations: { beauty_hair: 150 } }), 'beauty_hair'), 150);
    assert.equal(P.serviceDuration(settings({ profession: 'tutor' }), 'Μαθηματικά'), null);
  });

  test('the summary says what will be set, in words', () => {
    const app = loadApp();
    const line = app.Professions.summary('physiotherapy');
    assert.match(line, /08:00–14:00 & 17:00–21:00/);
    assert.match(line, /45′/);
  });
});
