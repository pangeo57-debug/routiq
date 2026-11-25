// ============================================================
// FEEDBACK — "tell us what you think", from inside the app
// ============================================================
// Opens the person's own mail app with their words and a few facts that help
// (screen size, profession, how many clients) — never names or addresses.
// FEEDBACK_TO is the address it goes to; empty hides the button.
const FEEDBACK_TO = '';

// Errors the app ran into on this phone: the message and where in the code,
// nothing of the person's data. The last 15 are kept here, and go out only
// inside a problem report the person reads and sends themselves.
const ErrorLog = {
  KEY: 'rp_errors',
  list(){ try{ const v = JSON.parse(localStorage.getItem(this.KEY) || '[]'); return Array.isArray(v) ? v : []; }catch(e){ return []; } },
  add(msg, where){
    msg = String(msg || '').slice(0, 300); if(!msg) return;
    const l = this.list();
    if(l.length && l[l.length - 1].msg === msg){ l[l.length - 1].n = (l[l.length - 1].n || 1) + 1; }
    else l.push({ at: new Date().toISOString().slice(0, 16), msg, where: String(where || '').replace(/^.*\//, '').slice(0, 80) });
    try{ localStorage.setItem(this.KEY, JSON.stringify(l.slice(-15))); }catch(e){}
  },
  clear(){ try{ localStorage.removeItem(this.KEY); }catch(e){} },
  text(){ return this.list().map(e => `${e.at} ${e.msg}${e.where ? ' @' + e.where : ''}${e.n > 1 ? ' ×' + e.n : ''}`).join('\n'); },
  install(){
    if(typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('error', (e) => { try{ this.add(e && e.message, e && e.filename ? e.filename + ':' + e.lineno : ''); }catch(x){} });
    window.addEventListener('unhandledrejection', (e) => { try{ const r = e && e.reason; this.add(r && (r.message || r), r && r.stack ? String(r.stack).split('\n')[1] : ''); }catch(x){} });
  },
};
try{ ErrorLog.install(); }catch(e){}

const Feedback = {
  // With an address set, the report opens in the mail app; without, it is
  // shared or copied, so a problem can always be told.
  available(){ return true; },
  facts(){
    const s = state.settings || {};
    return [`RoutePal · ${new Date().toISOString().slice(0, 10)}`,
      `${typeof screen !== 'undefined' ? screen.width + '×' + screen.height : ''} · ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
      `${s.profession || 'other'} · ${(state.students || []).length} · ${s.language || 'el'}`].join('\n');
  },
  body(text){
    const errs = document.getElementById('fb-errs')?.checked ? ErrorLog.text() : '';
    return String(text || '').trim() + '\n\n— \n' + this.facts() + (errs ? '\n\n' + t('fb_errors_head') + '\n' + errs : '');
  },
  link(text){
    return `mailto:${FEEDBACK_TO}?subject=${encodeURIComponent(t('fb_subject'))}&body=${encodeURIComponent(this.body(text))}`;
  },
  open(){
    document.getElementById('fb-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay open'; ov.id = 'fb-overlay';
    ov.innerHTML = `<div class="confirm-box" style="max-width:420px">
      <div class="confirm-title">${esc(t('fb_title'))}</div>
      <div class="confirm-text">${esc(t('fb_hint'))}</div>
      <textarea id="fb-text" rows="5" placeholder="${esc(t('fb_ph'))}" style="width:100%"></textarea>
      ${ErrorLog.list().length ? `<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-top:8px;color:var(--text2)"><input type="checkbox" id="fb-errs" checked style="margin-top:2px">
        <span>${esc(tf('fb_errors_attach', { n: ErrorLog.list().length }))}</span></label>` : ''}
      <div class="confirm-actions" style="margin-top:10px">
        <button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('fb-overlay').remove()">${esc(t('btn_cancel'))}</button>
        <button class="btn btn-primary" style="flex:1" onclick="Feedback.send()">${esc(t('fb_send'))}</button>
      </div></div>`;
    document.body.appendChild(ov);
    setTimeout(() => document.getElementById('fb-text')?.focus(), 50);
  },
  send(){
    const text = document.getElementById('fb-text')?.value || '';
    if(!text.trim()) return;
    const body = this.body(text);
    document.getElementById('fb-overlay')?.remove();
    if(FEEDBACK_TO){ try{ window.location.href = this.link(text); }catch(e){} }
    else if(typeof navigator !== 'undefined' && navigator.share){ navigator.share({ title: t('fb_subject'), text: body }).catch(() => {}); }
    else { try{ App.copyText(body); }catch(e){} }
    Toast.show(t('fb_thanks'), 'success');
  },
  buttonHtml(){
    return this.available() ? `<button type="button" class="btn btn-secondary btn-full" style="margin:12px 16px 0;width:calc(100% - 32px)" onclick="Feedback.open()">${ico('send', 15)} ${esc(t('fb_btn'))}</button>` : '';
  },
};
