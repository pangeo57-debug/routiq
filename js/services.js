// What each "in 15 minutes" reminder says, kept on the phone for the
// service worker (which cannot read localStorage). Replaced as a whole each
// time the day's reminders are set.
const RemindStore = {
  _db(){ return new Promise((res, rej) => { const r = indexedDB.open('routepal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('remind');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async replace(texts){
    if(typeof indexedDB === 'undefined') return;
    const db = await this._db();
    await new Promise((res, rej) => { const tx = db.transaction('remind', 'readwrite'), st = tx.objectStore('remind');
      st.clear(); for(const [k, v] of Object.entries(texts)) st.put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
};

const Remote = {
  KEY: 'rp_remote_job',
  available(){ return !!COMPUTE_BASE; },
  _url(p){ return COMPUTE_BASE.replace(/\/$/, '') + p; },
  STUDENT_FIELDS: ['lessonsPerWeek','lessonDuration','durations','hoursPerWeek','flexMinutes','minBlock','maxBlock',
    'availability','availabilityExceptions','availabilityMode','type','mergeMode','forceMerge','maxMergeSessions'],
  SETTING_FIELDS: ['workDays','dayHours','dateHours','blockedSlots','lunchBreak','maxPerDay','travelMargin','travelBuffer',
    'travelMode','endFlexMin','avgCitySpeedKmh','osrmTimeFactor','scheduleQuality','profession','language','fuelConsumption'],

  /** The anonymous job, and what is needed to turn its answer back into people. */
  build(input){
    const students = input.students, settings = input.settings;
    const ids = new Map(), groups = new Map(), subjects = new Map(), places = new Map();
    students.forEach((st, i) => ids.set(st.id, '§s' + (i + 1)));
    const code = (m, prefix, v) => { if(!v) return v; if(!m.has(v)) m.set(v, prefix + (m.size + 1)); return m.get(v); };
    const anonStudents = students.map(st => {
      const a = { id: ids.get(st.id), name: '', address: code(places, '§p', Scheduler._placeKey(st.address)) || '', color: 0,
        group: code(groups, '§g', st.group) || '', subject: code(subjects, '§x', st.subject) || '',
        pairedWith: st.pairedWith && ids.has(st.pairedWith) ? ids.get(st.pairedWith) : null };
      for(const f of this.STUDENT_FIELDS) if(st[f] !== undefined) a[f] = JSON.parse(JSON.stringify(st[f]));
      return a;
    });
    const anonSettings = { homeAddress: '' };
    for(const f of this.SETTING_FIELDS) if(settings[f] !== undefined) anonSettings[f] = JSON.parse(JSON.stringify(settings[f]));
    // The travel matrix, asked of the same estimator every plan uses (HERE,
    // OSRM or the straight line), in both traffic bands.
    const realIds = ['home', ...students.map(st => st.id)];
    const addrOf = (id) => id === 'home' ? (settings.homeAddress || '') : (students.find(x => x.id === id) || {}).address || '';
    const band = (at) => {
      const durations = [], distances = [];
      for(const a of realIds){
        const dr = [], kr = [];
        for(const b of realIds){
          if(a === b){ dr.push(0); kr.push(0); continue; }
          dr.push(Scheduler.travelEstMin(a, addrOf(a), b, addrOf(b), 1, at) * 60);
          kr.push(Math.round(Scheduler.travelEstKm(a, addrOf(a), b, addrOf(b), 1, at) * 1000));
        }
        durations.push(dr); distances.push(kr);
      }
      return { coordIds: ['home', ...anonStudents.map(x => x.id)], durations, distances };
    };
    const peak = band(Scheduler.PEAK_FROM);
    const off = state.travelMatrixOffPeak ? band(Scheduler.PEAK_TO) : null;
    const coords = this._embed(peak);
    const warm = input.warm ? this._rename(input.warm, ids) : null;
    const job = { v: 1, input: { students: anonStudents, settings: anonSettings, coords, attempts: input.attempts, warm },
      matrix: { peak, off } };
    const back = { ids: [...ids].map(([r, a]) => [a, r]), groups: [...groups].map(([r, a]) => [a, r]),
      subjects: [...subjects].map(([r, a]) => [a, r]) };
    return { job, back };
  },

  // Positions for the codes, made up from the matrix alone (classical
  // multidimensional scaling): the optimiser uses positions only to decide
  // which clients are neighbours, and real ones would say where people live.
  _embed(m){
    const n = m.coordIds.length, D = m.distances;
    const D2 = []; for(let i = 0; i < n; i++){ D2.push([]); for(let j = 0; j < n; j++) D2[i].push(((D[i][j] + D[j][i]) / 2000) ** 2); }
    const rm = D2.map(r => r.reduce((a, b) => a + b, 0) / n), all = rm.reduce((a, b) => a + b, 0) / n;
    const B = D2.map((r, i) => r.map((v, j) => -0.5 * (v - rm[i] - rm[j] + all)));
    const vecs = [];
    for(let e = 0; e < 2; e++){
      let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1 + e)), lam = 0;
      for(let it = 0; it < 200; it++){
        let w = B.map(r => r.reduce((a, b, j) => a + b * v[j], 0));
        for(const [u] of vecs){ const p = w.reduce((a, b, j) => a + b * u[j], 0); w = w.map((x, j) => x - p * u[j]); }
        const norm = Math.hypot(...w) || 1; lam = norm; v = w.map(x => x / norm);
      }
      vecs.push([v, lam]);
    }
    const KM = 111.32, LON = KM * Math.cos(38 * Math.PI / 180), out = {};
    m.coordIds.forEach((id, i) => { out[id] = { lat: 38 + vecs[0][0][i] * Math.sqrt(vecs[0][1]) / KM, lon: 21 + vecs[1][0][i] * Math.sqrt(vecs[1][1]) / LON }; });
    return out;
  },

  // Replace every id string by its counterpart: the schedule and the result
  // carry ids in studentId, pairedStudentId and groupMemberIds.
  _rename(x, map){
    const get = (v) => (map instanceof Map ? map.get(v) : map[v]);
    const walk = (v) => {
      if(typeof v === 'string'){ const r = get(v); return r === undefined ? v : r; }
      if(Array.isArray(v)) return v.map(walk);
      if(v && typeof v === 'object'){ const o = {}; for(const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
      return v;
    };
    return walk(x);
  },

  /** The answer, back into people: ids, names, addresses, subjects, groups. */
  restore(out, back, students){
    const m = new Map([...back.ids, ...back.groups, ...back.subjects]);
    const r = this._rename({ schedule: out.schedule, result: out.result, students: out.students }, m);
    const byId = Object.fromEntries(students.map(st => [st.id, st]));
    for(const d of Object.keys(r.schedule || {})){
      r.schedule[d] = (r.schedule[d] || []).map(sl => {
        const st = byId[sl.studentId];
        if(!st) return sl;
        const members = (sl.groupMemberIds || []).map(id => byId[id]).filter(Boolean);
        return { ...sl, studentName: members.length > 1 ? members.map(x => x.name).join(' & ') : st.name,
          address: st.address, subject: sl.isGroup ? (st.subject || '—') : (st.subject || sl.subject), color: st.color || 0 };
      });
    }
    // Clients in the result are the real ones, not their anonymous copies.
    const real = (v) => (v && typeof v === 'object' && v.id && byId[v.id]) ? byId[v.id] : v;
    if(r.result && Array.isArray(r.result.unplaced)) r.result.unplaced = r.result.unplaced.map(real);
    r.students = (r.students || []).map(a => byId[a.id] ? { ...byId[a.id], durations: a.durations, lessonsPerWeek: a.lessonsPerWeek,
      hoursPerWeek: a.hoursPerWeek, lessonDuration: a.lessonDuration } : a);
    return r;
  },

  _fingerprint(job){
    const s = JSON.stringify([job.input.students, job.input.settings, job.matrix.peak.durations]);
    let h = 2166136261; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  },
  _pending(){ try{ return JSON.parse(localStorage.getItem(this.KEY)); }catch(e){ return null; } },
  _setPending(v){ try{ v ? localStorage.setItem(this.KEY, JSON.stringify(v)) : localStorage.removeItem(this.KEY); }catch(e){} },
  hasPending(){ const p = this._pending(); return !!(p && p.id && Date.now() - (p.at || 0) < 20 * 3600 * 1000); },

  async _push(){
    try{
      if(!VAPID_PUBLIC || typeof navigator === 'undefined' || !navigator.serviceWorker || typeof Notification === 'undefined') return null;
      if(Notification.permission === 'default') await Notification.requestPermission();
      if(Notification.permission !== 'granted') return null;
      const reg = await navigator.serviceWorker.ready;
      const raw = atob(VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - VAPID_PUBLIC.length % 4) % 4));
      const key = Uint8Array.from(raw, c => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      return sub.toJSON();
    }catch(e){ return null; }
  },

  /**
   * The week, computed on the server. Same answer shape as _optimizeParallel.
   * A job already running for the same input is picked up, not started again.
   */
  async optimize(input, onProgress, stopped){
    const { job, back } = this.build(input);
    const fp = this._fingerprint(job);
    let p = this._pending();
    let id = p && p.fp === fp && this.hasPending() ? p.id : null;
    if(!id){
      const push = await this._push();
      const res = await fetch(this._url('/jobs'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...job, push, notify: { title: t('notif_schedule_ready_title'), body: t('notif_schedule_ready_body') } }) });
      if(!res.ok) throw new Error('remote-' + res.status);
      id = (await res.json()).id;
      this._setPending({ id, fp, back, at: Date.now() });
    }
    const saved = this._pending();
    for(let failures = 0;;){
      if(stopped && stopped()){
        try{ fetch(this._url('/jobs/' + id), { method: 'DELETE' }).catch(() => {}); }catch(e){}
        this._setPending(null);
        throw new Error('cancelled');
      }
      let st = null;
      try{
        const r = await fetch(this._url('/jobs/' + id));
        if(r.status === 404){ this._setPending(null); throw new Error('remote-lost'); }
        st = await r.json(); failures = 0;
      }catch(e){
        if(e && e.message === 'remote-lost') throw e;
        if(++failures > 30) throw new Error('remote-unreachable');      // about a minute without the server
      }
      if(st){
        if(st.progress && onProgress) onProgress(...st.progress);
        if(st.status === 'done'){ this._setPending(null); return this.restore(st.result, (saved || {}).back || back, input.students); }
        if(st.status === 'failed' || st.status === 'cancelled'){ this._setPending(null); throw new Error('remote-' + st.status); }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  },
};

// Understanding sentences with AI, opt-in. The phone's own rules read most
// sentences; with this on, a sentence that looks like it is about a client
// goes to Claude through the Worker (worker/src/ai.js), and what comes back
// is shown as "understood: …" with Correct / Fix / Cancel like everything
// else. Sent: the sentence, today's date, the working hours, the language.
// Not the client list. Errands ("φαρμακείο αύριο στις 11") are never sent.
const AiAssist = {
  available(){ return !!API_BASE; },
  on(){ return !!(state.settings && state.settings.aiAssist === true); },
  // Worth asking AI about: words people use about a client, or a sentence
  // that starts with someone already on the list.
  CUES: ['δεν μπορ','φορες','φορα','ωρες','ωρα ','λεπτα','πελατ','μαθητ','βαλουμε','βαλε','προσθεσ','καταχωρ','μενει','ξεχωριστ','χωριστ','σπαστ','διευθυνσ','τηλεφων'],
  looksLikeClient(text){
    const n = ' ' + normalizeSearchText(text) + ' ';
    if(this.CUES.some(c => n.includes(c))) return true;
    try{ const w = ClientCommand._words(text).norm; const who = ClientCommand.findClient(w, state.students || []); return !!(who && !who.ambiguous); }catch(e){ return false; }
  },
  // Asked once, the first time it would help. Closing it is a no.
  maybeAsk(){
    if(!this.available() || state.settings.aiAssist !== undefined) return;
    state.settings.aiAssist = false; Storage.saveSettings(state.settings);
    App.confirm(t('ai_ask_title'), t('ai_ask_text'), () => { state.settings.aiAssist = true; Storage.saveSettings(state.settings); Toast.show(t('ai_on'), 'success'); }, t('ai_ask_ok'), false);
  },
  // The draft the rest of the app understands, or null.
  async draft(text){
    const url = apiUrl('/ai/client'); if(!url) return null;
    const ctx = { today: App.todayISO(), lang: state.settings.language || 'el', dayHours: state.settings.dayHours || {} };
    let r;
    try{
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, context: ctx }) });
      if(!res.ok) return null;
      r = await res.json();
    }catch(e){ return null; }
    if(!r || r.intent === 'not_about_a_client' || !r.name) return null;
    const toMin = (x) => x ? Scheduler.toMin(x) : null;
    const flex = r.flexible_total_minutes > 0;
    return { name: r.name, address: r.address || '', phone: r.phone || '',
      minutes: flex ? r.flexible_total_minutes : (r.minutes_per_lesson || null), flex,
      perWeek: !flex && r.lessons_per_week ? r.lessons_per_week : null, subject: this._subject(r.subject),
      cannot: (r.cannot || []).map(c => ({ days: c.days, start: toMin(c.start), end: toMin(c.end) })),
      explicit: r.intent === 'new_client', viaAi: true };
  },
  // A subject said in words, to one of the profession's own if it matches.
  _subject(said){
    if(!said) return null;
    const n = normalizeSearchText(said);
    return getSubjects().find(sub => normalizeSearchText(sub) === n || normalizeSearchText(subjectLabel(sub)) === n) || null;
  },
};

// Anonymous usage counts, opt-in. Asked once, after the first plan; nothing
// is sent before a yes, and nothing at all without a proxy (API_BASE). A ping
// carries a random id made up here, what was done, and the saving the app
// measured — never a name, address, coordinate or schedule. Once a day per
// kind at most. The Worker side is worker/src/analytics.js.
const Usage = {
  KEY: 'rp_usage',
  _get(){ try{ return JSON.parse(localStorage.getItem(this.KEY)) || {}; }catch(e){ return {}; } },
  _set(v){ try{ localStorage.setItem(this.KEY, JSON.stringify(v)); }catch(e){} },
  available(){ return !!API_BASE; },
  on(){ return this._get().consent === true; },
  setConsent(on){
    const v = this._get();
    v.consent = !!on;
    if(on && !v.aid){
      const b = new Uint8Array(16);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => b[i] = Math.random() * 256);
      v.aid = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    }
    if(!on){ delete v.aid; delete v.sent; }
    this._set(v);
  },
  // The one question, asked once. Closing it is a no.
  maybeAsk(){
    if(!this.available()) return;
    const v = this._get();
    if(v.consent !== undefined) return;
    v.consent = false; this._set(v);
    App.confirm(t('usage_ask_title'), t('usage_ask_text'), () => this.setConsent(true), t('usage_ask_ok'), false);
  },
  ping(kind, saved){
    if(!this.available()) return;
    const v = this._get();
    if(v.consent !== true || !v.aid) return;
    const day = new Date().toISOString().slice(0, 10);
    v.sent = v.sent || {};
    if(v.sent[kind] === day) return;
    v.sent[kind] = day; this._set(v);
    const st = state.settings || {};
    const body = { aid: v.aid, kind, lang: st.language || null, prof: st.profession || null, ver: '1' };
    if(saved && saved.same){ body.km = Math.max(0, saved.km); body.min = Math.max(0, saved.minutes); }
    try{
      fetch(apiUrl('/a/ping'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), keepalive: true }).catch(() => {});
    }catch(e){}
  },
};
// The user's OWN key, or empty. Empty no longer means "fall back to a shared
// key in this file" — it means the request goes through the proxy, or to the
// free services if there is no proxy.
function getHereKey(){
  return (state.settings && state.settings.hereApiKey) || '';
}

// ============================================================
// SYNC — one person's data, on more than one device
// ============================================================
//
// The server stores an encrypted blob and nothing else. The key is derived
// here, on the device, from a code that is never sent: what leaves is
// ciphertext plus a hash that proves we know the code. Nobody running the
// server — including whoever ends up with the database — can read a name, an
// address or a schedule.
//
// The price is stated plainly in the UI: lose the code and the data on the
// server is gone. For a backup of data that also lives on the device, that is
// an honest trade rather than a nasty surprise.
//
// One device writes, the rest read. A second device can take over, but only
// by saying so — a phone left in a drawer must not quietly overwrite the
// laptop that has been doing the real work.

const Sync = {
  // Unambiguous alphabet: no O/0, no I/1/l. People read these codes aloud and
  // type them on phone keyboards.
  ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  ID_LEN: 12,
  SECRET_LEN: 12,
  PBKDF2_ROUNDS: 210000,

  _subtle(){
    const c = (typeof crypto !== 'undefined') ? crypto : null;
    return (c && c.subtle) ? c.subtle : null;
  },
  available(){ return !!this._subtle() && !!API_BASE; },

  randomCode(){
    const n = this.ID_LEN + this.SECRET_LEN;
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    let out = '';
    for(let i=0;i<n;i++) out += this.ALPHABET[bytes[i] % this.ALPHABET.length];
    return out;
  },

  /** "ABCD-EFGH-..." for reading out loud; parsing ignores the dashes. */
  format(code){ return (code.match(/.{1,4}/g) || []).join('-'); },
  parse(text){
    const up = String(text||'').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return up.length === this.ID_LEN + this.SECRET_LEN ? up : null;
  },
  spaceIdOf(code){ return code.slice(0, this.ID_LEN); },
  secretOf(code){ return code.slice(this.ID_LEN); },

  _hex(buf){ return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join(''); },

  /** What the server is told: a hash of the code, never the code. */
  async authHash(code){
    const data = new TextEncoder().encode('routepal-auth:' + code);
    return this._hex(await this._subtle().digest('SHA-256', data));
  },

  async _key(code){
    const sub = this._subtle();
    const base = await sub.importKey('raw', new TextEncoder().encode(this.secretOf(code)),
      'PBKDF2', false, ['deriveKey']);
    return sub.deriveKey(
      { name:'PBKDF2', salt: new TextEncoder().encode('routepal:' + this.spaceIdOf(code)),
        iterations: this.PBKDF2_ROUNDS, hash:'SHA-256' },
      base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
  },

  _b64(bytes){ let s=''; for(const b of bytes) s += String.fromCharCode(b); return btoa(s); },
  _unb64(text){ const bin = atob(text); const out = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; },

  // Ciphertext is as long as what went in, so an unpadded blob announces how
  // much work you have — roughly how many clients — to anyone who can see its
  // size, including the server. Rounding up to a 16KB step turns that into a
  // very coarse band instead of a number.
  PAD_STEP: 16 * 1024,

  _pad(bytes){
    const target = Math.max(this.PAD_STEP, Math.ceil((bytes.length + 4) / this.PAD_STEP) * this.PAD_STEP);
    const out = new Uint8Array(target);
    // Length first, so the padding can be removed exactly. It is inside the
    // encryption, so the server never sees it.
    new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(bytes, 4);
    return out;
  },
  _unpad(bytes){
    if(bytes.length < 4) return bytes;
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    // An older blob, written before padding existed, has no length header —
    // fall back to reading the whole thing rather than truncating it to junk.
    return (n > 0 && n <= bytes.length - 4) ? bytes.slice(4, 4 + n) : bytes;
  },

  async encrypt(code, obj){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this._key(code);
    const pt = this._pad(new TextEncoder().encode(JSON.stringify(obj)));
    const ct = await this._subtle().encrypt({ name:'AES-GCM', iv }, key, pt);
    // The nonce rides with the ciphertext; it is not a secret, and reusing one
    // with the same key is what actually breaks AES-GCM.
    const packed = new Uint8Array(iv.length + ct.byteLength);
    packed.set(iv, 0); packed.set(new Uint8Array(ct), iv.length);
    return this._b64(packed);
  },

  async decrypt(code, blob){
    const packed = this._unb64(blob);
    const iv = packed.slice(0, 12), ct = packed.slice(12);
    const key = await this._key(code);
    // AES-GCM authenticates: a wrong code or a tampered blob throws here
    // rather than returning plausible rubbish.
    const pt = await this._subtle().decrypt({ name:'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(this._unpad(new Uint8Array(pt))));
  },

  /** This device's own id — random, local, and not derived from anything. */
  deviceId(){
    let id = null;
    try{ id = localStorage.getItem('rp_device_id'); }catch(e){}
    if(!id){
      const b = new Uint8Array(9); crypto.getRandomValues(b);
      id = 'd' + [...b].map(x=>x.toString(36)).join('').slice(0,16);
      try{ localStorage.setItem('rp_device_id', id); }catch(e){}
    }
    return id;
  },

  /**
   * Exactly what gets synced — the same shape the backup file uses, minus the
   * sync record itself. That record holds this device's code and which device
   * is primary; neither belongs in a snapshot that another device restores,
   * and the code has no reason to travel at all.
   */
  snapshot(){
    const settings = { ...state.settings };
    delete settings.sync;
    return { students: state.students, jobs: state.jobs || [],
             schedule: state.schedule, coords: state.coords,
             settings, savedAt: new Date().toISOString() };
  },

  async _call(action, body){
    const url = apiUrl('/sync/' + action);
    if(!url) throw new Error('sync not configured');
    const r = await Router._fetch(url, { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, 20000);
    const data = await r.json().catch(()=>({}));
    return { ok: r.ok, status: r.status, data };
  },
};

