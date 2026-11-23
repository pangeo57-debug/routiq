'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

describe('who owes what', () => {
  function world() {
    const app = loadApp();
    app.setState({ settings: settings(), students: [student('a', { name: 'Γιώργος', price: 20 }), student('b', { name: 'Ελένη' })], coords: {}, jobs: [], schedule: {} });
    return app;
  }
  test('each appointment ticked as done adds one; ticking again takes it back', () => {
    const app = world(), P = app.Payments;
    P.toggleDone('2026-11-23', 'a', '15:00'); P.toggleDone('2026-11-24', 'a', '15:00'); P.toggleDone('2026-11-23', 'b', '17:00');
    assert.equal(P.owed('a'), 2); assert.equal(P.owed('b'), 1);
    P.toggleDone('2026-11-24', 'a', '15:00');
    assert.equal(P.owed('a'), 1);
    assert.ok(P.isDone('2026-11-23', 'a', '15:00'));
  });
  test('a payment takes appointments off; with a price it shows in euros', () => {
    const app = world(), P = app.Payments;
    for (const d of ['2026-11-02', '2026-11-09', '2026-11-16']) P.toggleDone(d, 'a', '15:00');
    assert.equal(P.owedText(app.state.students[0]), 'Χρωστάει 3 · 60 €');
    P.pay('a', 2);
    assert.equal(P.owed('a'), 1);
    assert.equal(P.owedText(app.state.students[1]), '', 'nothing owed, nothing shown');
    P.pay('a', 5);
    assert.equal(P.owed('a'), 0, 'a prepayment never shows as a negative debt');
  });
});
