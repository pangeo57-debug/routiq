'use strict';
/**
 * RoutePal compute server — the week computed off the phone.
 *
 * A phone freezes a page the moment the person leaves it, and a week takes
 * minutes. Here the computation goes on whatever the phone does, and a push
 * notification says when it is ready.
 *
 * What arrives is anonymous by construction (the app builds it, see Remote in
 * routiq.html): codes instead of people, availability, durations, and a
 * travel matrix. No names, addresses, phone numbers, notes or coordinates.
 * Jobs live in memory only, and are forgotten RESULT_TTL_MS after they finish.
 *
 *   POST   /jobs        { input, matrix, push?, notify? }  -> { id }
 *   GET    /jobs/:id    -> { status, progress, result? }
 *   DELETE /jobs/:id    -> stops it
 *   POST   /reminders   { push, items: [{ t, k }] }   -> replaces this phone's reminders
 *   GET    /health
 */
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');

const CONF = {
  port: Number(process.env.PORT) || 8790,
  origins: (process.env.ALLOWED_ORIGINS || 'https://pangeo57-debug.github.io,http://localhost:8080').split(',').map(s => s.trim()),
  runs: Math.max(1, Math.min(Number(process.env.RUNS) || os.cpus().length, 4)),
  concurrent: Math.max(1, Number(process.env.CONCURRENT_JOBS) || 1),
  queueMax: Number(process.env.QUEUE_MAX) || 30,
  perIpHour: Number(process.env.JOBS_PER_IP_HOUR) || 12,
  bodyMax: 4 * 1024 * 1024,
  resultTtlMs: 24 * 3600 * 1000,
  jobMaxMs: 20 * 60 * 1000,
};

let webpush = null;
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.invalid', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  } catch (e) { webpush = null; console.warn('web-push unavailable: no notifications'); }
}

const jobs = new Map();      // id -> job
const queue = [];
let running = 0;
const ipLog = new Map();     // ip -> [timestamps]

// ---- validation: the shape of an anonymous job, and nothing personal in it --
const ID = /^§s\d{1,4}$/;
const FORBIDDEN = ['name', 'address', 'phone', 'notes', 'email', 'homeAddress', 'hereApiKey', 'teacherName'];
function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const { input, matrix } = body;
  if (!input || !Array.isArray(input.students) || !input.settings) return 'input.students and input.settings required';
  if (input.students.length === 0 || input.students.length > 300) return 'between 1 and 300 clients';
  for (const s of input.students) {
    if (!s || !ID.test(String(s.id))) return 'client ids must be anonymous codes';
    for (const f of FORBIDDEN) if (s[f] && !(f === 'address' && /^§p\d{1,4}$/.test(s[f]))) return `client field "${f}" is not accepted`;
  }
  for (const f of FORBIDDEN) if (input.settings[f]) return `setting "${f}" is not accepted`;
  if (!matrix || !matrix.peak || !Array.isArray(matrix.peak.coordIds) || !Array.isArray(matrix.peak.durations))
    return 'matrix.peak required';
  const n = matrix.peak.coordIds.length;
  if (n !== input.students.length + 1 || matrix.peak.coordIds[0] !== 'home') return 'matrix must be home + every client';
  for (const m of [matrix.peak, matrix.off].filter(Boolean)) {
    if (m.durations.length !== n || m.durations.some(r => !Array.isArray(r) || r.length !== n || r.some(v => !Number.isFinite(v))))
      return 'matrix rows must be numbers';
  }
  return null;
}

// ---- running a job: k runs at once, then k more from the best (as the app) --
function thread(job, warm, seed, progress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'runner.js'), { workerData: { job: { input: job.input, matrix: job.matrix }, warm, seed, progress } });
    job.threads.add(w);
    let settled = false;
    const end = (fn, v) => { if (settled) return; settled = true; job.threads.delete(w); fn(v); };
    w.on('message', (m) => {
      if (m.progress) { job.progress = m.progress; return; }
      w.terminate();
      m.ok ? end(resolve, m.out) : end(reject, new Error(m.error));
    });
    w.on('error', (e) => end(reject, e));
    // A thread that ends without an answer was stopped, whatever its exit
    // code (terminate() reports 0 on some Node versions).
    w.on('exit', () => end(reject, new Error('stopped')));
  });
}

async function execute(job) {
  const { betterFn } = require('./engine');
  const better = betterFn(job.input.settings);
  const pick = (outs) => {
    const good = outs.filter(o => o && !(o instanceof Error) && o.schedule);
    if (!good.length) throw outs.find(o => o instanceof Error) || new Error('no result');
    return good.reduce((b, o) => (better(o.schedule, b.schedule) ? o : b));
  };
  const round = (warm, base) => Promise.all(Array.from({ length: CONF.runs }, (_, i) =>
    thread(job, warm, base + i, i === 0).catch(e => e)));
  const first = pick(await round(null, 1));
  if (job.cancelled) throw new Error('cancelled');
  let best = first;
  try {
    const second = pick(await round(first.schedule, 101));
    if (better(second.schedule, first.schedule)) best = { ...second, result: first.result };
  } catch (e) { if (job.cancelled) throw new Error('cancelled'); }
  return best;
}

function pump() {
  while (running < CONF.concurrent && queue.length) {
    const job = queue.shift();
    if (job.cancelled) continue;
    running++;
    job.status = 'running'; job.startedAt = Date.now();
    const timer = setTimeout(() => { job.cancelled = true; for (const w of job.threads) w.terminate(); }, CONF.jobMaxMs);
    execute(job)
      .then(out => { job.status = 'done'; job.result = out; notify(job); })
      .catch(e => { job.status = job.cancelled ? 'cancelled' : 'failed'; job.error = String(e && e.message || e); })
      .finally(() => {
        clearTimeout(timer); running--; job.finishedAt = Date.now();
        job.push = null;                               // the subscription is not kept once used
        setTimeout(() => jobs.delete(job.id), CONF.resultTtlMs).unref();
        pump();
      });
  }
}

async function notify(job) {
  if (!webpush || !job.push) return;
  const n = job.notify || {};
  try {
    await webpush.sendNotification(job.push, JSON.stringify({
      title: String(n.title || 'RoutePal').slice(0, 80), body: String(n.body || '').slice(0, 160), tag: 'plan-' + job.id, job: job.id }));
  } catch (e) { /* an expired subscription is not an error worth more than this */ }
}

// ---- reminders: "in 15 minutes", with the app closed --------------------------
// Only times and opaque keys arrive; what each reminder says is on the phone.
// One set per push subscription, replaced whenever the phone sends a new one.
// In memory: a restart forgets them until the app next opens.
const reminders = new Map();   // endpoint hash -> [timeouts]
const KEY = /^[0-9a-f]{8,48}$/;
function setReminders(body, now) {
  const push = body && body.push;
  if (!push || typeof push.endpoint !== 'string' || !/^https:\/\//.test(push.endpoint)) return 'push subscription required';
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length > 60) return 'items: at most 60';
  for (const it of items) {
    if (!it || !Number.isFinite(it.t) || it.t < now - 60000 || it.t > now + 26 * 3600 * 1000) return 'times must be within the next day';
    if (!KEY.test(String(it.k))) return 'bad key';
  }
  const id = crypto.createHash('sha256').update(push.endpoint).digest('hex');
  for (const tm of reminders.get(id) || []) clearTimeout(tm);
  const title = String((body.fallback && body.fallback.title) || 'RoutePal').slice(0, 60);
  const timers = items.map(it => {
    const tm = setTimeout(() => {
      if (webpush) webpush.sendNotification(push, JSON.stringify({ kind: 'reminder', k: it.k, title })).catch(() => {});
      sent.push({ id, k: it.k, at: Date.now() }); if (sent.length > 100) sent.shift();
    }, Math.max(0, it.t - now));
    tm.unref();
    return tm;
  });
  if (timers.length) reminders.set(id, timers); else reminders.delete(id);
  return null;
}
const sent = [];               // the last few sent, for the tests

// ---- http --------------------------------------------------------------------
function cors(req) {
  const o = req.headers.origin || '';
  const ok = CONF.origins.includes(o);
  return { ok, headers: ok ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : {} };
}
function send(res, status, body, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
function allowIp(ip, now) {
  const log = (ipLog.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (log.length >= CONF.perIpHour) { ipLog.set(ip, log); return false; }
  log.push(now); ipLog.set(ip, log); return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const c = cors(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, c.headers); return res.end(); }
  if (url.pathname === '/health') return send(res, 200, { ok: true, queue: queue.length, running }, c.headers);
  if (!c.ok) return send(res, 403, { error: 'origin not allowed' }, {});

  if (url.pathname === '/jobs' && req.method === 'POST') {
    const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowIp(ip, Date.now())) return send(res, 429, { error: 'too many jobs this hour' }, c.headers);
    if (queue.length >= CONF.queueMax) return send(res, 503, { error: 'busy' }, c.headers);
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > CONF.bodyMax) return send(res, 413, { error: 'body too large' }, c.headers); }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'body is not JSON' }, c.headers); }
    const bad = validate(body);
    if (bad) return send(res, 400, { error: bad }, c.headers);
    const id = crypto.randomBytes(16).toString('hex');
    const job = { id, status: 'queued', progress: null, input: body.input, matrix: body.matrix,
      push: body.push && body.push.endpoint ? body.push : null, notify: body.notify || null,
      threads: new Set(), cancelled: false, createdAt: Date.now() };
    jobs.set(id, job); queue.push(job); pump();
    return send(res, 202, { id, position: queue.indexOf(job) + 1 }, c.headers);
  }
  if (url.pathname === '/reminders' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) return send(res, 413, { error: 'body too large' }, c.headers); }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'body is not JSON' }, c.headers); }
    const bad = setReminders(body, Date.now());
    if (bad) return send(res, 400, { error: bad }, c.headers);
    return send(res, 200, { ok: true, n: body.items.length }, c.headers);
  }
  const m = url.pathname.match(/^\/jobs\/([0-9a-f]{32})$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'not found' }, c.headers);
    if (req.method === 'DELETE') {
      job.cancelled = true; for (const w of job.threads) w.terminate();
      const qi = queue.indexOf(job);
      if (qi >= 0){ queue.splice(qi, 1); job.finishedAt = Date.now(); job.push = null; setTimeout(() => jobs.delete(job.id), CONF.resultTtlMs).unref(); }
      job.status = 'cancelled';
      return send(res, 200, { ok: true }, c.headers);
    }
    if (req.method === 'GET') {
      const out = { status: job.status, progress: job.progress, position: job.status === 'queued' ? queue.indexOf(job) + 1 : 0 };
      if (job.status === 'done') out.result = job.result;
      if (job.status === 'failed') out.error = job.error;
      return send(res, 200, out, c.headers);
    }
  }
  return send(res, 404, { error: 'not found' }, c.headers);
}

function start(port = CONF.port) {
  const srv = http.createServer((req, res) => { handle(req, res).catch(() => send(res, 500, { error: 'server error' }, {})); });
  return new Promise(r => srv.listen(port, () => r(srv)));
}

if (require.main === module) start().then(() => console.log(`compute on :${CONF.port}, ${CONF.runs} runs per round`));

module.exports = { start, validate, CONF, jobs, setReminders, reminders, sent };
