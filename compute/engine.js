'use strict';
/**
 * The app's own scheduler, loaded out of routiq.html into a sandbox.
 *
 * Not a copy and not a port: the very file the phone runs, so a week computed
 * here is the week the phone would have computed. The page's DOM is stubbed;
 * nothing in the scheduler needs it.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const APP_FILE = process.env.ROUTIQ_APP_FILE
  ? path.resolve(process.env.ROUTIQ_APP_FILE)
  : path.join(__dirname, '..', 'routiq.html');

function extractScript(file) {
  const out = [];
  let inScript = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!inScript && /<script>/.test(line)) { inScript = true; continue; }
    if (inScript && /<\/script>/.test(line)) { inScript = false; continue; }
    if (inScript) out.push(line);
  }
  return out.join('\n');
}

function stubEl() {
  return {
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', disabled: false, checked: false,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {},
    querySelector() { return stubEl(); }, querySelectorAll() { return []; },
    closest() { return null; }, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
}

function load(file = APP_FILE, seed = null) {
  const storage = Object.create(null);
  let rs = seed == null ? null : ((seed * 2654435761) >>> 0) || 1;
  const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    Date, Math, JSON, Object, Array, Map, Set, Promise, Number, String, Boolean,
    RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    Int32Array, Float64Array, Uint8Array, TextEncoder, TextDecoder,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    document: { getElementById: () => stubEl(), querySelector: () => null, querySelectorAll: () => [],
      createElement: () => stubEl(), addEventListener() {}, body: stubEl(), head: stubEl(),
      documentElement: { dataset: {}, style: {} }, hidden: false },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
      location: { href: 'https://compute.local/', reload() {} }, innerWidth: 390, innerHeight: 844 },
    navigator: { userAgent: 'compute', serviceWorker: undefined, hardwareConcurrency: 1 },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }, clear() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    crypto: require('node:crypto').webcrypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Notification: undefined, URL, URLSearchParams, Blob: function Blob() {}, L: undefined,
  };
  if (seed != null) ctx.Math = Object.create(Math, { random: { value: rnd, writable: true, configurable: true } });
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractScript(file) + '\n;this.__exports = { Scheduler, state };', ctx, { filename: 'routiq.html' });
  return ctx.__exports;
}

/** One run: optimizeWeek, from a fresh start or from `warm` (round 2). */
async function run(job, { warm = null, seed = 1, onProgress, stopped } = {}) {
  // Different runs must start differently, as the phone's workers do.
  const { Scheduler, state } = load(APP_FILE, seed);
  Object.assign(state, {
    settings: job.input.settings, coords: job.input.coords, students: job.input.students,
    schedule: {}, jobs: [],
    travelMatrixPeak: job.matrix.peak, travelMatrixOffPeak: job.matrix.off || null, travelMatrix: null,
    dayMatrixPeak: null, dayMatrixOffPeak: null,
  });
  const input = { ...job.input, warm: warm || job.input.warm || null, skipPhase1: !!warm,
    timeScale: Number(process.env.COMPUTE_TIME_SCALE) || undefined };
  const out = await Scheduler.optimizeWeek(input, { progress: onProgress || (() => {}), stopped: stopped || (() => false) });
  return { schedule: out.schedule, students: out.students, result: out.result };
}

/** The app's rule for which of two weeks is better. */
function betterFn(settings) {
  const { Scheduler } = load();
  return (a, b) => Scheduler.isBetterStart(a, b, settings);
}

module.exports = { load, run, betterFn, extractScript };
