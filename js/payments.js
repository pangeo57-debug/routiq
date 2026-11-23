// ============================================================
// PAYMENTS — who owes what, counted in appointments
// ============================================================
// Every appointment ticked as done on Home adds one to what that client owes;
// a payment takes appointments off. With a price per appointment set on the
// client, the same is shown in euros. Kept on this device only.
//
//   rp_pay = { done: { 'YYYY-MM-DD|clientId|HH:MM': 1 }, paid: { clientId: [{ at, n, eur }] } }
const Payments = {
  KEY: 'rp_pay',
  load(){
    try{ const v = JSON.parse(localStorage.getItem(this.KEY) || 'null'); if(v && typeof v === 'object') return { done: v.done || {}, paid: v.paid || {} }; }catch(e){}
    return { done: {}, paid: {} };
  },
  save(v){ try{ localStorage.setItem(this.KEY, JSON.stringify(v)); }catch(e){} },
  key(date, sid, time){ return `${date}|${sid}|${time || ''}`; },

  isDone(date, sid, time){ return !!this.load().done[this.key(date, sid, time)]; },
  toggleDone(date, sid, time){
    const v = this.load(), k = this.key(date, sid, time);
    if(v.done[k]) delete v.done[k]; else v.done[k] = 1;
    this.save(v);
    try{ if(state.currentScreen === 'home') App.renderHome(); }catch(e){}
  },

  price(st){ const p = Number(st && st.price); return p > 0 ? p : 0; },
  doneCount(sid){ const v = this.load(); return Object.keys(v.done).filter(k => k.split('|')[1] === sid).length; },
  paidCount(sid){ return (this.load().paid[sid] || []).reduce((a, x) => a + (Number(x.n) || 0), 0); },
  owed(sid){ return Math.max(0, this.doneCount(sid) - this.paidCount(sid)); },

  // "3 · 75 €", or '' when nothing is owed.
  owedText(st){
    const n = this.owed(st.id);
    if(!n) return '';
    const p = this.price(st);
    return tf('pay_owes', { n }) + (p ? ` · ${(n * p).toFixed(p % 1 ? 2 : 0)} €` : '');
  },
  badgeHtml(st){
    const s = this.owedText(st);
    return s ? `<div class="wallet-owed" style="font-size:12px;font-weight:700;color:var(--orange,#c2410c);margin-top:4px">${esc(s)}</div>` : '';
  },
  // All clients together, above the list.
  totalHtml(){
    let n = 0, eur = 0;
    for(const st of state.students || []){ const o = this.owed(st.id); n += o; eur += o * this.price(st); }
    if(!n) return '';
    return `<div class="card-sm" style="margin:0 16px 10px;display:flex;align-items:center;gap:8px;font-size:14px">
      ${ico('flag', 14)}<span style="flex:1">${esc(tf('pay_total', { n }))}${eur ? ` · <b>${eur.toFixed(eur % 1 ? 2 : 0)} €</b>` : ''}</span></div>`;
  },

  // Record a payment: how many appointments it covers (all owed, by default).
  pay(sid, n){
    n = Math.max(0, Math.round(Number(n) || 0));
    if(!n) return;
    const st = (state.students || []).find(s => s.id === sid);
    const v = this.load();
    (v.paid[sid] = v.paid[sid] || []).push({ at: new Date().toISOString(), n, eur: n * this.price(st) });
    this.save(v);
  },
  openPay(sid){
    const st = (state.students || []).find(s => s.id === sid);
    if(!st) return;
    const owed = this.owed(sid), p = this.price(st);
    document.getElementById('pay-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay open'; ov.id = 'pay-overlay';
    ov.innerHTML = `<div class="confirm-box" style="max-width:380px">
      <div class="confirm-title">${esc(tf('pay_title', { name: st.name || '' }))}</div>
      <div class="confirm-text">${esc(owed ? tf('pay_owes_long', { n: owed }) : t('pay_nothing_owed'))}</div>
      <label for="pay-n" style="font-size:13px">${esc(t('pay_how_many'))}</label>
      <input type="number" id="pay-n" inputmode="numeric" min="1" max="200" value="${owed || 1}"
        oninput="document.getElementById('pay-eur').textContent=${p}?(Math.max(0,Number(this.value)||0)*${p}).toFixed(${p % 1 ? 2 : 0})+' €':''">
      <div id="pay-eur" style="font-size:22px;font-weight:800;margin:8px 0 4px">${p ? ((owed || 1) * p).toFixed(p % 1 ? 2 : 0) + ' €' : ''}</div>
      <div class="confirm-actions">
        <button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('pay-overlay').remove()">${esc(t('btn_cancel'))}</button>
        <button class="btn btn-primary" style="flex:1" onclick="Payments.pay('${esc(sid)}', document.getElementById('pay-n').value);document.getElementById('pay-overlay').remove();Toast.show(t('pay_saved'),'success');App.renderStudents()">${esc(t('pay_save'))}</button>
      </div></div>`;
    document.body.appendChild(ov);
  },
};
