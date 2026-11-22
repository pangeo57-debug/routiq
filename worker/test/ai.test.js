'use strict';
/**
 * The sentence-understanding route, with a stand-in for Claude: what is sent,
 * what is accepted back, and that nothing outside the schema gets through.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

let AI, W;
before(async () => {
  AI = await import(path.join(__dirname, '..', 'src', 'ai.js'));
  W = await import(path.join(__dirname, '..', 'src', 'index.js'));
});

function fakeClient(answer, extra = {}) {
  const calls = [];
  return { calls, beta: { messages: { create: async (p) => { calls.push(p); return { stop_reason: 'end_turn',
    content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }], ...extra }; } } } };
}
const GOOD = { intent: 'new_client', name: 'Γιώργος Κολυμπήτρας', address: 'Αρέθα 12, Πάτρα', phone: '',
  minutes_per_lesson: 60, lessons_per_week: 2, flexible_total_minutes: 0, subject: '',
  cannot: [{ days: [5], start: '16:00', end: '18:00' }, { days: [4], start: '15:00', end: '21:00' }, { days: [6], start: '', end: '' }] };

describe('what is sent to Claude', () => {
  test('the sentence, the date and the working hours; no client list; structured output; fallbacks on', () => {
    const p = AI.buildParams('Πάμε να βάλουμε τον Γιώργο', { today: '2026-11-13', dayHours: { 1: { start: '14:00', end: '22:00' } }, clients: ['Ζαχαρούλα Θεοχάρη'] });
    assert.equal(p.model, 'claude-opus-5-5');
    assert.equal(p.output_config.format.type, 'json_schema');
    assert.equal(p.output_config.effort, 'low');
    assert.equal(p.fallbacks, 'default');
    assert.deepStrictEqual(p.betas, ['server-side-fallback-2026-07-01']);
    const said = p.messages[0].content;
    assert.match(said, /1: 14:00–22:00/); assert.match(said, /2026-11-13/); assert.match(said, /Πάμε να βάλουμε τον Γιώργο/);
    assert.ok(!/Ζαχαρούλα/.test(JSON.stringify(p)), 'the client list is never sent');
    assert.ok(!('thinking' in p), 'thinking is not configured on this model');
  });
});

describe('what comes back', () => {
  test('a good answer passes through', async () => {
    const out = await AI.understand(fakeClient(GOOD), { text: 'x' });
    assert.equal(out.status, 200);
    assert.equal(out.body.cannot.length, 3);
    assert.equal(out.body.name, 'Γιώργος Κολυμπήτρας');
  });
  test('anything out of range or shape is dropped, not trusted', async () => {
    const bad = { ...GOOD, intent: 'delete_everything', lessons_per_week: 99, minutes_per_lesson: -5, phone: '69 41<script>',
      cannot: [{ days: [9, 2], start: '25:00', end: '18:00' }, { days: [], start: '10:00', end: '11:00' }] };
    const out = (await AI.understand(fakeClient(bad), { text: 'x' })).body;
    assert.equal(out.intent, 'not_about_a_client');
    assert.equal(out.lessons_per_week, 0); assert.equal(out.minutes_per_lesson, 0);
    assert.equal(out.phone, '6941');
    assert.deepStrictEqual(out.cannot, [{ days: [2], start: '', end: '' }]);
  });
  test('a refusal, a cut-off or an unreadable answer is an error, never a guess', async () => {
    assert.equal((await AI.understand(fakeClient(GOOD, { stop_reason: 'refusal' }), { text: 'x' })).status, 422);
    assert.equal((await AI.understand(fakeClient(GOOD, { stop_reason: 'max_tokens' }), { text: 'x' })).status, 502);
    assert.equal((await AI.understand(fakeClient('not json'), { text: 'x' })).status, 502);
  });
  test('an empty or overlong sentence is refused before anything is sent', async () => {
    const c = fakeClient(GOOD);
    assert.equal((await AI.understand(c, { text: '' })).status, 400);
    assert.equal((await AI.understand(c, { text: 'x'.repeat(700) })).status, 413);
    assert.equal(c.calls.length, 0);
  });
});

describe('through the Worker', () => {
  const ORIGIN = 'https://pangeo57-debug.github.io';
  const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };
  test('without a key the route does not work; with one it answers', async () => {
    const req = () => new Request('https://api.example/ai/client', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Πάμε να βάλουμε τον Γιώργο', context: { today: '2026-11-13' } }) });
    const off = await W.handle(req(), { ALLOWED_ORIGINS: ORIGIN, RATE: kv(), CACHE: kv() });
    assert.equal(off.status, 503);
    const on = await W.handle(req(), { ALLOWED_ORIGINS: ORIGIN, RATE: kv(), CACHE: kv(), ANTHROPIC_API_KEY: 'k', _aiClient: fakeClient(GOOD) });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).name, 'Γιώργος Κολυμπήτρας');
  });
  test('the paid model stops at the daily allowance, per person and for everyone', async () => {
    const req = (ip) => new Request('https://api.example/ai/client', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ text: 'Πάμε να βάλουμε τον Γιώργο', context: { today: '2026-11-13' } }) });
    const env = { ALLOWED_ORIGINS: ORIGIN, RATE: kv(), CACHE: kv(), ANTHROPIC_API_KEY: 'k', _aiClient: fakeClient(GOOD), AI_PER_DAY: '1', AI_DAILY_CAP: '2' };
    assert.equal((await W.handle(req('1.1.1.1'), env)).status, 200);
    assert.equal((await W.handle(req('1.1.1.1'), env)).status, 429, 'one each');
    assert.equal((await W.handle(req('2.2.2.2'), env)).status, 200);
    assert.equal((await W.handle(req('3.3.3.3'), env)).status, 429, 'two for everyone');
  });
});

describe('a local model through Ollama, chosen by one setting', () => {
  const ORIGIN = 'https://pangeo57-debug.github.io';
  const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } }; };
  const OLL = { AI_PROVIDER: 'ollama', OLLAMA_URL: 'https://llm.example/', OLLAMA_MODEL: 'qwen2.5:7b' };
  function fakeFetch(reply, status = 200) {
    const calls = [];
    const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) });
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify({ message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }), { status }); };
    f.calls = calls; return f;
  }
  test('which provider: the setting decides, and a half-set one is off', () => {
    assert.equal(AI.provider({ ANTHROPIC_API_KEY: 'k' }), 'claude');
    assert.equal(AI.provider({ AI_PROVIDER: 'ollama', ANTHROPIC_API_KEY: 'k', OLLAMA_URL: 'u', OLLAMA_MODEL: 'm' }), 'ollama');
    assert.equal(AI.provider({ AI_PROVIDER: 'ollama', OLLAMA_URL: 'u' }), null, 'no model named');
    assert.equal(AI.provider({ AI_PROVIDER: 'claude' }), null, 'no key');
    assert.equal(AI.provider({ AI_PROVIDER: 'something' , ANTHROPIC_API_KEY: 'k' }), null);
    assert.equal(AI.provider({}), null);
  });
  test('the same instructions and schema as Claude get, nothing more', async () => {
    const f = fakeFetch(GOOD);
    const out = await AI.understandOllama(f, { ...OLL, OLLAMA_TOKEN: 't' }, { text: 'Πάμε να βάλουμε τον Γιώργο', context: { today: '2026-11-13', clients: ['Ζαχαρούλα'] } });
    assert.equal(out.status, 200); assert.equal(out.body.cannot.length, 3);
    const c = f.calls[0];
    assert.equal(c.url, 'https://llm.example/api/chat');
    assert.equal(c.init.headers.Authorization, 'Bearer t');
    assert.deepStrictEqual(c.body.format, AI.SCHEMA);
    assert.equal(c.body.stream, false); assert.equal(c.body.model, 'qwen2.5:7b');
    assert.equal(c.body.messages[0].content, AI.buildParams('x', {}).system);
    assert.match(c.body.messages[1].content, /2026-11-13/);
    assert.ok(!/Ζαχαρούλα/.test(JSON.stringify(c.body)), 'the client list is never sent');
  });
  test('its answer is cleaned the same way; silence, errors and junk are errors', async () => {
    const bad = (await AI.understandOllama(fakeFetch({ ...GOOD, lessons_per_week: 99, intent: 'x' }), OLL, { text: 'x' })).body;
    assert.equal(bad.lessons_per_week, 0); assert.equal(bad.intent, 'not_about_a_client');
    assert.equal((await AI.understandOllama(fakeFetch(new Error('down')), OLL, { text: 'x' })).status, 504);
    assert.equal((await AI.understandOllama(fakeFetch(GOOD, 500), OLL, { text: 'x' })).status, 502);
    assert.equal((await AI.understandOllama(fakeFetch('not json'), OLL, { text: 'x' })).status, 502);
    const f = fakeFetch(GOOD);
    assert.equal((await AI.understandOllama(f, OLL, { text: '' })).status, 400);
    assert.equal(f.calls.length, 0);
  });
  test('through the Worker: no key needed, Claude never called', async () => {
    const f = fakeFetch(GOOD);
    const claude = fakeClient(GOOD);
    const res = await W.handle(new Request('https://api.example/ai/client', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Πάμε να βάλουμε τον Γιώργο' }) }),
      { ALLOWED_ORIGINS: ORIGIN, RATE: kv(), CACHE: kv(), ...OLL, ANTHROPIC_API_KEY: 'k', _aiClient: claude, _fetch: f });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, 'Γιώργος Κολυμπήτρας');
    assert.equal(f.calls.length, 1); assert.equal(claude.calls.length, 0);
  });
});
