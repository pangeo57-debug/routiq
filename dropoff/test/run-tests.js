// Node vm-based test harness for dropoff.html — no browser, no build step.
// Extracts the inline <script> (skipping CDN <script src=...> tags), runs it
// in a sandboxed Node vm context with stubbed browser globals, then drives
// assertions against the app's own objects (VRP, Router, esc, I18N, App, ...)
// via further vm.runInContext calls sharing the same context/lexical scope.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'dropoff.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// Grab the last <script>...</script> block that has no src attribute (the
// app's own code, as opposed to the Leaflet CDN <script src> tag).
const scriptBlocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (scriptBlocks.length === 0) throw new Error('No inline <script> block found in dropoff.html');
const appSource = scriptBlocks[scriptBlocks.length - 1][1];

let failures = 0, passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; return; }
  failures++;
  console.error('FAIL:', msg);
}
function approxEqual(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

// ---------------- Browser-global stubs ----------------
function makeElement(id) {
  return {
    id, _value: '',
    get value() { return this._value; }, set value(v) { this._value = v; },
    textContent: '', innerHTML: '', style: {}, disabled: false, placeholder: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, force) {
        if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
        else if (force) this._set.add(c); else this._set.delete(c);
      },
      contains(c) { return this._set.has(c); },
    },
    appendChild() {}, remove() {}, addEventListener() {},
  };
}
const elementsById = new Map();
function getElementById(id) {
  if (!elementsById.has(id)) elementsById.set(id, makeElement(id));
  return elementsById.get(id);
}

class LocalStorageStub {
  constructor() { this._map = new Map(); }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
}

// Tests reassign this before each fetch-dependent scenario.
let fetchImpl = async () => { throw new Error('fetchImpl not configured for this test'); };

const sandbox = {
  console,
  localStorage: new LocalStorageStub(),
  fetch: (...args) => fetchImpl(...args),
  navigator: { serviceWorker: undefined },
  confirm: () => true,
  URL: { createObjectURL: () => 'blob://stub' },
  Blob: class { constructor() {} },
  document: {
    getElementById,
    createElement: () => makeElement('tmp'),
    documentElement: { lang: '' },
    addEventListener() {},
    querySelectorAll: () => [],
  },
  setTimeout, clearTimeout,
};
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

vm.runInContext(appSource, context, { filename: 'dropoff.html' });
function run(code) { return vm.runInContext(code, context); }
function runAsync(code) { return vm.runInContext(`(async()=>{ ${code} })()`, context); }

// ================= esc() — XSS escaping =================
assert(run(`esc('<script>alert(1)</script>')`) === '&lt;script&gt;alert(1)&lt;/script&gt;', 'esc() must escape <script> tags');
assert(run(`esc(\`"'&<>\`)`) === '&quot;&#39;&amp;&lt;&gt;', 'esc() must escape all five special characters');
assert(run(`esc(null)`) === '' && run(`esc(undefined)`) === '', 'esc() must return empty string for null/undefined');

// ================= Geo utils =================
// Athens (37.9838,23.7275) to Thessaloniki (40.6401,22.9444) is ~314km by air.
const athensToThess = run(`haversineKm({lat:37.9838,lon:23.7275},{lat:40.6401,lon:22.9444})`);
assert(athensToThess > 295 && athensToThess < 335, `haversineKm Athens-Thessaloniki should be ~314km, got ${athensToThess}`);
assert(run(`haversineKm({lat:10,lon:10},{lat:10,lon:10})`) === 0, 'haversineKm of a point to itself must be 0');

// ================= I18N =================
assert(run(`I18N.el.nav_orders`) === 'Παραγγελίες', 'Greek nav_orders translation present');
assert(run(`I18N.en.nav_orders`) === 'Orders', 'English nav_orders translation present');
run(`state.settings.language='en'`);
assert(run(`t('nav_orders')`) === 'Orders', 't() must respect state.settings.language');
run(`state.settings.language='el'`);
assert(run(`t('nav_orders')`) === 'Παραγγελίες', 't() must fall back to el when language is el');
assert(run(`tf('orders_subtitle_n',{n:5})`) === '5 ενεργές παραγγελίες', 'tf() must interpolate {n} placeholders');
assert(run(`t('__nonexistent_key__')`) === '__nonexistent_key__', 't() must fall back to the raw key when missing from all dictionaries');

// ================= VRP.twoOpt — route improves or stays equal, construction-agnostic =================
{
  const depot = { lat: 0, lon: 0 };
  // A deliberately crossed tour (depot->a->c->b->d visits the four compass
  // points out of order, crossing its own path) — 2-opt must untangle it,
  // or at minimum never make it worse.
  const a = { id: 'a', lat: 0, lon: 1 };
  const b = { id: 'b', lat: 1, lon: 0 };
  const c = { id: 'c', lat: 0, lon: -1 };
  const d = { id: 'd', lat: -1, lon: 0 };
  const crossed = [a, c, b, d];
  sandbox.__crossed = crossed; sandbox.__depot2 = depot;
  const crossedCost = run(`VRP.routeCost(__crossed, __depot2, haversineKm)`);
  const improved = run(`VRP.twoOpt(__crossed, __depot2, haversineKm)`);
  sandbox.__improved = improved;
  const improvedCost = run(`VRP.routeCost(__improved, __depot2, haversineKm)`);
  assert(improvedCost <= crossedCost + 1e-9, `2-opt must never worsen the route (before=${crossedCost}, after=${improvedCost})`);
  assert(improvedCost < crossedCost - 1e-9, `2-opt should actually untangle this deliberately-crossed tour (before=${crossedCost}, after=${improvedCost})`);
  assert(improved.length === 4, '2-opt must preserve the number of stops');
  const improvedIds = new Set(improved.map(o => o.id));
  assert(improvedIds.size === 4 && ['a', 'b', 'c', 'd'].every(id => improvedIds.has(id)), '2-opt must not drop or duplicate stops');
}

// ================= VRP.clarkeWrightSavings — Clarke & Wright (1964) construction =================
{
  const depot = { lat: 0, lon: 0 };
  // Two tight clusters far apart and on opposite sides of the depot — the
  // within-cluster savings (merging two nearby stops instead of each doing
  // its own depot round trip) should dominate any cross-cluster merge, so
  // with driverCount=2 each driver should end up covering exactly one cluster.
  const cluster1 = [
    { id: 'n1', lat: 0, lon: 1.00 },
    { id: 'n2', lat: 0, lon: 1.01 },
    { id: 'n3', lat: 0, lon: 1.02 },
  ];
  const cluster2 = [
    { id: 's1', lat: 1.00, lon: 0 },
    { id: 's2', lat: 1.01, lon: 0 },
    { id: 's3', lat: 1.02, lon: 0 },
  ];
  const orders = [...cluster1, ...cluster2];
  sandbox.__cwOrders = orders; sandbox.__cwDepot = depot;
  const groups = run(`VRP.clarkeWrightSavings(__cwOrders, 2, __cwDepot, haversineKm)`);
  assert(groups.length === 2, `clarkeWrightSavings must return exactly driverCount route arrays, got ${groups.length}`);
  const allIds = new Set(groups.flat().map(o => o.id));
  assert(allIds.size === 6 && orders.every(o => allIds.has(o.id)), 'clarkeWrightSavings must place every order exactly once');
  const clusterOf = (o) => o.id[0]; // 'n' or 's'
  const routeIsPure = groups.every(g => g.length > 0 && new Set(g.map(clusterOf)).size === 1);
  assert(routeIsPure, `clarkeWrightSavings should keep each tight cluster on its own driver (huge intra-cluster savings should dominate), got ${JSON.stringify(groups.map(g => g.map(o => o.id)))}`);

  // The whole point of Clarke-Wright: merged routes must cost less than
  // every order doing its own solo depot round trip.
  sandbox.__cwGroups = groups;
  const naiveCost = run(`__cwOrders.reduce((sum,o)=> sum + 2*haversineKm(__cwDepot,o), 0)`);
  const mergedCost = run(`__cwGroups.reduce((sum,g)=> sum + VRP.routeCost(g, __cwDepot, haversineKm), 0)`);
  assert(mergedCost < naiveCost, `merged routes (${mergedCost.toFixed(3)}) must cost less than solo round trips (${naiveCost.toFixed(3)})`);

  // Edge cases.
  const moreDrivers = run(`VRP.clarkeWrightSavings([{id:'x',lat:0,lon:1},{id:'y',lat:0,lon:2}], 5, __cwDepot, haversineKm)`);
  assert(moreDrivers.length === 5, 'clarkeWrightSavings must pad with empty routes when driverCount exceeds order count');
  assert(moreDrivers.filter(g => g.length > 0).length === 2 && moreDrivers.flat().length === 2, 'clarkeWrightSavings must not fabricate or drop stops when padding');
  const zeroDrivers = run(`VRP.clarkeWrightSavings(__cwOrders, 0, __cwDepot, haversineKm)`);
  assert(Array.isArray(zeroDrivers) && zeroDrivers.length === 0, 'clarkeWrightSavings must return [] for driverCount<=0');
}

// ================= VRP.cheapestInsertion — matches brute force =================
{
  const depot = { lat: 0, lon: 0 };
  // Route A turns a corner (depot -> x1 -> x2), so both the "before x1" and
  // "after x2 back to depot" insertions are clearly expensive detours; only a
  // point near the x1-x2 midpoint is cheap to slot in — no near-collinear
  // ambiguity with the depot leg like a straight-line route would have.
  const routeA = [{ id: 'x1', lat: 1, lon: 0 }, { id: 'x2', lat: 1, lon: 1 }];
  const routeB = [{ id: 'y1', lat: -1, lon: 0 }];
  const newPoint = { id: 'n', lat: 1.02, lon: 0.5 }; // just off the x1-x2 midpoint
  sandbox.__routes = { A: routeA, B: routeB };
  sandbox.__depot3 = depot;
  sandbox.__newPoint = newPoint;
  const best = run(`VRP.cheapestInsertion(__newPoint, __routes, __depot3, haversineKm)`);
  assert(best.driverId === 'A' && best.pos === 1, `cheapestInsertion should pick route A position 1 (between x1,x2), got ${JSON.stringify(best)}`);

  // Brute force cross-check: try every (driver,pos) combination manually.
  let bruteBest = null;
  for (const [driverId, route] of Object.entries({ A: routeA, B: routeB })) {
    for (let pos = 0; pos <= route.length; pos++) {
      const prev = pos === 0 ? depot : route[pos - 1];
      const next = pos === route.length ? depot : route[pos];
      const hav = (p, q) => {
        const R = 6371, dLat = (q.lat - p.lat) * Math.PI / 180, dLon = (q.lon - p.lon) * Math.PI / 180;
        const lat1 = p.lat * Math.PI / 180, lat2 = q.lat * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
      };
      const added = hav(prev, newPoint) + hav(newPoint, next) - hav(prev, next);
      if (!bruteBest || added < bruteBest.added) bruteBest = { driverId, pos, added };
    }
  }
  assert(bruteBest.driverId === best.driverId && bruteBest.pos === best.pos, 'cheapestInsertion must match brute-force best slot');
  assert(approxEqual(bruteBest.added, best.added, 1e-6), 'cheapestInsertion added-cost must match brute-force calculation');
}

// ================= VRP.makeMatrixDistFn — matrix lookup + haversine fallback =================
{
  const depot = { lat: 0, lon: 0 };
  const p1 = { lat: 0, lon: 1 };
  const p2 = { lat: 0, lon: 2 }; // deliberately absent from the matrix -> must fall back
  const matrix = { durations: [[0, 100], [100, 0]], distances: [[0, 5000], [5000, 0]] };
  sandbox.__mdepot = depot; sandbox.__mp1 = p1; sandbox.__mp2 = p2; sandbox.__matrix = matrix;
  const distFn = run(`VRP.makeMatrixDistFn([__mdepot, __mp1], __matrix, 22)`);
  sandbox.__distFn = distFn;
  assert(run(`__distFn(__mdepot, __mp1)`) === 100, 'makeMatrixDistFn must use the real matrix duration when both points are indexed');
  const fallback = run(`__distFn(__mdepot, __mp2)`);
  assert(fallback > 0 && Number.isFinite(fallback), 'makeMatrixDistFn must fall back to a haversine-based estimate for points missing from the matrix');
}

// ================= Storage round-trip =================
{
  run(`Storage.saveSettings({shopName:'Test Shop', depotAddress:'Οδός 1', depotCoord:{lat:1,lon:2}, hereApiKey:'', language:'el', avgCitySpeedKmh:22})`);
  const loaded = run(`Storage.loadSettings()`);
  assert(loaded.shopName === 'Test Shop', 'Storage.saveSettings/loadSettings must round-trip shopName');
  assert(loaded.depotCoord.lat === 1 && loaded.depotCoord.lon === 2, 'Storage must round-trip nested depotCoord');

  const orders = [{ id: 'o1', customerName: 'Πελάτης', address: 'Διεύθυνση', lat: 1, lon: 2, status: 'pending', notes: '', source: 'manual', createdAt: 1 }];
  sandbox.__testOrders = orders;
  run(`Storage.saveOrders(__testOrders)`);
  const loadedOrders = run(`Storage.loadOrders()`);
  assert(loadedOrders.length === 1 && loadedOrders[0].customerName === 'Πελάτης', 'Storage must round-trip orders array');
}

async function main() {
  // ================= onAddrInput suggestion rendering — no JS-string injection =================
  {
    // A Nominatim result name containing quotes/HTML must never be spliced into
    // an inline event-handler attribute string (regression test for a bug found
    // during manual browser testing: JSON.stringify(res.name) inside
    // onmousedown="..." broke on any embedded double-quote and was a JS
    // injection vector for externally-supplied geocoder data).
    const dangerousName = 'Café "Ο/Η" <b>Test</b>\', evil(); //';
    fetchImpl = async () => ({ ok: true, json: async () => ([
      { display_name: dangerousName, lat: '37.9', lon: '23.7', namedetails: {} }
    ]) });
    run(`state.settings.hereApiKey=''`);
    await runAsync(`App.onAddrInput('${dangerousName.replace(/'/g, "\\'")}', 'order-addr-suggest')`);
    await new Promise(r => setTimeout(r, 600)); // let the 500ms debounce fire
    const box = run(`document.getElementById('order-addr-suggest')`);
    assert(!box.innerHTML.includes('onmousedown="App.selectAddr('), 'suggestion HTML must not embed raw JS in an inline event-handler attribute');
    assert(box.innerHTML.includes('&lt;b&gt;Test&lt;/b&gt;') || box.innerHTML.includes('&lt;b&gt;'), 'suggestion HTML must escape embedded HTML tags in the geocoder result name');

    run(`__App_selectAddr_orig = App.selectAddr; App.selectAddr = (name)=>{ globalThis.__lastSelectedName = name; }`);
    // Simulate clicking the first (only) suggestion item via the delegated handler.
    run(`
      (function(){
        const b = document.getElementById('order-addr-suggest');
        const item = { dataset: { idx: '0' } };
        const fakeTarget = { closest: (sel) => sel === '.addr-suggest-item' ? item : null };
        b.onmousedown({ target: fakeTarget });
      })();
    `);
    const lastSelected = run(`globalThis.__lastSelectedName`);
    assert(lastSelected === dangerousName, `delegated click handler must pass through the exact, unmangled name (got ${JSON.stringify(lastSelected)})`);
    run(`App.selectAddr = __App_selectAddr_orig`);
  }

  // ================= End-to-end smoke test: full optimize flow via App =================
  await runAsync(`
    state.settings = defaultSettings();
    state.settings.depotCoord = {lat:37.98,lon:23.73};
    state.orders = [];
    state.drivers = [];
    state.routes = null;

    state.drivers.push({id:'d1', name:'Γιάννης', color: colorForIndex(0), active:true});
    state.drivers.push({id:'d2', name:'Μαρία', color: colorForIndex(1), active:true});

    for(let i=0;i<6;i++){
      const angle = (i/6)*2*Math.PI;
      state.orders.push({
        id:'o'+i, source:'manual', externalId:null,
        customerName:'Πελάτης '+i, address:'Διεύθυνση '+i, notes:'',
        lat: 37.98 + 0.03*Math.sin(angle), lon: 23.73 + 0.03*Math.cos(angle),
        status:'pending', driverId:null, createdAt: Date.now(), deliveredAt:null,
      });
    }
    // one order that will fail to geocode -> should be excluded + warned, not crash
    state.orders.push({id:'o_nogeo', source:'manual', externalId:null, customerName:'Χωρίς GPS', address:'Άγνωστη', notes:'', lat:null, lon:null, status:'pending', driverId:null, createdAt:Date.now(), deliveredAt:null});
  `);

  fetchImpl = async (url) => {
    if (String(url).includes('/table/')) {
      const n = 7; // depot + 6 geocoded orders
      const durations = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : 300 + Math.abs(i - j) * 60));
      const distances = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0 : 2000 + Math.abs(i - j) * 500));
      return { ok: true, json: async () => ({ code: 'Ok', durations, distances }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };

  await run(`App.runOptimize()`);

  {
    const routes = run(`state.routes`);
    assert(routes && Object.keys(routes).length === 2, 'runOptimize() must produce a route entry for each active driver');
    const totalStopsAssigned = Object.values(routes).reduce((s, r) => s + r.orderIds.length, 0);
    assert(totalStopsAssigned === 6, `runOptimize() must assign all 6 geocoded orders across drivers, got ${totalStopsAssigned}`);
    const stillPending = run(`state.orders.find(o=>o.id==='o_nogeo').status`);
    assert(stillPending === 'pending', 'ungeocoded orders must be excluded from optimization and stay pending');
    Object.values(routes).forEach(r => {
      assert(r.totalKm > 0 && Number.isFinite(r.totalKm), 'each route must have a positive finite totalKm');
      assert(r.totalMin > 0 && Number.isFinite(r.totalMin), 'each route must have a positive finite totalMin');
      assert(r.approx === false, 'route computed with a successful OSRM matrix must not be flagged approx');
    });
  }

  // ================= Savings dashboard (state.routeStats) =================
  {
    const stats = run(`state.routeStats`);
    assert(stats, 'runOptimize() must populate state.routeStats');
    ['naiveKm', 'actualKm', 'kmSaved', 'naiveMin', 'actualMin', 'minSaved', 'percentSaved', 'fuelSavedL', 'costSavedEur'].forEach(k => {
      assert(Number.isFinite(stats[k]), `routeStats.${k} must be a finite number, got ${JSON.stringify(stats[k])}`);
    });
    assert(stats.kmSaved >= 0, 'kmSaved must never be negative (clamped)');
    assert(stats.minSaved >= 0, 'minSaved must never be negative (clamped)');
    assert(stats.naiveKm >= stats.actualKm - 1e-9, 'naive (solo round-trip) distance must be >= the merged Clarke-Wright route distance');
    assert(stats.percentSaved > 0, 'this scenario (6 orders sharing 2 drivers from one depot) must show a real, nonzero percentage saved');
    assert(stats.fuelSavedL >= 0 && stats.costSavedEur >= 0, 'fuel/cost saved must be non-negative');

    // Recompute cost saved independently from the settings actually in effect, to
    // catch a wrong constant/formula rather than just "some positive number".
    const settings = run(`state.settings`);
    const expectedFuelSavedL = stats.kmSaved * settings.fuelConsumptionL100km / 100;
    const expectedCostSaved = expectedFuelSavedL * settings.fuelPricePerLiter;
    assert(approxEqual(stats.fuelSavedL, expectedFuelSavedL, 1e-6), `fuelSavedL must equal kmSaved * fuelConsumptionL100km/100 (expected ${expectedFuelSavedL}, got ${stats.fuelSavedL})`);
    assert(approxEqual(stats.costSavedEur, expectedCostSaved, 1e-6), `costSavedEur must equal fuelSavedL * fuelPricePerLiter (expected ${expectedCostSaved}, got ${stats.costSavedEur})`);

    // Persisted, so a page reload wouldn't lose the last savings figures.
    const persisted = run(`Storage.loadRouteStats()`);
    assert(persisted && approxEqual(persisted.kmSaved, stats.kmSaved, 1e-6), 'routeStats must be persisted via Storage.saveRouteStats/loadRouteStats');
  }

  // Rendering must not throw given the stubbed DOM.
  run(`App.renderOrders()`); run(`App.renderRoutes()`); run(`App.renderDriversScreen()`); run(`App.renderSettingsScreen()`);
  assert(true, 'render* methods must not throw against the stubbed DOM');

  // ================= Live insertion (cheapest-insertion) after an optimize run =================
  await runAsync(`
    App._pendingCoords['order-addr-suggest'] = {lat: 37.981, lon: 23.731};
    document.getElementById('order-name').value = 'Νέος Πελάτης';
    document.getElementById('order-addr').value = 'Νέα Διεύθυνση';
    document.getElementById('order-notes').value = '';
    App._editingOrderId = null;
    await App.saveOrder();
  `);
  {
    const newOrder = run(`state.orders.find(o=>o.customerName==='Νέος Πελάτης')`);
    assert(newOrder && newOrder.status === 'assigned' && newOrder.driverId, 'a new order added after optimize should be live-inserted into a driver route, not left pending');
    const routes = run(`state.routes`);
    const containingDriver = Object.entries(routes).find(([, r]) => r.orderIds.includes(newOrder.id));
    assert(containingDriver, 'the new order id must appear in exactly one driver route after live insertion');
    assert(containingDriver[1].approx === true, 'a live-inserted route must be flagged approx until the next full Optimize');
  }

  console.log(`\n${passed} passed, ${failures} failed.`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
