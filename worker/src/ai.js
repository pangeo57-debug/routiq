/**
 * Understanding a sentence about a client, with Claude or a local model.
 *
 * One setting chooses who reads it: AI_PROVIDER = "claude" (the default
 * when ANTHROPIC_API_KEY is set) or "ollama" (a model on your own server,
 * OLLAMA_URL and OLLAMA_MODEL, OLLAMA_TOKEN if it sits behind a proxy that
 * wants one). Both get the same instructions and the same schema, and both
 * answers go through the same clean().
 *
 * The app reads most sentences itself, by rules, on the phone. What its rules
 * cannot read comes here — only when the person has switched it on — and
 * goes back as structured data that the app shows as "understood: …" with
 * Correct / Fix / Cancel. Nothing is saved from here, and nothing is kept.
 *
 * What is sent: the sentence, today's date, the working hours (so "5" can be
 * read as 17:00), the language. Not the client list: matching a name to a
 * client is done on the phone.
 */

export const MODEL = 'claude-opus-5-5';
export const MAX_TEXT = 600;

const DAYS = { type: 'array', items: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7] } };
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'name', 'address', 'phone', 'minutes_per_lesson', 'lessons_per_week',
    'flexible_total_minutes', 'subject', 'cannot'],
  properties: {
    intent: { type: 'string', enum: ['new_client', 'update_client', 'not_about_a_client'] },
    name: { type: 'string' },
    address: { type: 'string' },
    phone: { type: 'string' },
    minutes_per_lesson: { type: 'integer' },
    lessons_per_week: { type: 'integer' },
    flexible_total_minutes: { type: 'integer' },
    subject: { type: 'string' },
    cannot: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['days', 'start', 'end'],
        properties: { days: DAYS, start: { type: 'string' }, end: { type: 'string' } },
      },
    },
  },
};

const SYSTEM = `You read one sentence that a self-employed professional (a tutor, a physiotherapist, a trainer, a cleaner, a technician) says or types into their scheduling app about a client, usually in Greek, often spoken and transcribed, informal and imperfect. Return what it says as the JSON schema requires.

- intent: "new_client" when they add someone ("πάμε να βάλουμε…", "νέος πελάτης…", a name with an address and lesson details); "update_client" when they change someone already known ("ο Γιώργος δεν μπορεί πια Τρίτη", "η Μαρία θέλει 2 φορές"); "not_about_a_client" for errands, reminders or anything else.
- name: the client's name in the nominative, as it would be written on a contact card ("τον Γιώργο Κολυμπήτρα" → "Γιώργος Κολυμπήτρας"). Empty if none.
- address: street, number and town as said, ready for a map search; numbers in digits ("πενήντα δύο" → 52). Empty if none.
- phone: digits only, empty if none.
- minutes_per_lesson: the length of one session in minutes; 0 if not said.
- lessons_per_week: sessions a week; 0 if not said. "2 ώρες ξεχωριστές / χωριστά" means 2 sessions of 60 minutes. "2 ώρες μαζί" means 1 session of 120.
- flexible_total_minutes: only when they say the weekly time may be split however fits ("σπαστά", "μαζί ή σπαστά", "όπως βγει"): the total minutes a week; otherwise 0.
- subject: the lesson or service if named, else empty.
- cannot: every time they say the client cannot do, each with weekdays (1 Monday … 7 Sunday) and 24-hour "HH:MM" start and end, or empty start and end for the whole day. Keep all of them, also when "δεν μπορεί" is said only once for several days. Hours said without morning or afternoon belong to the working hours given below: someone working 14:00–22:00 who says "5 με 7" means 17:00–19:00. "Το πρωί" is 08:00–13:00, "το απόγευμα" 13:00–20:00, "το βράδυ" 19:00–23:00 unless they give hours.

Do not invent anything that was not said: leave it empty or 0.`;

/** What the model is told about the sentence: it, the date, the working hours. */
function userText(text, ctx) {
  const hours = Object.entries((ctx && ctx.dayHours) || {})
    .filter(([d, h]) => /^[1-7]$/.test(d) && h && /^\d{2}:\d{2}$/.test(h.start) && /^\d{2}:\d{2}$/.test(h.end))
    .map(([d, h]) => `${d}: ${h.start}–${h.end}`).join(', ');
  const today = ctx && /^\d{4}-\d{2}-\d{2}$/.test(ctx.today) ? ctx.today : '';
  return `Working hours by weekday: ${hours || 'not set'}.\nToday: ${today || 'unknown'}.\nSentence: ${text}`;
}

/** The request to Claude: the sentence, and only what is needed to read times and dates. */
export function buildParams(text, ctx) {
  return {
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: userText(text, ctx) }],
  };
}

/** The same request for Ollama's /api/chat: the schema goes in `format`. */
export function ollamaParams(text, ctx, model) {
  return {
    model,
    stream: false,
    format: SCHEMA,
    options: { temperature: 0 },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userText(text, ctx) }],
  };
}

/** Which provider the Worker's settings choose, or null when none is set up. */
export function provider(env) {
  const p = String((env && env.AI_PROVIDER) || '').trim().toLowerCase();
  if (p === 'ollama') return env.OLLAMA_URL && env.OLLAMA_MODEL ? 'ollama' : null;
  if (p === '' || p === 'claude') return env && env.ANTHROPIC_API_KEY ? 'claude' : null;
  return null;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Only what the schema allows, in range; the app re-checks everything again. */
export function clean(x) {
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const i = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : 0);
  const cannot = (Array.isArray(x && x.cannot) ? x.cannot : []).slice(0, 14).map(c => {
    const days = [...new Set((Array.isArray(c && c.days) ? c.days : []).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))];
    let start = HM.test(c && c.start) ? c.start : '', end = HM.test(c && c.end) ? c.end : '';
    if (!start || !end || end <= start) { start = ''; end = ''; }
    return { days, start, end };
  }).filter(c => c.days.length);
  return {
    intent: ['new_client', 'update_client', 'not_about_a_client'].includes(x && x.intent) ? x.intent : 'not_about_a_client',
    name: s(x && x.name, 80), address: s(x && x.address, 160), phone: s(x && x.phone, 20).replace(/[^\d+]/g, ''),
    minutes_per_lesson: i(x && x.minutes_per_lesson, 15, 480), lessons_per_week: i(x && x.lessons_per_week, 1, 14),
    flexible_total_minutes: i(x && x.flexible_total_minutes, 15, 2400), subject: s(x && x.subject, 60), cannot,
  };
}

function sentence(body) {
  const text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { error: { status: 400, error: 'text required' } };
  if (text.length > MAX_TEXT) return { error: { status: 413, error: 'text too long' } };
  return { text };
}

export async function understand(client, body) {
  const { text, error } = sentence(body);
  if (error) return error;
  const response = await client.beta.messages.create(buildParams(text, body.context));
  if (response.stop_reason === 'refusal') return { status: 422, error: 'declined' };
  if (response.stop_reason === 'max_tokens') return { status: 502, error: 'incomplete' };
  const block = (response.content || []).find(b => b.type === 'text');
  if (!block) return { status: 502, error: 'no answer' };
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { return { status: 502, error: 'unreadable answer' }; }
  return { status: 200, body: clean(parsed) };
}

/**
 * The same, from a model on your own server through Ollama. `fetchFn` is the
 * Worker's fetch (a stand-in in the tests). A slow or absent server is an
 * error, never a guess: the app then keeps what its rules understood.
 */
export async function understandOllama(fetchFn, env, body) {
  const { text, error } = sentence(body);
  if (error) return error;
  const url = String(env.OLLAMA_URL).replace(/\/+$/, '') + '/api/chat';
  const headers = { 'Content-Type': 'application/json' };
  if (env.OLLAMA_TOKEN) headers.Authorization = 'Bearer ' + env.OLLAMA_TOKEN;
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(ollamaParams(text, body.context, env.OLLAMA_MODEL)),
      signal: AbortSignal.timeout(Number(env.OLLAMA_TIMEOUT_MS) || 30000) });
  } catch { return { status: 504, error: 'local model did not answer' }; }
  if (!res.ok) return { status: 502, error: 'local model error ' + res.status };
  let parsed;
  try { const data = await res.json(); parsed = JSON.parse(data && data.message && data.message.content); }
  catch { return { status: 502, error: 'unreadable answer' }; }
  return { status: 200, body: clean(parsed) };
}
