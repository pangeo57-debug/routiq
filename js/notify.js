// ============================================================
// NOTIFY — tell the clients whose times changed, in one go
// ============================================================
// The app remembers, per client, the times that client was last told (or
// knew already). When the week changes, those whose times differ are listed
// with what was and what is, and a ready message for WhatsApp or SMS. Sending
// one, or ticking it, marks that client as told. Nothing is sent by itself:
// every message goes out from the person's own phone, by their tap.
//
// The first time there is a week, it is taken as known: the person's clients
// already know the times they have. Only later changes are listed.
const Notify = {
  KEY: 'rp_told',
  load(){ try{ const v = JSON.parse(localStorage.getItem(this.KEY) || 'null'); return v && typeof v === 'object' ? v : null; }catch(e){ return null; } },
  save(v){ try{ localStorage.setItem(this.KEY, JSON.stringify(v)); }catch(e){} },

  // A client's week as text, one line a lesson; '' when they have none.
  lines(sid){ return (typeof App !== 'undefined' && App._weekTimeLines) ? App._weekTimeLines(sid) : []; },
  sig(sid){ return this.lines(sid).join('\n'); },

  // The week as the clients know it, taken the first time there is one.
  baseline(){
    let told = this.load();
    if(told) return told;
    const any = Object.values(state.schedule || {}).some(d => (d || []).length);
    if(!any) return null;
    told = {};
    for(const st of state.students || []) told[st.id] = this.sig(st.id);
    this.save(told);
    return told;
  },

  // Clients whose times differ from what they were told: [{ st, before, now }].
  changed(){
    const told = this.baseline();
    if(!told) return [];
    const out = [];
    for(const st of state.students || []){
      const now = this.sig(st.id), before = told[st.id] == null ? '' : told[st.id];
      if(now !== before && (now || before)) out.push({ st, before, now });
    }
    return out;
  },

  // Who a client's messages go to: their own choice, else the parent when
  // there is a parent's number, else the client. [{ role, raw }]
  recipients(st){
    if(!st) return [];
    const kid = String(st.phone || '').trim(), par = String(st.parentPhone || '').trim();
    const want = st.sendTo || 'auto';
    const out = [];
    if((want === 'student' || want === 'both' || (want === 'auto' && !par)) && kid) out.push({ role: 'student', raw: kid });
    if((want === 'parent' || want === 'both' || want === 'auto') && par) out.push({ role: 'parent', raw: par });
    if(!out.length && (kid || par)) out.push({ role: kid ? 'student' : 'parent', raw: kid || par });
    return out;
  },
  markTold(sid){ const told = this.baseline() || {}; told[sid] = this.sig(sid); this.save(told); },
  markAll(){ const told = this.baseline() || {}; for(const st of state.students || []) told[st.id] = this.sig(st.id); this.save(told); },

  // The message, from the person's own text if they wrote one.
  message(row, role){
    const first = String(row.st.name || '').trim().split(/\s+/)[0] || '';
    const me = String(state.settings.teacherName || '').trim();
    const tpl = String(state.settings.changeMessage || '').trim() || t(role === 'parent' ? 'notify_msg_parent' : 'notify_msg_default');
    const fill = { name: first, me,
      new: row.now || t('notify_none_now'),
      old: row.before ? tf('notify_before', { old: row.before.split('\n').join(', ') }) : '' };
    return tpl.replace(/\{(name|new|old|me)\}/g, (m, k) => fill[k]).replace(/\n{3,}/g, '\n\n').trim();
  },

  bannerHtml(){
    const rows = this.changed();
    if(!rows.length) return '';
    const L = getLabels();
    return `<div class="card-sm notify-banner" style="margin:0 16px 12px;display:flex;align-items:center;gap:10px;font-size:14px;border-color:var(--green)">
      ${ico('send', 16)}<span style="flex:1">${esc(tf('notify_banner', { n: rows.length, clients: String(rows.length === 1 ? L.client : L.clients).toLowerCase() }))}</span>
      <button class="btn btn-primary" style="padding:8px 14px" onclick="Notify.open()">${esc(t('notify_open'))}</button></div>`;
  },

  open(){
    const rows = this.changed();
    document.getElementById('notify-overlay')?.remove();
    if(!rows.length){ Toast.show(t('notify_nothing'), 'success'); return; }
    this._rows = rows;
    // Everyone to send to, in list order: one entry per client and recipient.
    this._queue = [];
    rows.forEach((r, i) => this.recipients(r.st).forEach(x => this._queue.push({ i, role: x.role, raw: x.raw })));
    this._sent = this._sent && this._sentFor === rows.map(r => r.st.id).join() ? this._sent : new Set();
    this._sentFor = rows.map(r => r.st.id).join();
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay open'; ov.id = 'notify-overlay';
    document.body.appendChild(ov);
    this._draw();
  },
  _draw(){
    const ov = document.getElementById('notify-overlay'); if(!ov) return;
    const rows = this._rows || [], cc = state.settings.countryCode;
    const left = this._queue.filter(q => !this._sent.has(q.i + '|' + q.role));
    const next = left[0];
    const roleName = (r) => t(r === 'parent' ? 'notify_role_parent' : 'notify_role_student');
    ov.innerHTML = `<div class="confirm-box" style="max-width:480px;max-height:85vh;overflow-y:auto">
      <div class="confirm-title">${esc(t('notify_title'))}</div>
      <div class="confirm-text" style="margin-bottom:10px">${esc(t('notify_hint'))}</div>
      ${next ? `<button class="btn btn-primary" style="width:100%;margin-bottom:12px;min-height:48px" onclick="Notify.sendNext()">${ico('send', 16)} ${esc(tf('notify_next', { name: rows[next.i].st.name || '', who: roleName(next.role), k: this._queue.length - left.length + 1, n: this._queue.length }))}</button>` : ''}
      ${rows.map((r, i) => {
        const rec = this.recipients(r.st);
        return `<div class="card-sm" id="notify-row-${i}" style="margin:0 0 10px">
          <div style="font-weight:700">${esc(r.st.name || '')}</div>
          ${r.before ? `<div style="font-size:13px;color:var(--text3);text-decoration:line-through">${esc(r.before.split('\n').join(' · '))}</div>` : ''}
          <div style="font-size:14px;color:var(--green);font-weight:600">${esc((r.now || t('notify_none_now')).split('\n').join(' · '))}</div>
          ${rec.length ? rec.map(x => {
            const intl = App.normalizePhone(x.raw, cc), done = this._sent.has(i + '|' + x.role);
            return `<div style="display:flex;gap:8px;margin-top:8px;align-items:center${done ? ';opacity:.5' : ''}">
              <span style="font-size:12px;color:var(--text3);min-width:64px">${esc(roleName(x.role))}${done ? ' ✓' : ''}</span>
              <button class="btn btn-primary" style="flex:1;${intl ? '' : 'opacity:.45'}" ${intl ? '' : 'disabled'} onclick="Notify.send(${i},'whatsapp','${x.role}')">WhatsApp</button>
              <button class="btn btn-secondary" style="flex:1" onclick="Notify.send(${i},'sms','${x.role}')">SMS</button></div>`; }).join('')
          : `<div style="font-size:12px;color:var(--text3);margin-top:6px">${esc(t('send_no_phone'))}</div>`}
          <div style="display:flex;justify-content:flex-end;margin-top:6px"><button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="Notify.tick(${i})">✓ ${esc(t('notify_mark'))}</button></div>
        </div>`; }).join('')}
      <div class="confirm-actions" style="margin-top:4px">
        <button class="btn btn-secondary" style="flex:1" onclick="Notify.close()">${esc(t('notify_close'))}</button>
        <button class="btn btn-primary" style="flex:1" onclick="Notify.markAll();Notify.close();Toast.show(t('notify_all_done'),'success')">${esc(t('notify_all'))}</button>
      </div></div>`;
  },
  close(){ document.getElementById('notify-overlay')?.remove(); this._rows = null; try{ App.renderSchedule(); }catch(e){} },

  // Open WhatsApp or SMS with the message for one recipient; that client
  // counts as told. Nothing is sent by itself: the person taps send there.
  send(i, how, role){
    const r = this._rows && this._rows[i]; if(!r) return;
    const x = this.recipients(r.st).find(y => y.role === role) || this.recipients(r.st)[0];
    if(!x){ Toast.show(t('send_no_phone'), 'error'); return; }
    const text = this.message(r, x.role);
    const intl = App.normalizePhone(x.raw, state.settings.countryCode);
    const url = how === 'whatsapp' ? App.waLink(intl, text) : App.smsLink(x.raw, text);
    if(!url){ Toast.show(t('send_no_phone'), 'error'); return; }
    this._sent.add(i + '|' + x.role);
    this.markTold(r.st.id);
    this._draw();
    try{ if(how === 'whatsapp') window.open(url, '_blank'); else window.location.href = url; }catch(e){}
  },
  // The next one not yet sent: WhatsApp when the number allows it, else SMS.
  sendNext(){
    const q = (this._queue || []).find(q => !this._sent.has(q.i + '|' + q.role));
    if(!q) return;
    this.send(q.i, App.normalizePhone(q.raw, state.settings.countryCode) ? 'whatsapp' : 'sms', q.role);
  },
  tick(i){
    const r = this._rows && this._rows[i]; if(!r) return;
    this.markTold(r.st.id);
    for(const x of this.recipients(r.st)) this._sent.add(i + '|' + x.role);
    this._draw();
  },
};
