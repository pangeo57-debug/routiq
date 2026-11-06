'use strict';
/**
 * Analytics tests. The two ways this can fail badly: storing something about
 * a person that was not meant to be stored, and letting a stranger read it.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

let A, W;
before(async () => {
  A = await import(path.join(__dirname, '..', 'src', 'analytics.js'));
  W = await import(path.join(__dirname, '..', 'src', 'index.js'));
});

const AID = 'a'.repeat(32);
const NOW = Date.parse('2026-11-06T12:00:00Z');

/** Enough D1 for analytics.js: one table keyed by (aid, day, kind). */
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() {
          if (/^INSERT INTO pings/.test(sql.trim())) {
            const [aid, day, kind, km, min, lang, prof, ver] = args;
            const k = aid + '|' + day + '|' + kind, r = rows.get(k);
            if (r) { r.n++; r.km_saved = Math.max(r.km_saved, km); r.min_saved = Math.max(r.min_saved, min); Object.assign(r, { lang, prof, ver }); }
            else rows.set(k, { aid, day, kind, n: 1, km_saved: km, min_saved: min, lang, prof, ver });
            return { meta: { changes: 1 } };
          }
          if (/^DELETE FROM pings/.test(sql)) {
            let c = 0; for (const [k, r] of rows) if (r.day < args[0]) { rows.delete(k); c++; }
            return { meta: { changes: c } };
          }
          throw new Error('unexpected ' + sql);
        },
        async all() {
          const by = {};
          for (const r of rows.values()) {
            const p = by[r.aid] || (by[r.aid] = { aid: r.aid, first: r.day, last: r.day, days: new Set(), km: 0, min: 0 });
            if (r.day < p.first) p.first = r.day; if (r.day > p.last) p.last = r.day; p.days.add(r.day);
            if (r.kind === 'week') { p.km = Math.max(p.km, r.km_saved); p.min = Math.max(p.min, r.min_saved); }
          }
          return { results: Object.values(by).map(p => ({ ...p, days: p.days.size })) };
        },
      };
      return api;
    },
  };
}

describe('what a ping may carry', () => {
  test('only the listed fields are kept; names, addresses or anything else are dropped', () => {
    const v = A.validate({ aid: AID, kind: 'week', km: 12.34, min: 40, lang: 'el', prof: 'tutor', ver: '1.0',
      name: 'Μαρία Παπαδοπούλου', address: 'Κορίνθου 12', coords: { lat: 38.2 } }, NOW);
    assert.deepStrictEqual(Object.keys(v.ping).sort(), ['aid', 'day', 'kind', 'km', 'lang', 'min', 'prof', 'ver']);
    assert.equal(v.ping.km, 12.3);
    assert.equal(v.ping.day, '2026-11-06');
  });
  test('the day is the server\'s, not the device\'s', () => {
    assert.equal(A.validate({ aid: AID, kind: 'open', day: '1999-01-01' }, NOW).ping.day, '2026-11-06');
  });
  test('a free-text field cannot smuggle text in', () => {
    const v = A.validate({ aid: AID, kind: 'open', lang: 'Κορίνθου 12, Πάτρα' }, NOW);
    assert.equal(v.ping.lang, null);
  });
  test('a bad id or kind is refused', () => {
    assert.ok(A.validate({ aid: 'me@example.com', kind: 'open' }, NOW).error);
    assert.ok(A.validate({ aid: AID, kind: 'export' }, NOW).error);
  });
});

describe('the numbers', () => {
  test('one row per person per day per kind, counted', async () => {
    const db = fakeDB();
    await A.record(db, { aid: AID, kind: 'open' }, NOW);
    await A.record(db, { aid: AID, kind: 'open' }, NOW);
    assert.equal(db.rows.size, 1);
    assert.equal([...db.rows.values()][0].n, 2);
  });
  test('retention and saving come out of first and last day', () => {
    const day = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);
    const s = A.summarize([
      { aid: '1', first: day(40), last: day(0), km: 50, min: 100 },   // stayed
      { aid: '2', first: day(40), last: day(40), km: 0, min: 0 },     // left on day one
      { aid: '3', first: day(3), last: day(2), km: 30, min: 20 },     // new
    ], NOW);
    assert.equal(s.people, 3);
    assert.equal(s.active1, 1);
    assert.equal(s.retentionD1, 66.7);       // 2 of 3 old enough; '1' and '3' came back
    assert.equal(s.retentionD30, 50);        // of '1' and '2', only '1'
    assert.equal(s.meanWeekKmSaved, 40);
  });
  test('rows older than the retention period are deleted', async () => {
    const db = fakeDB();
    await A.record(db, { aid: AID, kind: 'open' }, NOW - 500 * 86400000);
    await A.record(db, { aid: AID, kind: 'open' }, NOW);
    const r = await A.purge(db, NOW);
    assert.equal(r.deleted, 1);
    assert.equal(db.rows.size, 1);
  });
});

describe('through the Worker', () => {
  const ORIGIN = 'https://pangeo57-debug.github.io';
  const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };
  const env = (over) => ({ ALLOWED_ORIGINS: ORIGIN, RATE: kv(), CACHE: kv(), DB: fakeDB(), ANALYTICS_KEY: 'k'.repeat(40), ...over });

  test('a ping from the app is stored', async () => {
    const e = env();
    const res = await W.handle(new Request('https://api.example/a/ping', { method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ aid: AID, kind: 'week', km: 9 }) }), e);
    assert.equal(res.status, 200);
    assert.equal(e.DB.rows.size, 1);
  });
  test('the stats do not exist without the key, or with a wrong one', async () => {
    for (const h of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Bearer ' + 'k'.repeat(39) + 'x' }]) {
      const res = await W.handle(new Request('https://api.example/a/stats', { headers: h }), env());
      assert.equal(res.status, 404);
    }
    const none = await W.handle(new Request('https://api.example/a/stats', { headers: { Authorization: 'Bearer ' + 'k'.repeat(40) } }), env({ ANALYTICS_KEY: undefined }));
    assert.equal(none.status, 404, 'no key configured means no stats at all');
  });
  test('with the key they are served', async () => {
    const res = await W.handle(new Request('https://api.example/a/stats', { headers: { Authorization: 'Bearer ' + 'k'.repeat(40) } }), env());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).people, 0);
  });
});
