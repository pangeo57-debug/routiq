// ============================================================
// TOAST
// ============================================================
const Toast = {
  show(msg, type='info', duration=3000, action){
    const icons = {
      success:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
      error:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
      info:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    // The icon is our own markup and goes in as html; the MESSAGE never does.
    // Toast messages carry student names, addresses and verifier output — all
    // typed by the user — through 47 call sites, and writing them as innerHTML
    // made every one of them stored XSS. Escaping here fixes all of them at
    // once and cannot be forgotten at a new call site.
    const icon = document.createElement('span');
    icon.innerHTML = icons[type] || '';
    const body = document.createElement('span');
    body.textContent = msg == null ? '' : String(msg);
    t.appendChild(icon); t.appendChild(body);
    // An optional action, e.g. "Undo": a real button, so it is tappable.
    if(action && action.label && typeof action.run === 'function'){
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action.label;
      b.onclick = (e) => { e.stopPropagation(); try{ action.run(); }finally{ t.remove(); } };
      t.appendChild(b);
      t.style.pointerEvents = 'auto';
    }
    // One message at a time: a stack of them covered the bottom of the
    // screen and the buttons under it. A message with an action (Undo) is
    // kept while a plain one arrives, but never two of those either.
    const box = document.getElementById('toast-container');
    for(const old of Array.from(box.children || [])){
      if(!old.querySelector) continue;
      if(!old.querySelector('.toast-action') || t.querySelector('.toast-action')) old.remove();
    }
    box.appendChild(t);
    this._swipeAway(t);
    setTimeout(()=>{
      if(t.isConnected === false) return;
      t.style.animation='toastOut .25s ease forwards';
      setTimeout(()=>t.remove(),250);
    }, duration);
  },

  // Drag a message sideways (left, or right) and let go past a third of its
  // width — or flick it — and it is gone. A short drag springs back. Taps on
  // its button still work: only a real horizontal drag counts.
  _swipeAway(t){
    if(!t || typeof t.addEventListener !== 'function' || !t.style) return;
    let x0 = null, y0 = 0, dx = 0, t0 = 0, dragging = false;
    const start = (x, y) => { x0 = x; y0 = y; dx = 0; t0 = Date.now(); dragging = false; };
    const move = (x, y, e) => {
      if(x0 == null) return;
      const ddx = x - x0, ddy = y - y0;
      if(!dragging){
        if(Math.abs(ddx) < 8 || Math.abs(ddx) < Math.abs(ddy)) return;
        dragging = true;
        t.style.animation = 'none';
        t.style.transition = 'none';
      }
      dx = ddx;
      if(e && e.cancelable) e.preventDefault();
      t.style.transform = `translateX(${dx}px)`;
      t.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / (t.offsetWidth || 300)));
    };
    const end = () => {
      if(x0 == null) return;
      x0 = null;
      if(!dragging) return;
      const w = t.offsetWidth || 300;
      const fast = Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.5;
      t.style.transition = 'transform .2s ease, opacity .2s ease';
      if(Math.abs(dx) > w / 3 || (fast && Math.abs(dx) > 30)){
        t.style.transform = `translateX(${dx < 0 ? -w * 1.2 : w * 1.2}px)`;
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 200);
      } else {
        t.style.transform = '';
        t.style.opacity = '';
      }
    };
    t.style.touchAction = 'pan-y';
    t.addEventListener('touchstart', e => { const p = e.touches[0]; start(p.clientX, p.clientY); }, { passive: true });
    t.addEventListener('touchmove', e => { const p = e.touches[0]; move(p.clientX, p.clientY, e); }, { passive: false });
    t.addEventListener('touchend', end);
    t.addEventListener('touchcancel', end);
    // Mouse: listen on the window only while the button is down, so nothing
    // is left behind once the message is gone.
    t.addEventListener('mousedown', e => {
      start(e.clientX, e.clientY);
      const mm = ev => move(ev.clientX, ev.clientY, null);
      const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); end(); };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
    // A drag must not also count as a tap on the button.
    t.addEventListener('click', e => { if(dragging){ e.stopPropagation(); e.preventDefault(); dragging = false; } }, true);
  }
};

// ============================================================
// CLOSE OVERLAYS ON BG CLICK
// ============================================================
document.getElementById('drawer-student-overlay').addEventListener('click',e=>{
  if(e.target.id==='drawer-student-overlay') App.closeStudentDrawer();
});
document.getElementById('drawer-block-overlay').addEventListener('click',e=>{
  if(e.target.id==='drawer-block-overlay') App.closeBlockDrawer();
});
document.getElementById('confirm-overlay').addEventListener('click',e=>{
  if(e.target.id==='confirm-overlay') App.confirmReject();
});

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', ()=>App.init());
