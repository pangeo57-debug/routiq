/**
 * Anonymous usage counts — only from people who said yes in the app.
 *
 * What a ping carries is listed in validate(): a random id the device made
 * up, the day, what was done, the saving the app measured, language,
 * profession and version. Anything else in the body is dropped, not stored.
 * Rows older than RETENTION_DAYS are deleted by the daily run.
 */

export const KINDS = ['open', 'week', 'day'];
export const RETENTION_DAYS = 400;
const AID = /^[0-9a-f]{32}$/;
const SHORT = /^[a-z0-9_.-]{1,24}$/i;

const today = (now) => new Date(now).toISOString().slice(0, 10);
const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);

export function validate(body, now) {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  if (!AID.test(String(body.aid || ''))) return { error: 'bad id' };
  if (!KINDS.includes(body.kind)) return { error: 'bad kind' };
  const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Number(v))) : 0);
  const short = (v) => (typeof v === 'string' && SHORT.test(v) ? v : null);
  return { ping: {
    aid: body.aid, day: today(now), kind: body.kind,
    km: Math.round(num(body.km, 100000) * 10) / 10, min: Math.round(num(body.min, 100000)),
    lang: short(body.lang), prof: short(body.prof), ver: short(body.ver),
  } };
}

export async function record(db, body, now) {
  const v = validate(body, now);
  if (v.error) return { status: 400, error: v.error };
  const p = v.ping;
  await db.prepare(
    `INSERT INTO pings (aid, day, kind, n, km_saved, min_saved, lang, prof, ver)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT (aid, day, kind) DO UPDATE SET n = n + 1,
       km_saved = MAX(km_saved, excluded.km_saved), min_saved = MAX(min_saved, excluded.min_saved),
       lang = excluded.lang, prof = excluded.prof, ver = excluded.ver`)
    .bind(p.aid, p.day, p.kind, p.km, p.min, p.lang, p.prof, p.ver).run();
  return { status: 200, body: { ok: true } };
}

/**
 * The numbers that matter, from per-person rows
 * { aid, first, last, days, km, min } (first/last as YYYY-MM-DD).
 * Retention Dn: of the people who started at least n days ago, the share
 * who came back on day n or later.
 */
export function summarize(rows, now) {
  const t = dayNum(today(now));
  const people = rows.length;
  const active = (k) => rows.filter(r => t - dayNum(r.last) < k).length;
  const ret = (n) => {
    const cohort = rows.filter(r => t - dayNum(r.first) >= n);
    if (!cohort.length) return null;
    return Math.round(cohort.filter(r => dayNum(r.last) - dayNum(r.first) >= n).length / cohort.length * 1000) / 10;
  };
  const withSaving = rows.filter(r => r.km > 0);
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null);
  return {
    people, active1: active(1), active7: active(7), active30: active(30),
    retentionD1: ret(1), retentionD7: ret(7), retentionD30: ret(30),
    meanWeekKmSaved: mean(withSaving.map(r => r.km)),
    meanWeekMinSaved: mean(withSaving.map(r => r.min)),
    peopleWithSaving: withSaving.length,
  };
}

export async function stats(db, now) {
  const res = await db.prepare(
    `SELECT aid, MIN(day) AS first, MAX(day) AS last, COUNT(DISTINCT day) AS days,
            MAX(CASE WHEN kind = 'week' THEN km_saved ELSE 0 END) AS km,
            MAX(CASE WHEN kind = 'week' THEN min_saved ELSE 0 END) AS min
     FROM pings GROUP BY aid`).all();
  return { status: 200, body: summarize(res.results || [], now) };
}

export async function purge(db, now) {
  const cutoff = new Date(now - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const r = await db.prepare('DELETE FROM pings WHERE day < ?').bind(cutoff).run();
  return { deleted: (r && r.meta && r.meta.changes) || 0 };
}

/** Constant-time comparison for the stats key. */
export function sameSecret(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
