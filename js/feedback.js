// ============================================================
// FEEDBACK — "tell us what you think", from inside the app
// ============================================================
// Opens the person's own mail app with their words and a few facts that help
// (screen size, profession, how many clients) — never names or addresses.
// FEEDBACK_TO is the address it goes to; empty hides the button.
const FEEDBACK_TO = '';

const Feedback = {
  available(){ return !!FEEDBACK_TO; },
  facts(){
    const s = state.settings || {};
    return [`RoutePal · ${new Date().toISOString().slice(0, 10)}`,
      `${typeof screen !== 'undefined' ? screen.width + '×' + screen.height : ''} · ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
      `${s.profession || 'other'} · ${(state.students || []).length} · ${s.language || 'el'}`].join('\n');
  },
  link(text){
    return `mailto:${FEEDBACK_TO}?subject=${encodeURIComponent(t('fb_subject'))}&body=${encodeURIComponent(String(text || '').trim() + '\n\n— \n' + this.facts())}`;
  },
  open(){
    document.getElementById('fb-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay open'; ov.id = 'fb-overlay';
    ov.innerHTML = `<div class="confirm-box" style="max-width:420px">
      <div class="confirm-title">${esc(t('fb_title'))}</div>
      <div class="confirm-text">${esc(t('fb_hint'))}</div>
      <textarea id="fb-text" rows="5" placeholder="${esc(t('fb_ph'))}" style="width:100%"></textarea>
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
    document.getElementById('fb-overlay')?.remove();
    try{ window.location.href = this.link(text); }catch(e){}
    Toast.show(t('fb_thanks'), 'success');
  },
  buttonHtml(){
    return this.available() ? `<button type="button" class="btn btn-secondary btn-full" style="margin:12px 16px 0;width:calc(100% - 32px)" onclick="Feedback.open()">${ico('send', 15)} ${esc(t('fb_btn'))}</button>` : '';
  },
};
