/**
 * Sync: one person's data, as a single encrypted blob, with one device allowed
 * to write it.
 *
 * What the server can see: how big the blob is and when it changed. That is
 * all. The blob is encrypted on the device with a key derived from a code that
 * never reaches here, so names, addresses and schedules stay unreadable to the
 * server, to Cloudflare, and to anyone who ever gets hold of the database.
 *
 * The trade that buys: lose the code and the data is gone. That is an honest
 * trade for a backup of data that also lives on the device, and it is said out
 * loud in the UI rather than discovered later.
 *
 * Writing is restricted to ONE device — the model the user chose. A second
 * device reads. It can take over explicitly, which is a decision someone
 * makes, not a race two phones resolve by accident.
 */

const LIMITS = {
  blobBytesMax: 2 * 1024 * 1024,   // a very large roster is still far under this
  spaceIdLength: 12,
  authHashLength: 64,              // hex SHA-256
  deviceIdMax: 64,
};

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Constant-time comparison. A plain === leaks, through timing, how much of a
 * guess was right, which is how someone walks a secret out one character at a
 * time.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function badRequest(msg) { return { error: msg, status: 400 }; }

function validateSpaceId(id) {
  return typeof id === 'string' && new RegExp(`^[A-Za-z0-9_-]{${LIMITS.spaceIdLength}}$`).test(id);
}
function validateAuthHash(h) {
  return typeof h === 'string' && new RegExp(`^[a-f0-9]{${LIMITS.authHashLength}}$`).test(h);
}
function validateDeviceId(d) {
  return typeof d === 'string' && d.length > 0 && d.length <= LIMITS.deviceIdMax
    && /^[A-Za-z0-9_-]+$/.test(d);
}

/**
 * The caller proves it knows the code by sending a hash of it. That hash is
 * hashed AGAIN before comparison with what is stored, so the stored value is
 * not itself a usable credential if the database leaks.
 */
async function checkAuth(row, sentHash) {
  if (!validateAuthHash(sentHash)) return false;
  return safeEqual(row.auth_hash, await sha256Hex(sentHash));
}

async function createSpace(db, body, now) {
  const { spaceId, authHash, deviceId } = body || {};
  if (!validateSpaceId(spaceId)) return badRequest('bad spaceId');
  if (!validateAuthHash(authHash)) return badRequest('bad authHash');
  if (!validateDeviceId(deviceId)) return badRequest('bad deviceId');

  const existing = await db.prepare('SELECT space_id FROM spaces WHERE space_id = ?')
    .bind(spaceId).first();
  // Refusing rather than overwriting: an id collision must never silently
  // destroy somebody else's data.
  if (existing) return { error: 'space already exists', status: 409 };

  await db.prepare(
    `INSERT INTO spaces (space_id, auth_hash, blob, version, primary_device, updated_at, created_at, bytes)
     VALUES (?, ?, NULL, 0, ?, ?, ?, 0)`)
    .bind(spaceId, await sha256Hex(authHash), deviceId, now, now).run();

  return { status: 200, body: { spaceId, version: 0, primaryDevice: deviceId } };
}

async function pull(db, body) {
  const { spaceId, authHash, knownVersion } = body || {};
  if (!validateSpaceId(spaceId)) return badRequest('bad spaceId');
  const row = await db.prepare('SELECT * FROM spaces WHERE space_id = ?').bind(spaceId).first();
  // The same answer whether the space does not exist or the code is wrong —
  // otherwise this endpoint tells you which ids are real.
  if (!row || !(await checkAuth(row, authHash))) return { error: 'not found', status: 404 };

  // Nothing new? Then say so and send nothing. A device that opens the app
  // five times a day used to download the entire roster five times to be told
  // it already had it — pointless on a phone's data allowance, and pointless
  // for the database. The version IS the cache key: it only ever goes up, and
  // it goes up on every write, so "same version" cannot mean "different data".
  if (Number.isInteger(knownVersion) && knownVersion === row.version) {
    return { status: 200, body: {
      spaceId, version: row.version, unchanged: true,
      primaryDevice: row.primary_device, updatedAt: row.updated_at } };
  }

  return { status: 200, body: {
    spaceId, version: row.version, blob: row.blob, unchanged: false,
    primaryDevice: row.primary_device, updatedAt: row.updated_at } };
}

async function push(db, body, now) {
  const { spaceId, authHash, deviceId, blob, baseVersion, takeOver } = body || {};
  if (!validateSpaceId(spaceId)) return badRequest('bad spaceId');
  if (!validateDeviceId(deviceId)) return badRequest('bad deviceId');
  if (typeof blob !== 'string' || !blob) return badRequest('blob must be a non-empty string');
  if (blob.length > LIMITS.blobBytesMax) return { error: 'blob too large', status: 413 };
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return badRequest('bad baseVersion');

  const row = await db.prepare('SELECT * FROM spaces WHERE space_id = ?').bind(spaceId).first();
  if (!row || !(await checkAuth(row, authHash))) return { error: 'not found', status: 404 };

  // Only the primary device writes. A second device must say, explicitly, that
  // it is taking over — so a phone left in a drawer cannot quietly overwrite
  // the laptop that has been doing the real work.
  if (row.primary_device && row.primary_device !== deviceId && !takeOver) {
    return { error: 'not the primary device', status: 403,
      body: { primaryDevice: row.primary_device, version: row.version } };
  }

  // The blob being written must be based on what is currently stored. If it is
  // not, somebody else wrote in between and this write would erase them: hand
  // back the newer version instead of taking it.
  if (row.version !== baseVersion) {
    return { error: 'version conflict', status: 409,
      body: { version: row.version, blob: row.blob, updatedAt: row.updated_at } };
  }

  const version = row.version + 1;
  await db.prepare(
    `UPDATE spaces SET blob = ?, version = ?, primary_device = ?, updated_at = ?, bytes = ?
     WHERE space_id = ? AND version = ?`)
    .bind(blob, version, deviceId, now, blob.length, spaceId, baseVersion).run();

  return { status: 200, body: { spaceId, version, primaryDevice: deviceId } };
}

/**
 * Change the code.
 *
 * The honest answer to "whoever has the code has the data" is not a second
 * password nobody will use — it is being able to take access back. The caller
 * proves it knows the current code, and hands over a new credential together
 * with the data re-encrypted under the new key. Every other device is locked
 * out at that moment, because its key no longer opens anything.
 *
 * Both halves in one statement: a rotation that changed the credential but
 * not the blob would leave data nobody can read.
 */
async function rotate(db, body, now) {
  const { spaceId, authHash, newAuthHash, blob, deviceId, baseVersion } = body || {};
  if (!validateSpaceId(spaceId)) return badRequest('bad spaceId');
  if (!validateAuthHash(newAuthHash)) return badRequest('bad newAuthHash');
  if (!validateDeviceId(deviceId)) return badRequest('bad deviceId');
  if (typeof blob !== 'string' || !blob) return badRequest('blob must be a non-empty string');
  if (blob.length > LIMITS.blobBytesMax) return { error: 'blob too large', status: 413 };
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return badRequest('bad baseVersion');

  const row = await db.prepare('SELECT * FROM spaces WHERE space_id = ?').bind(spaceId).first();
  if (!row || !(await checkAuth(row, authHash))) return { error: 'not found', status: 404 };
  // Rotating on top of somebody else's newer data would destroy it, exactly
  // as an ordinary push would.
  if (row.version !== baseVersion) {
    return { error: 'version conflict', status: 409,
      body: { version: row.version, blob: row.blob, updatedAt: row.updated_at } };
  }

  const version = row.version + 1;
  await db.prepare(
    `UPDATE spaces SET auth_hash = ?, blob = ?, version = ?, primary_device = ?, updated_at = ?, bytes = ?
     WHERE space_id = ? AND version = ?`)
    .bind(await sha256Hex(newAuthHash), blob, version, deviceId, now, blob.length, spaceId, baseVersion)
    .run();

  return { status: 200, body: { spaceId, version, primaryDevice: deviceId, rotated: true } };
}

async function deleteSpace(db, body) {
  const { spaceId, authHash } = body || {};
  if (!validateSpaceId(spaceId)) return badRequest('bad spaceId');
  const row = await db.prepare('SELECT * FROM spaces WHERE space_id = ?').bind(spaceId).first();
  if (!row || !(await checkAuth(row, authHash))) return { error: 'not found', status: 404 };
  await db.prepare('DELETE FROM spaces WHERE space_id = ?').bind(spaceId).run();
  return { status: 200, body: { deleted: true } };
}

/** Twelve months of nobody touching it. Stated in the privacy policy. */
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Delete spaces nobody has touched for a year.
 *
 * A retention period written only in a policy is a promise with nothing
 * keeping it. This is the part that keeps it.
 *
 * Two deliberate restraints:
 *
 *  - A batch limit. A single run that deleted a hundred thousand rows because
 *    of a clock problem is not a cleanup, it is an incident. It is capped, and
 *    it runs daily, so a genuine backlog drains over days instead of
 *    disappearing in one irreversible sweep.
 *  - A floor on updated_at. A row with a missing or absurd timestamp is left
 *    alone rather than treated as ancient: the failure mode of "0 means 1970
 *    means delete it" is losing data that was fine.
 *
 * Nobody can be warned first — the service holds no email address, by design.
 * That is exactly why the period is long and the local copy stays untouched:
 * the device keeps its own data whatever happens here.
 */
async function purgeStale(db, now, opts) {
  const o = opts || {};
  const maxAge = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : RETENTION_MS;
  const limit = Number.isInteger(o.limit) ? o.limit : 500;
  const cutoff = now - maxAge;
  // Nothing before 2020 can be a real updated_at from this service.
  const floor = Date.UTC(2020, 0, 1);
  if (!Number.isFinite(cutoff) || cutoff <= floor) return { deleted: 0, skipped: 'cutoff out of range' };

  const { results } = await db.prepare(
    'SELECT space_id FROM spaces WHERE updated_at > ? AND updated_at < ? ORDER BY updated_at LIMIT ?')
    .bind(floor, cutoff, limit).all();
  const ids = (results || []).map(r => r.space_id);
  for (const id of ids) {
    await db.prepare('DELETE FROM spaces WHERE space_id = ? AND updated_at < ?')
      .bind(id, cutoff).run();
  }
  return { deleted: ids.length, cutoff };
}

export { createSpace, pull, push, rotate, deleteSpace, purgeStale, RETENTION_MS, sha256Hex, safeEqual,
         validateSpaceId, validateAuthHash, validateDeviceId, LIMITS };
