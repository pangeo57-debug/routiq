'use strict';
/**
 * Worker tests.
 *
 * The Worker is plain ES modules with no Cloudflare-specific imports, so it
 * runs under node:test with a stubbed env — no wrangler, no network, no
 * account needed to know whether it is correct.
 *
 * Every test here is about NOT leaking the key and NOT being an open relay,
 * because those are the only two ways this component can fail badly.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

let W;
before(async () => {
  W = await import(path.join(__dirname, '..', 'src', 'index.js'));
});

const ORIGIN = 'https://pangeo57-debug.github.io';
const KEY = 'secret-here-key-do-not-leak';

/** An env with working KV stubs. */
function makeEnv(over = {}) {
  const store = new Map();
  const kv = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    _store: store,
  };
  return Object.assign({
    HERE_API_KEY: KEY,
    ALLOWED_ORIGINS: ORIGIN + ',http://localhost:8080',
    RATE: kv, CACHE: { ...kv, _store: store },
  }, over);
}

function req(url, opts = {}) {
  return new Request(url, Object.assign({
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '1.2.3.4' },
  }, opts));
}

/** Capture what the Worker sends upstream, and answer with `reply`. */
function stubFetch(reply = { ok: true, status: 200, body: '[]' }) {
  const calls = [];
  global.fetch = async (u, o) => {
    calls.push({ url: String(u), opts: o || {} });
    return new Response(reply.body, { status: reply.status || 200 });
  };
  return calls;
}

describe('the API key never reaches the browser', () => {
  test('a geocode answer carries no key, and the key goes upstream', async () => {
    const calls = stubFetch({ body: '[{"lat":38.2,"lon":21.7}]' });
    const res = await W.handle(req('https://api.test/here/geocode?q=Πάτρα'), makeEnv(), {});
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.ok(!text.includes(KEY), 'the response body must not contain the key');
    for (const [, v] of res.headers) assert.ok(!String(v).includes(KEY), 'nor any header');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes(`apiKey=${encodeURIComponent(KEY)}`),
      'the upstream call is what carries it');
  });

  test('an upstream failure does not echo the URL back', async () => {
    global.fetch = async () => { throw new Error(`failed calling https://x?apiKey=${KEY}`); };
    const res = await W.default.fetch(req('https://api.test/here/geocode?q=a'), makeEnv(), {});
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.ok(!text.includes(KEY), `error body leaked the key: ${text}`);
  });

  test('the cache key cannot contain the key either', async () => {
    const env = makeEnv();
    stubFetch({ body: '[]' });
    await W.handle(req('https://api.test/here/geocode?q=Πάτρα'), env, {});
    for (const k of env.CACHE._store.keys())
      assert.ok(!k.includes(KEY), `cache key leaked it: ${k}`);
  });
});

describe('it is not an open relay', () => {
  test('an unknown origin is refused before anything is forwarded', async () => {
    const calls = stubFetch();
    const res = await W.handle(
      new Request('https://api.test/here/geocode?q=a', { headers: { Origin: 'https://evil.test' } }),
      makeEnv(), {});
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0, 'nothing may be forwarded for a refused origin');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'null');
  });

  test('with no allowlist configured it refuses everything', async () => {
    // A half-configured Worker must fail closed. Defaulting to "*" here would
    // hand the quota to anyone who found the URL.
    const res = await W.handle(req('https://api.test/here/geocode?q=a'),
      makeEnv({ ALLOWED_ORIGINS: '' }), {});
    assert.equal(res.status, 403);
  });

  test('only known actions are forwarded', async () => {
    const calls = stubFetch();
    for (const p of ['/here/whatever', '/osm/anything', '/nope', '/here']) {
      const res = await W.handle(req('https://api.test' + p), makeEnv(), {});
      assert.equal(res.status, 404, `${p} should not be a route`);
    }
    assert.equal(calls.length, 0);
  });

  test('parameters the caller invents are dropped, not forwarded', async () => {
    const calls = stubFetch();
    await W.handle(req('https://api.test/here/geocode?q=Πάτρα&apiKey=mine&callback=evil&at=1,2'),
      makeEnv(), {});
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('apiKey'), KEY, "the caller's apiKey must be ignored");
    assert.equal(u.searchParams.get('callback'), null);
    assert.equal(u.searchParams.get('at'), null, 'at is not allowed on geocode');
    assert.equal(u.searchParams.get('q'), 'Πάτρα');
  });

  test('a value with a line break is refused', async () => {
    const calls = stubFetch();
    const res = await W.handle(
      req('https://api.test/here/geocode?q=' + encodeURIComponent('a\r\nHost: evil')), makeEnv(), {});
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  test('an over-long value is refused', async () => {
    const res = await W.handle(
      req('https://api.test/here/geocode?q=' + 'x'.repeat(W.LIMITS.qMaxLength + 1)), makeEnv(), {});
    assert.equal(res.status, 400);
  });
});

describe('the matrix endpoint checks its body', () => {
  const post = (body) => req('https://api.test/here/matrix', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '1.2.3.4', 'Content-Type': 'application/json' },
  });

  test('a good body is forwarded', async () => {
    const calls = stubFetch({ body: '{"matrix":{}}' });
    const res = await W.handle(post({ origins: [{ lat: 38.2, lng: 21.7 }] }), makeEnv(), {});
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.method, 'POST');
  });

  const bad = {
    'not JSON at all': '{{{',
    'no origins': { destinations: [] },
    'an empty origin list': { origins: [] },
    'a coordinate off the planet': { origins: [{ lat: 999, lng: 0 }] },
    'a missing coordinate': { origins: [{ lat: 38.2 }] },
    'too many points': { origins: Array.from({ length: 500 }, () => ({ lat: 38, lng: 21 })) },
  };
  for (const [name, body] of Object.entries(bad)) {
    test(`refuses ${name}`, async () => {
      const calls = stubFetch();
      const res = await W.handle(post(body), makeEnv(), {});
      assert.equal(res.status, 400, `${name} should be a 400`);
      assert.equal(calls.length, 0, 'and nothing should reach HERE');
    });
  }

  test('refuses a body larger than the limit', async () => {
    const calls = stubFetch();
    const res = await W.handle(post('x'.repeat(W.LIMITS.bodyBytesMax + 1)), makeEnv(), {});
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  test('GET is not a way to reach it', async () => {
    const res = await W.handle(req('https://api.test/here/matrix'), makeEnv(), {});
    assert.equal(res.status, 405);
  });
});

describe('limits', () => {
  test('a client is cut off after the per-minute allowance', async () => {
    const env = makeEnv();
    stubFetch();
    let last;
    for (let i = 0; i < W.LIMITS.perMinute + 2; i++)
      last = await W.handle(req('https://api.test/here/geocode?q=a' + i), env, {});
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('Retry-After')) > 0, 'and says when to come back');
  });

  test('one client running out does not cut off another', async () => {
    const env = makeEnv();
    stubFetch();
    const as = (ip, q) => new Request('https://api.test/here/geocode?q=' + q,
      { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } });
    for (let i = 0; i < W.LIMITS.perMinute + 2; i++) await W.handle(as('1.1.1.1', 'a' + i), env, {});
    const other = await W.handle(as('2.2.2.2', 'b'), env, {});
    assert.equal(other.status, 200);
  });

  test('without a KV binding it serves rather than refuses', async () => {
    // A misconfigured limiter must not take the whole proxy down with it.
    stubFetch();
    const res = await W.handle(req('https://api.test/here/geocode?q=a'),
      makeEnv({ RATE: undefined }), {});
    assert.equal(res.status, 200);
  });
});

describe('upstream manners and caching', () => {
  test('Nominatim gets the User-Agent its policy requires', async () => {
    const calls = stubFetch({ body: '[]' });
    await W.handle(req('https://api.test/osm/search?q=Πάτρα'), makeEnv(), {});
    assert.equal(calls.length, 1);
    assert.match(calls[0].opts.headers['User-Agent'], /RoutePal/,
      'a browser cannot set this header at all, which is why it belongs here');
  });

  test('a repeated lookup is answered from cache', async () => {
    const env = makeEnv();
    const calls = stubFetch({ body: '[{"lat":1,"lon":2}]' });
    const first = await W.handle(req('https://api.test/osm/search?q=Πάτρα'), env, {});
    const second = await W.handle(req('https://api.test/osm/search?q=Πάτρα'), env, {});
    assert.equal(first.headers.get('X-Cache'), 'miss');
    assert.equal(second.headers.get('X-Cache'), 'hit');
    assert.equal(calls.length, 1, 'the second must not reach Nominatim');
    assert.equal(await second.text(), '[{"lat":1,"lon":2}]');
  });

  test('a failure is never cached', async () => {
    // A cached error is served long after the upstream recovered, and the user
    // sees a permanent fault that no longer exists.
    const env = makeEnv();
    let calls = stubFetch({ status: 500, body: 'upstream down' });
    await W.handle(req('https://api.test/osm/search?q=Χ'), env, {});
    calls = stubFetch({ status: 200, body: '[{"lat":3,"lon":4}]' });
    const res = await W.handle(req('https://api.test/osm/search?q=Χ'), env, {});
    assert.equal(res.headers.get('X-Cache'), 'miss', 'it must try again');
    assert.equal(await res.text(), '[{"lat":3,"lon":4}]');
  });

  test('health needs no origin and reveals nothing', async () => {
    const res = await W.handle(new Request('https://api.test/health'), makeEnv(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['ok']);
  });
});
