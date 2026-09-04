'use strict';
/**
 * Test harness for RoutePal.
 *
 * The whole app is one HTML file with an inline <script>, so tests load that
 * script into a Node `vm` sandbox with just enough browser stubbed out to let
 * it evaluate. This deliberately runs the REAL code from routiq.html rather
 * than a copy — if the file changes, the tests see the change.
 *
 * Two things about the app shape that tests must respect:
 *  - Many Scheduler methods read the module-level `state` (state.coords,
 *    state.settings) rather than taking it as an argument. Use setState() to
 *    mutate that same object; replacing it would not be visible to them.
 *  - Every load gets its OWN sandbox, so tests can't leak state into each
 *    other.
 */

const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Overridable so an experiment can load two builds side by side and compare
// them on identical inputs.
const APP_FILE = process.env.ROUTIQ_APP_FILE
  ? path.resolve(process.env.ROUTIQ_APP_FILE)
  : path.join(__dirname, '..', 'routiq.html');

function extractScript() {
  const html = fs.readFileSync(APP_FILE, 'utf8');
  const lines = html.split('\n');
  const out = [];
  let inScript = false;
  for (const line of lines) {
    if (!inScript && /<script>/.test(line)) { inScript = true; continue; }
    if (inScript && /<\/script>/.test(line)) { inScript = false; continue; }
    if (inScript) out.push(line);
  }
  return out.join('\n');
}

/** A DOM element stub permissive enough that render/UI code doesn't throw. */
function stubEl() {
  const el = {
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    disabled: false, checked: false,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {},
    querySelector() { return stubEl(); }, querySelectorAll() { return []; },
    closest() { return null; }, getBoundingClientRect() { return { top:0,left:0,width:0,height:0 }; },
  };
  return el;
}

/**
 * Load a fresh instance of the app.
 * @param {object} opts
 * @param {Function} [opts.fetch] - fetch stub; defaults to always-failing.
 * @returns {{Scheduler, App, Router, Storage, state, storage, setState, ctx}}
 */
function loadApp(opts = {}) {
  const storage = Object.create(null);

  // A seeded Math.random makes a run reproducible, so two builds can be
  // compared on the same starting schedule instead of on different draws.
  // Without this, runMultiAttempt's shuffles dominate any measurement.
  let rngState = opts.seed == null ? null : (opts.seed >>> 0) || 1;
  const seededRandom = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  const ctx = {
    console: opts.quiet === false ? console : { log(){}, warn(){}, error(){}, info(){} },
    Date, Math, JSON, Object, Array, Map, Set, Promise, Number, String, Boolean,
    RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    // The progress bar runs on rAF; browsers have it, so the sandbox must too.
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: {
      getElementById: () => stubEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => stubEl(),
      addEventListener() {},
      body: stubEl(),
      documentElement: { dataset: {}, style: {} },
      head: stubEl(),
    },
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      location: { href: 'https://example.test/', reload() {} },
      innerWidth: 390, innerHeight: 844,
    },
    navigator: { userAgent: 'test', serviceWorker: undefined },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
      clear: () => { for (const k in storage) delete storage[k]; },
    },
    fetch: opts.fetch || (async () => ({ ok: false, json: async () => ({}) })),
    Notification: undefined,
    // Real URL/URLSearchParams — the app builds navigation deep links with
    // them, and a stub would let a broken link pass. The object-URL helpers
    // ride along as statics, the way they do in a browser.
    URL: Object.assign(
      class extends URL {},
      { createObjectURL: () => 'blob:test', revokeObjectURL() {} }),
    URLSearchParams,
    Blob: function Blob(parts) { this.parts = parts; },
    L: undefined, // Leaflet absent — map init paths no-op
  };
  // After the defaults above, or the plain `Math` would overwrite the override.
  if(opts.seed != null){
    ctx.Math = Object.create(Math, {
      random: { value: seededRandom, writable: true, configurable: true } });
  }
  ctx.globalThis = ctx;
  ctx.self = ctx;

  vm.createContext(ctx);
  // Top-level `const` declarations in a vm script are NOT reachable as context
  // properties, so anything a test needs must be named explicitly here.
  const src = extractScript() +
    '\n;this.__exports = {Scheduler, App, Router, Storage, state, defaultSettings,' +
    ' I18N, PROFESSION_VALUES, SUBJECTS, COLORS, DAYS, DAYS_FULL, esc, t, tf, curLang,' +
    ' normalizeSearchText, getProfessions, getLabels, subjectLabel, getHereKey,' +
    ' schedProgress, _schedFrame, Toast};';
  vm.runInContext(src, ctx, { filename: 'routiq.html' });

  const ex = ctx.__exports;

  // Silence UI side effects that tests don't care about but code paths call.
  // opts.realRender keeps them, so a test can catch errors that only happen
  // while actually drawing a screen.
  if(!opts.realRender){
  ex.App.renderHome = () => {};
  ex.App.renderStudents = () => {};
  ex.App.renderSchedule = () => {};
  ex.App.renderSettings = () => {};
  ex.App.renderRoute = () => {};
  ex.App.renderDaySlots = () => {};
  ex.App.nav = () => {};
  ex.App.initStudentsMap = () => {};
  ex.App.initRouteMap = () => {};
  }

  return {
    ...ex,
    storage,
    ctx,
    /** Mutate the app's own `state` object in place (see file header). */
    setState(patch) { Object.assign(ex.state, patch); return ex.state; },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A student with sane defaults; override anything via `ov`. */
function student(id, ov = {}) {
  const days = ov.days || [1, 2, 3, 4, 5];
  const win = ov.window || { start: '15:00', end: '22:00' };
  const availability = {};
  for (const d of days) availability[d] = { on: true, start: win.start, end: win.end };
  delete ov.days; delete ov.window;
  return Object.assign({
    id, name: id, address: 'addr-' + id, subject: 'Μαθηματικά',
    lessonDuration: 60, lessonsPerWeek: 1, type: 'solo', group: '',
    pairedWith: null, notes: '', mergeMode: 'off', forceMerge: false,
    color: 0, availability, availabilityMode: 'exceptions', availabilityExceptions: [],
  }, ov);
}

function settings(ov = {}) {
  const workDays = ov.workDays || [1, 2, 3, 4, 5];
  const dayHours = {};
  for (const d of workDays) dayHours[d] = { start: '15:00', end: '22:00' };
  return Object.assign({
    workDays, dayHours, blockedSlots: [], travelMargin: 2,
    avgCitySpeedKmh: 25, homeAddress: 'Πλατεία Γεωργίου 1, Πάτρα',
    fuelConsumption: 7, language: 'el', profession: 'tutor',
  }, ov, ov.dayHours ? { dayHours: ov.dayHours } : {});
}

/** Coordinates spread over a realistic ~8km city, deterministic per index. */
function cityCoords(students, home = { lat: 38.2466, lon: 21.7346 }) {
  const coords = { home };
  students.forEach((s, i) => {
    coords[s.id] = {
      lat: 38.215 + ((i * 13) % 40) / 1000 * 1.6,
      lon: 21.705 + ((i * 29) % 40) / 1000 * 1.6,
    };
  });
  return coords;
}

/** A slot in the app's schedule format. */
function slot(studentId, start, end, ov = {}) {
  return Object.assign({
    studentId, studentName: studentId, subject: 'Μαθηματικά',
    address: 'addr-' + studentId, color: 0, start, end,
    duration: 60, mergedCount: 1, merged: false,
  }, ov);
}

module.exports = { loadApp, student, settings, cityCoords, slot, APP_FILE };
