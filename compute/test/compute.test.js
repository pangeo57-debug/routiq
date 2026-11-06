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
