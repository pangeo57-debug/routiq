// While a plan is being computed the screen is kept on. A phone that turns
// its screen off hides the page, and a hidden page is frozen by the browser
// (at once on iPhone, within seconds on Android): the computation stops and
// only resumes when the person comes back. Released as soon as the bar goes.
const SchedWake = {
  lock: null, want: false,
  async on(){
    this.want = true;
    if(this.lock || typeof navigator === 'undefined' || !navigator.wakeLock) return;
    try{ this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => { this.lock = null; }); }catch(e){ this.lock = null; }
  },
  off(){ this.want = false; const l = this.lock; this.lock = null; if(l) try{ l.release(); }catch(e){} },
};
// A wake lock is dropped whenever the page is hidden; take it again on return.
if(typeof document !== 'undefined' && document.addEventListener)
  document.addEventListener('visibilitychange', () => { if(!document.hidden && SchedWake.want) SchedWake.on(); });

function schedProgress(pct, phase, sub, icon){
  if(pct === null) SchedWake.off(); else SchedWake.on();
  const ov=document.getElementById('sched-overlay');
  if(!ov) return;
  // After ✕ the bar stays gone, even if the stopping run reports once more.
  if(pct!==null && typeof state!=='undefined' && state._schedulingCancelled) return;
  if(pct===null){
    _schedStopAnim();
    document.body.classList.remove('sched-on');
    ov.style.opacity='0';
    setTimeout(()=>{
      ov.style.display='none'; ov.style.opacity=''; ov.classList.remove('done');
      const wn=document.getElementById('sched-warn'); if(wn) wn.textContent='';
      _schedShown=0; _schedGoal=0; _schedPctText=-1; _schedCeil=99; _schedLastPct=0;
      const bar=document.getElementById('sched-bar'); if(bar) bar.style.width='0%';
    },300);
    return;
  }
  ov.style.display='block';
  document.body.classList.add('sched-on');
  // The toasts keep above the panel, whatever its height (one or two lines).
  requestAnimationFrame(() => { try{ document.body.style.setProperty('--sched-h', ov.offsetHeight + 'px'); }catch(e){} });
  const ph=document.getElementById('sched-phase');
  const sb=document.getElementById('sched-sub');
  const wn=document.getElementById('sched-warn');
  if(wn && !wn.textContent) wn.textContent = t('sched_dont_change_settings');

  // A phase update only ever moves forward: a later phase reporting a lower
  // number than the creep has already reached must not yank the bar backwards.
  _schedGoal=Math.max(_schedGoal, pct);
  _schedLastPct=Math.max(_schedLastPct, pct);
  if(pct>=100){
    // Finished — go straight to the end and turn green. The creep's ~9s time
    // constant is for looking busy; making the user watch it crawl the last
    // percent after the work is already done would be theatre.
    _schedCeil=100; _schedGoal=100; ov.classList.add('done');
  } else {
    ov.classList.remove('done');
    // Never creep past the next phase's starting point, so the bar cannot
    // promise progress that the following phase then has to walk back.
    _schedCeil=99;
  }
  _schedAnimate();

  if(ph&&phase&&ph.textContent!==phase){
    const ph2=document.getElementById('sched-phase-on');
    ph.style.opacity='0'; if(ph2) ph2.style.opacity='0';
    setTimeout(()=>{ ph.textContent=phase; ph.style.opacity='1'; if(ph2){ ph2.textContent=phase; ph2.style.opacity='1'; } },160);
  }
  if(sb&&sub&&sb.textContent!==sub){
    sb.style.opacity='0';
    setTimeout(()=>{ sb.textContent=sub; sb.style.opacity='1'; },160);
  }
}

// ============================================================
// ICONS — thin line icons in place of emoji, drawn in the text colour
// ============================================================
const ICON_PATHS = {
  nav:   '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  phone: '<path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  bell:  '<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
  map:   '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  send:  '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  users: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.9"/><path d="M16 3.1a4 4 0 010 7.8"/>',
  user:  '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  search:'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.7" y2="16.7"/>',
  car:   '<path d="M5 17h14M5 17a2 2 0 11-4 0v-5l2-5h14l2 5h2v5a2 2 0 11-4 0M5 17a2 2 0 104 0m6 0a2 2 0 104 0M3 12h18"/>',
  home:  '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  pin:   '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  coffee:'<path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>',
  mic:   '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>',
  bag:   '<path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>',
  book:  '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
  tool:  '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.8-3.8a6 6 0 01-7.9 7.9l-6.9 6.9a2.1 2.1 0 01-3-3l6.9-6.9a6 6 0 017.9-7.9z"/>',
  edit:  '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z"/>',
  flag:  '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  lock:  '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
  unlock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/>',
};
function ico(name, size = 16){
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

// ============================================================
// APP STATE
// ============================================================
let _drag = null;
let state = {
  currentScreen: 'home',
  students: [],
  // One-off appointments for a particular date, kept entirely separate from the
  // weekly roster. A plumber has five jobs tomorrow and nothing the week after;
  // a tutor has the same Tuesday forever. The app has to do both, and mixing
  // them into one list would make every existing rule ambiguous.
  jobs: [],
  dayPlan: null,          // the most recent result of planning a single date
  planDate: null,         // which date that was
  settings: {},
  schedule: {},
  coords: {},
  schedulerResult: null,
  editingStudentId: null,
  confirmCallback: null,
  scheduleDay: null,
  routeDay: null,
  routeResults: {},
  dayMatrixPeak: null,
  dayMatrixOffPeak: null,
  scheduleAttempts: [],
  scheduleAttemptIdx: 0,
  scheduleOptimized: false,
  scheduleKmBefore: null,
  scheduleKmAfter: null,
  _schedulingInProgress: false
};

