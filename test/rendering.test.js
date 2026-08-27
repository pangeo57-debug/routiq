'use strict';
/**
 * Output safety and address search.
 *
 * The app builds HTML by string interpolation, so any user-typed value that
 * reaches innerHTML without esc() is a stored-XSS hole: a student named
 * `<img src=x onerror=...>` would execute on every render, for as long as that
 * student exists. These tests pin the escaping in the render paths that had
 * real holes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings, slot } = require('./harness');

const PAYLOAD = '<img src=x onerror="alert(1)">';

/** Fails if `html` contains the payload unescaped. */
function assertEscaped(html, label) {
  assert.ok(!html.includes('<img src=x'),
    `${label}: user input reached the DOM unescaped\n  ...${
      html.slice(Math.max(0, html.indexOf('<img src=x') - 80), html.indexOf('<img src=x') + 60)}`);
  assert.ok(html.includes('&lt;img'), `${label}: expected the payload to appear escaped`);
}

describe('escaping of user-controlled text', () => {
  test('route stop list escapes name, address and subject', () => {
    const app = loadApp();
    app.setState({ settings: settings(), coords: {}, students: [], schedule: {} });
    const html = app.App.buildStopList([
      slot('s1', '15:00', '16:00', {
        studentName: PAYLOAD, address: PAYLOAD, subject: PAYLOAD,
      }),
    ], false);
    assertEscaped(html, 'buildStopList');
  });

  test('route start/return rows escape the home address', () => {
    const app = loadApp();
    app.setState({ settings: settings({ homeAddress: PAYLOAD }), coords: {}, students: [], schedule: {} });
    const html = app.App.buildStopList([], false);
    assertEscaped(html, 'buildStopList home address');
  });

  test('unplaced-students card escapes the student name', () => {
    const app = loadApp();
    const st = student('s1', { name: PAYLOAD, lessonsPerWeek: 2 });
    app.setState({ settings: settings(), students: [st], coords: {}, schedule: {} });
    const html = app.App.renderUnplaced([
      { student: st, needed: 2, placed: 0, reason: 'test' },
    ]);
    assertEscaped(html, 'renderUnplaced');
  });

  test('a quote-and-tag payload cannot break out of the markup', () => {
    const app = loadApp();
    const st = student('s1', { name: `"><script>x</script>`, lessonsPerWeek: 1 });
    app.setState({ settings: settings(), students: [st], coords: {}, schedule: {} });
    const html = app.App.renderUnplaced([{ student: st, needed: 1, placed: 0, reason: 'r' }]);
    assert.ok(!html.includes('<script>'), 'script tag must not survive interpolation');
  });
});

describe('address search relevance', () => {
  /** Build a HERE-shaped autosuggest response. */
  const hereItems = (items) => ({
    ok: true,
    json: async () => ({ items }),
  });
  const hereItem = (title, addr, lat = 38.25, lng = 21.74) => ({
    title, address: addr, position: { lat, lng },
  });

  async function search(query, items) {
    const app = loadApp({ fetch: async () => hereItems(items) });
    app.setState({ settings: settings(), coords: { home: { lat: 38.2466, lon: 21.7346 } } });
    const results = await app.App._searchHere(query, 'fake-key');
    return { app, results };
  }

  test('multi-word query still matches when the address has text in between', async () => {
    // "Ψαρών 11 Ρίο" vs a formatted address with a postal code between the parts.
    const { results } = await search('Ψαρων 11 Ριο', [
      hereItem('Ψαρών 11', { label: 'Ψαρών 11, 265 00 Ρίο, Ελλάδα', street: 'Ψαρών', houseNumber: '11', city: 'Ρίο', postalCode: '265 00' }),
    ]);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0]._matchText.includes('Ρίο'), 'match text should retain the full label');
  });

  test('results carry the provider\'s full text for matching, separate from display', async () => {
    const { results } = await search('Αραχωβιτικα', [
      hereItem('Ψαρών', { label: 'Ψαρών, 265 00 Ρίο, Ελλάδα', street: 'Ψαρών', city: 'Ρίο', county: 'Αραχωβίτικα', postalCode: '265 00' }),
    ]);
    assert.strictEqual(results.length, 1);
    // The settlement lives in `county`, which the fixed-order display format
    // drops — it must still be searchable.
    assert.ok(results[0]._matchText.includes('Αραχωβίτικα'),
      'county/settlement must be present in the match text');
    assert.ok(!results[0].name.includes('Αραχωβίτικα'),
      'display name uses the fixed field order');
  });

  test('addresses render as street, number, area, city, postal code', async () => {
    const { results } = await search('Γούναρη', [
      hereItem('Γούναρη 58', {
        label: 'ignored', street: 'Γούναρη', houseNumber: '58',
        district: 'Κέντρο', city: 'Πάτρα', postalCode: '26221',
      }),
    ]);
    assert.strictEqual(results[0].name, 'Γούναρη 58, Κέντρο, Πάτρα, 26221');
  });

  test('a missing house number still yields a usable street-level result', async () => {
    const { results } = await search('Γούναρη 58', [
      hereItem('Γούναρη', { label: 'Γούναρη, 262 21 Πάτρα', street: 'Γούναρη', city: 'Πάτρα', postalCode: '262 21' }),
    ]);
    assert.strictEqual(results.length, 1, 'the street is still the right answer');
  });
});

describe('geocoding resilience', () => {
  test('a hung request aborts instead of hanging forever', async () => {
    // fetch that never settles unless aborted — a dead mobile connection.
    const app = loadApp({
      fetch: (url, opts) => new Promise((_resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }
      }),
    });
    const started = Date.now();
    await assert.rejects(() => app.Router._fetch('https://example.test/x', {}, 300));
    assert.ok(Date.now() - started < 2000, 'should give up quickly, not hang');
  });

  test('geocode retries without the house number before giving up', async () => {
    const queries = [];
    const app = loadApp({
      fetch: async (url) => {
        queries.push(decodeURIComponent(url));
        // Only the house-number-less query returns a hit.
        const hit = !/58/.test(url);
        return { ok: true, json: async () => (hit ? [{ lat: '38.25', lon: '21.74' }] : []) };
      },
    });
    app.setState({ settings: settings(), coords: {} });
    const c = await app.Router.geocode('Γούναρη 58, Πάτρα');
    assert.ok(c && c.lat, 'should fall back to a street-level coordinate');
    assert.ok(queries.length >= 2, 'should have retried');
  });
});
