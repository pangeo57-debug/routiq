/**
 * RoutePal API proxy — Cloudflare Worker.
 *
 * Two jobs, and deliberately no others:
 *
 *  1. Hold the HERE API key. It shipped inside routiq.html, where anyone
 *     could read it out of the page and spend the quota. The key now lives
 *     as a Worker secret and never reaches a browser.
 *
 *  2. Be a good citizen upstream. Nominatim's usage policy requires an
 *     identifying User-Agent and no more than one request a second —
 *     a browser cannot set User-Agent at all (the header is forbidden, so
 *     the client's attempt to send one was silently dropped), and nothing
 *     was spacing the requests out. Both are enforceable only here.
 *
 * It stores no user data. The schedule, the clients and their addresses stay
 * on the device: this proxy sees an address string on its way to a geocoder
 * and nothing else.
 */

import * as Sync from './sync.js';

const HERE_HOSTS = {
  geocode:     'https://geocode.search.hereapi.com/v1/geocode',
  autosuggest: 'https://autosuggest.search.hereapi.com/v1/autosuggest',
  revgeocode:  'https://revgeocode.search.hereapi.com/v1/revgeocode',
  matrix:      'https://matrix.router.hereapi.com/v8/matrix',
};

const OSM_HOSTS = {
  search:  'https://nominatim.openstreetmap.org/search',
  reverse: 'https://nominatim.openstreetmap.org/reverse',
};

// Only these may be forwarded, and each is rebuilt from validated values
// rather than passed through. A proxy that forwards whatever it is given is
// an open relay wearing a different hat.
const ALLOWED_PARAMS = {
  geocode:     ['q', 'limit', 'lang'],
  autosuggest: ['q', 'at', 'limit', 'lang'],
  revgeocode:  ['at', 'lang'],
  search:      ['q', 'format', 'limit', 'addressdetails', 'namedetails', 'viewbox', 'bounded'],
  reverse:     ['format', 'lat', 'lon', 'addressdetails', 'zoom'],
};

const LIMITS = {
  perMinute: 60,        // a burst while geocoding a fresh roster
  perDay: 2000,         // one person cannot exhaust a shared quota
  // Creating a space is nothing like a lookup: it makes a row that stays.
  // Under the general allowance alone, one address could create 2000 spaces a
  // day and fill the database with rows nobody will ever read. A person needs
  // a handful of these in a lifetime.
  createsPerDay: 5,
  matrixPointsMax: 120, // HERE's own matrix limit for the sync endpoint
  bodyBytesMax: 32 * 1024,
  qMaxLength: 300,
};

/** Seconds a geocoding answer stays cached. Addresses do not move. */
const CACHE_TTL = { geocode: 60 * 60 * 24 * 30, matrix: 60 * 60 * 6 };

// ---------------------------------------------------------------------------

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // No allowlist configured means the Worker has not been set up yet. Refuse
  // rather than default to "*", which would hand the key's quota to anyone
  // who found the URL.
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    _allowed: ok,
  };
}

function json(body, status, headers) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  for (const [k, v] of Object.entries(headers || {})) if (!k.startsWith('_')) h[k] = v;
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * Fixed-window counter per client, per minute and per day.
 *
 * KV is eventually consistent and this is a read-modify-write, so two
 * simultaneous requests can both read the same count and a burst can overshoot
 * the limit slightly. That is acceptable for what this defends against — one
 * person or script draining a shared quota — and is written down rather than
 * pretended away. If it ever needs to be exact, the answer is a Durable
 * Object, not a cleverer version of this.
 */
async function rateLimit(env, clientId, now, kind) {
  if (!env.RATE) return { ok: true, skipped: true };

  // A separate, much tighter budget for anything that leaves a row behind.
  if (kind === 'create') {
    const key = `rl:c:${clientId}:${Math.floor(now / 86400000)}`;
    const n = Number(await env.RATE.get(key)) || 0;
    if (n >= LIMITS.createsPerDay) return { ok: false, scope: 'creates', retryAfter: 3600 };
    await env.RATE.put(key, String(n + 1), { expirationTtl: 90000 });
  }

  const minuteKey = `rl:m:${clientId}:${Math.floor(now / 60000)}`;
  const dayKey = `rl:d:${clientId}:${Math.floor(now / 86400000)}`;

  const [mRaw, dRaw] = await Promise.all([env.RATE.get(minuteKey), env.RATE.get(dayKey)]);
  const m = Number(mRaw) || 0, d = Number(dRaw) || 0;
  if (m >= LIMITS.perMinute) return { ok: false, scope: 'minute', retryAfter: 60 };
  if (d >= LIMITS.perDay) return { ok: false, scope: 'day', retryAfter: 3600 };

  await Promise.all([
    env.RATE.put(minuteKey, String(m + 1), { expirationTtl: 120 }),
    env.RATE.put(dayKey, String(d + 1), { expirationTtl: 90000 }),
  ]);
  return { ok: true, minute: m + 1, day: d + 1 };
}

/** Values that reach an upstream URL, checked rather than trusted. */
function cleanParams(kind, url) {
  const allowed = ALLOWED_PARAMS[kind] || [];
  const out = new URLSearchParams();
  for (const name of allowed) {
    const v = url.searchParams.get(name);
    if (v == null || v === '') continue;
    if (v.length > LIMITS.qMaxLength) return { error: `${name} is too long` };
    // Newlines would let a value smuggle a second header or line into the
    // upstream request if any layer between here and there is sloppy.
    if (/[\r\n]/.test(v)) return { error: `${name} contains a line break` };
    out.set(name, v);
  }
  return { params: out };
}

/** A matrix request is a body, so it gets checked as one. */
function validateMatrixBody(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const origins = body.origins;
  if (!Array.isArray(origins) || origins.length === 0) return 'origins must be a non-empty list';
  if (origins.length > LIMITS.matrixPointsMax)
    return `at most ${LIMITS.matrixPointsMax} origins`;
  for (const p of origins) {
    if (!p || typeof p !== 'object') return 'each origin must be an object';
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return 'each origin needs lat and lng';
    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) return 'origin out of range';
  }
  if (body.destinations !== undefined) {
    if (!Array.isArray(body.destinations)) return 'destinations must be a list';
    if (body.destinations.length > LIMITS.matrixPointsMax)
      return `at most ${LIMITS.matrixPointsMax} destinations`;
  }
  return null;
}

async function cachedFetch(env, cacheKey, ttl, doFetch) {
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey);
    if (hit != null) return { body: hit, cached: true };
  }
  const res = await doFetch();
  const text = await res.text();
  // Never cache a failure: a cached error is served long after the upstream
  // recovered, and the user sees a permanent fault that no longer exists.
  if (res.ok && env.CACHE) {
    await env.CACHE.put(cacheKey, text, { expirationTtl: ttl });
  }
  return { body: text, cached: false, status: res.status, ok: res.ok };
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (url.pathname === '/health') return json({ ok: true }, 200, cors);

  if (!cors._allowed) {
    return json({ error: 'origin not allowed' }, 403, cors);
  }

  const clientId = request.headers.get('CF-Connecting-IP') || 'unknown';
  const isCreate = url.pathname === '/sync/create';
  const limit = await rateLimit(env, clientId, Date.now(), isCreate ? 'create' : 'lookup');
  if (!limit.ok) {
    return json({ error: 'rate limit reached', scope: limit.scope }, 429,
      { ...cors, 'Retry-After': String(limit.retryAfter) });
  }

  const [, group, action] = url.pathname.split('/');

  // ---- HERE ---------------------------------------------------------------
  if (group === 'here') {
    if (!env.HERE_API_KEY) return json({ error: 'not configured' }, 503, cors);

    if (action === 'matrix') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
      const raw = await request.text();
      if (raw.length > LIMITS.bodyBytesMax) return json({ error: 'body too large' }, 413, cors);
      let body;
      try { body = JSON.parse(raw); }
      catch { return json({ error: 'body is not JSON' }, 400, cors); }
      const bad = validateMatrixBody(body);
      if (bad) return json({ error: bad }, 400, cors);

      const upstream = `${HERE_HOSTS.matrix}?async=false&apiKey=${encodeURIComponent(env.HERE_API_KEY)}`;
      const res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return new Response(text, { status: res.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...stripPrivate(cors) } });
    }

    if (HERE_HOSTS[action] && action !== 'matrix') {
      const clean = cleanParams(action, url);
      if (clean.error) return json({ error: clean.error }, 400, cors);
      clean.params.set('apiKey', env.HERE_API_KEY);
      const upstream = `${HERE_HOSTS[action]}?${clean.params.toString()}`;
      // The key is in the upstream URL, so it must never appear in a cache key.
      const cacheKey = `here:${action}:${clean.params.toString().replace(/&?apiKey=[^&]*/, '')}`;
      const out = await cachedFetch(env, cacheKey, CACHE_TTL.geocode, () => fetch(upstream));
      return new Response(out.body, { status: out.status || 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8',
          'X-Cache': out.cached ? 'hit' : 'miss', ...stripPrivate(cors) } });
    }
  }

  // ---- Sync ---------------------------------------------------------------
  // The server never sees anything readable here: the blob is encrypted on the
  // device with a key derived from a code that does not leave it.
  if (group === 'sync') {
    if (!env.DB) return json({ error: 'sync not configured' }, 503, cors);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    const raw = await request.text();
    if (raw.length > Sync.LIMITS.blobBytesMax + 4096)
      return json({ error: 'body too large' }, 413, cors);
    let body;
    try { body = JSON.parse(raw); }
    catch { return json({ error: 'body is not JSON' }, 400, cors); }

    const now = Date.now();
    const ops = { create: Sync.createSpace, pull: Sync.pull, push: Sync.push, delete: Sync.deleteSpace };
    const op = ops[action];
    if (!op) return json({ error: 'not found' }, 404, cors);

    const out = (action === 'pull' || action === 'delete')
      ? await op(env.DB, body)
      : await op(env.DB, body, now);
    return json(out.body || { error: out.error }, out.status, cors);
  }

  // ---- OpenStreetMap ------------------------------------------------------
  if (group === 'osm' && OSM_HOSTS[action]) {
    const clean = cleanParams(action, url);
    if (clean.error) return json({ error: clean.error }, 400, cors);
    clean.params.set('format', 'json');
    const upstream = `${OSM_HOSTS[action]}?${clean.params.toString()}`;
    const cacheKey = `osm:${action}:${clean.params.toString()}`;
    const out = await cachedFetch(env, cacheKey, CACHE_TTL.geocode, () => fetch(upstream, {
      headers: {
        // Required by Nominatim's usage policy, and impossible from a browser:
        // User-Agent is a forbidden header there, so the client's attempt to
        // set it was dropped and every request went out anonymous.
        'User-Agent': env.CONTACT_UA || 'RoutePal/1.0 (+https://github.com/pangeo57-debug/routiq)',
        'Accept-Language': url.searchParams.get('lang') || 'el',
      },
    }));
    return new Response(out.body, { status: out.status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8',
        'X-Cache': out.cached ? 'hit' : 'miss', ...stripPrivate(cors) } });
  }

  return json({ error: 'not found' }, 404, cors);
}

function stripPrivate(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      // Never let an upstream error message carry the key or an internal URL
      // back to the browser.
      console.error('proxy error', err && err.message);
      const cors = corsHeaders(request.headers.get('Origin') || '', env);
      return json({ error: 'upstream failed' }, 502, cors);
    }
  },
};

export { cleanParams, validateMatrixBody, corsHeaders, rateLimit, LIMITS, handle };
