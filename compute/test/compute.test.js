'use strict';
/**
 * The compute server and the app's side of it, end to end: the app builds an
 * anonymous job, the server computes it with the app's own scheduler, the app
 * turns the answer back into people. Plus the one thing that must never
 * happen: anything personal leaving the phone.
 */
process.env.COMPUTE_TIME_SCALE = '0.04';
process.env.RUNS = '1';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('../../test/harness');
const server = require('../server');

let srv, base;
// A browser sends its Origin; node's fetch does not, so the tests add it.
const browserFetch = (url, o = {}) => fetch(url, { ...o, headers: { ...(o.headers || {}), Origin: 'http://localhost:8080' } });
before(async () => { srv = await server.start(0); base = 'http://127.0.0.1:' + srv.address().port; });
after(() => { srv.closeAllConnections(); srv.close(); });

function week(fetchImpl) {
  const app = loadApp({ seed: 5, computeBase: base, fetch: fetchImpl });
  const names = ['Μαρία Παπαδοπούλου', 'Γιώργος Νικολάου', 'Ελένη Κ.', 'Νίκος Π.', 'Άννα Δ.', 'Κώστας Μ.'];
  const sts = names.map((nm, i) => student('id' + i, { name: nm, address: `Κορίνθου ${10 + i}, Πάτρα`,
    phone: '69' + String(41234560 + i), notes: 'κουδούνι 3ος', lessonsPerWeek: 1 + (i % 2),
    days: [1, 2, 3, 4, 5], window: { start: '15:00', end: '21:00' } }));
  const cfg = settings({ homeAddress: 'Πλατεία Γεωργίου 1, Πάτρα', teacherName: 'Παναγιώτης', hereApiKey: 'SECRETKEY' });
  const coords = { home: { lat: 38.2466, lon: 21.7346 } };
  sts.forEach((s, i) => { coords[s.id] = { lat: 38.23 + i / 150, lon: 21.72 + (i % 3) / 120 }; });
  app.setState({ students: sts, settings: cfg, coords, schedule: {}, travelMatrixPeak: null, travelMatrixOffPeak: null, travelMatrix: null });
  return { app, sts, cfg, coords, input: { students: sts, settings: cfg, coords, attempts: 2, warm: null } };
}

describe('what leaves the phone', () => {
  test('no name, address, phone, note, key, home or coordinate is in the job', () => {
    const { app, sts, cfg, coords, input } = week();
    const text = JSON.stringify(app.Remote.build(input).job);
    for (const st of sts) for (const v of [st.name, st.address, st.phone, st.notes, st.id]) assert.ok(!text.includes(v), `"${v}" left the phone`);
    for (const v of [cfg.homeAddress, cfg.teacherName, cfg.hereApiKey]) assert.ok(!text.includes(v), `"${v}" left the phone`);
    for (const c of Object.values(coords)) assert.ok(!text.includes(String(c.lat)) && !text.includes(String(c.lon)), 'a real coordinate left the phone');
  });
  test('the server refuses a job with anything personal in it', () => {
    const { app, input } = week();
    const { job } = app.Remote.build(input);
    assert.equal(server.validate(job), null);
    const named = JSON.parse(JSON.stringify(job)); named.input.students[0].name = 'Μαρία';
    assert.match(server.validate(named), /name/);
    const realId = JSON.parse(JSON.stringify(job)); realId.input.students[0].id = 'id0';
    assert.match(server.validate(realId), /anonymous/);
    const home = JSON.parse(JSON.stringify(job)); home.input.settings.homeAddress = 'Κορίνθου 1';
    assert.match(server.validate(home), /homeAddress/);
  });
});

describe('computed on the server, returned as people', () => {
  test('every lesson placed, the real ids and names back, no rule broken', async () => {
    const { app, sts, cfg, input } = week(browserFetch);
    const out = await app.Remote.optimize(input, null, () => false);
    const S = app.Scheduler;
    assert.equal(S.countTotal(out.schedule), sts.reduce((a, s) => a + s.lessonsPerWeek, 0));
    for (const d of Object.keys(out.schedule)) for (const sl of out.schedule[d]) {
      const st = sts.find(x => x.id === sl.studentId);
      assert.ok(st, 'a slot names someone who is not a client: ' + sl.studentId);
      assert.equal(sl.studentName, st.name); assert.equal(sl.address, st.address);
    }
    assert.deepStrictEqual(Array.from(S.verifySchedule(out.schedule, sts, cfg)), []);
    assert.equal(app.Remote.hasPending(), false, 'a finished job is not left pending');
  });

  test('coming back to a job already running picks it up instead of starting another', async () => {
    let posts = 0;
    const counting = (url, o) => { if (o && o.method === 'POST') posts++; return browserFetch(url, o); };
    const { app, input } = week(counting);
    const first = app.Remote.optimize(input, null, () => false);   // the page that was left
    for (let i = 0; i < 250 && !app.Remote.hasPending(); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(app.Remote.hasPending(), 'the job was not accepted');
    const second = await app.Remote.optimize(input, null, () => false);  // the page coming back
    await first;
    assert.equal(posts, 1, 'the same week must not be sent twice');
    assert.ok(app.Scheduler.countTotal(second.schedule) > 0);
  });

  test('stopping deletes the job on the server', async () => {
    const { app, input } = week(browserFetch);
    await assert.rejects(app.Remote.optimize(input, null, () => true), /cancelled/);
    let job;
    for (let i = 0; i < 100; i++) {
      job = [...server.jobs.values()].find(j => j.status === 'cancelled' && j.finishedAt);
      if (job) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(job, 'the job must stop and be wound up');
    assert.equal(job.threads.size, 0);
  });
});

describe('reminders with the app closed', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'x', auth: 'y' } };
  test('only times and opaque keys are accepted; a text field is ignored, a bad key refused', () => {
    const now = Date.now();
    assert.equal(server.setReminders({ push: sub, items: [{ t: now + 100, k: 'a1b2c3d4e5f6' }] }, now), null);
    assert.match(server.setReminders({ push: sub, items: [{ t: now + 100, k: 'Μαρία Κορίνθου 12' }] }, now), /key/);
    assert.match(server.setReminders({ push: sub, items: [{ t: now + 3 * 86400000, k: 'a1b2c3d4' }] }, now), /next day/);
  });
  test('each fires at its time, and a new set replaces the old one', async () => {
    const now = Date.now();
    server.setReminders({ push: sub, items: [{ t: now + 50, k: 'aaaaaaaa' }, { t: now + 5000, k: 'bbbbbbbb' }] }, now);
    server.setReminders({ push: sub, items: [{ t: now + 80, k: 'cccccccc' }] }, now);
    await new Promise(r => setTimeout(r, 250));
    const keys = server.sent.map(x => x.k);
    assert.ok(keys.includes('cccccccc'));
    assert.ok(!keys.includes('aaaaaaaa'), 'the replaced set must not fire');
  });
  test('the phone sends the server no name and no address for a reminder', () => {
    const src = require('../../tools/assemble').assemble(require('path').join(__dirname, '..', '..', 'routiq.html'));
    const body = src.slice(src.indexOf('  async _pushReminders('), src.indexOf('  _remind(x){'));
    assert.match(body, /items\.push\(\{ t: at, k \}\)/);
    assert.match(body, /JSON\.stringify\(\{ push, items, fallback/);
    assert.match(body, /RemindStore\.replace\(texts\)/);
  });
});

describe('abuse guards', () => {
  const S = require('../server.js');
  test('push only to the browsers\' own push services', () => {
    assert.equal(S.pushOk({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }), true);
    assert.equal(S.pushOk({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x' }), true);
    assert.equal(S.pushOk({ endpoint: 'https://web.push.apple.com/x' }), true);
    assert.equal(S.pushOk({ endpoint: 'https://evil.example/x' }), false);
    assert.equal(S.pushOk({ endpoint: 'https://fcm.googleapis.com.evil.example/x' }), false);
    assert.equal(S.pushOk({ endpoint: 'http://fcm.googleapis.com/x' }), false);
    assert.equal(S.setReminders({ push: { endpoint: 'https://evil.example/x' }, items: [] }, Date.now()), 'push subscription required');
  });
  test('a header the caller writes is not their address unless a proxy is trusted', () => {
    const req = { headers: { 'x-forwarded-for': '9.9.9.9', 'cf-connecting-ip': '8.8.8.8' }, socket: { remoteAddress: '1.2.3.4' } };
    const keep = S.CONF.ipHeader;
    S.CONF.ipHeader = '';
    assert.equal(S.clientIp(req), '1.2.3.4');
    S.CONF.ipHeader = 'cf-connecting-ip';
    assert.equal(S.clientIp(req), '8.8.8.8');
    S.CONF.ipHeader = keep;
  });
  test('reminders have their own hourly limit per address', () => {
    const now = Date.now();
    let ok = 0;
    for (let i = 0; i < S.CONF.remindersPerIpHour + 5; i++) if (S.allowIp('5.5.5.5', now, 'reminders')) ok++;
    assert.equal(ok, S.CONF.remindersPerIpHour);
  });
});
