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

  markTold(sid){ const told = this.baseline() || {}; told[sid] = this.sig(sid); this.save(told); },
  markAll(){ const told = this.baseline() || {}; for(const st of state.students || []) told[st.id] = this.sig(st.id); this.save(told); },

  // The message, from the person's own text if they wrote one.
  message(row){
    const first = String(row.st.name || '').trim().split(/\s+/)[0] || '';
    const me = String(state.settings.teacherName || '').trim();
    const tpl = String(state.settings.changeMessage || '').trim() || t('notify_msg_default');
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
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay open'; ov.id = 'notify-overlay';
    ov.innerHTML = `<div class="confirm-box" style="max-width:480px;max-height:85vh;overflow-y:auto">
      <div class="confirm-title">${esc(t('notify_title'))}</div>
      <div class="confirm-text" style="margin-bottom:10px">${esc(t('notify_hint'))}</div>
      ${rows.map((r, i) => {
        const intl = App.normalizePhone(r.st.phone, state.settings.countryCode);
        return `<div class="card-sm" id="notify-row-${i}" style="margin:0 0 10px">
          <div style="font-weight:700">${esc(r.st.name || '')}</div>
          ${r.before ? `<div style="font-size:13px;color:var(--text3);text-decoration:line-through">${esc(r.before.split('\n').join(' · '))}</div>` : ''}
          <div style="font-size:14px;color:var(--green);font-weight:600">${esc((r.now || t('notify_none_now')).split('\n').join(' · '))}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-primary" style="flex:1;${intl ? '' : 'opacity:.45'}" ${intl ? '' : 'disabled'} onclick="Notify.send(${i},'whatsapp')">WhatsApp</button>
            <button class="btn btn-secondary" style="flex:1;${r.st.phone ? '' : 'opacity:.45'}" ${r.st.phone ? '' : 'disabled'} onclick="Notify.send(${i},'sms')">SMS</button>
            <button class="btn btn-secondary" aria-label="${esc(t('notify_mark'))}" title="${esc(t('notify_mark'))}" onclick="Notify.tick(${i})">✓</button>
          </div></div>`; }).join('')}
      <div class="confirm-actions" style="margin-top:4px">
        <button class="btn btn-secondary" style="flex:1" onclick="Notify.close()">${esc(t('notify_close'))}</button>
        <button class="btn btn-primary" style="flex:1" onclick="Notify.markAll();Notify.close();Toast.show(t('notify_all_done'),'success')">${esc(t('notify_all'))}</button>
      </div></div>`;
    document.body.appendChild(ov);
    this._rows = rows;
  },
  close(){ document.getElementById('notify-overlay')?.remove(); this._rows = null; try{ App.renderSchedule(); }catch(e){} },

  // Open WhatsApp or SMS with the message; that client counts as told.
  send(i, how){
    const r = this._rows && this._rows[i]; if(!r) return;
    const text = this.message(r);
    const url = how === 'whatsapp' ? App.waLink(App.normalizePhone(r.st.phone, state.settings.countryCode), text) : App.smsLink(r.st.phone, text);
    if(!url){ Toast.show(t('send_no_phone'), 'error'); return; }
    this.tick(i);
    try{ if(how === 'whatsapp') window.open(url, '_blank'); else window.location.href = url; }catch(e){}
  },
  tick(i){
    const r = this._rows && this._rows[i]; if(!r) return;
    this.markTold(r.st.id);
    const el = document.getElementById('notify-row-' + i);
    if(el){ el.style.opacity = '.5'; el.querySelectorAll('button').forEach(b => { b.disabled = true; }); }
  },
};
