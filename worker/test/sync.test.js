'use strict';
/**
 * Sync tests.
 *
 * A tiny in-memory stand-in for D1 — enough of prepare/bind/first/run to drive
 * the real code. Every test here is about one of the three ways sync destroys
 * data: writing over somebody else's newer copy, letting the wrong device
 * write, and letting a stranger read.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

let S;
before(async () => { S = await import(path.join(__dirname, '..', 'src', 'sync.js')); });

/** Just enough D1 for this module's four statements. */
function fakeDB() {
  const rows = new Map();
  return {
    _rows: rows,
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() {
          if (/FROM spaces WHERE space_id/.test(sql)) return rows.get(args[0]) || null;
          return null;
        },
        async run() {
          if (/^\s*INSERT INTO spaces/.test(sql)) {
            const [space_id, auth_hash, primary_device, updated_at, created_at] = args;
            rows.set(space_id, { space_id, auth_hash, blob: null, version: 0,
              primary_device, updated_at, created_at, bytes: 0 });
          } else if (/^\s*UPDATE spaces/.test(sql)) {
            const [blob, version, primary_device, updated_at, bytes, space_id, baseVersion] = args;
            const r = rows.get(space_id);
            // The WHERE clause carries the expected version; honour it here too
            // or the fake would accept writes the real database refuses.
            if (r && r.version === baseVersion)
              Object.assign(r, { blob, version, primary_device, updated_at, bytes });
          } else if (/^\s*DELETE FROM spaces/.test(sql)) {
            rows.delete(args[0]);
          }
          return { success: true };
        },
      };
      return api;
    },
  };
}

const ID = 'abcdefgh1234';
const SECRET = 'a'.repeat(64);            // what the device sends
const OTHER  = 'b'.repeat(64);
const DEV1 = 'device-one', DEV2 = 'device-two';

async function newSpace(db, deviceId = DEV1) {
  return S.createSpace(db, { spaceId: ID, authHash: SECRET, deviceId }, 1000);
}

describe('creating a space', () => {
  test('stores a hash of what was sent, never the value itself', async () => {
    const db = fakeDB();
    await newSpace(db);
    const row = db._rows.get(ID);
    assert.ok(row, 'the space should exist');
    assert.notEqual(row.auth_hash, SECRET,
      'storing what the client sends would make the database itself a credential');
    assert.equal(row.auth_hash, await S.sha256Hex(SECRET));
    assert.equal(row.blob, null);
    assert.equal(row.version, 0);
  });

  test('never overwrites a space that already exists', async () => {
    const db = fakeDB();
    await newSpace(db);
    db._rows.get(ID).blob = 'somebody-elses-data';
    const res = await S.createSpace(db, { spaceId: ID, authHash: OTHER, deviceId: DEV2 }, 2000);
    assert.equal(res.status, 409);
    assert.equal(db._rows.get(ID).blob, 'somebody-elses-data', 'their data must survive');
  });

  const bad = {
    'a short id': { spaceId: 'abc', authHash: SECRET, deviceId: DEV1 },
    'an id with punctuation': { spaceId: 'abcdefgh12/.', authHash: SECRET, deviceId: DEV1 },
    'a non-hex auth hash': { spaceId: ID, authHash: 'z'.repeat(64), deviceId: DEV1 },
    'a short auth hash': { spaceId: ID, authHash: 'ab', deviceId: DEV1 },
    'no device': { spaceId: ID, authHash: SECRET },
    'a device id with spaces': { spaceId: ID, authHash: SECRET, deviceId: 'my phone' },
  };
  for (const [name, body] of Object.entries(bad)) {
    test(`refuses ${name}`, async () => {
      const db = fakeDB();
      const res = await S.createSpace(db, body, 1000);
      assert.equal(res.status, 400, name);
      assert.equal(db._rows.size, 0);
    });
  }
});

describe('reading', () => {
  test('the right code gets the blob', async () => {
    const db = fakeDB();
    await newSpace(db);
    await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1,
      blob: 'ciphertext', baseVersion: 0 }, 2000);
    const res = await S.pull(db, { spaceId: ID, authHash: SECRET });
    assert.equal(res.status, 200);
    assert.equal(res.body.blob, 'ciphertext');
    assert.equal(res.body.version, 1);
  });

  test('the wrong code gets nothing', async () => {
    const db = fakeDB();
    await newSpace(db);
    const res = await S.pull(db, { spaceId: ID, authHash: OTHER });
    assert.equal(res.status, 404);
    assert.equal(res.body, undefined, 'and no data alongside the refusal');
  });

  test('a wrong code and a missing space are indistinguishable', async () => {
    // Otherwise this endpoint answers "which space ids are real?"
    const db = fakeDB();
    await newSpace(db);
    const wrongCode = await S.pull(db, { spaceId: ID, authHash: OTHER });
    const noSpace = await S.pull(db, { spaceId: 'zzzzzzzz9999', authHash: SECRET });
    assert.equal(wrongCode.status, noSpace.status);
    assert.equal(wrongCode.error, noSpace.error);
  });
});

describe('writing cannot destroy a newer copy', () => {
  test('a push based on the current version is accepted', async () => {
    const db = fakeDB();
    await newSpace(db);
    const res = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1,
      blob: 'v1', baseVersion: 0 }, 2000);
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 1);
  });

  test('a push based on a stale version is refused, and hands back the newer one', async () => {
    const db = fakeDB();
    await newSpace(db);
    await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1, blob: 'first', baseVersion: 0 }, 2000);
    // A device that still thinks the world is at version 0.
    const res = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1,
      blob: 'would-erase-first', baseVersion: 0 }, 3000);
    assert.equal(res.status, 409);
    assert.equal(res.body.blob, 'first', 'the caller is given what it was missing');
    assert.equal(db._rows.get(ID).blob, 'first', 'and the stored copy is untouched');
  });
});

describe('only the primary device writes', () => {
  test('a second device is refused and told which one is primary', async () => {
    const db = fakeDB();
    await newSpace(db, DEV1);
    await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1, blob: 'laptop', baseVersion: 0 }, 2000);
    const res = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV2,
      blob: 'phone-in-a-drawer', baseVersion: 1 }, 3000);
    assert.equal(res.status, 403);
    assert.equal(res.body.primaryDevice, DEV1);
    assert.equal(db._rows.get(ID).blob, 'laptop');
  });

  test('taking over is possible, but only by saying so', async () => {
    const db = fakeDB();
    await newSpace(db, DEV1);
    await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1, blob: 'laptop', baseVersion: 0 }, 2000);
    const res = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV2,
      blob: 'phone', baseVersion: 1, takeOver: true }, 3000);
    assert.equal(res.status, 200);
    assert.equal(db._rows.get(ID).primary_device, DEV2);
    // And a takeover still cannot ignore the version.
    const stale = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1,
      blob: 'stale', baseVersion: 1, takeOver: true }, 4000);
    assert.equal(stale.status, 409);
  });

  test('a stranger cannot take over', async () => {
    const db = fakeDB();
    await newSpace(db, DEV1);
    const res = await S.push(db, { spaceId: ID, authHash: OTHER, deviceId: DEV2,
      blob: 'theirs', baseVersion: 0, takeOver: true }, 3000);
    assert.equal(res.status, 404);
  });
});

describe('limits and hygiene', () => {
  test('an oversized blob is refused', async () => {
    const db = fakeDB();
    await newSpace(db);
    const res = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1,
      blob: 'x'.repeat(S.LIMITS.blobBytesMax + 1), baseVersion: 0 }, 2000);
    assert.equal(res.status, 413);
    assert.equal(db._rows.get(ID).blob, null);
  });

  test('deleting needs the code, and really deletes', async () => {
    const db = fakeDB();
    await newSpace(db);
    assert.equal((await S.deleteSpace(db, { spaceId: ID, authHash: OTHER })).status, 404);
    assert.equal(db._rows.size, 1);
    assert.equal((await S.deleteSpace(db, { spaceId: ID, authHash: SECRET })).status, 200);
    assert.equal(db._rows.size, 0);
  });

  test('the comparison does not leak how much of a guess was right', () => {
    assert.equal(S.safeEqual('abc', 'abc'), true);
    assert.equal(S.safeEqual('abc', 'abd'), false);
    assert.equal(S.safeEqual('abc', 'ab'), false, 'different lengths are not equal');
    assert.equal(S.safeEqual('abc', null), false);
    assert.equal(S.safeEqual(undefined, undefined), false);
  });
});

// ---------------------------------------------------------------------------
// Attacks, run against the real code
// ---------------------------------------------------------------------------

describe('SQL injection', () => {
  // Every query uses a prepared statement with ? and bind(), so a value can
  // never become part of the statement. These run the actual payloads anyway:
  // "we use prepared statements" is a claim until something tries.

  const payloads = {
    "the classic always-true": "' OR '1'='1",
    "dropping the table": "'; DROP TABLE spaces; --",
    "a comment that cuts the check off": "abcdefgh1234' --",
    "a union to read other rows": "' UNION SELECT * FROM spaces --",
    "a null byte": "abcdefgh123\u0000",
    "a quote inside a valid-length id": "abcdefgh'234",
  };

  for (const [name, payload] of Object.entries(payloads)) {
    test(`is refused: ${name}`, async () => {
      const db = fakeDB();
      await newSpace(db);
      db._rows.get(ID).blob = 'THE-USERS-DATA';

      const res = await S.pull(db, { spaceId: payload, authHash: 'b'.repeat(64) });
      assert.ok(res.status >= 400, `${name} must not succeed`);
      assert.ok(!JSON.stringify(res).includes('THE-USERS-DATA'),
        `${name} leaked the blob`);
      assert.equal(db._rows.size, 1, 'the table must still be there');
      assert.equal(db._rows.get(ID).blob, 'THE-USERS-DATA', 'and the data untouched');
    });
  }

  test('every value reaches the database as a parameter, never as SQL', async () => {
    // Records the statement and its arguments separately: if a value ever
    // ended up inside the statement text, it would show here.
    const statements = [];
    const rows = new Map();
    const db = { prepare(sql) { let args = [];
      const api = { bind(...a) { args = a; statements.push({ sql, args }); return api; },
        async first() { return /FROM spaces WHERE space_id/.test(sql) ? (rows.get(args[0]) || null) : null; },
        async run() {
          if (/INSERT/.test(sql)) rows.set(args[0], { space_id: args[0], auth_hash: args[1],
            blob: null, version: 0, primary_device: args[2], updated_at: args[3], created_at: args[4] });
          return { success: true }; } };
      return api; } };

    await S.createSpace(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1 }, 1000);
    await S.pull(db, { spaceId: ID, authHash: SECRET });
    await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1, blob: "'; DROP TABLE spaces; --",
      baseVersion: 0 }, 2000);

    assert.ok(statements.length >= 3, 'the statements should have run');
    for (const st of statements) {
      assert.ok(st.sql.includes('?'), `a statement with no placeholder: ${st.sql}`);
      assert.ok(!/DROP|UNION|--/.test(st.sql),
        `attack text reached the statement itself: ${st.sql}`);
    }
  });

  test('even a blob full of SQL is only ever data', async () => {
    const db = fakeDB();
    await newSpace(db);
    const nasty = "'; DELETE FROM spaces WHERE 1=1; --";
    const res = await S.push(db, { spaceId: ID, authHash: SECRET, deviceId: DEV1,
      blob: nasty, baseVersion: 0 }, 2000);
    assert.equal(res.status, 200, 'it is legitimate content, just unpleasant text');
    assert.equal(db._rows.size, 1);
    assert.equal(db._rows.get(ID).blob, nasty, 'stored verbatim, executed never');
  });
});
