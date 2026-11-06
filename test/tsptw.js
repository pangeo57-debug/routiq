'use strict';
/**
 * TSPTW instances of Dumas et al. (1995), wired to RoutePal's day planner.
 *
 * One vehicle leaves the depot (node 0) at time 0, visits every customer once
 * inside its time window, and is back at the depot by the depot's due time.
 * Travel time equals cost, waiting is allowed and free, and the objective is
 * the total travel time. The matrix is integer and already includes the
 * service time at the node a leg starts from — the convention of these files.
 *
 * Read `test/data/tsptw/README.md` for where the files come from.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data', 'tsptw');

function parseInstance(name) {
  const nums = fs.readFileSync(path.join(DIR, name + '.txt'), 'utf8').trim().split(/\s+/).map(Number);
  const n = nums[0];
  const t = [], tw = [];
  let k = 1;
  for (let i = 0; i < n; i++) t.push(nums.slice(k, k += n));
  for (let i = 0; i < n; i++) tw.push([nums[k++], nums[k++]]);
  if (k !== nums.length || nums.some(Number.isNaN)) throw new Error(`${name}: unexpected file layout`);
  return { name, n, t, tw };
}

function parseSolution(name) {
  const text = fs.readFileSync(path.join(DIR, name + '.sol'), 'utf8');
  const [first, costLine] = text.trim().split('\n');
  return { tour: first.trim().split(/\s+/).map(Number), cost: Number(costLine.match(/Cost\s+([\d.]+)/)[1]) };
}

/**
 * Check a tour against the instance alone — nothing from the app.
 * `tour` is the customers in visit order, depot excluded.
 */
function verifyTour(inst, tour) {
  const errors = [], seen = new Set();
  let time = inst.tw[0][0], cost = 0, prev = 0, late = 0;
  for (const c of tour) {
    if (!(c >= 1 && c < inst.n)) { errors.push(`node ${c} is not a customer`); continue; }
    if (seen.has(c)) errors.push(`customer ${c} twice`);
    seen.add(c);
    const start = Math.max(time + inst.t[prev][c], inst.tw[c][0]);
    if (start > inst.tw[c][1]) { late++; errors.push(`customer ${c} starts ${start} > due ${inst.tw[c][1]}`); }
    cost += inst.t[prev][c];
    time = start; prev = c;
  }
  const back = time + inst.t[prev][0];
  cost += inst.t[prev][0];
  if (back > inst.tw[0][1]) { late++; errors.push(`back at depot ${back} > ${inst.tw[0][1]}`); }
  let missing = 0;
  for (let c = 1; c < inst.n; c++) if (!seen.has(c)) { missing++; errors.push(`customer ${c} not visited`); }
  return { valid: errors.length === 0, cost, late, missing, errors };
}

/** Triples (i, j, k) with t[i][k] > t[i][j] + t[j][k]. */
function triangleViolations(inst) {
  let bad = 0;
  for (let i = 0; i < inst.n; i++) for (let j = 0; j < inst.n; j++) for (let k = 0; k < inst.n; k++)
    if (i !== j && j !== k && i !== k && inst.t[i][k] > inst.t[i][j] + inst.t[j][k]) bad++;
  return bad;
}

/**
 * Positions for the matrix, by classical multidimensional scaling. The day
 * planner takes its distances and times from the matrix; positions only
 * steer which stops its destroy/repair moves treat as neighbours, and it
 * will not plan a stop without one.
 */
function embed(inst) {
  const n = inst.n;
  const D2 = inst.t.map((r, i) => r.map((_, j) => ((inst.t[i][j] + inst.t[j][i]) / 2) ** 2));
  const rowMean = D2.map(r => r.reduce((a, b) => a + b, 0) / n);
  const all = rowMean.reduce((a, b) => a + b, 0) / n;
  const B = D2.map((r, i) => r.map((v, j) => -0.5 * (v - rowMean[i] - rowMean[j] + all)));
  const vecs = [];
  for (let e = 0; e < 2; e++) {
    let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1 + e));
    let lambda = 0;
    for (let it = 0; it < 300; it++) {
      let w = B.map(r => r.reduce((a, b, j) => a + b * v[j], 0));
      for (const [u, l] of vecs) { const p = w.reduce((a, b, j) => a + b * u[j], 0); w = w.map((x, j) => x - p * u[j]); void l; }
      const norm = Math.hypot(...w) || 1;
      lambda = norm; v = w.map(x => x / norm);
    }
    vecs.push([v, lambda]);
  }
  return Array.from({ length: n }, (_, i) => ({
    x: vecs[0][0][i] * Math.sqrt(vecs[0][1]), y: vecs[1][0][i] * Math.sqrt(vecs[1][1]) }));
}

/**
 * The instance as one date of jobs for Scheduler.planDay.
 *
 * Times are x10, so a leg of t units is 10t whole minutes. The matrix already
 * holds each stop's service time inside the leg that leaves it; the app needs
 * a job to last at least a minute, so every job lasts 1 minute and every leg
 * that leaves a customer is 1 minute shorter. Start-to-start times are then
 * exactly the instance's: nothing is rounded, nothing added or removed —
 * except on a leg of length 0, see zeroLegs below.
 *
 * The app treats the first stop of a day as reached at its window's opening
 * (the drive from home is the person's to leave early for), and has no notion
 * of a latest time back home. Both depot legs are therefore written into each
 * customer's window: it cannot start before it is reachable from the depot at
 * time 0, nor so late that the depot's due time cannot be met. With the
 * triangle inequality these bounds are exact; the benchmark reports when an
 * instance lacks it, because the bounds could then cut off valid tours (never
 * admit invalid ones — the independent check sees to that).
 */
const K = 10;
const SERVICE = 1;
function toDay(inst, { settings }) {
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  // A leg of 0 (two customers at one place) cannot give up the job's minute,
  // and the app counts any drive between two stops as at least 1 minute
  // anyway; such a leg costs 0.2 units here. Counted, so it is reported.
  let zeroLegs = 0;
  for (let i = 1; i < inst.n; i++) for (let j = 0; j < inst.n; j++)
    if (i !== j && inst.t[i][j] === 0) zeroLegs++;

  const date = '2026-09-28';                 // a Monday
  const day = 1;
  const depotDue = inst.tw[0][1];
  const cfg = settings({ workDays: [day], travelMargin: 0, homeAddress: 'depot',
    dayHours: { [day]: { start: hhmm(inst.tw[0][0] * K), end: hhmm(depotDue * K) } } });

  const pts = embed(inst);
  const KM = 111.32, LON = KM * Math.cos(38 * Math.PI / 180);
  const place = (p) => ({ lat: 38 + p.y / KM, lon: 21 + p.x / LON });

  const ids = ['home'], jobs = [], coords = { home: place(pts[0]) };
  for (let c = 1; c < inst.n; c++) {
    const ready = Math.max(inst.tw[c][0], inst.tw[0][0] + inst.t[0][c]);
    const due = Math.min(inst.tw[c][1], depotDue - inst.t[c][0]);
    if (due < ready) throw new Error(`${inst.name}: customer ${c} cannot be visited at all`);
    const id = 'c' + c;
    jobs.push({ id, name: id, address: '', durationMin: SERVICE, date,
      window: { start: hhmm(ready * K), end: hhmm(due * K + SERVICE) } });
    ids.push(id);
    coords[id] = place(pts[c]);
  }
  const durations = [], distances = [];
  for (let a = 0; a < inst.n; a++) {
    durations.push([]); distances.push([]);
    for (let b = 0; b < inst.n; b++) {
      const min = a === b ? 0 : Math.max(0, inst.t[a][b] * K - (a === 0 ? 0 : SERVICE));
      durations[a].push(min * 60);                 // seconds
      distances[a].push(inst.t[a][b] * 1000);       // metres, so km == cost units
    }
  }
  return { jobs, cfg, coords, date, day, zeroLegs, matrix: { coordIds: ids, durations, distances } };
}

/** Does the given tour also fit the windows toDay wrote? (It must, or toDay cut it off.) */
function fitsDayWindows(inst, tour) {
  let time = inst.tw[0][0], prev = 0;
  for (const c of tour) {
    const ready = Math.max(inst.tw[c][0], inst.tw[0][0] + inst.t[0][c]);
    const due = Math.min(inst.tw[c][1], inst.tw[0][1] - inst.t[c][0]);
    const start = prev === 0 ? ready : Math.max(time + inst.t[prev][c], ready);
    if (start > due) return false;
    time = start; prev = c;
  }
  return true;
}

module.exports = { parseInstance, parseSolution, verifyTour, triangleViolations, toDay, fitsDayWindows, K };
