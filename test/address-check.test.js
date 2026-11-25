'use strict';
// Addresses that look wrong: one mistyped street cost a week 32 km.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

test('flags a client far from home and from everyone, an address with no town, and a pin on the home', () => {
  const app = loadApp();
  const home = { lat: 38.3293, lon: 21.8422 };
  const near = (i) => ({ lat: 38.32 - i * 0.004, lon: 21.83 - i * 0.004 });
  const sts = [
    ...[0, 1, 2, 3, 4].map(i => student('n' + i, { name: 'N' + i, address: 'Οδός ' + i + ', Ρίο' })),
    student('far', { name: 'Βαγγέλης', address: 'Αγίου Γεωργίου 74' }),
    student('pin', { name: 'Αναστάσης', address: 'Σικελιανού 4, Αραχωβίτικα' }),
    student('ok', { name: 'Σωστός', address: 'Κοραή 25' }),
  ];
  const coords = { home, far: { lat: 38.1794, lon: 21.6999 }, pin: { ...home }, ok: { ...near(1), src: 'pin' } };
  [0, 1, 2, 3, 4].forEach(i => { coords['n' + i] = near(i); });
  app.setState({ students: sts, settings: settings({ homeAddress: 'Ψαρών 11, Αραχωβίτικα' }), coords });
  const w = app.App.addressWarnings();
  const by = Object.fromEntries(w.map(x => [x.st.id, x.why]));
  assert.equal(by.far, 'far');
  assert.equal(by.pin, 'athome');
  assert.equal(by.ok, undefined, 'a pinned point is the person\'s own choice');
  assert.equal(Object.keys(by).filter(k => k.startsWith('n')).length, 0, 'ordinary addresses are not flagged');
  app.App.addressIsRight(w.find(x => x.st.id === 'far').key);
  assert.ok(!app.App.addressWarnings().some(x => x.st.id === 'far'), '"it is right" hides it');
  assert.ok(app.App.addressBannerHtml().includes('Αναστάσης'));
});
