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

describe('resource lifecycle', () => {
  test('navigating away destroys Leaflet maps instead of leaking them', () => {
    const app = loadApp();
    let removed = 0;
    const mapEl = {
      id: 'route-map',
      _leaflet_map: { remove() { removed++; } },
      _leaflet_marker: {},
    };
    // Only the selector destroyMaps() uses should see the element, so a typo
    // in that selector fails this test rather than silently leaking.
    app.ctx.document.querySelectorAll = (sel) =>
      sel === '.screen [id$="-map"]' ? [mapEl] : [];

    app.App.destroyMaps();
    assert.equal(removed, 1, 'the map object should have been torn down');
    assert.equal(mapEl._leaflet_map, null, 'the reference should be cleared');
    assert.equal(mapEl._leaflet_marker, null);

    // Idempotent: a second navigation must not throw on an already-dead map.
    assert.doesNotThrow(() => app.App.destroyMaps());
    assert.equal(removed, 1);
  });

  test('a non-destructive confirm is not a red Delete button', () => {
    const app = loadApp();
    const classes = new Set(['btn', 'btn-danger']);
    const okBtn = {
      textContent: '',
      classList: {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
        add(n) { classes.add(n); }, remove(n) { classes.delete(n); },
        contains(n) { return classes.has(n); },
      },
    };
    app.ctx.document.getElementById = (id) =>
      id === 'confirm-ok-btn' ? okBtn : { textContent: '', classList: okBtn.classList,
        style: {}, addEventListener() {}, appendChild() {} };

    app.App.confirm('Load demo?', 'text', () => {}, 'Load', false);
    assert.equal(okBtn.textContent, 'Load');
    assert.ok(!classes.has('btn-danger'), 'loading demo data is not destructive');
    assert.ok(classes.has('btn-primary'));

    // Real deletions still get the danger treatment.
    app.App.confirm('Delete?', 'text', () => {});
    assert.ok(classes.has('btn-danger'));
    assert.ok(!classes.has('btn-primary'));
  });
});

describe('scheduling progress bar', () => {
  /** Drive the rAF loop by hand and record everything the bar was told to be. */
  let clock = 0;
  function runFrames(app, ms, stepMs = 16) {
    const widths = [], pcts = [];
    const bar = { style: {} };
    const pct = { textContent: '' };
    app.ctx.document.getElementById = (id) =>
      id === 'sched-bar' ? bar : id === 'sched-pct' ? pct
      : { style: {}, textContent: '', classList: { add(){}, remove(){}, toggle(){} } };
    for (let t = 0; t < ms; t += stepMs) {
      clock += stepMs;
      app.ctx._schedFrame(clock);
      widths.push(parseFloat(bar.style.width));
      pcts.push(pct.textContent);
    }
    return { widths, pcts };
  }

  test('the bar only ever moves forward, in small steps', () => {
    const app = loadApp();
    app.ctx.schedProgress(20, 'Phase', 'sub', '🧩');
    const { widths } = runFrames(app, 4000);
    for (let i = 1; i < widths.length; i++) {
      assert.ok(widths[i] >= widths[i - 1] - 1e-9,
        `bar went backwards at frame ${i}: ${widths[i - 1]} -> ${widths[i]}`);
      // A visible jump between adjacent frames is the stutter this replaced.
      assert.ok(widths[i] - widths[i - 1] < 2,
        `frame ${i} jumped ${widths[i] - widths[i - 1]}%`);
    }
  });

  test('a later phase reporting a lower number does not yank the bar back', () => {
    const app = loadApp();
    app.ctx.schedProgress(55, 'Phase 3', 'sub', '🔥');
    const a = runFrames(app, 8000).widths.pop();     // creep runs well past 55
    app.ctx.schedProgress(35, 'Phase 2', 'sub', '🗺️'); // an out-of-order update
    const b = runFrames(app, 200).widths[0];
    assert.ok(b >= a - 1e-9, `bar jumped back from ${a} to ${b}`);
  });

  test('the creep slows down and never reaches 100 on its own', () => {
    const app = loadApp();
    app.ctx.schedProgress(10, 'Phase', 'sub', '🧩');
    const { widths } = runFrames(app, 120000);      // two minutes of one phase
    assert.ok(widths[widths.length - 1] < 100,
      'an unfinished run must never show a full bar');
  });

  test('the percentage is whole numbers only', () => {
    const app = loadApp();
    app.ctx.schedProgress(20, 'Phase', 'sub', '🧩');
    const { pcts } = runFrames(app, 3000);
    for (const p of pcts) {
      assert.match(p, /^\d+%$/, `expected a whole percent, got "${p}"`);
    }
  });

  test('finishing goes all the way to 100 promptly', () => {
    const app = loadApp();
    app.ctx.schedProgress(20, 'Phase', 'sub', '🧩');
    runFrames(app, 1000);
    app.ctx.schedProgress(100, 'Done', 'sub', '✅');
    const { widths, pcts } = runFrames(app, 1500);
    assert.equal(pcts[pcts.length - 1], '100%');
    assert.ok(widths[widths.length - 1] > 99.8);
  });
});

describe('opening a stop in Google Maps', () => {
  function setup() {
    const app = loadApp();
    const sts = [1, 2].map(i => student('s' + i, { days: [1], lessonsPerWeek: 1 }));
    app.setState({
      students: sts,
      settings: settings({ homeAddress: 'Πλατεία Γεωργίου 1, Πάτρα' }),
      // s2 is deliberately not geocoded.
      coords: { home: { lat: 38.246, lon: 21.734 }, s1: { lat: 38.250, lon: 21.740 } },
    });
    return { app, sts };
  }

  test('a geocoded stop is handed over as coordinates, not as text', () => {
    const { app, sts } = setup();
    const url = new URL(app.App.buildGoogleStopUrl('s1', sts[0].address));
    assert.equal(url.searchParams.get('destination'), '38.25,21.74',
      'the address was already resolved here; re-resolving it elsewhere is how you end up on the wrong street');
    assert.equal(url.searchParams.get('travelmode'), 'driving');
  });

  test('a stop with no coordinate falls back to its address', () => {
    const { app, sts } = setup();
    const url = new URL(app.App.buildGoogleStopUrl('s2', sts[1].address));
    assert.equal(url.searchParams.get('destination'), sts[1].address);
  });

  test('a stop with neither coordinate nor address produces no link', () => {
    const { app } = setup();
    assert.equal(app.App.buildGoogleStopUrl('nobody', ''), null);
  });

  test('an address cannot inject parameters into the link', () => {
    const { app } = setup();
    const url = new URL(app.App.buildGoogleStopUrl('nobody', 'Οδός 1&travelmode=walking#x'));
    assert.equal(url.searchParams.get('travelmode'), 'driving', 'not overridden by the address');
    assert.equal(url.searchParams.get('destination'), 'Οδός 1&travelmode=walking#x',
      'the address survives intact as data');
  });
});

describe('toast messages', () => {
  test('a student name cannot execute in a toast', () => {
    const app = loadApp();
    // Toasts carry student names, addresses and verifier output — all typed by
    // the user — through dozens of call sites, and the toast body used to be
    // written as innerHTML. One escaping mistake in any of those call sites was
    // stored XSS; escaping in Toast.show cannot be forgotten.
    let bodyHtml = null, bodyText = null;
    const made = [];
    app.ctx.document.createElement = () => {
      const el = { className: '', style: {}, _html: '', _text: '', children: [],
        set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
        set textContent(v) { this._text = v; }, get textContent() { return this._text; },
        appendChild(c) { this.children.push(c); }, remove() {} };
      made.push(el);
      return el;
    };
    app.ctx.document.getElementById = () => ({ appendChild() {} });

    app.Toast.show(PAYLOAD, 'info');

    // The message must appear as text, never as markup.
    const asHtml = made.map(e => e.innerHTML).join('');
    const asText = made.map(e => e.textContent).join('');
    assert.ok(!asHtml.includes('onerror'), `payload reached innerHTML: ${asHtml}`);
    assert.ok(asText.includes('onerror'), 'and it should still be shown, as plain text');
  });
});
