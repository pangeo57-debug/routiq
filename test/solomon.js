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
 *  - Every time window is shortened by 15 minutes at the end, because the
 *    scheduler allows a lesson to overrun its window by that much.
 *  - Day 6 is skipped. The optimizer charges a penalty for Saturday work and
 *    treats it as off-peak traffic; neither belongs in this comparison.
 */
function toRoutePal(inst, { student, settings }, maxRoutes) {
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
  const days = [];
  for (let d = 1; days.length < maxRoutes; d++) if (d !== 6) days.push(d);

  const horizon = inst.tw[1][1];
  const dayHours = {};
  for (const d of days) dayHours[d] = { start: '00:00', end: hhmm(horizon) };
  const cfg = settings({ workDays: days, dayHours, travelMargin: 0, homeAddress: 'depot' });

  // Coordinates carry no distance here — the matrix does — but ALNS builds its
  // destroy/repair neighbourhoods from geometry, so it needs real ones.
  const KM = 111.32, LON = KM * Math.cos(38 * Math.PI / 180);
  const place = (c) => ({ lat: 38 + c.y / KM, lon: 21 + c.x / LON });

  const ids = ['home'], sts = [], coords = { home: place(inst.coord[1]) };
  for (let node = 2; node <= inst.n; node++) {
    const [ready, due] = inst.tw[node];
    const service = inst.service(node);
    const st = student('n' + node, { days, lessonsPerWeek: 1, lessonDuration: service,
      window: { start: hhmm(ready), end: hhmm(Math.max(ready + service, due + service - 15)) } });
    sts.push(st); ids.push(st.id);
    coords[st.id] = place(inst.coord[node]);
  }

  const node = (i) => (i === 0 ? 1 : i + 1);
  const durations = [], distances = [];
  for (let a = 0; a < ids.length; a++) {
    durations.push([]); distances.push([]);
    for (let b = 0; b < ids.length; b++) {
      const d = dist(inst, node(a), node(b));
      durations[a].push(d * 60);      // seconds, so minutes == distance units
      distances[a].push(d * 1000);    // metres,  so km      == distance units
    }
  }
  return { sts, cfg, coords, days, matrix: { coordIds: ids, durations, distances } };
}

/** Cost of a schedule under the benchmark's own metric, not the app's. */
function scheduleCost(inst, schedule, days) {
  let total = 0, routes = 0, overCapacity = 0;
  for (const d of days) {
    const slots = (schedule[d] || []).slice()
      .sort((a, b) => a.start.localeCompare(b.start));
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

module.exports = { parseInstance, parseSolution, toRoutePal, scheduleCost, dist, trunc1 };
