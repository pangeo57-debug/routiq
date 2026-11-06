'use strict';
/**
 * Solomon VRPTW instances, wired to RoutePal exactly.
 *
 * Every distance and duration comes from a matrix built from the instance's own
 * coordinates, so the scheduler measures the problem the way the benchmark
 * does — no road factor, no average-speed guess. The wiring is checked by the
 * benchmark itself before any result is reported.
 *
 * Read `test/data/README.md` for where the instances and their best-known
 * solutions come from and why edges are truncated to one decimal.
 */

const fs = require('fs');
const path = require('path');

/** Truncate to one decimal — the convention the published solutions use. */
const trunc1 = (x) => Math.floor(x * 10) / 10;

function parseInstance(name) {
  const text = fs.readFileSync(path.join(__dirname, 'data', name + '.vrp'), 'utf8');
  const meta = {}, coord = {}, demand = {}, tw = {}, svc = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[A-Z_]+ *:/.test(line)) {
      const [k, v] = line.split(':');
      meta[k.trim()] = v.trim();
      continue;
    }
    if (/_SECTION$|^DEPOT_SECTION$|^EOF$/.test(line)) { section = line; continue; }
    const p = line.split(/\s+/).map(Number);
    if (!section || p.some(Number.isNaN)) continue;
    if (section.startsWith('NODE_COORD')) coord[p[0]] = { x: p[1], y: p[2] };
    else if (section.startsWith('DEMAND')) demand[p[0]] = p[1];
    else if (section.startsWith('TIME_WINDOW')) tw[p[0]] = [p[1], p[2]];
    else if (section.startsWith('SERVICE_TIME')) svc[p[0]] = p[1];
  }
  const n = Object.keys(coord).length;
  return { name, meta, coord, demand, tw, svc, n,
    capacity: Number(meta.CAPACITY),
    service: (id) => (svc[id] != null ? svc[id] : Number(meta.SERVICE_TIME) || 0) };
}

/** The published best-known solution: its routes and its cost. */
function parseSolution(name) {
  const text = fs.readFileSync(path.join(__dirname, 'data', name + '.sol'), 'utf8');
  const routes = [], costLine = text.match(/^Cost\s+([\d.]+)/m);
  for (const line of text.split('\n')) {
    if (line.startsWith('Route')) routes.push(line.split(':')[1].trim().split(/\s+/).map(Number));
  }
  return { routes, cost: costLine ? Number(costLine[1]) : null };
}

const dist = (inst, a, b) =>
  trunc1(Math.hypot(inst.coord[a].x - inst.coord[b].x, inst.coord[a].y - inst.coord[b].y));

/**
 * Turn an instance into students, settings, coordinates and a travel matrix.
 *
 * Two deliberate choices, both making the problem HARDER for us than the
 * benchmark requires, so that no result can be an artefact of a loophole:
 *
 *  - Every time window is shortened by the scheduler's end-of-day tolerance,
 *    so a lesson cannot buy itself room the benchmark does not allow. That
 *    tolerance used to be a hard-coded 15 minutes here as well as in the app;
 *    it is now a setting that defaults to zero, and copying the old number
 *    into this file would have gone on shortening every window for an overrun
 *    that no longer happens.
 *  - Day 6 is skipped. The optimizer charges a penalty for Saturday work and
 *    treats it as off-peak traffic; neither belongs in this comparison.
 */
// timeScale: app minutes per instance time unit. The app keeps time in whole
// minutes and the instance's travel times have one decimal, so at 1 a lesson
// can look reachable that is 0.1-0.6 units late. At 10 every time is a whole
// number of minutes: nothing is rounded.
//
// depot: model the two depot legs the app has no notion of. The vehicle leaves
// the depot at 0, so a customer cannot be started before it is reachable
// (ready' = max(ready, d(depot, c))); and it must be back by the depot's due
// time, so a customer cannot be started after due' = min(due, depotDue -
// service - d(c, depot)). Both are exact: by the triangle inequality any
// route that obeys the instance obeys these windows and vice versa, so the
// windows narrow nothing the benchmark allows and admit nothing it forbids.
function toRoutePal(inst, { student, settings }, maxRoutes, timeScale = 1, { depot = false } = {}) {
  const K = timeScale;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
  const days = [];
  for (let d = 1; days.length < maxRoutes; d++) if (d !== 6) days.push(d);

  const horizon = inst.tw[1][1] * K;
  const dayHours = {};
  for (const d of days) dayHours[d] = { start: '00:00', end: hhmm(horizon) };
  const cfg = settings({ workDays: days, dayHours, travelMargin: 0, homeAddress: 'depot' });
  const flex = Number(cfg.endFlexMin) || 0;

  // Coordinates carry no distance here — the matrix does — but ALNS builds its
  // destroy/repair neighbourhoods from geometry, so it needs real ones.
  const KM = 111.32, LON = KM * Math.cos(38 * Math.PI / 180);
  const place = (c) => ({ lat: 38 + c.y / KM, lon: 21 + c.x / LON });

  const ids = ['home'], sts = [], coords = { home: place(inst.coord[1]) };
  for (let node = 2; node <= inst.n; node++) {
    let [ready, due] = inst.tw[node];
    if (depot) {
      ready = Math.max(ready, dist(inst, 1, node));
      due = Math.min(due, inst.tw[1][1] - inst.service(node) - dist(inst, node, 1));
      if (due < ready) throw new Error(`${inst.name}: customer ${node} cannot be served at all`);
    }
    // Every time in an instance has at most one decimal, so at K = 10 these
    // are whole minutes. Anything else would be rounded, and say so.
    ready = Math.round(ready * K * 1e6) / 1e6; due = Math.round(due * K * 1e6) / 1e6;
    if (K === 10 && (!Number.isInteger(ready) || !Number.isInteger(due)))
      throw new Error(`${inst.name}: customer ${node} window is not whole minutes at x10`);
    const service = inst.service(node) * K;
    const st = student('n' + node, { days, lessonsPerWeek: 1, lessonDuration: service,
      window: { start: hhmm(ready), end: hhmm(Math.max(ready + service, due + service - flex)) } });
    sts.push(st); ids.push(st.id);
    coords[st.id] = place(inst.coord[node]);
  }

  const node = (i) => (i === 0 ? 1 : i + 1);
  const durations = [], distances = [];
  for (let a = 0; a < ids.length; a++) {
    durations.push([]); distances.push([]);
    for (let b = 0; b < ids.length; b++) {
      const d = dist(inst, node(a), node(b));
      durations[a].push(Math.round(d * 60 * K));      // seconds; minutes == distance units × K
      distances[a].push(d * 1000);    // metres,  so km      == distance units
    }
  }
  return { sts, cfg, coords, days, matrix: { coordIds: ids, durations, distances } };
}

/**
 * Check routes against the instance alone — nothing from the app. Each route
 * is a list of customer node ids in visit order. The vehicle leaves the depot
 * at 0, travel time equals distance, service starts at max(arrival, ready)
 * and must not be after due, and the vehicle must be back by the depot's due
 * time with a load within capacity. Every customer exactly once.
 *
 * mode 'trunc1' uses edges truncated to one decimal for both distance and
 * time, the convention of the exact methods and of the best-known costs in
 * test/data/*.sol. 'exact' uses full-precision Euclidean distances, the
 * convention of most heuristic papers; it is reported for information.
 */
function verifyRoutes(inst, routes, mode = 'trunc1') {
  const d = (a, b) => {
    const e = Math.hypot(inst.coord[a].x - inst.coord[b].x, inst.coord[a].y - inst.coord[b].y);
    return mode === 'exact' ? e : trunc1(e);
  };
  const EPS = 1e-9, errors = [], seen = new Set();
  let distance = 0, overCapacity = 0, late = 0;
  routes.forEach((r, k) => {
    let t = 0, prev = 1, load = 0;
    for (const c of r) {
      if (seen.has(c)) errors.push(`route ${k + 1}: customer ${c} twice`);
      seen.add(c);
      const start = Math.max(t + d(prev, c), inst.tw[c][0]);
      if (start > inst.tw[c][1] + EPS) { late++; errors.push(`route ${k + 1}: customer ${c} starts ${start.toFixed(2)} > due ${inst.tw[c][1]}`); }
      distance += d(prev, c); load += inst.demand[c] || 0;
      t = start + inst.service(c); prev = c;
    }
    const back = t + d(prev, 1);
    distance += d(prev, 1);
    if (back > inst.tw[1][1] + EPS) { late++; errors.push(`route ${k + 1}: back at depot ${back.toFixed(2)} > ${inst.tw[1][1]}`); }
    if (load > inst.capacity) { overCapacity++; errors.push(`route ${k + 1}: load ${load} > capacity ${inst.capacity}`); }
  });
  let missing = 0;
  for (let i = 2; i <= inst.n; i++) if (!seen.has(i)) { missing++; errors.push(`customer ${i} not served`); }
  return { valid: errors.length === 0, distance, routes: routes.filter(r => r.length).length,
    late, overCapacity, missing, errors };
}

/** Cost of a schedule under the benchmark's own metric, not the app's. */
function scheduleCost(inst, schedule, days) {
  let total = 0, routes = 0, overCapacity = 0;
  for (const d of days) {
    const slots = (schedule[d] || []).slice()
      .sort((a, b) => ((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; })(a.start) - ((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; })(b.start));
    if (!slots.length) continue;
    routes++;
    let prev = 1, load = 0;
    for (const s of slots) {
      const node = Number(s.studentId.slice(1));
      total += dist(inst, prev, node);
      load += inst.demand[node] || 0;
      prev = node;
    }
    total += dist(inst, prev, 1);
    if (load > inst.capacity) overCapacity++;
  }
  return { cost: total, routes, overCapacity };
}

module.exports = { parseInstance, parseSolution, toRoutePal, scheduleCost, verifyRoutes, dist, trunc1 };
