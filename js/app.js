// ============================================================
// APP
// ============================================================
const App = {
  _googleMapsLoadPromise: null,
  _googlePlacesSessionTokens: {},
  _googleMapsApiKey(){
    return String(window.ROUTEPAL_GOOGLE_MAPS_API_KEY ||
      (document.querySelector('meta[name="google-maps-api-key"]')?.content) || '').trim();
  },
  async _ensureGoogleMapsReady(){
    // With loading=async the script defines google.maps before importLibrary
    // is ready; wait for it rather than calling it too early.
    const ready = async () => {
      for(let i = 0; i < 100 && !(window.google && window.google.maps && typeof window.google.maps.importLibrary === 'function'); i++)
        await new Promise(r => setTimeout(r, 50));
    };
    if(window.google && window.google.maps){
      await ready();
      await window.google.maps.importLibrary('maps');
      await window.google.maps.importLibrary('places');
      return window.google.maps;
    }
    const key = this._googleMapsApiKey();
    if(!key) throw new Error('Google Maps API key not configured');
    if(!this._googleMapsLoadPromise){
      this._googleMapsLoadPromise = new Promise((resolve,reject)=>{
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=places`;
        script.async = true;
        script.onload = resolve;
        script.onerror = ()=>reject(new Error('Google Maps failed to load'));
        document.head.appendChild(script);
      });
    }
    await this._googleMapsLoadPromise;
    await ready();
    await window.google.maps.importLibrary('maps');
    await window.google.maps.importLibrary('places');
    return window.google.maps;
  },
  _googleMapDarkStyle(){
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    return dark ? [
      { elementType:'geometry', stylers:[{color:'#1b1b1b'}] },
      { elementType:'labels.text.fill', stylers:[{color:'#a3a3a3'}] },
      { elementType:'labels.text.stroke', stylers:[{color:'#1b1b1b'}] },
      { featureType:'road', elementType:'geometry', stylers:[{color:'#303030'}] },
      { featureType:'water', elementType:'geometry', stylers:[{color:'#101010'}] }
    ] : null;
  },
  async _googleMapUpdate(el, options={}){
    if(!el) return null;
    let googleMaps;
    try{ googleMaps = await this._ensureGoogleMapsReady(); }catch(e){ console.warn('Google Maps unavailable:',e); return null; }
    if(!el.__google_map){
      const center = options.center || {lat:38.2466, lon:21.7346};
      el.__google_map = new googleMaps.Map(el,{
        center:{lat:center.lat,lng:center.lon ?? center.lng},
        zoom:options.zoom||13,
        disableDefaultUI:options.disableDefaultUI||false,
        zoomControl:options.zoomControl!==false,
        mapTypeControl:false,
        streetViewControl:false,
        fullscreenControl:false,
        styles:this._googleMapDarkStyle()
      });
      el.__google_markers=[];
      el.__google_polyline=null;
    }else{
      el.__google_map.setOptions({styles:this._googleMapDarkStyle()});
      if(options.center) el.__google_map.setCenter({lat:options.center.lat,lng:options.center.lon ?? options.center.lng});
      if(options.zoom) el.__google_map.setZoom(options.zoom);
    }
    const map=el.__google_map;
    (el.__google_markers||[]).forEach(marker=>marker.setMap(null));
    el.__google_markers=[];
    if(el.__google_polyline){ el.__google_polyline.setMap(null); el.__google_polyline=null; }
    for(const item of (options.markers||[])){
      const marker=new googleMaps.Marker({
        position:{lat:item.lat,lng:item.lon},
        map,
        draggable:!!item.draggable,
        label:item.label ? {text:String(item.label),color:item.labelColor||'#ffffff',fontWeight:'700'} : undefined,
        title:item.title||''
      });
      if(item.onDrag) marker.addListener('dragend',()=>item.onDrag(marker.getPosition()));
      if(item.onClick) marker.addListener('click',()=>item.onClick(marker.getPosition()));
      el.__google_markers.push(marker);
    }
    if(options.polyline?.length){
      el.__google_polyline=new googleMaps.Polyline({
        path:options.polyline.map(p=>({lat:p.lat,lng:p.lon ?? p.lng})),
        geodesic:true,
        strokeColor:options.polylineColor||this._accent(),
        strokeOpacity:options.polylineOpacity??0.85,
        strokeWeight:options.polylineWeight||4,
        map
      });
    }
    if(options.fitBounds && options.fitBounds.length){
      const bounds=new googleMaps.LatLngBounds();
      options.fitBounds.forEach(p=>bounds.extend({lat:p.lat,lng:p.lon ?? p.lng}));
      map.fitBounds(bounds,{top:24,bottom:24,left:24,right:24});
    }
    googleMaps.event?.trigger(map,'resize');
    return map;
  },
  _googlePlacesSession(boxId){
    if(!window.google?.maps?.places?.AutocompleteSessionToken) return null;
    if(!this._googlePlacesSessionTokens[boxId]){
      this._googlePlacesSessionTokens[boxId]=new window.google.maps.places.AutocompleteSessionToken();
    }
    return this._googlePlacesSessionTokens[boxId];
  },
  async _googlePlacesAutocomplete(val, boxId){
    const googleMaps=await this._ensureGoogleMapsReady();
    // Near the person: their home, else their workplace, else Patras. A
    // tight bias (15 km) keeps the shop round the corner above the one with
    // the same name across the country; far places still appear if typed.
    const near=[state.coords?.home, state.coords?.workplace].find(c=>Scheduler.validCoord(c));
    const home=near||{lat:38.2466,lon:21.7346};
    const sessionToken=this._googlePlacesSession(boxId);
    const request={
      input:String(val||'').trim(),
      sessionToken,
      includedRegionCodes:['gr'],
      // The JavaScript API wants {center:{lat,lng}, radius}; the REST shape
      // ({circle:{center:{latitude,…}}}) is rejected and no suggestion came back.
      locationBias:{center:{lat:home.lat,lng:home.lon},radius:15000},
      origin:{lat:home.lat,lng:home.lon}
    };
    const suggestions=await googleMaps.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions?.(request);
    if(suggestions && Array.isArray(suggestions.suggestions)){
      return suggestions.suggestions.map(s=>{
        const p=s.placePrediction;
        return p ? {
          name:p.text?.text||p.mainText?.text||String(val||''),
          poiName:p.mainText?.text||'',
          _matchText:p.text?.text||'',
          _googlePlaceId:p.placeId||p.place?.id||'',
          _google:true,
          _precise:true,
          lat:null,lon:null
        } : null;
      }).filter(Boolean);
    }
    return [];
  },
  async _googlePlacesPlaceDetails(placeId, boxId){
    if(!placeId) return null;
    const googleMaps=await this._ensureGoogleMapsReady();
    const place=new googleMaps.places.Place({id:placeId});
    await place.fetchFields({fields:['location','formattedAddress']});
    const location=place.location;
    const lat=location?.lat?.() ?? location?.lat;
    const lon=location?.lng?.() ?? location?.lng;
    if(!Scheduler.validCoord({lat,lon:lon})) return null;
    const result={lat,lon,formattedAddress:place.formattedAddress||'',placeId};
    this._googlePlacesSessionTokens[boxId]=null;
    return result;
  },
  init(){
    try {
      state.settings = Storage.loadSettings();
      state.students = Storage.loadStudents();
      state.schedule = Storage.loadSchedule();
      // Group names used to be stored with an emoji in front; the app no
      // longer uses them, so saved schedules lose it on load.
      for(const d of Object.keys(state.schedule || {}))
        for(const sl of (state.schedule[d] || []))
          if(typeof sl.studentName === 'string') sl.studentName = sl.studentName.replace(/^\u{1F465}\s*/u, '');
      state.coords   = Storage.loadCoords();
    state.jobs = Storage.loadJobs();
    state.savings = Storage.loadSavings();
    try{ Usage.ping('open'); }catch(e){}
    // A week that was being computed on the server when the app was left:
    // pick it up. runAndNotify finds the job by its input and does not start
    // a new one.
    try{ if(Remote.available() && Remote.hasPending()) setTimeout(() => { if(!state._schedulingInProgress) App.runAndNotify(); }, 800); }catch(e){}
    } catch(e) {
      localStorage.clear();
      state.settings = defaultSettings();
      state.students = [];
      state.schedule = {};
      state.coords = {};
    }

    // Backfill any settings field added after this user's data was last saved.
    // Settings are loaded verbatim from localStorage, and the scheduler reads
    // e.g. settings.dayHours[day] unguarded in a dozen places — a profile
    // saved by an older build (before dayHours/blockedSlots existed) crashed
    // App.init outright, leaving a blank app with no way to recover.
    const _defs = defaultSettings();
    for(const k in _defs){
      if(state.settings[k] === undefined || state.settings[k] === null) state.settings[k] = _defs[k];
    }
    if(!Array.isArray(state.settings.workDays)) state.settings.workDays = [1,2,3,4,5];
    if(!Array.isArray(state.settings.blockedSlots)) state.settings.blockedSlots = [];
    if(!state.settings.dayHours || typeof state.settings.dayHours !== 'object') state.settings.dayHours = _defs.dayHours;
    for(const d of state.settings.workDays){
      const dh = state.settings.dayHours[d];
      if(!dh || !dh.start || !dh.end) state.settings.dayHours[d] = (_defs.dayHours && _defs.dayHours[d]) || {start:'15:00', end:'22:00'};
    }
    if(!state.settings.language) state.settings.language = 'el';
    applyLanguageArrays();
    this.applyTheme();

    try { this._initSwipe(); } catch(e){}

    // First run: clean slate + onboarding
    if(!localStorage.getItem('rp_init_v24')){
      state.settings = defaultSettings();
      Storage.saveSettings(state.settings);
      localStorage.setItem('rp_init_v24','1');
      this.showOnboarding();
      return;
    } else if(Object.keys(state.schedule).length===0 && state.students.length>0){
      this.runScheduler();
    }

    // Default schedule day = today or first work day
    const today = new Date().getDay();
    const todayISO = today===0?7:today;
    const workDays = state.settings.workDays.length ? state.settings.workDays : [1,2,3,4,5];
    state.scheduleDay = workDays.includes(todayISO) ? todayISO : (workDays[0]||1);
    state.routeDay = state.scheduleDay;

    try { this.updateNavLabels(); } catch(e){}
    try { this.renderHome(); } catch(e){ console.error('renderHome failed',e); }
    try { this.registerSW(); } catch(e){}
    setTimeout(() => { this.refreshGoogleCoords().catch(() => {}); }, 3000);
    try { this.initAnalytics(); } catch(e){}
  },

  // Loads Cloudflare Web Analytics, but only when a token is configured — an
  // unconfigured build makes no third-party request at all. Deliberately
  // page-view only: no custom events, no identifiers, nothing derived from the
  // user's own data (see ANALYTICS_TOKEN above for why that boundary matters).
  initAnalytics(){
    if(!ANALYTICS_TOKEN) return;
    if(document.querySelector('script[data-cf-beacon]')) return; // already loaded
    const s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: ANALYTICS_TOKEN }));
    document.head.appendChild(s);
  },

  // Clear map overlays when a screen is torn down. The Google Maps API script
  // and each container instance stay singleton; markers/polyline are replaced.
  destroyMaps(){
    document.querySelectorAll('.screen [id$="-map"]').forEach(el=>{
      if(el.__google_markers) el.__google_markers.forEach(marker=>marker.setMap(null));
      el.__google_markers=[];
      if(el.__google_polyline) el.__google_polyline.setMap(null);
      el.__google_polyline=null;
    });
  },

  nav(screen){
    this.fabClose();
    this.destroyMaps();
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    document.getElementById('screen-'+screen).classList.add('active');
    // The route is a view of the schedule: its tab is the schedule's.
    document.querySelector(`.nav-btn[data-screen="${screen === 'route' ? 'schedule' : screen}"]`).classList.add('active');
    state.currentScreen = screen;
    this.updateNavLabels();
    this['render'+screen.charAt(0).toUpperCase()+screen.slice(1)]();
  },

  // ---- THEME (light / dark / system) ----
  applyTheme(){
    const theme = (state.settings && state.settings.theme) || 'system';
    const root = document.documentElement;
    if(theme==='system') delete root.dataset.theme; // let @media (prefers-color-scheme) decide
    else root.dataset.theme = theme;
    const isDark = theme==='dark' || (theme==='system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content', isDark ? '#14141c' : '#f7f6f3');
  },

  setTheme(theme){
    state.settings.theme = theme;
    Storage.saveSettings(state.settings);
    this.applyTheme();
  },

  // ---- NOTIFICATIONS (tell the user the schedule is ready without making
  // them stare at a blocking overlay) ----
  async requestNotifyPermission(){
    if(typeof Notification==='undefined') return false;
    if(Notification.permission==='granted') return true;
    if(Notification.permission==='denied') return false;
    try{ return (await Notification.requestPermission())==='granted'; }catch(e){ return false; }
  },

  // ---- REMINDERS ----------------------------------------------------------
  // A web app cannot wake itself once closed without a push server that would
  // hold the person's schedule. Two ways that need none:
  //  · the phone's own calendar, which reminds even with the app closed
  //    (buildICS / exportCalendar), and
  //  · a notification REMIND_MIN before each stop while the app is open or in
  //    the background (scheduleReminders).
  REMIND_MIN: 15,
  // How long before an appointment to remind: the person's choice, 15′ unless set.
  remindMin(){ const v = Number(state.settings && state.settings.remindMin); return v >= 5 && v <= 1440 ? v : this.REMIND_MIN; },
  _icsText(x){ return String(x || '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n'); },
  buildICS(items, dateISO, alarmMin){
    const ymd = dateISO.replace(/-/g, '');
    const hm = (t) => t.replace(':', '') + '00';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RoutePal//EN', 'CALSCALE:GREGORIAN'];
    for(const x of items){
      if(!x.time || x.done) continue;
      const end = x.end || Scheduler.toTime(Scheduler.toMin(x.time) + 30);
      lines.push('BEGIN:VEVENT', `UID:${ymd}-${hm(x.time)}-${String(x.id).replace(/[^\w-]/g, '')}@routepal`, `DTSTAMP:${stamp}`,
        `DTSTART:${ymd}T${hm(x.time)}`, `DTEND:${ymd}T${hm(end)}`, `SUMMARY:${this._icsText(x.title)}`);
      if(x.address) lines.push(`LOCATION:${this._icsText(x.address)}`);
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${this._icsText(x.title)}`,
        `TRIGGER:-PT${Number(alarmMin) || this.remindMin()}M`, 'END:VALARM', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  },

  /**
   * The week as repeating events for the phone's calendar: one event per
   * appointment, weekly (every 2 or 4 weeks for clients on that rhythm), each
   * with a reminder. Imported once, the calendar reminds with the app closed
   * until the week changes. UIDs are stable, so importing again updates.
   */
  buildWeekICS(alarmMin, fromISO){
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const monday = Cadence.monday(fromISO || this.todayISO());
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const hm = (x) => x.replace(':', '') + '00';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RoutePal//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:RoutePal'];
    for(const d of [1, 2, 3, 4, 5, 6, 7]){
      for(const sl of (state.schedule[d] || [])){
        const st = (state.students || []).find(s => s.id === sl.studentId);
        const every = Cadence.of(st);
        // The first date on this weekday, from this week on, that is one of the client's weeks.
        let date = new Date(monday); date.setDate(date.getDate() + d - 1);
        for(let k = 0; k < every && st && !Cadence.onWeek(st, iso(date)); k++) date.setDate(date.getDate() + 7);
        const ymd = iso(date).replace(/-/g, '');
        lines.push('BEGIN:VEVENT', `UID:week-${String(sl.studentId).replace(/[^\w-]/g, '')}-${d}-${hm(sl.start)}@routepal`, `DTSTAMP:${stamp}`,
          `DTSTART:${ymd}T${hm(sl.start)}`, `DTEND:${ymd}T${hm(sl.end)}`,
          `RRULE:FREQ=WEEKLY${every > 1 ? ';INTERVAL=' + every : ''}`, `SUMMARY:${this._icsText(sl.studentName || (st && st.name) || '')}`);
        if(sl.address) lines.push(`LOCATION:${this._icsText(sl.address)}`);
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${this._icsText(sl.studentName || '')}`,
          `TRIGGER:-PT${Number(alarmMin) || this.remindMin()}M`, 'END:VALARM', 'END:VEVENT');
      }
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  },

  async exportWeekCalendar(){
    const n = Object.values(state.schedule || {}).reduce((a, d) => a + (d || []).length, 0);
    if(!n){ Toast.show(t('cal_nothing'), 'info'); return; }
    const text = this.buildWeekICS(this.remindMin());
    const name = 'routepal-week.ics';
    try{
      const file = (typeof File === 'function') ? new File([text], name, { type: 'text/calendar' }) : null;
      if(file && navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file], title: 'RoutePal' }); Toast.show(tf('cal_week_saved', { n }), 'success', 7000); return; }
    }catch(e){ if(e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    Toast.show(tf('cal_week_saved', { n }), 'success', 7000);
  },

  async exportCalendar(){
    const date = this.todayISO();
    const items = this._todayAgenda().filter(x => x.time && !x.done);
    if(!items.length){ Toast.show(t('cal_nothing'), 'info'); return; }
    const text = this.buildICS(items, date, this.remindMin());
    const name = `routepal-${date}.ics`;
    try{
      const file = (typeof File === 'function') ? new File([text], name, { type: 'text/calendar' }) : null;
      if(file && navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file], title: 'RoutePal' }); return; }
    }catch(e){ if(e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    Toast.show(tf('cal_saved', { n: items.length }), 'success', 6000);
  },

  async enableReminders(){
    const ok = await this.requestNotifyPermission();
    Toast.show(t(ok ? 'remind_on' : 'remind_denied'), ok ? 'success' : 'error', 6000);
    if(ok) this.scheduleReminders();
    if(state.currentScreen === 'home') this.renderHome();
  },

  // One timer per stop still ahead today (up to 12 hours out), replaced each
  // time the day changes. Nothing is set without permission.
  scheduleReminders(now){
    (this._remindTimers || []).forEach(clearTimeout);
    this._remindTimers = [];
    if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return 0;
    const d = now || new Date(), nowMin = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    for(const x of this._todayAgenda()){
      if(!x.time || x.done) continue;
      const wait = (Scheduler.toMin(x.time) - this.remindMin() - nowMin) * 60000;
      if(wait <= 0 || wait > 12 * 3600000) continue;
      this._remindTimers.push(setTimeout(() => this._remind(x), wait));
    }
    // With the compute server, the same reminders also come with the app
    // closed: the server is told only WHEN (and an opaque key per stop); what
    // each one says stays on the phone, in IndexedDB, where the service
    // worker reads it at the moment the notification is shown.
    try{ if(Remote.available() && VAPID_PUBLIC) this._pushReminders(d); }catch(e){}
    return this._remindTimers.length;
  },
  async _pushReminders(d){
    const base = new Date(d); base.setHours(0, 0, 0, 0);
    const items = [], texts = {};
    for(const x of this._todayAgenda()){
      if(!x.time || x.done) continue;
      const at = base.getTime() + (Scheduler.toMin(x.time) - this.remindMin()) * 60000;
      if(at <= d.getTime() || at - d.getTime() > 24 * 3600000) continue;
      const k = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
      texts[k] = { title: tf('remind_title', { min: this.remindMin(), name: x.title }),
        body: [x.time, x.address].filter(Boolean).join(' · '), tag: 'rp-' + x.id };
      items.push({ t: at, k });
    }
    await RemindStore.replace(texts);
    const push = await Remote._push();
    if(!push) return;
    await fetch(Remote._url('/reminders'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ push, items, fallback: { title: tf('remind_title', { min: this.remindMin(), name: '' }).replace(/[:\s]+$/, '') } }) });
  },
  _remind(x){
    const title = tf('remind_title', { min: this.remindMin(), name: x.title });
    const opts = { body: [x.time, x.address].filter(Boolean).join(' · '), icon: 'icon-192.png', tag: 'rp-' + x.id };
    try{
      if(navigator.serviceWorker && navigator.serviceWorker.ready)
        navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(() => { new Notification(title, opts); });
      else new Notification(title, opts);
    }catch(e){}
  },

  notifyScheduleReady(){
    if(typeof Notification==='undefined' || Notification.permission!=='granted') return;
    // Only bother if the user isn't already looking at the app — the
    // floating progress banner already told them while it was running.
    if(typeof document!=='undefined' && !document.hidden) return;
    try{ new Notification(t('notif_schedule_ready_title'), { body: t('notif_schedule_ready_body'), icon:'icon-192.png' }); }catch(e){}
  },

  updateNavLabels(){
    const L = getLabels();
    const el = document.getElementById('nav-clients-label');
    if(el) el.textContent = L.clients;
    const map = {
      'nav-home-label':'nav_home','nav-fab-label':'fab_new','nav-schedule-label':'nav_schedule','nav-route-label':'nav_route','nav-settings-label':'nav_settings',
      'drawer-student-title':'drawer_new_prefix','drawer-student-cancel-btn':'btn_cancel','drawer-student-save-btn':'btn_save',
      'drawer-block-title':'block_drawer_title','drawer-block-cancel-btn':'btn_cancel','drawer-block-save-btn':'btn_save',
      'confirm-title':'confirm_title','confirm-cancel-btn':'btn_cancel','confirm-ok-btn':'btn_delete',
      'sched-phase':'debug_calc_prefix','sched-sub':'common_please_wait',
    };
    for(const [id,key] of Object.entries(map)){
      const e = document.getElementById(id);
      if(e) e.textContent = t(key);
    }
  },

  // ---- SCHEDULER ----
  runScheduler(){
    if(state.students.length===0) return;
    const result = Scheduler.run(state.students, state.settings, state.coords);
    state.scheduleAttempts = [result];
    state.scheduleAttemptIdx = 0;
    state.scheduleOptimized = false;
    state.scheduleKmBefore = null;
    state.scheduleKmAfter = null;
    state.schedule = result.schedule;
    state.schedulerResult = result;
    state.routeResults = {};
    Storage.saveSchedule(state.schedule);
    return result;
  },

  switchAttempt(idx){
    state.scheduleAttemptIdx = idx;
    const r = state.scheduleAttempts[idx];
    state.schedule = r.schedule;
    state.schedulerResult = r;
    state.routeResults = {};
    state.scheduleOptimized = false;
    state.scheduleKmBefore = null;
    state.scheduleKmAfter = null;
    Storage.saveSchedule(state.schedule);
    this.renderSchedule();
  },

  // How many lessons a schedule actually places. The primary objective —
  // a shorter week that teaches fewer people is not an improvement.
  _countPlaced(schedule){
    if(!schedule) return 0;
    // Scheduler.countTotal, not a raw slot count: a group block of three is
    // three lessons placed, so the ratchet cannot trade a group away for a
    // shorter drive and call it an improvement.
    try{ return Scheduler.countTotal(schedule); }catch(e){ return 0; }
  },

  // Strictly better = more lessons placed, or the same number in fewer km.
  // The 0.1 km deadband stops two effectively identical schedules from
  // swapping places on rounding noise.
  _isBetterSchedule(a, b){
    if(!b) return true;
    if(a.placed !== b.placed) return a.placed > b.placed;
    return a.km < b.km - 0.1;
  },

  // Is the schedule currently on screen still a legal answer to the CURRENT
  // students and settings? Only then may it be used as a floor for a rerun —
  // otherwise a rerun after editing availability would be pinned to a schedule
  // that is no longer valid.
  _scheduleStillValid(schedule){
    if(!schedule || this._countPlaced(schedule) === 0) return false;
    const ids = new Set(state.students.map(s=>s.id));
    for(const d of Object.keys(schedule)){
      for(const sl of (schedule[d]||[])){
        // References a deleted student — stale by definition.
        if(!ids.has(sl.studentId)) return false;
      }
    }
    try{
      return Scheduler.verifySchedule(schedule, state.students, state.settings).length === 0;
    }catch(e){ return false; }
  },

  // Real road km for a schedule, falling back to the straight-line estimate.
  // Both sides of a comparison must go through the same function or the
  // comparison is meaningless.
  // ---- KILOMETRES THAT FOLLOW THE SCHEDULE ----
  //
  // The week's kilometres used to be a number stored at the end of a full
  // calculation, and the Route screen kept a stored road route per day. Neither
  // remembered WHICH schedule it was computed for, so a hand swap, a move, a
  // filled gap or a break left both showing the old figures — while the
  // lessons on screen were the new ones.
  //
  // Wiring a recalculation into every place that changes the schedule does not
  // work: there are five today, and the sixth will forget. Instead each stored
  // result carries a fingerprint of what it was computed from, and is used only
  // while the schedule still matches it.

  _placeKey(id){
    const c = state.coords && state.coords[id];
    return (c && Number.isFinite(c.lat) && Number.isFinite(c.lon))
      ? `${c.lat.toFixed(4)},${c.lon.toFixed(4)}` : '?';
  },

  /** What one day's route depends on: who, when, and where they live. */
  dayKey(day){
    const slots = ((state.schedule || {})[day] || []).slice()
      .sort((a,b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start));
    return slots.map(x => `${x.studentId}@${x.start}-${x.end}@${this._placeKey(x.studentId)}`).join(',')
      + '|home:' + this._placeKey('home');
  },

  scheduleKey(){
    return Object.keys(state.schedule || {}).sort().map(d => d + ':' + this.dayKey(d)).join('||');
  },

  /** A stored road route for a day, but only if the day is still what it was. */
  routeFor(day){
    const rr = state.routeResults && state.routeResults[day];
    return (rr && rr._key === this.dayKey(day)) ? rr : null;
  },

  /**
   * The week's kilometres for the schedule as it is NOW.
   *
   * Returns at once: the straight-line figure, which is always about the
   * current schedule, or the road figure if it has already been worked out for
   * exactly this schedule. If it has not, the road figure is fetched in the
   * background and the screen redrawn when it lands.
   */
  currentKm(){
    const key = this.scheduleKey();
    const c = state._kmCache;
    if(c && c.key === key) return c;
    this._scheduleKmRefresh(key);
    return { key, km: this._estimateTotalKm(state.schedule || {}), real: false };
  },

  _scheduleKmRefresh(key){
    if(state._kmPending === key) return;
    state._kmPending = key;
    clearTimeout(this._kmTimer);
    // A short delay so a run of quick changes asks the road service once, not
    // once per change.
    this._kmTimer = setTimeout(async () => {
      let km;
      try{ km = await this._kmOf(state.schedule || {}); }
      catch(e){ km = this._estimateTotalKm(state.schedule || {}); }
      if(state._kmPending === key) state._kmPending = null;
      // The schedule changed while the road figure was on its way: it answers a
      // question nobody is asking any more, and a newer refresh owns the screen.
      if(this.scheduleKey() !== key) return;
      state._kmCache = { key, km, real: true };
      state.scheduleKmBefore = km;
      if(state.currentScreen === 'home') this.renderHome();
    }, 350);
  },

  async _kmOf(schedule){
    try{ return await this._estimateTotalKmReal(schedule); }
    catch(e){ return this._estimateTotalKm(schedule); }
  },

  // Straight-line ("as the crow flies") estimate — instant, no network. Used as
  // an immediate placeholder and as the per-day fallback when OSRM is
  // unreachable for _estimateTotalKmReal below.
  _estimateTotalKm(schedule){
    const homeC = state.coords['home'] || Scheduler.coordsHash(state.settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα');
    let total = 0;
    for(const day of Object.keys(schedule)){
      const slots = schedule[day];
      if(!slots.length) continue;
      let prev = homeC;
      let prevSl = null;
      for(const sl of slots){
        const c = state.coords[sl.studentId] || Scheduler.coordsHash(sl.address);
        const sameLocation = prevSl && (prevSl.studentId === sl.studentId ||
          (prevSl.groupCode && prevSl.groupCode === sl.groupCode));
        if(!sameLocation) total += Router.estimateKm(prev, c);
        prev = c;
        prevSl = sl;
      }
      total += Router.estimateKm(prev, homeC);
    }
    return total;
  },

  // Real driving-distance total (home → first lesson → … → last lesson → home,
  // for every work day, summed for the week) using OSRM's road network — the
  // same source of truth as the Route screen, so this matches what you'd see
  // in Google Maps/Waze instead of a straight-line guess. One matrix request
  // per day (home + that day's unique stop locations); any day whose request
  // fails falls back to the straight-line estimate for just that day, so a
  // single network hiccup never blanks out the whole week's total.
  async _estimateTotalKmReal(schedule){
    const homeC = state.coords['home'] || Scheduler.coordsHash(state.settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα');
    let total = 0;
    for(const day of Object.keys(schedule)){
      const slots = schedule[day].slice().sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
      if(!slots.length) continue;
      const uniqueSlots = [];
      let prevSl = null;
      slots.forEach(sl=>{
        const sameLocation = prevSl && (prevSl.studentId === sl.studentId ||
          (prevSl.groupCode && prevSl.groupCode === sl.groupCode));
        if(!sameLocation) uniqueSlots.push(sl);
        prevSl = sl;
      });
      if(!uniqueSlots.length) continue;
      // Reuse the road matrix already fetched for this run (HERE when a key is
      // set, OSRM otherwise) via travelEstKm, instead of firing a second,
      // OSRM-only request per day. Previously this ignored a configured HERE
      // key entirely, so the headline km figure came from a different engine
      // than the schedule was planned with — and cost one extra network round
      // trip per day on every run. travelEstKm falls back to straight-line
      // internally when no matrix is available.
      const homeAddr = state.settings.homeAddress || '';
      let dayKm = 0;
      let prevId = 'home', prevAddr = homeAddr;
      uniqueSlots.forEach(sl=>{
        dayKm += Scheduler.travelEstKm(prevId, prevAddr, sl.studentId, sl.address, Number(day));
        prevId = sl.studentId; prevAddr = sl.address;
      });
      dayKm += Scheduler.travelEstKm(prevId, prevAddr, 'home', homeAddr, Number(day));
      total += dayKm;
    }
    return total;
  },

  // Opens a clean printable view of the full weekly schedule in a new tab and
  // triggers the browser's print dialog — user picks "Save as PDF" there.
  // Builds and downloads a real .pdf file directly (jsPDF), instead of opening a
  // print dialog — window.print() from a JS-opened window is unreliable on iOS,
  // especially when the app is installed as a standalone PWA (no browser chrome
  // to offer "Save as PDF" from), so it often looked like nothing happened.
  // Builds and downloads a real .pdf file directly, instead of opening a print
  // dialog — window.print() from a JS-opened window is unreliable on iOS,
  // especially when the app is installed as a standalone PWA (no browser chrome
  // to offer "Save as PDF" from), so it often looked like nothing happened.
  //
  // Renders the schedule as real HTML (so Greek text uses the browser's own
  // fonts correctly — jsPDF's built-in fonts don't support Greek glyphs at all),
  // rasterizes it with html2canvas, then slices that image across as many A4
  // pages as needed inside a jsPDF document and triggers a native download.
  // jsPDF and html2canvas together are ~550KB — more than the app itself — and
  // are used by exactly one button. Loading them eagerly in <head> made every
  // cold start pay for a feature most sessions never touch. Fetched on first
  // use instead, then cached by the browser for the rest of the session.
  _pdfLibsPromise: null,
  loadPdfLibs(){
    if(typeof jspdf !== 'undefined' && jspdf.jsPDF && typeof html2canvas !== 'undefined'){
      return Promise.resolve();
    }
    if(this._pdfLibsPromise) return this._pdfLibsPromise; // a second click must not load them twice
    // Loaded with an integrity hash, like the ones in the head. A CDN is a
    // single point at which somebody else's code can be swapped for something
    // that reads every student's name and address out of localStorage; the hash
    // means the browser refuses anything but the exact bytes published for
    // these versions. Bump the hash whenever the version is bumped — a stale
    // one blocks the file outright, which is the correct failure but an
    // unhelpful one to debug.
    const SRI = {
      'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js':
        'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
      'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js':
        'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H',
    };
    const script = (src) => new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      if(SRI[src]){ el.integrity = SRI[src]; el.crossOrigin = 'anonymous'; }
      el.onload = resolve;
      el.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(el);
    });
    this._pdfLibsPromise = Promise.all(Object.keys(SRI).map(script))
    .catch(err => {
      this._pdfLibsPromise = null; // allow a retry after a transient failure
      throw err;
    });
    return this._pdfLibsPromise;
  },

  // Hand the finished PDF to the person the way their device expects. Phones
  // and tablets get the share sheet (Save to Files, WhatsApp, Print…): a
  // download from an app on the home screen often goes nowhere on iOS. Else a
  // plain download, with a real file name and .pdf at the end.
  async _deliverPdf(blob, fileName){
    const pdf = new Blob([blob], { type: 'application/pdf' });
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches;
    try{
      const file = typeof File === 'function' ? new File([pdf], fileName, { type: 'application/pdf' }) : null;
      if(coarse && file && navigator.canShare && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], title: fileName });
        Toast.show(t('toast_pdf_downloaded'), 'success');
        return;
      }
    }catch(e){
      if(e && e.name === 'AbortError') return;        // closed the share sheet: nothing to say
    }
    const url = URL.createObjectURL(pdf);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    Toast.show(t('toast_pdf_downloaded'), 'success');
  },

  async printSchedule(){
    Toast.show(t('toast_pdf_generating'),'info');
    try{
      await this.loadPdfLibs();
    }catch(e){
      Toast.show(t('toast_pdf_lib_failed'),'error'); return;
    }
    if(typeof jspdf === 'undefined' || !jspdf.jsPDF || typeof html2canvas === 'undefined'){
      Toast.show(t('toast_pdf_lib_failed'),'error'); return;
    }
    const teacherName = state.settings.teacherName || 'RoutePal';
    const avatarColors=['#059669','#7c3aed','#d97706','#db2777','#ca8a04','#0891b2','#16a34a','#9333ea','#c2410c','#0284c7'];
    const dateLocale = curLang()==='el'?'el-GR':curLang();
    const genDate = new Date().toLocaleDateString(dateLocale,{weekday:'long',year:'numeric',month:'long',day:'numeric'});

    // A4 at 760 css px wide. Each page is rendered on its own, so nothing is
    // ever cut in half by a page edge: the rows are measured first and
    // packed into pages (see _pdfPack).
    const PAGE_W = 760, PAGE_H = Math.round(760 * 841.89 / 595.28);
    const css = this._pdfCss();
    const made = [];
    try{
      // The week at a glance, on its side like a school timetable: one page.
      const doc = new jspdf.jsPDF({unit:'pt', format:'a4', orientation:'landscape', compress:true});
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:-9999px;top:0;width:${PAGE_H}px;height:${PAGE_W}px;box-sizing:border-box;background:#fff;padding:28px 32px;font-family:-apple-system,BlinkMacSystemFont,"DM Sans","Segoe UI",Arial,sans-serif;color:#1c1c2e;overflow:hidden`;
      el.innerHTML = `<style>${css}</style>` + this._pdfGrid(teacherName, genDate, avatarColors, PAGE_W - 56) +
        `<div class="pdf-footer">RoutePal · ${esc(genDate)}</div>`;
      document.body.appendChild(el); made.push(el);
      const canvas = await html2canvas(el, {scale:2, backgroundColor:'#ffffff', useCORS:true});
      doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight());
      const safeTeacher = teacherName.replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'') || 'routepal';
      // Latin letters only: with Greek ones in it Chrome drops the name and
      // saves a file called "download", with no .pdf for the phone to open.
      const G = { α:'a',β:'v',γ:'g',δ:'d',ε:'e',ζ:'z',η:'i',θ:'th',ι:'i',κ:'k',λ:'l',μ:'m',ν:'n',ξ:'x',ο:'o',π:'p',ρ:'r',σ:'s',ς:'s',τ:'t',υ:'y',φ:'f',χ:'ch',ψ:'ps',ω:'o' };
      const latin = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[α-ω]/g, c => G[c] || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const fileName = `${latin(safeTeacher) || 'RoutePal'}-${latin(t('print_title')) || 'schedule'}-${new Date().toISOString().slice(0, 10)}.pdf`;
      await this._deliverPdf(doc.output('blob'), fileName);
    }catch(e){
      console.error('PDF generation failed:', e);
      Toast.show(t('toast_pdf_lib_failed'),'error');
    }finally{
      for(const el of made) try{ document.body.removeChild(el); }catch(e){}
    }
  },

  // The week as a timetable: a column per working day, the hours down the
  // side, every appointment a block where it falls and as tall as it lasts.
  // `innerH` is the height available inside the page's padding.
  _pdfGrid(teacherName, genDate, colours, innerH){
    const st = state.settings, days = st.workDays || [];
    const byDay = Object.fromEntries(days.map(d => [d, this._mergeConsecutiveRouteStops((state.schedule[d] || []).slice()
      .sort((a, b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start)))]));
    let lo = 24 * 60, hi = 0;
    for(const d of days) for(const sl of byDay[d]){ lo = Math.min(lo, Scheduler.toMin(sl.start)); hi = Math.max(hi, Scheduler.toMin(sl._mergedEnd || sl.end)); }
    if(hi <= lo){ lo = 9 * 60; hi = 17 * 60; }
    lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
    const HEAD = 54, DAYHEAD = 30, FOOT = 30;
    const gridH = innerH - HEAD - DAYHEAD - FOOT, ppm = gridH / (hi - lo);
    const y = (m) => ((m - lo) * ppm).toFixed(1);
    const tint = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},.13)`; };
    const hours = []; for(let h = lo; h <= hi; h += 60) hours.push(h);
    const col = (d) => {
      const raw = state.schedule[d] || [];
      const km = raw.length ? Scheduler.dayKm(raw.slice().sort((a, b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start)), d, st) : 0;
      const blocks = byDay[d].map(sl => {
        const s0 = Scheduler.toMin(sl.start), e0 = Scheduler.toMin(sl._mergedEnd || sl.end), h = (e0 - s0) * ppm - 2;
        const c = colours[(sl.color || 0) % colours.length];
        const time = `${esc(sl.start)}–${esc(sl._mergedEnd || sl.end)}`;
        // a short block has room for one line: the name, with the start time
        return `<div class="pdf-g-block" style="top:${y(s0)}px;height:${Math.max(12, h).toFixed(1)}px;border-left-color:${c};background:${tint(c)}">
          ${h >= 30 ? `<div class="pdf-g-time">${time}</div><div class="pdf-g-name">${esc(sl.studentName)}</div>`
                    : `<div class="pdf-g-name"><span class="pdf-g-time">${esc(sl.start)}</span> ${esc(sl.studentName)}</div>`}
        </div>`;
      }).join('');
      return `<div class="pdf-g-col">
        <div class="pdf-g-dayhead" style="height:${DAYHEAD}px"><b>${esc(DAYS_FULL[d])}</b><span>${raw.length ? `${raw.length} · ${km.toFixed(1)} km` : '—'}</span></div>
        <div class="pdf-g-body" style="height:${gridH.toFixed(1)}px">
          ${hours.map(h => `<div class="pdf-g-line" style="top:${y(h)}px"></div>`).join('')}${blocks}
        </div></div>`;
    };
    return `<div class="pdf-header pdf-header-slim" style="height:${HEAD - 14}px;margin-bottom:14px;align-items:center">
        <div><div class="pdf-brand" style="font-size:20px">Route<b>Pal</b> <span class="pdf-g-sub">${esc(t('print_h1_sub'))}</span></div></div>
        <div class="pdf-meta"><strong>${esc(teacherName)}</strong>${esc(genDate)}</div></div>
      <div class="pdf-g">
        <div class="pdf-g-axis" style="padding-top:${DAYHEAD}px;height:${gridH.toFixed(1)}px">
          ${hours.map(h => `<div class="pdf-g-hour" style="top:${(Number(y(h)) + DAYHEAD - 6).toFixed(1)}px">${Scheduler.toTime(h)}</div>`).join('')}
        </div>
        ${days.map(col).join('')}
      </div>`;
  },

  _pdfCss(){
    return `
        .pdf-header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1c1c2e;padding-bottom:14px;margin-bottom:6px}
        .pdf-header-slim{border-bottom-width:1px;padding-bottom:8px;margin-bottom:0}
        .pdf-header-slim .pdf-brand{font-size:16px}
        .pdf-brand{font-size:24px;font-weight:800;letter-spacing:-.02em}
        .pdf-brand b{color:#059669}
        .pdf-brand-sub{font-size:12px;color:#64748b;margin-top:2px;font-weight:500}
        .pdf-meta{text-align:right;font-size:11px;color:#64748b;line-height:1.6}
        .pdf-meta strong{color:#1c1c2e;font-size:13px;display:block;font-weight:700}
        .pdf-stats{display:flex;gap:10px;padding:18px 0 10px}
        .pdf-stat{flex:1;background:#f7f6f3;border-radius:10px;padding:10px 14px;text-align:center}
        .pdf-stat-val{font-size:20px;font-weight:800;color:#1c1c2e}
        .pdf-stat-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-top:2px;font-weight:600}
        .pdf-dayhead{margin-top:14px;font-size:14px;background:#1c1c2e;color:#fff;padding:7px 12px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center}
        .pdf-dayhead b{font-weight:700}
        .pdf-dayhead span{color:#a7f3d0;font-weight:500;font-size:11px}
        .pdf-empty{color:#64748b;font-size:12px;padding:5px 0;text-align:center;font-style:italic;flex:1}
        .pdf-slot{display:flex;align-items:center;gap:12px;padding:9px 12px;border:1px solid #e2e0da;border-top:none}
        .pdf-slot.pdf-last{border-radius:0 0 8px 8px}
        .pdf-slot-color{width:4px;align-self:stretch;border-radius:2px;flex-shrink:0;min-height:28px}
        .pdf-slot-time{font-weight:700;font-size:12px;color:#1c1c2e;width:92px;flex-shrink:0}
        .pdf-slot-info{flex:1;min-width:0}
        .pdf-slot-name{font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px}
        .pdf-slot-meta{font-size:11px;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pdf-slot-drive{font-size:11px;color:#64748b;white-space:nowrap;flex-shrink:0}
        .pdf-badge{font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:#d1fae5;color:#047857;text-transform:uppercase;letter-spacing:.03em}
        .pdf-badge.pdf-lock{background:#e2e8f0;color:#334155}
        .pdf-g{display:flex;gap:6px;position:relative}
        .pdf-g-sub{font-size:12px;color:#64748b;font-weight:500;letter-spacing:0;margin-left:8px}
        .pdf-g-axis{width:40px;flex-shrink:0;position:relative}
        .pdf-g-hour{position:absolute;right:4px;font-size:10px;color:#64748b}
        .pdf-g-col{flex:1 1 0;min-width:0}
        .pdf-g-dayhead{box-sizing:border-box;background:#1c1c2e;color:#fff;border-radius:6px 6px 0 0;padding:0 8px;display:flex;justify-content:space-between;align-items:center;font-size:12px}
        .pdf-g-dayhead span{color:#a7f3d0;font-size:10px;white-space:nowrap}
        .pdf-g-body{position:relative;border:1px solid #e2e0da;border-top:none;border-radius:0 0 6px 6px;overflow:hidden}
        .pdf-g-line{position:absolute;left:0;right:0;border-top:1px solid #f0efe9}
        .pdf-g-block{position:absolute;left:3px;right:3px;box-sizing:border-box;border-left:3px solid #059669;border-radius:4px;padding:2px 5px;overflow:hidden}
        .pdf-g-time{font-size:9px;font-weight:700;color:#334155}
        .pdf-g-name{font-size:10.5px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pdf-footer{position:absolute;left:32px;right:32px;bottom:22px;padding-top:8px;border-top:1px solid #e2e0da;font-size:10px;color:#64748b;display:flex;justify-content:space-between}`;
  },

  // Called by the ✕ button on the progress overlay. Just flips a flag — the
  // long-running phases (alnsOptimize's loop, lnsRepair's loop) poll it and
  // return early, and runAndNotify itself checks it between phases. Actually
  // restoring the previous schedule happens once control gets back to
  // runAndNotify's cleanup, not here, since a phase mid-mutation can't be
  // safely interrupted from outside.
  // Respond at the tap: the bar goes, the Refresh button comes back and the
  // previous schedule stays. The run itself stops within a moment (every
  // long loop checks the flag) and then puts the previous schedule back.
  cancelScheduling(){
    if(!state._schedulingInProgress || state._schedulingCancelled) return;
    state._schedulingCancelled = true;
    state._cancelShown = true;
    if(this._schedWorker){ try{ this._schedWorker.reject(new Error('cancelled')); }catch(e){} }
    for(const x of (this._schedWorkers || []).slice()){ try{ x.reject(new Error('cancelled')); }catch(e){} }
    try{ schedProgress(null); }catch(e){}
    const rb = document.querySelector('.btn[onclick*="runAndNotify"]');
    if(rb){ rb.disabled=false; rb.style.opacity=''; rb.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> ${t('schedule_refresh')}`; }
    Toast.show(t('toast_scheduling_cancelled'), 'info');
  },

  // ── Phase 1 in a worker ────────────────────────────────────────────────
  // The worker runs this same script (taken from the page), with stand-ins
  // for the page objects it never uses there, and answers one message:
  // runMultiAttempt for the inputs it is given.
  _WORKER_PRELUDE: `
    const __stub = () => ({ style:{}, dataset:{}, value:'', textContent:'', innerHTML:'',
      classList:{ add(){}, remove(){}, contains(){ return false; }, toggle(){} },
      addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){},
      setAttribute(){}, getAttribute(){ return null; }, querySelector(){ return __stub(); },
      querySelectorAll(){ return []; }, closest(){ return null; },
      getBoundingClientRect(){ return { top:0, left:0, width:0, height:0 }; } });
    self.document = { getElementById: () => __stub(), querySelector: () => null, querySelectorAll: () => [],
      createElement: () => __stub(), addEventListener(){}, body: __stub(), head: __stub(),
      documentElement: { dataset:{}, style:{} } };
    self.window = self;
    self.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){}, clear(){} };
    self.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    self.cancelAnimationFrame = (id) => clearTimeout(id);
    self.matchMedia = () => ({ matches: false, addEventListener(){} });
    self.L = undefined;
  `,
  _WORKER_HANDLER: `
    self.onmessage = async (e) => {
      const m = e.data;
      try{
        Object.assign(state, m.state);
        if(m.type === 'week'){
          const out = await Scheduler.optimizeWeek(m.input, {
            progress: (p, a, b, c) => { if(m.progress) self.postMessage({ progress: [p, a, b, c] }); },
            stopped: () => false });
          self.postMessage({ ok: true, result: out });
        } else {
          const r = await Scheduler.runMultiAttempt(m.students, m.settings, m.coords, m.attempts, false);
          self.postMessage({ ok: true, result: r });
        }
      }catch(err){ self.postMessage({ ok: false, error: String((err && err.message) || err) }); }
    };
  `,
  // One worker job. Every live worker is kept in _schedWorkers so ✕ can
  // stop them all at once.
  _workerCall(message, onProgress){
    return new Promise((resolve, reject) => {
      let w;
      try{
        if(typeof Worker === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) return reject(new Error('no-worker'));
        if(!this._schedWorkerUrl){
          const src = [...document.querySelectorAll('script:not([src])')].map(x => x.textContent).find(x => x.includes('const Scheduler = {'));
          if(!src) return reject(new Error('no-source'));
          this._schedWorkerUrl = URL.createObjectURL(new Blob([this._WORKER_PRELUDE, src, this._WORKER_HANDLER], { type: 'text/javascript' }));
        }
        w = new Worker(this._schedWorkerUrl);
      }catch(e){ return reject(new Error('no-worker')); }
      this._schedWorkers = this._schedWorkers || [];
      const entry = { w, reject: null };
      const done = () => { this._schedWorkers = (this._schedWorkers || []).filter(x => x !== entry); try{ w.terminate(); }catch(e){} };
      entry.reject = (err) => { done(); reject(err); };
      this._schedWorkers.push(entry);
      w.onmessage = (e) => {
        const d = e.data || {};
        if(d.progress){ if(onProgress) onProgress(...d.progress); return; }
        done(); d.ok ? resolve(d.result) : reject(new Error(d.error || 'worker'));
      };
      w.onerror = (e) => { if(e && e.preventDefault) e.preventDefault(); done(); reject(new Error('no-worker')); };
      w.postMessage({ ...message, progress: !!onProgress, state: {
        settings: state.settings, coords: state.coords, students: state.students, schedule: state.schedule, jobs: state.jobs,
        travelMatrixPeak: state.travelMatrixPeak, travelMatrixOffPeak: state.travelMatrixOffPeak, travelMatrix: state.travelMatrix,
        dayMatrixPeak: state.dayMatrixPeak, dayMatrixOffPeak: state.dayMatrixOffPeak, idAlias: state.idAlias || null } });
    });
  },
  // Two rounds share one bar. A round reports 15..95; the first is drawn
  // over 15..60 and the second over 60..98, so neither sits at a ceiling
  // while it is still working (the second used to be squeezed into 90..99).
  _round1Pct(p){ return p <= 15 ? p : Math.min(60, 15 + (p - 15) * 45 / 80); },
  _round2Pct(p){ return Math.min(94, 60 + Math.max(0, p - 55) * 34 / 40); },
  // How many runs at once: one per spare core, at most three.
  _parallelRuns(){
    const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    return Math.max(1, Math.min(3, n - 1));
  },
  // Two rounds, each as several runs at once in workers; the best wins by
  // the app's rule. Round 2 starts every run from the best week of round 1
  // (no fresh placement) and searches again from there: measured on the
  // owner's week, a run from 138.2 km found 127.2 km 3 times in 8.
  async _optimizeParallel(input, onProgress){
    const k = this._parallelRuns();
    const round = async (inp, prog) => {
      const outs = await Promise.all(Array.from({ length: k }, (_, i) =>
        this._workerCall({ type: 'week', input: i === 0 ? inp : { ...inp, shuffleFirst: true } }, i === 0 ? prog : null).catch(e => e)));
      if(outs.some(o => o instanceof Error && o.message === 'cancelled')) throw new Error('cancelled');
      const good = outs.filter(o => o && !(o instanceof Error) && o.schedule);
      if(!good.length) throw outs[0] instanceof Error ? outs[0] : new Error('worker');
      let best = good[0];
      for(const o of good.slice(1)) if(Scheduler.isBetterStart(o.schedule, best.schedule, inp.settings)) best = o;
      return best;
    };
    const first = await round(input, onProgress ? (p, a, b, c) => onProgress(this._round1Pct(p), a, b, c) : null);
    if(state._schedulingCancelled) return first;
    const second = await round({ ...input, students: first.students || input.students, warm: first.schedule, skipPhase1: true },
      onProgress ? (p, a, b, c) => onProgress(this._round2Pct(p), 'phase_refine_title', 'phase_refine_sub') : null).catch(e => {
        if(e && e.message === 'cancelled') throw e; return null; });
    const best = second && Scheduler.isBetterStart(second.schedule, first.schedule, input.settings) ? second : first;
    console.info(`parallel runs: ${k} at a time, two rounds; round 2 ${best === second ? 'improved' : 'kept round 1'}`);
    return { ...best, result: first.result };
  },

  _workerRun(students, settings, coords, attempts){
    return new Promise((resolve, reject) => {
      let w;
      try{
        if(typeof Worker === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) return reject(new Error('no-worker'));
        if(!this._schedWorkerUrl){
          const src = [...document.querySelectorAll('script:not([src])')].map(x => x.textContent).find(x => x.includes('const Scheduler = {'));
          if(!src) return reject(new Error('no-source'));
          this._schedWorkerUrl = URL.createObjectURL(new Blob([this._WORKER_PRELUDE, src, this._WORKER_HANDLER], { type: 'text/javascript' }));
        }
        w = new Worker(this._schedWorkerUrl);
      }catch(e){ return reject(new Error('no-worker')); }
      const done = () => { if(this._schedWorker && this._schedWorker.w === w) this._schedWorker = null; try{ w.terminate(); }catch(e){} };
      this._schedWorker = { w, reject: (err) => { done(); reject(err); } };
      w.onmessage = (e) => { done(); e.data && e.data.ok ? resolve(e.data.result) : reject(new Error((e.data && e.data.error) || 'worker')); };
      w.onerror = (e) => { if(e && e.preventDefault) e.preventDefault(); done(); reject(new Error('no-worker')); };
      w.postMessage({ students, settings, coords, attempts, state: {
        settings, coords, students, schedule: state.schedule, jobs: state.jobs,
        travelMatrixPeak: state.travelMatrixPeak, travelMatrixOffPeak: state.travelMatrixOffPeak, travelMatrix: state.travelMatrix,
        dayMatrixPeak: state.dayMatrixPeak, dayMatrixOffPeak: state.dayMatrixOffPeak, idAlias: state.idAlias || null } });
    });
  },

  async runAndNotify(){
    // Two runs must never be in flight at once: several entry points can start
    // one (the two Ανανέωση buttons, the unplaced-student suggestions,
    // saveSettings), and previously the second would immediately clear
    // _schedulingCancelled — un-cancelling the first, leaving both alive and
    // both writing to state.schedule from different inputs. Stop the running
    // one and wait for it to actually unwind before starting.
    if(state._schedulingInProgress){
      this.cancelScheduling();
      const waitStart = Date.now();
      while(state._schedulingInProgress && Date.now()-waitStart < 15000){
        await new Promise(r=>setTimeout(r,50));
      }
    }
    const btn = document.querySelector('.btn[onclick*="runAndNotify"]');
    if(btn){ btn.disabled=true; btn.style.opacity='0.6'; btn.innerHTML = btn.innerHTML.replace(new RegExp(t('schedule_refresh')+'|<svg[^>]*>.*?<\\/svg>\\s*','s'),'') ; btn.textContent = t('debug_geocoding'); }
    state._schedulingInProgress = true;
    state._schedulingCancelled = false;
    state._cancelShown = false;
    // Generation marker: if a newer run starts anyway (e.g. the wait above
    // timed out on a stuck phase), this one must not write its now-stale
    // result over the newer one's.
    const myToken = (state._runToken = (state._runToken||0) + 1);
    const isStale = () => state._runToken !== myToken;
    // Keep a snapshot to restore if the user cancels — a half-optimized
    // schedule from an interrupted run is worse than just keeping what was
    // there before "Ανανέωση" was pressed.
    const scheduleBackup = JSON.parse(JSON.stringify(state.schedule));
    const kmBeforeBackup = state.scheduleKmBefore, kmAfterBackup = state.scheduleKmAfter;
    // Whether that snapshot may act as a quality floor for this run. Decided
    // once, up front, before anything has been mutated.
    const prevUsable = this._scheduleStillValid(scheduleBackup);
    // Flexible weekly time starts every run from its longest pieces.
    const flexBackup = state.students.filter(st => Scheduler.isFlex(st))
      .map(st => [st, JSON.parse(JSON.stringify({ d: st.durations, n: st.lessonsPerWeek, h: st.hoursPerWeek, l: st.lessonDuration }))]);
    for(const [st] of flexBackup) Scheduler.flexStart(st);
    // Clients with more lessons than days they fit on get a double lesson
    // where one fits (kept on the client, and said once).
    {
      const joined = [];
      for(const st of state.students){
        const durs = Scheduler.autoCombine(st, state.settings);
        if(!durs) continue;
        st.durations = durs; st.lessonsPerWeek = st.hoursPerWeek = durs.length; st.lessonDuration = Math.max(...durs);
        st.mergeMode = 'off'; st.forceMerge = false;
        joined.push(st.name + ' (' + durs.map(d => d >= 120 && d % 60 === 0 ? d / 60 + t('unit_hr') : d + '′').join(' + ') + ')');
      }
      if(joined.length){ Storage.saveStudents(state.students); Toast.show(tf('auto_combined', { list: joined.join(', ') }), 'info', 9000); }
    }
    // Reset per run: it is only set inside the success path, so a failed run
    // used to leave the previous run's value behind and the toast lied.
    state._keptPreviousSchedule = false;
    state._schedulerError = null;
    const cancelledCleanup = ()=>{
      // Superseded rather than genuinely cancelled — the newer run owns the
      // schedule now, so restoring this run's pre-start snapshot would undo
      // whatever it has already produced.
      if(isStale()) return;
      state.schedule = scheduleBackup;
      for(const [st, v] of flexBackup){
        st.durations = v.d; st.lessonsPerWeek = v.n; st.hoursPerWeek = v.h; st.lessonDuration = v.l;
      }
      state.scheduleKmBefore = kmBeforeBackup;
      state.scheduleKmAfter = kmAfterBackup;
      Storage.saveSchedule(state.schedule);
      state._schedulingCancelled = false;
      state._schedulingInProgress = false;
      clearTimeout(this._schedulingWatchdog);
      schedProgress(null,null,null,null);
      if(btn){ btn.disabled=false; btn.style.opacity=''; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> ${t('schedule_refresh')}`; }
      if(state.currentScreen==='schedule') this.renderSchedule();
      else if(state.currentScreen==='home') this.renderHome();
      if(!state._cancelShown) Toast.show(t('toast_scheduling_cancelled'), 'error');
      state._cancelShown = false;
    };
    // Safety net: if something throws outside the phases' own try/catch guards
    // and this never gets to its normal cleanup, don't leave Settings blocked
    // forever — force-clear after longer than any legitimate run could take.
    clearTimeout(this._schedulingWatchdog);
    // Signal cancellation rather than just clearing the in-progress flag:
    // cancelScheduling() early-returns when that flag is false, so the old
    // behaviour left the ✕ button permanently inert on any run that outlived
    // the watchdog, while the run itself carried on in the background.
    this._schedulingWatchdog = setTimeout(()=>{ state._schedulingCancelled = true; }, 9*60*1000);
    this.requestNotifyPermission(); // user-gesture-triggered, fine to ask here

    // Show the overlay (and its ✕ cancel button) right away — it previously
    // only appeared after geocoding finished, so pressing cancel wasn't even
    // possible during that phase.
    schedProgress(2,t('phase1_title'),t('phase1_sub'));
    await new Promise(r=>setTimeout(r,0));

    try{ await this.refreshGoogleCoords(); }catch(e){}
    // Geocode any missing addresses before scheduling
    const toGeocode = [];
    if(!state.coords['home']){
      toGeocode.push({ id:'home', addr: state.settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα' });
    }
    for(const st of state.students){
      if(st.address && !state.coords[st.id]) toGeocode.push({ id:st.id, addr:st.address });
    }
    if(toGeocode.length > 0){
      const hereKey = getHereKey();
      let updated = false, failed = 0;
      // Home first, awaited alone — Nominatim biases every later search
      // toward it via Router._viewboxParam(), which only works once home's
      // own coords are actually in state.coords (they weren't yet if it was
      // batched into the same parallel round as everyone else).
      const homeItem = toGeocode.find(x=>x.id==='home');
      const rest = toGeocode.filter(x=>x.id!=='home');
      if(homeItem){
        let c=null;
        if(hereAvailable()){
          try{ c=await Router.geocodeHere(homeItem.addr,hereKey); }catch(e){ c=null; }
        }
        if(!c) c=await Router.geocodeNominatim(homeItem.addr);
        if(c){ state.coords['home']=c; updated=true; } else failed++;
      }
      if(hereAvailable()){
        // HERE's per-key rate limits are generous enough for a batch like
        // this — no artificial throttling needed.
        const results = await Promise.allSettled(rest.map(({id,addr})=>Router.geocodeHere(addr,hereKey).then(c=>({id,c}))));
        const missed = [];
        results.forEach((res, i) => {
          if(res.status==='fulfilled' && res.value.c){ state.coords[res.value.id]=res.value.c; updated=true; }
          else missed.push(rest[i]);
        });
        // What HERE did not find is asked of Nominatim, one at a time.
        for(const {id,addr} of missed){
          if(state._schedulingCancelled) break;
          const c = await Router.geocodeNominatim(addr);
          if(c){ state.coords[id]=c; updated=true; } else failed++;
          await new Promise(r=>setTimeout(r,1100));
        }
      } else {
        // Nominatim's free public server enforces ~1 request/second. Firing
        // every student's geocode request in parallel (the old behavior) got
        // most of them silently rejected/rate-limited, which fell back to
        // meaningless pseudo-coordinates near a fixed default point instead
        // of the student's real location — exactly the "map shows the wrong
        // city" bug. Go one at a time instead.
        for(const {id,addr} of rest){
          if(state._schedulingCancelled) break;
          const c = await Router.geocode(addr);
          if(c){ state.coords[id]=c; updated=true; } else failed++;
          await new Promise(r=>setTimeout(r,1100));
        }
      }
      if(updated) Storage.saveCoords(state.coords);
      // Surface failures instead of letting them silently become
      // wrong-looking pins on the map — check the console for the specific
      // HTTP status/reason logged by Router.geocode() per failed address.
      if(failed > 0) Toast.show(tf('toast_geocode_failures',{n:failed}), 'error');
    }
    /*i18n-note: default homeAddress fallback ("Πλατεία Γεωργίου 1, Πάτρα") intentionally kept as literal Greek demo address text*/

    if(state._schedulingCancelled) return cancelledCleanup();

    if(btn){ btn.disabled=true; btn.style.opacity='0.6'; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> ${t('debug_calc_prefix')}`; }
    schedProgress(5,t('phase1_title'),t('phase1_sub'));
    await new Promise(r=>setTimeout(r,40));

    // Fetch routing matrices BEFORE scheduling so travelEstMin() uses real road times
    state.travelMatrixPeak = null;
    state.travelMatrixOffPeak = null;
    state.travelMatrix = null;
    try{
      const hereKey = getHereKey();
      const allStudentIds = state.students.map(s=>s.id);
      const allIds = ['home', ...allStudentIds];
      const matCoords = allIds.map(id=>state.coords[id]).filter(Boolean);
      const validIds = allIds.filter(id=>state.coords[id]);
      if(matCoords.length >= 2){
        if(hereAvailable()){
          // Peak: weekdays 17:00
          const depPeak = new Date(); depPeak.setHours(17,0,0,0);
          const matPeak = await Router.getHereMatrix(matCoords, hereKey, depPeak.toISOString());
          state.travelMatrixPeak = {durations: matPeak.durations, distances: matPeak.distances, coordIds: validIds};
          // Off-peak: Saturday 11:00
          const depOff = new Date(); depOff.setHours(11,0,0,0);
          const dow = depOff.getDay(); if(dow!==6) depOff.setDate(depOff.getDate()+(6-dow+7)%7||7);
          const matOff = await Router.getHereMatrix(matCoords, hereKey, depOff.toISOString());
          state.travelMatrixOffPeak = {durations: matOff.durations, distances: matOff.distances, coordIds: validIds};
        } else {
          const matrix = await Router.getMatrix(matCoords).catch(()=>null);
          if(matrix && matrix.durations){
            // No traffic data — use same matrix for both (OSRM is traffic-free).
            // OSRM also gives real road distances (meters) — keep them so the km
            // objective used by geoOptimize/saOptimize reflects actual roads.
            state.travelMatrixPeak = {durations: matrix.durations, distances: matrix.distances, coordIds: validIds};
            state.travelMatrixOffPeak = {durations: matrix.durations, distances: matrix.distances, coordIds: validIds};
          }
        }
      }
    }catch(e){ console.warn('Matrix pre-fetch failed, using straight-line estimates:', e); }

    if(state._schedulingCancelled) return cancelledCleanup();

    // Phase 1: backtracking CSP — multiple randomized attempts, keep the one that
    // places the most students (km is only a tie-breaker, never sacrifices a student)
    // The quick plan is the default: one short first placement and a quarter
    // of the search time. Measured on the owner's week, 188 s became about
    // 43 s for a week no worse (three seeds each); nearly half of the long
    // run went on repeating the first placement six times. The thorough
    // setting, or "search deeper" after a quick plan that left someone out,
    // runs the long one.
    const deep = state.settings.scheduleQuality==='thorough' || !!state._deepOnce;
    state._deepOnce = false;
    const attemptCount = deep ? (state.settings.scheduleQuality==='thorough' ? 8 : 6) : 1;
    schedProgress(15,t('phase1b_title'),tf('phase1b_sub',{n:attemptCount}));
    await new Promise(r=>setTimeout(r,40));
    let r;
    if(state.students.length===0){
      schedProgress(null); state._schedulingInProgress=false; clearTimeout(this._schedulingWatchdog);
      if(btn){ btn.disabled=false; btn.style.opacity=''; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> ${t('schedule_refresh')}`; }
      return;
    }
    // The whole optimisation, several times at once in worker threads, each
    // from its own start; the best by the app's rule wins. The schedule on
    // screen (cleaned of what no longer holds) is a starting point for every
    // one of them. Without workers it runs once here, as it always did.
    try{
      // Locked lessons run as clients of their own, fixed in time (lockSplit).
      const lk = Scheduler.lockSplit(state.students, scheduleBackup, state.settings);
      const hasLocks = Object.keys(lk.alias).length > 0;
      const unalias = () => { for(const v of Object.keys(lk.alias)) delete state.coords[v]; state.idAlias = null; };
      if(hasLocks){
        for(const [v, real] of Object.entries(lk.alias)) if(state.coords[real]) state.coords[v] = state.coords[real];
        state.idAlias = lk.alias;
      }
      let warm = null;
      try{ warm = Scheduler.warmStart(lk.schedule, lk.students, state.settings); }catch(e){}
      const input = { students: lk.students, settings: state.settings, coords: state.coords, attempts: attemptCount, warm,
        // the example week is small and is there to be seen quickly
        ...(deep ? {} : state.settings.demo ? { timeScale: 0.1, p1: { backtrackMs: 1500, repairMs: 700 } } : { timeScale: 0.25, p1: { backtrackMs: 3000, repairMs: 1500 } }) };
      const P = (p, a, b, c) => schedProgress(p, t(a), c ? tf(b, c) : t(b));
      let out;
      try{
        if(Remote.available()){
          try{ out = await Remote.optimize(input, P, () => state._schedulingCancelled || isStale()); }
          catch(e){
            if(e && e.message === 'cancelled') throw e;
            // No server (offline, busy, gone): the phone computes it, as before.
            console.warn('compute server unavailable; computing here', e && e.message);
            out = await this._optimizeParallel(input, P);
          }
        } else out = await this._optimizeParallel(input, P);
      }
      catch(e){
        if(state._schedulingCancelled || isStale()){ unalias(); return cancelledCleanup(); }
        if(!/^(no-worker|no-source)$/.test(e && e.message)) console.warn('scheduler workers failed; running on the page', e);
        const hooks = { progress: (p, a, b, c) => P(this._round1Pct(p), a, b, c), stopped: () => state._schedulingCancelled || isStale() };
        out = await Scheduler.optimizeWeek(input, hooks);
        // the same second round the workers do, from the best week found
        if(!hooks.stopped()){
          const again = await Scheduler.optimizeWeek({ ...input, warm: out.schedule, skipPhase1: true },
            { ...hooks, progress: (p) => P(this._round2Pct(p), 'phase_refine_title', 'phase_refine_sub') });
          if(Scheduler.isBetterStart(again.schedule, out.schedule, state.settings)) out = { ...again, result: out.result };
        }
      }
      unalias();
      if(state._schedulingCancelled || isStale()) return cancelledCleanup();
      if(hasLocks) out = { ...out, schedule: Scheduler.lockJoin(out.schedule, lk.alias) };
      // Flexible time may have been split in the winning run: carry that over.
      for(const st of state.students){
        const w = (out.students || []).find(x => x.id === st.id);
        if(w && w !== st && Scheduler.isFlex(st)){ st.durations = w.durations; st.lessonsPerWeek = w.lessonsPerWeek; st.hoursPerWeek = w.hoursPerWeek; st.lessonDuration = w.lessonDuration; }
      }
      r = { ...out.result, schedule: out.schedule };
      state.scheduleAttempts = [r];
      state.scheduleAttemptIdx = 0;
      state.scheduleOptimized = false;
      state.scheduleKmBefore = null;
      state.scheduleKmAfter = null;
      state.schedule = out.schedule;
      if(hasLocks){ try{ r.unplaced = this.computeUnplacedLive(); }catch(e){} }
      // A quick plan that left someone out: the long search may still fit them.
      if(!deep){ try{ if(this.computeUnplacedLive().length) setTimeout(() => Toast.show(t('deep_offer'), 'info', 12000,
        { label: t('deep_btn'), run: () => { state._deepOnce = true; App.runAndNotify(); } }), 1200); }catch(e){} }
      state.schedulerResult = r;
      state.routeResults = {};
    }catch(e){
      try{ for(const v of Object.keys(state.idAlias || {})) delete state.coords[v]; state.idAlias = null; }catch(e2){}
      // A throw here used to leave the run silently doing nothing; say so.
      console.error('Scheduler error', e);
      state._schedulerError = (e && e.message) || String(e);
    }

    if(state._schedulingCancelled) return cancelledCleanup();

    // Verify constraints — surfaced to the user, not just the console, so a
    // scheduling bug that violates someone's availability doesn't ship silently.
    try{
      const issues = Scheduler.verifySchedule(state.schedule, state.students, state.settings);
      if(issues.length){
        console.warn('⚠ Schedule constraint issues:', issues);
        Toast.show(tf('toast_constraint_issues',{n:issues.length}), 'error');
      }
    }catch(e){}

    if(r){
      // Instant straight-line placeholder so the stat isn't blank while the
      // real-road-distance figures are being computed.
      state.scheduleKmBefore = this._estimateTotalKm(state.schedule);
      schedProgress(97,t('phase_km_title'),t('phase_km_sub'));

      // The floor. Both sides are measured with the SAME function — the real
      // road distance the user is about to read — so the comparison is the one
      // they would make themselves. If this run did not beat what was already
      // there, the old schedule stays and we say so, rather than quietly
      // replacing 140 km with 170 km because the search rolled badly.
      // A locked lesson is a promise: a result that dropped one loses to the
      // week as it was, even if that week leaves someone else out.
      try{
        const key = (d, x) => d + '|' + x.studentId + '|' + Scheduler.toMin(x.start);
        const have = new Set(Object.keys(state.schedule).flatMap(d => (state.schedule[d] || []).map(x => key(d, x))));
        const lost = Object.keys(scheduleBackup || {}).flatMap(d => (scheduleBackup[d] || []).filter(x => x.locked && !have.has(key(d, x))));
        if(lost.length && !Scheduler.verifySchedule(scheduleBackup, state.students, state.settings).length){
          console.warn('result dropped locked lessons; keeping the week as it was', lost.map(x => x.studentName));
          state.schedule = scheduleBackup;
        }
      }catch(e){}
      let km = await this._kmOf(state.schedule);
      let keptPrevious = false;
      if(prevUsable){
        const prevKm = await this._kmOf(scheduleBackup);
        const now = { placed: this._countPlaced(state.schedule), km };
        const was = { placed: this._countPlaced(scheduleBackup),  km: prevKm };
        if(this._isBetterSchedule(was, now)){
          state.schedule = scheduleBackup;
          km = prevKm;
          keptPrevious = true;
        }
      }
      state.scheduleKmBefore = km;
      state._keptPreviousSchedule = keptPrevious;
      // The same person not on two days in a row: moved apart after the plan
      // is built, as far as the setting allows.
      try{
        const sp = Scheduler.enforceSpacing(state.schedule, state.students, state.settings);
        state._spacingLeft = sp.left.length;
      }catch(e){ console.warn('spacing pass failed', e); state._spacingLeft = 0; }
      // Last word on every day: its best order, solved day by day (the exact
      // day solver), after everything above may have moved lessons between
      // days. Locked lessons run pinned to their time, as in the main run.
      // A day changes only if it keeps every lesson, breaks nothing and
      // costs less.
      try{
        schedProgress(98, t('phase_refine_title'), t('phase_refine_sub'));
        const lk = Scheduler.lockSplit(state.students, state.schedule, state.settings);
        const al = Object.keys(lk.alias);
        for(const [v, real] of Object.entries(lk.alias)) if(state.coords[real]) state.coords[v] = state.coords[real];
        if(al.length) state.idAlias = lk.alias;
        try{
          await Scheduler.polishDays(lk.schedule, lk.students, state.settings, 400);
          state.schedule = al.length ? Scheduler.lockJoin(lk.schedule, lk.alias) : lk.schedule;
        }finally{
          for(const v of al) delete state.coords[v];
          if(al.length) state.idAlias = null;
        }
      }catch(e){ console.warn('final day polish failed', e); }
      Scheduler.flexSync(state.schedule, state.students);
      if(flexBackup.length) Storage.saveStudents(state.students);

      // Before / after is measured on the week as it is now, after spacing and
      // the last per-day pass, which both move lessons. Measured earlier, the
      // "after" here and the week's km on Home were two different weeks.
      km = await this._kmOf(state.schedule);
      state.scheduleKmBefore = km;
      try{
        // The person's own week, imported from their calendar, is the real
        // "before"; otherwise the first plain placement stands in for it.
        const own = state._ownWeek && Scheduler.countTotal(scheduleBackup) ? scheduleBackup : null;
        const base = own || (r && r._baseline);
        if(base){
          const b = Scheduler.measureWeek(base, state.settings), a = Scheduler.measureWeek(state.schedule, state.settings);
          b.km = await this._kmOf(base); a.km = km;       // the km the person reads, both sides
          a.key = this.scheduleKey();                     // which week this "after" is
          this.recordSavings('week', null, { kind: own ? 'own' : 'plain', before: b, after: a });
        }
        state._ownWeek = false;
      }catch(e){ console.warn('before/after failed', e); }

      // Phases 2-5 can place students that were still unplaced after phase 1 —
      // recompute the unplaced list from the FINAL schedule (which may now be
      // the restored previous one) instead of reusing a stale snapshot.
      state.scheduleAttempts[0] = { ...r, schedule: state.schedule, unplaced: this.computeUnplacedLive() };
      state.schedulerResult = state.scheduleAttempts[0];
      if(isStale()) return;
      Storage.saveSchedule(state.schedule);
    }

    // A newer run took over while this one was finishing: it owns the state
    // now, so bow out silently rather than overwriting its result, resetting
    // the stale flag, or clearing the in-progress flag out from under it.
    if(isStale()) return;

    schedProgress(100,t('phase_done_title'),t('phase_done_sub'));
    // Long enough for the bar to actually reach the end and turn green before
    // the overlay fades — the completion is the one frame worth showing.
    await new Promise(r=>setTimeout(r,600));
    if(isStale()) return;

    state._scheduleStale = false;
    // Open on a day that has something in it: a new plan may have emptied
    // the day that was open.
    if(!(state.schedule[state.scheduleDay] || []).length){
      const d = (state.settings.workDays || []).find(x => (state.schedule[x] || []).length);
      if(d != null){ state.scheduleDay = d; state.weekOpen = d; state.routeDay = d; }
    }
    schedProgress(null,null,null,null);
    state._schedulingInProgress = false;
    clearTimeout(this._schedulingWatchdog);
    this.notifyScheduleReady();
    if(btn){ btn.disabled=false; btn.style.opacity=''; btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> ${t('schedule_refresh')}`; }
    // Always re-render regardless of scheduler outcome
    if(state.currentScreen==='schedule') this.renderSchedule();
    else if(state.currentScreen==='home') this.renderHome();
    // Always refresh home stats (even if not currently visible)
    if(state.currentScreen!=='home') this.renderHome();
    if(!r){
      Toast.show(tf('toast_scheduler_failed',{reason: state._schedulerError || '—'}),'error',9000);
      state._schedulerError = null;
      return;
    }
    const total = state.students.reduce((a,s)=>a+s.lessonsPerWeek,0);
    const placed = total - r.unplaced.reduce((a,u)=>a+(u.needed-u.placed),0);
    const att = r._attempts || 1;
    const attLabel = att > 1 ? tf('toast_attempts_suffix',{n:att}) : '';
    // Say which of the two happened. Silently keeping the old schedule would
    // look like the button did nothing.
    if(state._spacingLeft && Scheduler.spacingMode(state.settings) === 'strict'){
      Toast.show(tf('toast_spacing_left',{n:state._spacingLeft}),'info',8000);
    } else if(state._keptPreviousSchedule){
      Toast.show(t('toast_kept_previous'),'info');
    } else {
      Toast.show(tf('toast_placed_summary',{placed,total,attempts:attLabel}),'success');
    }
  },

  // ---- HOME ----
  renderHome(){
    const s = document.getElementById('screen-home');
    const today = new Date();
    const todayNum = today.getDay()===0?7:today.getDay();
    const todaySlots = (state.schedule[todayNum]||[]).slice().sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const totalLessons = state.students.reduce((a,s)=>a+s.lessonsPerWeek,0);
    const placedCount = Scheduler.countTotal(state.schedule);
    const allFit = totalLessons > 0 && placedCount >= totalLessons;

    // Computed fresh from state.schedule so it survives page reloads
    // (state.schedulerResult is session-only, never persisted to localStorage)
    const placedByStudent = {};
    Object.values(state.schedule).flat().forEach(e=>{
      if(e.isGroup){
        const ids = e.groupMemberIds || [e.studentId, e.pairedStudentId].filter(Boolean);
        ids.forEach(id=>{ placedByStudent[id] = (placedByStudent[id]||0) + 1; });
      } else {
        placedByStudent[e.studentId] = (placedByStudent[e.studentId]||0) + (e.mergedCount||1);
      }
    });
    const unplacedStudents = state.students.filter(s => (placedByStudent[s.id]||0) < s.lessonsPerWeek);

    const weekKm = this.currentKm();
    const greeting = this.getGreeting();
    const name = state.settings.teacherName||'';
    const L = getLabels();

    this._homeGreeting = greeting + (name ? ', ' + name : '');
    // The map is worth its half of the screen only when it has a stop to show.
    const mapStops = this._todayAgenda(this.homeDateISO()).filter(x => x.time != null && !x.done)
      .map((x, i) => ({ c: state.coords && state.coords[x.id], label: String(i + 1) }));
    const mapEmpty = !mapStops.some(x => x.c);
    s.innerHTML = `
      ${this._homeMapHtml(mapEmpty)}
      ${(()=>{ const d = this.syncStaleDays();
        if(d == null || d < this.SYNC_STALE_DAYS) return '';
        const left = this.SYNC_EXPIRY_DAYS - d;
        return `
        <div style="margin:0 16px 12px;background:rgba(217,119,6,.1);border:1.5px solid rgba(217,119,6,.35);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:10px">
          <div style="flex:1">
            <div style="font-weight:700;font-size:13px;color:#d97706">${t('sync_stale_title')}</div>
            <div style="font-size:12px;color:var(--text2)">${tf('sync_stale_sub',{days:d, left:Math.max(0,left)})}</div>
          </div>
          <button onclick="App.syncPush()" style="padding:8px 14px;background:#d97706;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">${t('sync_push')}</button>
        </div>`; })()}
      ${state.settings.demo ? `
        <div style="margin:0 16px 12px;background:rgba(var(--accent-rgb),.08);border:1.5px solid rgba(var(--accent-rgb),.3);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:10px">
          <div style="flex:1">
            <div style="font-weight:700;font-size:13px">${esc(t('demo_banner_title'))}</div>
            <div style="font-size:12px;color:var(--text2)">${esc(t('demo_banner_sub'))}</div>
          </div>
          <button onclick="App.endDemo()" class="btn btn-primary" style="padding:8px 14px;font-size:12px;white-space:nowrap">${esc(t('demo_end'))}</button>
        </div>` : ''}
      ${state._scheduleStale && state.students.length>0 ? `
        <div style="margin:0 16px 12px;background:rgba(217,119,6,.1);border:1.5px solid rgba(217,119,6,.35);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:10px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div style="flex:1">
            <div style="font-weight:700;font-size:13px;color:#d97706">${t('home_schedule_stale_title')}</div>
            <div style="font-size:12px;color:var(--text2)">${t('home_schedule_stale_sub')}</div>
          </div>
          <button onclick="App.runAndNotify()" style="padding:8px 14px;background:#d97706;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">${t('btn_calculate')}</button>
        </div>
      `:''}
      ${this._homeTodayHtml(L, placedCount, totalLessons, weekKm, unplacedStudents)}
    `;
    try{ this.scheduleReminders(); }catch(e){}
    if(!mapEmpty) this._drawStopsMap('home-map', mapStops, { line: true });
  },

  // Today, in time order: the week's lessons for this weekday, the day's jobs
  // and errands (with the time of today's plan, else their window), done
  // items last. What the person opens the app to see.
  _todayAgenda(date){
    date = date || this.todayISO();
    const day = Scheduler.weekdayOf(date);
    const out = [];
    for(const sl of (state.schedule[day] || [])){
      // A client on a 2- or 4-week rhythm, on one of their off weeks.
      if(!Cadence.onWeek((state.students || []).find(s => s.id === sl.studentId), date)) continue;
      out.push({ kind: 'lesson', id: sl.studentId, title: sl.studentName, sub: subjectText(sl.subject), address: sl.address,
                 date, done: Payments.isDone(date, sl.studentId, sl.start),
                 time: sl.start, end: sl.end, note: ((state.students || []).find(s => s.id === sl.studentId) || {}).notes || '' });
    }
    const plan = state.dayPlan && state.dayPlan.date === date ? state.dayPlan : null;
    for(const j of (state.jobs || [])){
      if(j.date !== date) continue;
      const stop = plan && plan.stops.find(x => x.job && x.job.id === j.id);
      const time = stop ? stop.start : (j.window ? j.window.start : null);
      const end = stop ? stop.end : (j.window ? j.window.end : null);
      out.push({ kind: j.kind === 'errand' ? 'errand' : 'job', id: j.id, title: j.name, sub: '', address: j.address,
                 time, end, done: !!j.done, note: j.notes || '' });
    }
    const key = (x) => (x.done ? 1e6 : 0) + (x.time ? Scheduler.toMin(x.time) : 5e5);
    return out.sort((a, b) => key(a) - key(b));
  },

  // Home shows today or tomorrow: organising tomorrow is the usual evening job.
  homeDateISO(){
    const today = this.todayISO();
    return state.homeDay === 1 ? QuickNote._addDays(today, 1) : today;
  },
  setHomeDay(n){ state.homeDay = n === 1 ? 1 : 0; this.renderHome(); },

  // Plan the home date's errands from the home screen, without leaving it.
  // Errands first (what home adds); with none, the day's work jobs. Nothing
  // at all: say how to add, rather than a button that does nothing.
  async homePlan(){
    const day = this.homeDateISO();
    const open = (kind) => (state.jobs || []).filter(j => j.date === day && !j.done && ((j.kind === 'errand') === (kind === 'errands'))).length;
    const kind = open('errands') ? 'errands' : open('day') ? 'day' : null;
    if(!kind){ Toast.show(t('home_plan_empty'), 'info', 5000); return; }
    const btn = document.getElementById('home-plan');
    if(btn){ btn.disabled = true; btn.textContent = t('day_planning'); }
    const mode = state.scheduleMode, date = state.planDate;
    state.scheduleMode = kind;
    state.planDate = day;
    try{ await this.planTheDay({ render: false }); }
    finally{ state.scheduleMode = mode; state.planDate = date; }
    if(state.currentScreen === 'home') this.renderHome();
  },

  // Tapping something on home opens it: a lesson its client, a job or an
  // errand its own form (on the day screen, where it is saved).
  homeOpen(kind, id){
    if(kind === 'lesson'){ this.nav('students'); this.openStudentDrawer(id); return; }
    const j = (state.jobs || []).find(x => x.id === id);
    if(!j) return;
    this.nav('schedule');
    state.scheduleMode = j.kind === 'errand' ? 'errands' : 'day';
    state.planDate = j.date;
    this.renderSchedule();
    this.openJobDrawer(id);
  },
  homeGo(where){
    if(where === 'students' || where === 'route' || where === 'settings'){ this.nav(where); return; }
    this.nav('schedule');
    state.scheduleMode = 'week';
    this.renderSchedule();
    if(where === 'today'){ try{ this.switchDay(Scheduler.weekdayOf(this.todayISO())); }catch(e){} }
  },

  _homeStatsHtml(L, placedCount, totalLessons, weekKm){
    const todayCount = (state.schedule[Scheduler.weekdayOf(this.todayISO())] || []).length;
    const hours = state.schedule ? Object.values(state.schedule).flat().reduce((a,s)=>a+(s.duration||0),0)/60 : 0;
    const card = (val, unit, label, cls, go) => `<div class="stat-card${cls ? ' ' + cls : ''}" role="button" tabindex="0" style="cursor:pointer" onclick="${go}"><div class="stat-val">${val}<span>${unit}</span></div><div class="stat-label">${label}</div></div>`;
    return `
      <div class="stats-grid home-stats" style="margin-top:14px">
        ${card(todayCount, ' ' + esc(t('home_today_suffix')), esc(L.sessions) + ' ' + esc(DAYS_FULL[Scheduler.weekdayOf(this.todayISO())] || ''), 'accent-green', 'App.homeGo(\'today\')')}
        ${card(placedCount, '/' + totalLessons, esc(t('home_week')), 'accent-blue', 'App.homeGo(\'week\')')}
        ${card(state.students.length, '', esc(L.clients), '', 'App.homeGo(\'students\')')}
        ${card(hours.toFixed(1), esc(t('unit_hr')), esc(t('home_hours_wk_short')), '', 'App.homeGo(\'week\')')}
        ${card(weekKm.km > 0 ? weekKm.km.toFixed(1) : '—', 'km', esc(weekKm.real ? t('home_km_optimized') : t('home_km_estimated')) + ' · ' + esc(t('km_incl_return')), '', 'App.homeGo(\'route\')')}
        ${card(state.settings.travelMargin ?? 3, esc(t('unit_min')), esc(t('home_margin_safety')), '', 'App.homeGo(\'settings\')')}
      </div>`;
  },

  // Home, top: the day's map with the date and Today/Tomorrow over it.
  _homeMapHtml(empty){
    const date = this.homeDateISO(), isToday = date === this.todayISO();
    return `
      <div class="home-mapwrap${empty ? ' empty' : ''}">
        <div id="home-map" class="home-map"></div>
        <div class="home-mapbar">
          <div class="home-datepill"><span>${esc(this._homeGreeting || '')}</span><b>${esc(this.prettyDate(date))}</b></div>
          <div style="flex:1"></div>
          <button class="home-pill${isToday ? ' on' : ''}" onclick="App.setHomeDay(0)">${esc(t('day_today'))}</button>
          <button class="home-pill${!isToday ? ' on' : ''}" onclick="App.setHomeDay(1)">${esc(t('day_tomorrow'))}</button>
        </div>
      </div>`;
  },

  // Who to call for an item on the agenda, if a number is on file.
  _agendaPhone(x){
    const p = x.kind === 'lesson' ? ((state.students || []).find(s => s.id === x.id) || {}).phone
      : ((state.jobs || []).find(j => j.id === x.id) || {}).phone;
    return p ? String(p).replace(/[^\d+]/g, '') : '';
  },

  _homeTodayHtml(L, placedCount, totalLessons, weekKm, unplacedStudents){
    const date = this.homeDateISO(), isToday = date === this.todayISO();
    const day = Scheduler.weekdayOf(date);
    const items = this._todayAgenda(date);
    // Nothing entered yet: the day comes first — it is planned in a second.
    const firstRun = !state.students.length && !(state.jobs || []).length;
    const now = new Date(), nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : -1;
    const next = !isToday ? null : items.find(x => !x.done && x.time && Scheduler.toMin(x.end || x.time) > nowMin);
    const timed = items.filter(x => x.time && !x.done);
    const main = next || (!isToday ? timed[0] : null);
    const kindIcon = { lesson: ico('book', 14), job: ico('tool', 14), errand: ico('bag', 14) };
    const home = { id: 'home', address: state.settings.homeAddress || '' };
    // The drive into each timed stop, from home or from the stop before it.
    const legs = {};
    let prev = home;
    for(const x of timed){
      legs[x.id + '@' + x.time] = { min: Scheduler.travelEstMin(prev.id, prev.address, x.id, x.address, day, Scheduler.toMin(x.time)),
                                    km: Scheduler.travelEstKm(prev.id, prev.address, x.id, x.address, day) };
      prev = x;
    }
    const pseudo = timed.map(x => ({ studentId: x.id, address: x.address, start: x.time, end: x.end || x.time }));
    const km = pseudo.length ? Scheduler.dayKm(pseudo, day, state.settings) : 0;
    const last = timed[timed.length - 1];
    const homeAt = last ? Scheduler.toTime(Scheduler.toMin(last.end || last.time) +
      Scheduler.travelEstMin(last.id, last.address, 'home', home.address, day, Scheduler.toMin(last.end || last.time))) : '';
    const daySave = state.savings && state.savings.days && (state.savings.days[date + '|errands'] || state.savings.days[date + '|day']);
    const saved = daySave ? this.savingsOf(daySave) : null;
    const dirs = (x) => `App.openLegInMaps(null, { id: '${esc(x.id)}', address: ${esc(JSON.stringify(x.address || ''))} })`;
    const card = (x, isMain) => {
      const phone = this._agendaPhone(x), leg = legs[x.id + '@' + x.time];
      const inMin = isMain && isToday && x.time ? Scheduler.toMin(x.time) - nowMin : null;
      return `<div class="home-card${isMain ? ' next-card main' : ''}" onclick="App.homeOpen('${x.kind}','${esc(x.id)}')">
        <div class="home-card-label">${isMain ? esc(t('home_next')) + ' · ' : ''}${esc(x.time || '—')}${x.end ? '–' + esc(x.end) : ''}${inMin != null && inMin > 0 ? ' · ' + esc(inMin < 60 ? tf('home_in_min', { n: inMin }) : tf('home_in_hm', { h: Math.floor(inMin / 60), m: inMin % 60 })) : ''}</div>
        <div class="home-card-title">${kindIcon[x.kind] || ''} ${esc(x.title)}</div>
        <div class="home-card-sub">${esc(x.address || '')}${leg ? ' · ' + leg.min + '′ ' + esc(t('ba_drive')) : ''}</div>
        ${isMain ? `<div class="home-card-actions">
          <button class="btn btn-primary" onclick="event.stopPropagation();${dirs(x)}">${ico('nav')} ${esc(t('home_go'))}</button>
          ${x.kind !== 'lesson' ? `<button class="home-card-btn" aria-label="${esc(t('job_done'))}" onclick="event.stopPropagation();App.toggleJobDone('${esc(x.id)}')">✓</button>` : ''}
          ${phone ? `<a class="home-card-btn" href="tel:${esc(phone)}" onclick="event.stopPropagation()" aria-label="${esc(t('student_phone_label'))}">${ico('phone')}</a>` : ''}
        </div>` : ''}
      </div>`;
    };
    const after = main ? timed.slice(timed.indexOf(main) + 1, timed.indexOf(main) + 4) : [];
    const row = (x) => {
      const leg = legs[x.id + '@' + x.time];
      return `
      ${leg && !x.done ? `<div class="agenda-leg">${ico('car', 12)} ${leg.min}′ · ${leg.km.toFixed(1)} km</div>` : ''}
      <div class="agenda-row${x.done ? ' done' : ''}${next && x === next ? ' next' : ''}" role="button" tabindex="0" style="cursor:pointer"${x.kind !== 'lesson' ? ` data-swipe="job:${esc(x.id)}"` : ` data-swipe="slot:${day}:${esc(x.id)}:${esc(x.time || '')}:${esc(x.end || x.time || '')}"`}
        onclick="App.homeOpen('${x.kind}','${esc(x.id)}')">
        <div class="agenda-time">${x.time ? esc(x.time) : '—'}</div>
        <div class="agenda-body">
          <div class="agenda-title">${kindIcon[x.kind] || ''} ${esc(x.title)}</div>
          <div class="agenda-sub">${esc([x.sub, x.address].filter(Boolean).join(' · '))}</div>
          ${x.note ? `<div class="agenda-note">${ico('edit', 11)} ${esc(x.note)}</div>` : ''}
        </div>
        ${x.kind !== 'lesson' ? `<button class="agenda-check" aria-label="${esc(t('job_done'))}" onclick="event.stopPropagation();App.toggleJobDone('${esc(x.id)}')">${x.done ? '↺' : '✓'}</button>`
          : `<button class="agenda-check" aria-label="${esc(t('pay_done_btn'))}" title="${esc(t('pay_done_btn'))}" onclick="event.stopPropagation();Payments.toggleDone('${esc(x.date)}','${esc(x.id)}','${esc(x.time || '')}')">${x.done ? '↺' : '✓'}</button>`}
      </div>`;
    };
    return `
      <div class="home-sheet">
        ${firstRun ? '' : `<div class="home-summary">
          <div><b>${tf('home_stops_km', { n: timed.length, km: km.toFixed(1) })}</b>
            <span>${saved && saved.same && saved.km > 0.05 ? `<em>−${saved.km.toFixed(1)} km</em> · ` : ''}${homeAt ? esc(t('wk_home_at')) + ' ' + esc(homeAt) : ''}</span></div>
          <button class="btn btn-primary" id="home-plan" onclick="App.homePlan()">${ico('nav')} ${esc(t('day_plan_btn'))}</button>
        </div>`}
        ${main ? `<div class="home-cards">${card(main, true)}${after.map(x => card(x, false)).join('')}</div>` : ''}
        <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px">
          <span>${isToday ? t('home_today_label') : esc(t('day_tomorrow'))} · ${esc(this.prettyDate(date))}</span>
          <span style="display:flex;gap:6px">
            ${timed.length && typeof Notification !== 'undefined' && Notification.permission === 'default' ? `<button class="chip chip-gray" style="border:none;cursor:pointer" onclick="App.enableReminders()">${ico('bell', 14)} ${esc(t('remind_enable'))}</button>` : ''}
            ${timed.length ? `<button class="chip chip-gray" style="border:none;cursor:pointer" onclick="App.exportCalendar()">${ico('calendar', 14)} ${esc(t('cal_add'))}</button>` : ''}
            <button class="chip chip-gray" style="border:none;cursor:pointer" onclick="App.exportWeekCalendar()">${ico('calendar', 14)} ${esc(t('cal_add_week'))}</button>
          </span>
        </div>
        <div class="home-timeline">
          ${items.length ? items.map(row).join('') : firstRun ? `<div class="card-sm" style="padding:16px">
            <div style="font-weight:700;font-size:16px;margin-bottom:4px">${esc(t('first_title'))}</div>
            <div class="settings-sub" style="margin-bottom:10px">${esc(t('first_sub'))}</div>
            <textarea id="home-first-qn" rows="2" aria-label="${esc(t('first_title'))}" placeholder="${esc(t('home_add_ph'))}" style="width:100%;margin-bottom:10px"></textarea>
            <button class="btn btn-primary btn-full" onclick="App.homeQuickAdd('home-first-qn')">${ico('nav')} ${esc(t('first_go'))}</button>
            <button class="btn btn-secondary btn-full" style="margin-top:8px" onclick="App.nav('students')">${ico('users')} ${esc(t('first_weekly'))}</button>
            <button class="btn btn-secondary btn-full" style="margin-top:8px" onclick="App.startDemo()">${ico('flag')} ${esc(t('demo_try'))}</button>
          </div>` : `<div class="card-sm" style="text-align:center;color:var(--text2);font-size:14px;padding:20px">${esc(t('home_today_empty'))}</div>`}
          ${last ? `<div class="agenda-leg">${ico('home', 12)} ${esc(t('wk_home_at'))} ${esc(homeAt)}</div>` : ''}
        </div>
      </div>
      ${unplacedStudents.length ? `
      <div class="warning-banner" style="margin-top:12px" onclick="App.nav('schedule')">
        <span><b>${unplacedStudents.length} ${t('home_unplaced_suffix')}</b> · ${t('home_see_schedule')}</span>
      </div>` : ''}
      ${firstRun ? '' : this._homeStatsHtml(L, placedCount, totalLessons, weekKm)}`;
  },

  // Add from the home screen: errands go straight in as boxes, no form.
  homeQuickAdd(boxId){
    const box = document.getElementById(boxId || 'fab-qn');
    const text = box ? box.value.trim() : '';
    if(!text) return;
    // A sentence about a client ("Γιώργος δεν μπορεί Τρίτη 5–7") changes the
    // client; anything else is an errand, as before. With AI on this waits
    // for the answer, so the errand path follows only if it was not one.
    if(AiAssist.available() && AiAssist.on() && AiAssist.looksLikeClient(text)){
      this.clientCommandSmart(text).then(h => { if(h){ if(box) box.value = ''; this.renderHome(); } else this._quickAddErrand(text, box, boxId); });
      return;
    }
    if(this.clientCommand(text)){ if(box) box.value = ''; this.renderHome(); return; }
    if(AiAssist.available() && AiAssist.looksLikeClient(text)) AiAssist.maybeAsk();
    this._quickAddErrand(text, box, boxId);
  },
  _quickAddErrand(text, box, boxId){
    const known = [...(state.jobs || []).map(j => j.name), ...(state.students || []).map(s => s.name)];
    const base = this.homeDateISO();
    const items = QuickNote.parseMany(text, this.todayISO(), known);
    if(!items.length) return;
    const mode = state.scheduleMode;
    state.scheduleMode = 'errands';
    try{ this._addNoteItems(items.map(it => ({ ...it, date: it.date || base })), { render: false }); }
    finally{ state.scheduleMode = mode; }
    if(box) box.value = '';
    this.renderHome();
    // From the first-run card the day is planned straight away.
    if(boxId) try{ this.homePlan(); }catch(e){}
  },

  // ── Before / after ──────────────────────────────────────────────────────
  // Kept on the device: the latest week, and one record per planned date.
  recordSavings(scope, key, rec){
    if(!state.savings) state.savings = { week: null, days: {} };
    const r = { ...rec, at: new Date().toISOString() };
    if(scope === 'week') state.savings.week = r;
    else state.savings.days[key] = r;
    Storage.saveSavings(state.savings);
    try{ Usage.ping(scope === 'week' ? 'week' : 'day', this.savingsOf(r)); Usage.maybeAsk(); }catch(e){}
    return r;
  },
  // Saving = before minus after. Kilometres only when both sides have the same
  // stops: fitting more in is said separately, never turned into kilometres.
  savingsOf(rec){
    if(!rec || !rec.before || !rec.after) return null;
    const b = rec.before, a = rec.after, fuel = state.settings.fuelConsumption || 7;
    const same = b.stops === a.stops;
    const km = same ? b.km - a.km : 0, drive = same ? b.drive - a.drive : 0, idle = same ? b.idle - a.idle : 0;
    const litres = km / 100 * fuel;
    return { same, more: a.stops - b.stops, km, drive, idle, minutes: drive + idle,
             litres, co2: litres * this.co2PerLitre(),
             eur: litres * this.fuelPrice(), pct: same && b.km > 0 ? km / b.km * 100 : 0 };
  },
  // Kilograms of CO2 from burning a litre, by fuel (tank-to-wheel figures in
  // common use: petrol 2.31, diesel 2.68, LPG 1.61).
  CO2_KG_PER_L: { petrol: 2.31, diesel: 2.68, lpg: 1.61 },
  co2PerLitre(){ return this.CO2_KG_PER_L[(state.settings && state.settings.fuelType) || 'petrol'] || 2.31; },
  WEEKS_PER_YEAR: 48,
  _savingsCardHtml(rec, scope){
    const s = this.savingsOf(rec);
    if(!s) return '';
    const b = rec.before, a = rec.after;
    const label = scope === 'week' ? (rec.kind === 'own' ? t('ba_before_own') : t('ba_before_week')) : (rec.kind === 'time' ? t('ba_before_time') : t('ba_before_typed'));
    const row = (name, m, strong) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;${strong ? 'font-weight:700' : 'color:var(--text2)'}">
        <span>${esc(name)}</span><span style="white-space:nowrap">${m.km.toFixed(1)} km · ${Math.round(m.drive)}′ ${esc(t('ba_drive'))}${m.idle >= 1 ? ' · ' + Math.round(m.idle) + '′ ' + esc(t('ba_wait')) : ''}</span></div>`;
    let verdict;
    if(!s.same && s.more > 0) verdict = tf('ba_more', { n: s.more });
    else if(s.km < 0.05 && s.minutes < 1) verdict = t('ba_already_good');
    else if(s.km < -0.05) verdict = tf('ba_trade', { min: Math.round(s.minutes), km: (-s.km).toFixed(1) });
    else verdict = tf('ba_saved', { km: Math.max(0, s.km).toFixed(1), min: Math.max(0, Math.round(s.minutes)), eur: Math.max(0, s.eur).toFixed(2), pct: Math.max(0, Math.round(s.pct)) });
    // Same stops on both sides: the comparison as a small table — km,
    // driving, waiting, fuel and CO2, before, after and the difference.
    let table = row(label, b, false) + row(t('ba_after'), a, true), year = '';
    if(s.same){
      const fuel = state.settings.fuelConsumption || 7, price = this.fuelPrice(), co2 = this.co2PerLitre();
      const L = (km) => km / 100 * fuel;
      const sign = (v, d, unit) => Math.abs(v) < 0.05 ? '—' : (v > 0 ? '−' : '+') + Math.abs(v).toFixed(d) + unit;
      const hm = (m) => { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + esc(t('unit_hr')) + String(m % 60).padStart(2, '0') + '′' : m + '′'; };
      const signT = (m) => Math.abs(m) < 1 ? '—' : (m > 0 ? '−' : '+') + hm(Math.abs(m));
      const tr = (name, x, y, gain, good) => `<tr><th scope="row">${esc(name)}</th><td>${x}</td><td>${y}</td><td class="${good ? 'ba-good' : ''}">${gain}</td></tr>`;
      table = `<table class="ba-table">
        <thead><tr><td></td><th scope="col">${esc(t('ba_col_before'))}</th><th scope="col">${esc(t('ba_after'))}</th><th scope="col">${esc(t('ba_col_gain'))}</th></tr></thead>
        <tbody>
        ${tr(t('ba_row_km'), b.km.toFixed(1), a.km.toFixed(1), sign(s.km, 1, ' km'), s.km > 0.05)}
        ${tr(t('ba_row_drive'), hm(b.drive), hm(a.drive), signT(s.drive), s.drive >= 1)}
        ${b.idle >= 1 || a.idle >= 1 ? tr(t('ba_row_idle'), hm(b.idle), hm(a.idle), signT(s.idle), s.idle >= 1) : ''}
        ${tr(t('ba_row_fuel'), L(b.km).toFixed(1) + ' L', L(a.km).toFixed(1) + ' L', sign(s.litres, 1, ' L'), s.litres > 0.05)}
        ${tr(t('ba_row_cost'), '€' + (L(b.km) * price).toFixed(2), '€' + (L(a.km) * price).toFixed(2), sign(s.eur, 2, ' €'), s.eur > 0.005)}
        ${tr('CO₂', (L(b.km) * co2).toFixed(1) + ' kg', (L(a.km) * co2).toFixed(1) + ' kg', sign(s.co2, 1, ' kg'), s.co2 > 0.05)}
        </tbody></table>
        <div class="ba-note">${esc(label)}</div>`;
      if(scope === 'week' && s.km > 0.05){
        const w = this.WEEKS_PER_YEAR;
        year = `<div class="ba-year">${esc(tf('ba_year', { w, km: Math.round(s.km * w), h: Math.round(s.minutes * w / 60), eur: Math.round(s.eur * w), co2: Math.round(s.co2 * w) }))}</div>`;
      }
    }
    return `
      <div class="ba-card" style="margin:0 16px 12px;padding:12px 14px;border-radius:14px;background:var(--bg2);border:1px solid var(--border);font-size:13px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--text3);text-transform:uppercase;margin-bottom:4px">${esc(t('ba_title'))}</div>
        ${table}
        <div style="margin-top:6px;padding-top:8px;border-top:1px solid var(--border);color:var(--green);font-weight:700">${esc(verdict)}</div>
        ${year}
      </div>`;
  },

  // ── The + button ────────────────────────────────────────────────────────
  // One tap opens the choices in an arc above it (a list beside it on a
  // laptop); holding it starts dictation straight away. The screen you are
  // on decides which choice comes first.
  _fabItems(){
    const L = getLabels();
    const all = {
      errand: { icon: ico('bag', 24), label: t('fab_errand'), run: () => this.fabSheetOpen() },
      job:    { icon: ico('flag', 24), label: t('fab_job'), run: () => { this.nav('schedule'); state.scheduleMode = 'day'; this.renderSchedule(); this.openJobDrawer(null); } },
      client: { icon: ico('user', 24), label: L.client, run: () => { this.nav('students'); this.openStudentDrawer(null); } },
      voice:  { icon: ico('mic', 24), label: t('fab_voice'), run: () => this.fabVoice() },
      plan:   { icon: ico('nav', 24), label: t('fab_plan'), run: () => { this.nav('home'); this.homePlan(); } },
    };
    const order = state.currentScreen === 'students' ? ['client', 'errand', 'job', 'voice', 'plan']
      : state.currentScreen === 'schedule' ? ['job', 'errand', 'client', 'voice', 'plan']
      : ['errand', 'job', 'client', 'voice', 'plan'];
    return order.map(k => ({ key: k, ...all[k] }));
  },
  fabIsOpen(){ const m = document.getElementById('fab-menu'); return !!(m && m.classList.contains('open')); },
  fabToggle(){ this.fabIsOpen() ? this.fabClose() : this.fabOpen(); },
  fabOpen(){
    const menu = document.getElementById('fab-menu'), fab = document.getElementById('nav-fab');
    if(!menu || !fab) return;
    const r = fab.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const items = this._fabItems(), W = window.innerWidth, side = W >= 1100;
    const n = items.length, R = 132, pad = 44;
    // The arc is centred on the screen and sits clear above the bar, whatever
    // slot the button has; the items still fly out of the button itself.
    const navTop = (document.querySelector('nav')?.getBoundingClientRect().top) || cy;
    const ax = W / 2, ay = navTop - 52;
    menu.innerHTML = items.map((it, i) => {
      let x, y;
      if(side){ x = r.right + 60; y = r.top + 40 + i * 84; }
      else {
        const a = (-162 + i * (144 / (n - 1))) * Math.PI / 180;     // an upward arc, left to right
        x = Math.min(W - pad, Math.max(pad, ax + R * Math.cos(a)));
        y = ay + R * Math.sin(a) + R * 0.32;
      }
      return `<button class="fab-item${i === 0 ? ' first' : ''}" style="left:${x}px;top:${y}px;--dx:${cx - x}px;--dy:${cy - y}px;--delay:${i * 0.025}s"
        onclick="App.fabRun('${it.key}')">${it.icon}<span>${esc(it.label)}</span></button>`;
    }).join('');
    menu.offsetWidth;                         // lay out the closed state first, so it animates open
    menu.classList.add('open'); fab.classList.add('open');
  },
  fabClose(){
    document.getElementById('fab-menu')?.classList.remove('open');
    document.getElementById('nav-fab')?.classList.remove('open');
  },
  fabRun(key){
    const it = this._fabItems().find(x => x.key === key);
    this.fabClose();
    if(it) it.run();
  },
  fabPress(){
    clearTimeout(this._fabTimer);
    this._fabLong = false;
    this._fabTimer = setTimeout(() => { this._fabLong = true; this.fabClose(); this.fabVoice(); }, 550);
  },
  fabRelease(){ clearTimeout(this._fabTimer); },
  fabClick(e){
    if(this._fabLong){ this._fabLong = false; if(e) e.preventDefault(); return; }
    this.fabToggle();
  },

  // A short sheet to type (or say) what has to be done; it goes in as boxes,
  // for today or tomorrow, like the line that used to sit on the home screen.
  fabSheetOpen(){
    const body = document.getElementById('fab-sheet-body');
    if(!body) return;
    const tomorrow = state.homeDay === 1;
    body.innerHTML = `
      <div style="padding:4px 20px 20px">
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:12px">${esc(t('fab_errand_title'))}</div>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button class="chip ${!tomorrow ? 'chip-blue' : 'chip-gray'}" style="border:none;cursor:pointer" onclick="App.fabSetDay(0)">${esc(t('day_today'))}</button>
          <button class="chip ${tomorrow ? 'chip-blue' : 'chip-gray'}" style="border:none;cursor:pointer" onclick="App.fabSetDay(1)">${esc(t('day_tomorrow'))}</button>
        </div>
        <textarea id="fab-qn" autocomplete="off" placeholder="${esc(t('home_add_ph'))}"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();App.fabSheetAdd()}"></textarea>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-secondary fab-mic" id="fab-mic" style="flex:0 0 56px;font-size:20px" onclick="App.fabVoice()" aria-label="${esc(t('fab_voice'))}">${ico('mic', 20)}</button>
          <button class="btn btn-primary" style="flex:1" onclick="App.fabSheetAdd()">${esc(t('qn_add'))}</button>
        </div>
        <p style="font-size:12px;color:var(--text3);margin-top:10px">${esc(t('fab_errand_hint'))}</p>
        ${state.students.length ? `<p style="font-size:12px;color:var(--text3);margin-top:6px">${ico('mic', 12)} ${esc(t('voice_examples'))}</p>` : ''}
      </div>`;
    document.getElementById('fab-sheet-overlay')?.classList.add('open');
    setTimeout(() => document.getElementById('fab-qn')?.focus(), 250);
  },
  fabSetDay(n){
    const box = document.getElementById('fab-qn'), text = box ? box.value : '';
    state.homeDay = n === 1 ? 1 : 0;
    this.fabSheetOpen();
    const again = document.getElementById('fab-qn'); if(again) again.value = text;
  },
  fabSheetClose(){
    this._fabStopVoice();
    document.getElementById('fab-sheet-overlay')?.classList.remove('open');
  },
  fabSheetAdd(){
    const box = document.getElementById('fab-qn');
    if(!box || !box.value.trim()) return;
    this._fabStopVoice();
    this.homeQuickAdd();
    this.fabSheetClose();
    if(state.currentScreen !== 'home') this.nav('home');
  },
  // Dictation where the browser offers it; otherwise the keyboard's own
  // microphone does the same job.
  fabVoice(){
    if(!document.getElementById('fab-sheet-overlay')?.classList.contains('open')) this.fabSheetOpen();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const box = document.getElementById('fab-qn'), mic = document.getElementById('fab-mic');
    if(this._fabRec){ this._fabStopVoice(); return; }
    if(!SR){ Toast.show(t('fab_voice_none'), 'info', 5000); box?.focus(); return; }
    try{
      const rec = new SR();
      rec.lang = { el: 'el-GR', en: 'en-US', fr: 'fr-FR', de: 'de-DE' }[state.settings.language] || 'el-GR';
      rec.interimResults = true; rec.continuous = false;
      const start = box ? box.value.trim() : '';
      rec.onresult = (e) => {
        const said = Array.from(e.results).map(x => x[0].transcript).join(' ').trim();
        if(box) box.value = (start ? start + ', ' : '') + said;
      };
      rec.onerror = (e) => { if(e && e.error === 'not-allowed') Toast.show(t('fab_voice_denied'), 'error', 6000); };
      rec.onend = () => { this._fabRec = null; document.getElementById('fab-mic')?.classList.remove('on'); };
      rec.start();
      this._fabRec = rec;
      mic?.classList.add('on');
    }catch(e){ this._fabRec = null; Toast.show(t('fab_voice_none'), 'info', 5000); }
  },
  _fabStopVoice(){
    try{ this._fabRec && this._fabRec.stop(); }catch(e){}
    this._fabRec = null;
    document.getElementById('fab-mic')?.classList.remove('on');
  },

  // Swipe right on a job or errand to delete it, with Undo. The planned day
  // closes the gap (see Scheduler.dropStop).
  swipeDeleteJob(id){
    const j = (state.jobs || []).find(x => x.id === id);
    if(!j) return;
    const saved = { jobs: state.jobs.slice(), coord: state.coords[id], plan: state.dayPlan };
    state.jobs = state.jobs.filter(x => x.id !== id);
    delete state.coords[id];
    let refitMsg = '';
    const plan = state.dayPlan;
    if(plan && plan.date === j.date && plan.stops.some(x => x.job && x.job.id === id)){
      const now = new Date();
      const nowMin = plan.date === this.todayISO() ? now.getHours() * 60 + now.getMinutes() : null;
      try{
        state.dayPlan = Scheduler.dropStop(plan, state.settings, id, nowMin);
        if(state.dayPlan.stops.length) refitMsg = ' ' + (!state.dayPlan.refit ? t('swipe_no_refit')
          : nowMin != null ? tf('swipe_refit_now', { time: state.dayPlan.refitFrom }) : t('swipe_refit'));
      }catch(e){ console.warn('dropStop failed', e); state.dayPlan = null; }
    }
    Storage.saveJobs(state.jobs); Storage.saveCoords(state.coords);
    this._rerenderAfterJobs();
    Toast.show(tf('swipe_deleted', { name: j.name }) + refitMsg, 'info', 6000, { label: t('swipe_undo'), run: () => {
      state.jobs = saved.jobs; if(saved.coord) state.coords[id] = saved.coord; state.dayPlan = saved.plan;
      Storage.saveJobs(state.jobs); Storage.saveCoords(state.coords);
      this._rerenderAfterJobs();
    } });
  },
  _rerenderAfterJobs(){
    if(state.currentScreen === 'home') this.renderHome();
    else if(state.currentScreen === 'schedule') this.renderSchedule();
  },
  // ── Swipe, everywhere ───────────────────────────────────────────────────
  // Anything with data-swipe="kind:..." can be swiped: LEFT deletes it (with
  // Undo), RIGHT opens a note on it. Kinds: job:ID, student:ID and
  // slot:DAY:STUDENT:START:END (a lesson on the schedule).
  _swipeAction(spec, dir){
    const [kind, ...p] = String(spec || '').split(':');
    if(dir === 'left'){
      if(kind === 'job') return this.swipeDeleteJob(p[0]);
      if(kind === 'student') return this.swipeDeleteStudent(p[0]);
      if(kind === 'slot') return this.swipeDeleteSlot(Number(p[0]), p[1], p[2] + ':' + p[3], p[4] + ':' + p[5]);
    } else {
      if(kind === 'job') return this.openNoteSheet('job', p[0]);
      if(kind === 'student') return this.openNoteSheet('student', p[0]);
      if(kind === 'slot') return this.openNoteSheet('student', p[1]);
    }
  },
  _rerenderAll(){
    if(state.currentScreen === 'home') this.renderHome();
    else if(state.currentScreen === 'schedule') this.renderSchedule();
    else if(state.currentScreen === 'students') this.renderStudents();
    else if(state.currentScreen === 'route' && this.renderRoute) this.renderRoute();
  },
  swipeDeleteStudent(id){
    const st = (state.students || []).find(s => s.id === id);
    if(!st) return;
    const saved = JSON.stringify({ students: state.students, schedule: state.schedule, coords: state.coords, stale: !!state._scheduleStale });
    this._removeStudent(id);
    this._rerenderAll();
    Toast.show(tf('swipe_deleted', { name: st.name }), 'info', 6000, { label: t('swipe_undo'), run: () => {
      const v = JSON.parse(saved);
      state.students = v.students; state.schedule = v.schedule; state.coords = v.coords; state._scheduleStale = v.stale;
      Storage.saveStudents(state.students); Storage.saveCoords(state.coords); Storage.saveSchedule(state.schedule);
      this._rerenderAll();
    } });
  },
  // A lesson off the week (the client stays; that lesson is now unplaced).
  swipeDeleteSlot(day, sid, start, end){
    const list = state.schedule[day] || [];
    const a = Scheduler.toMin(start), b = Scheduler.toMin(end);
    const gone = list.filter(sl => sl.studentId === sid && Scheduler.toMin(sl.start) >= a && Scheduler.toMin(sl.end) <= b);
    if(!gone.length) return;
    const saved = JSON.stringify(state.schedule);
    state.schedule[day] = list.filter(sl => !gone.includes(sl));
    if(state.routeResults) delete state.routeResults[day];
    Storage.saveSchedule(state.schedule);
    this._rerenderAll();
    Toast.show(tf('swipe_slot_removed', { name: gone[0].studentName || '', day: DAYS[day] || '' }), 'info', 6000, { label: t('swipe_undo'), run: () => {
      state.schedule = JSON.parse(saved);
      if(state.routeResults) delete state.routeResults[day];
      Storage.saveSchedule(state.schedule);
      this._rerenderAll();
    } });
  },
  // A note on a client or a job, from a swipe to the right.
  openNoteSheet(kind, id){
    const rec = kind === 'student' ? (state.students || []).find(s => s.id === id) : (state.jobs || []).find(j => j.id === id);
    const body = document.getElementById('fab-sheet-body');
    if(!rec || !body) return;
    this._noteFor = { kind, id };
    body.innerHTML = `
      <div style="padding:4px 20px 20px">
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:4px">${esc(t('note_title'))}</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:12px">${esc(rec.name || '')}</div>
        <textarea id="note-text" style="width:100%;min-height:110px;font-size:16px;resize:vertical" placeholder="${esc(t('note_ph'))}">${esc(rec.notes || '')}</textarea>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-secondary" style="flex:1" onclick="App.fabSheetClose()">${esc(t('btn_cancel'))}</button>
          <button class="btn btn-primary" style="flex:1" onclick="App.saveNote()">${esc(t('btn_save'))}</button>
        </div>
      </div>`;
    document.getElementById('fab-sheet-overlay')?.classList.add('open');
    setTimeout(() => document.getElementById('note-text')?.focus(), 250);
  },
  saveNote(){
    const f = this._noteFor; if(!f) return;
    const text = (document.getElementById('note-text')?.value || '').trim().slice(0, 1000);
    if(f.kind === 'student'){
      const st = state.students.find(s => s.id === f.id); if(st){ st.notes = text; Storage.saveStudents(state.students); }
    } else {
      const j = state.jobs.find(x => x.id === f.id); if(j){ j.notes = text; Storage.saveJobs(state.jobs); }
    }
    this._noteFor = null;
    this.fabSheetClose();
    this._rerenderAll();
    Toast.show(t('note_saved'), 'success');
  },
  _initSwipe(){
    if(this._swipeInit) return; this._swipeInit = true;
    let el = null, x0 = 0, y0 = 0, dx = 0, active = false, bg = null, armed = false;
    const reset = () => { if(el){ el.classList.remove('swiping'); el.style.transform = ''; } if(bg) bg.remove(); el = null; bg = null; active = false; dx = 0; };
    document.addEventListener('pointerdown', (e) => {
      const t0 = e.target.closest && e.target.closest('[data-swipe]');
      if(!t0 || e.target.closest('button,input,select,textarea,a')) return;
      el = t0; x0 = e.clientX; y0 = e.clientY; dx = 0; active = false;
    }, { passive: true });
    document.addEventListener('pointermove', (e) => {
      if(!el) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if(!active){
        // Only a clearly sideways drag is a swipe: past 24px, and more than
        // twice as wide as it is tall. Anything else is a scroll or a shaky
        // tap, and the row stays where it is.
        if(Math.abs(my) > 10 && Math.abs(my) * 2 > Math.abs(mx)){ reset(); return; }
        if(Math.abs(mx) < 24) return;
        active = true; el.classList.add('swiping'); armed = false;
        try{ window.getSelection().removeAllRanges(); }catch(e){}
        bg = document.createElement('div'); el.appendChild(bg);
      }
      // The row follows the finger less and less the further it goes, and no
      // further than 45% of its width.
      const w = el.offsetWidth || 300, raw = mx - Math.sign(mx) * 24, cap = w * 0.45;
      dx = Math.sign(raw) * Math.min(cap, Math.abs(raw) < 90 ? Math.abs(raw) : 90 + (Math.abs(raw) - 90) * 0.4);
      const left = dx < 0, far = Math.abs(dx) > Math.min(110, w * 0.3);
      if(far !== armed){ armed = far; if(far) try{ navigator.vibrate && navigator.vibrate(8); }catch(e){} }
      bg.className = 'swipe-bg ' + (left ? 'del' : 'note');
      bg.style.opacity = far ? '1' : String(0.35 + 0.65 * Math.abs(dx) / Math.min(110, w * 0.3));
      bg.innerHTML = left ? `<span>${esc(t('swipe_delete'))}</span>${ico('trash', 16)}` : `${ico('edit', 16)}<span>${esc(t('note_title'))}</span>`;
      el.style.transform = `translateX(${dx}px)`;
      bg.style.transform = `translateX(${-dx}px)`;
    }, { passive: true });
    const end = () => {
      if(!el) return;
      if(active){
        this._swipeJustEnded = Date.now();                 // swallow the click that follows
        const far = Math.abs(dx) > Math.min(110, el.offsetWidth * 0.3);
        if(far){
          const spec = el.getAttribute('data-swipe'), dir = dx < 0 ? 'left' : 'right', target = el;
          if(bg) bg.remove(); el = null; bg = null; active = false;
          if(dir === 'left'){
            target.classList.remove('swiping'); target.classList.add('swipe-out');
            setTimeout(() => this._swipeAction(spec, dir), 180);
          } else {
            target.classList.remove('swiping'); target.style.transform = '';
            this._swipeAction(spec, dir);
          }
          return;
        }
      }
      reset();
    };
    document.addEventListener('pointerup', end, { passive: true });
    document.addEventListener('pointercancel', reset, { passive: true });
    document.addEventListener('click', (e) => {
      if(this._swipeJustEnded && Date.now() - this._swipeJustEnded < 400 && e.target.closest && e.target.closest('[data-swipe]')){
        e.stopPropagation(); e.preventDefault();
      }
    }, true);
  },

  toggleJobDone(id){
    const j = (state.jobs || []).find(x => x.id === id);
    if(!j) return;
    j.done = !j.done;
    Storage.saveJobs(state.jobs);
    if(state.dayPlan && state.dayPlan.date === j.date) state.dayPlan = null;   // the plan no longer describes the day
    if(state.currentScreen === 'home') this.renderHome(); else if(document.getElementById('qn-text')) this.renderDayPlanner();
  },

  miniSlot(slot, idx){
    const mergeTag = slot.merged ? `<span class="merge-badge">${t('merge_badge_label')} ${slot.mergedCount}×${slot.originalDuration}${t('unit_min')}</span>` : '';
    return `
      <div class="slot-block ${COLORS[slot.color||0]}${slot.merged?' merged':''}${slot.isGroup?' group-slot':''}" style="margin-bottom:8px">
        <div class="slot-time">${slot.start} – ${slot.end}</div>
        <div class="slot-name">${esc(slot.studentName)} ${mergeTag}</div>
        <div class="slot-meta">
          ${subjectText(slot.subject) ? `<span class="chip chip-gray">${esc(subjectText(slot.subject))}</span>` : ''}
          <span class="chip chip-gray">${slot.duration}${t('unit_min')}</span>
        </div>
      </div>`;
  },

  getGreeting(){
    const h = new Date().getHours();
    if(h<12) return t('greeting_morning');
    if(h<17) return t('greeting_afternoon');
    return t('greeting_evening');
  },

  // ---- STUDENTS ----
  renderStudents(){
    const s = document.getElementById('screen-students');
    const students = state.students;
    const L = getLabels();
    s.innerHTML = `
      <div class="topbar">
        <div class="topbar-inner">
          <div>
            <div class="logo">Route<span>Pal</span></div>
            <div class="topbar-sub">${L.clients} · ${students.length} ${t('students_registered_suffix')}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${students.length>0?`<button class="btn btn-secondary" onclick="App.geocodeAllStudents()" id="btn-geocode-all" style="padding:8px 12px;font-size:12px">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 10-16 0c0 3 2.7 6.9 8 11.7z"/></svg>
              ${t('students_map_btn')}
            </button>`:''}
            <button class="btn btn-primary" onclick="App.openStudentDrawer(null)" style="padding:8px 14px">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              ${t('students_new_btn')}
            </button>
          </div>
        </div>
      </div>
      ${students.length===0?`
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          <h3>${tf('students_empty_title',{clients:L.clients.toLowerCase()})}</h3>
          <p>${tf('students_empty_sub',{client:L.client.toLowerCase()})}</p>
          <button class="btn btn-primary" onclick="App.openStudentDrawer(null)">${tf('students_add_btn',{client:L.client})}</button>
          <button class="btn btn-secondary" style="margin-top:8px" onclick="App.openPasteClients()">${esc(t('paste_btn'))}</button>
          <button class="btn btn-secondary" style="margin-top:8px" onclick="App.openCalendarImport()">${ico('calendar', 14)} ${esc(t('cal_import_btn'))}</button>
          <p class="settings-sub" style="margin-top:6px;max-width:320px">${esc(t('cal_import_hint'))}</p>
        </div>
      `:`
        ${Object.keys(state.coords).filter(k=>k!=='home'&&k!=='workplace').length>0?`
          <div style="margin:0 0 8px;background:var(--bg2);border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px 6px;cursor:pointer" onclick="App.toggleStudentsMap()">
              <span style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.05em">${t('students_map_locations_label')}</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:11px;color:var(--text3)">${Object.keys(state.coords).filter(k=>k!=='home'&&k!=='workplace').length} ${t('students_map_locations_count')}</span>
                <svg id="map-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text3);transition:transform .2s;transform:rotate(${state._mapExpanded?'180':'0'}deg)"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            </div>
            <div id="students-overview-map-wrap" style="overflow:hidden;transition:max-height .3s ease;max-height:${state._mapExpanded?'220px':'0px'}">
              <div id="students-overview-map" style="height:200px;margin:0 16px 12px;border-radius:10px;overflow:hidden;background:var(--bg3);position:relative;isolation:isolate"></div>
            </div>
          </div>
        `:''}
        <div style="display:flex;gap:8px;padding:0 16px 10px;flex-wrap:wrap">
          <button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="App.openPasteClients()">${esc(t('paste_btn'))}</button>
          <button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="App.openCalendarImport()">${ico('calendar', 13)} ${esc(t('cal_import_btn'))}</button>
        </div>
        ${Payments.totalHtml()}
        ${students.map(st=>this.studentCard(st)).join('')}
      `}
    `;
    if(students.length>0 && state._mapExpanded) this.initStudentsMap();
  },

  toggleStudentsMap(){
    state._mapExpanded = !state._mapExpanded;
    const wrap = document.getElementById('students-overview-map-wrap');
    const chev = document.getElementById('map-chevron');
    if(wrap) wrap.style.maxHeight = state._mapExpanded ? '220px' : '0px';
    if(chev) chev.style.transform = state._mapExpanded ? 'rotate(180deg)' : 'rotate(0deg)';
    if(state._mapExpanded){
      // Container animates over 300ms (see max-height transition above) — initializing
      // Wait for the container transition before measuring the Google map.
      if(wrap){
        const onDone = (e)=>{ if(e && e.propertyName!=='max-height') return; wrap.removeEventListener('transitionend', onDone); this.initStudentsMap(); };
        wrap.addEventListener('transitionend', onDone);
        setTimeout(onDone, 400); // fallback in case transitionend doesn't fire
      } else {
        this.initStudentsMap();
      }
    }
  },

  initStudentsMap(){
    const el = document.getElementById('students-overview-map');
    if(!el) return;
    const geocodedStudents = state.students.filter(s => state.coords[s.id]);
    if(geocodedStudents.length === 0){ el.innerHTML=`<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3);font-size:12px">${t('students_map_no_geocoded')}</div>`; return; }
    const homeC = state.coords['home'];
    const pts = geocodedStudents.map(s=>state.coords[s.id]);
    const allPts = homeC ? [homeC,...pts] : pts;
    const markers=[];
    if(homeC){
      markers.push({lat:homeC.lat,lon:homeC.lon,label:'',title:t('home_marker_tooltip')});
    }
    geocodedStudents.forEach(s=>{
      const c=state.coords[s.id];
      const initials=esc(s.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase());
      markers.push({lat:c.lat,lon:c.lon,label:initials,title:`${s.name} — ${s.address}`});
    });
    this._googleMapUpdate(el,{
      center:allPts[0],zoom:12,zoomControl:false,
      markers,fitBounds:allPts.map(c=>({lat:c.lat,lon:c.lon}))
    });
  },

  studentCard(st){
    // Every free stretch, not just the largest. The scheduler reads all of
    // them; showing only one made the card disagree with the schedule, and a
    // gap explained by "not free before 20:00" looked wrong next to a card
    // that listed a different stretch.
    const avDays = Object.entries(st.availability||{})
      .filter(([,v])=>v.on)
      .map(([d])=>`${DAYS[d]} ${Scheduler.availWindows(st, Number(d))
        .map(([a,b])=>`${Scheduler.toTime(a)}–${Scheduler.toTime(b)}`).join(' & ')}`)
      .join(', ');
    const placed = Scheduler.countPlaced(st.id, state.schedule);
    const avatarColors = ['#059669','#7c3aed','#d97706','#db2777','#ca8a04','#0891b2','#16a34a','#9333ea','#c2410c','#0284c7'];
    const bg = avatarColors[(st.color||0) % avatarColors.length];
    const initials = esc(st.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase());
    // When this client is on the week, as chips on the card: "Δευ 14:30".
    const times = [];
    for(const d of (state.settings.workDays || []))
      for(const sl of (state.schedule[d] || []))
        if(sl.studentId === st.id || (sl.groupMemberIds || []).includes(st.id) || sl.pairedStudentId === st.id)
          times.push(`${DAYS[d]} ${sl.start}`);
    const phone = st.phone ? String(st.phone).replace(/[^\d+]/g, '') : '';
    return `
      <div class="student-card wallet-card" id="sc-${st.id}" style="--cc:${bg}" data-swipe="student:${esc(st.id)}">
        <div class="student-header" onclick="App.toggleStudent('${st.id}')">
          <div class="student-avatar" style="background:${bg}20;color:${bg};border:1px solid ${bg}40">${initials}</div>
          <div class="student-info">
            <div class="student-name">${esc(st.name)} ${this._farFromHomeWarning(st.id)} ${this._locationNote(st.id)}</div>
            <div class="student-sub">${subjectText(st.subject) ? esc(subjectText(st.subject)) + ' · ' : ''}${Scheduler.hasMixedDurations(st) ? st.durations.map(d => d + '′').join(' + ') : st.lessonsPerWeek + t('student_per_week_suffix')}${Cadence.label(st) ? ' · ' + esc(Cadence.label(st)) : ''} · <span class="wallet-placed${placed>=st.lessonsPerWeek?'':' short'}">${placed}/${st.lessonsPerWeek} ${t('student_placed_suffix')}</span></div>
            ${times.length ? `<div class="wallet-times">${times.slice(0, 5).map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
            ${Payments.badgeHtml(st)}
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron-${st.id}" style="flex-shrink:0;color:var(--text3);transition:transform .2s"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="student-body" id="sb-${st.id}">
          <div class="student-detail-row"><span class="student-detail-label">${t('student_address_label')}</span><span style="font-size:12px;text-align:right;max-width:200px">${esc(st.address)}${state.coords[st.id]?` <span style="color:var(--green);font-size:10px" title="${t('student_geocoded_title')} ✓">${ico('pin', 11)}</span>`:`<span style="color:var(--text3);font-size:10px" title="${t('student_not_geocoded_title')}"> ○</span>`} ${this._farFromHomeWarning(st.id)}</span></div>
          ${st.phone?`<div class="student-detail-row"><span class="student-detail-label">${t('student_phone_label')}</span><span style="font-size:12px">${esc(st.phone)}</span></div>`:''}
          <div class="student-detail-row"><span class="student-detail-label">${t('student_duration_label')}</span><span>${st.lessonDuration} ${t('student_minutes_suffix')}</span></div>
          <div class="student-detail-row"><span class="student-detail-label">${t('pay_row')}</span><span style="display:flex;align-items:center;gap:8px">${esc(Payments.owedText(st) || t('pay_nothing_short'))}${Payments.price(st) ? ` <span style="color:var(--text3)">(${Payments.price(st)} €)</span>` : ''}<button class="chip chip-gray" style="border:none;cursor:pointer" onclick="event.stopPropagation();Payments.openPay('${st.id}')">${esc(t('pay_btn'))}</button></span></div>
          <div class="student-detail-row"><span class="student-detail-label">${t('student_type_label')}</span><span class="chip ${st.type==='group'?'chip-purple':'chip-blue'}">${st.type==='group'?t('student_type_group_prefix')+': '+esc(st.group):t('student_type_solo')}</span></div>
          ${st.pairedWith ? (()=>{
            const partner = state.students.find(s=>s.id===st.pairedWith);
            const linkedBack = partner && partner.pairedWith===st.id;
            return `<div class="student-detail-row"><span class="student-detail-label">${t('student_paired_label')}</span><span class="chip ${linkedBack?'chip-purple':'chip-red'}">${partner?esc(partner.name):t('student_unknown_partner')}${linkedBack?'':' '+t('student_not_mutual')}</span></div>`;
          })() : ''}
          <div class="student-detail-row"><span class="student-detail-label">${t('student_availability_label')}</span><span style="font-size:12px;text-align:right;max-width:200px;color:var(--text2)">${avDays||'—'}</span></div>
          ${st.notes?`<div class="student-detail-row"><span class="student-detail-label">${t('student_notes_label')}</span><span style="font-size:12px;text-align:right;max-width:200px;color:var(--text2)">${esc(st.notes)}</span></div>`:''}
          ${placed>0 || phone?`
          <div class="student-actions" style="margin-bottom:8px">
            ${phone ? `<a class="btn btn-secondary" style="flex:1;text-decoration:none" href="tel:${esc(phone)}">${ico('phone', 14)} ${esc(t('wallet_call'))}</a>` : ''}
            ${placed>0 ? `<button class="btn btn-primary" style="flex:1" onclick="App.openSendSheet('student','${st.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
              ${t('send_times_btn')}
            </button>` : ''}
          </div>`:''}
          <div class="student-actions">
            <button class="btn btn-secondary" style="flex:1" onclick="App.openStudentDrawer('${st.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              ${t('btn_edit')}
            </button>
            <button class="btn btn-danger" style="flex:1" onclick="App.deleteStudent('${st.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
              ${t('btn_delete')}
            </button>
          </div>
        </div>
      </div>
    `;
  },

  toggleStudent(id){
    const body = document.getElementById('sb-'+id);
    const chevron = document.querySelector('.chevron-'+id);
    if(!body) return;
    const open = body.classList.toggle('open');
    if(chevron) chevron.style.transform = open?'rotate(180deg)':'';
  },

  _restoreStudentSave(){
    const b = document.querySelector('#drawer-student .drawer-footer .btn-primary');
    if(b) b.setAttribute('onclick','App.saveStudent()');
  },

  openStudentDrawer(id){
    this._restoreStudentSave();
    state.editingStudentId = id;
    const isNew = !id;
    const st = id ? state.students.find(s=>s.id===id) : null;
    const L = getLabels();
    document.getElementById('drawer-student-title').textContent = isNew?`${t('drawer_new_prefix')} ${L.client}`:`${t('drawer_edit_prefix')} ${L.client}`;
    document.getElementById('drawer-student-body').innerHTML = this.buildStudentForm(st);
    this.initStudentFormEvents(st);
    document.getElementById('drawer-student-overlay').classList.add('open');
  },

  closeStudentDrawer(){
    document.getElementById('drawer-student-overlay').classList.remove('open');
    state.editingStudentId = null;
    const saveBtn = document.querySelector('#drawer-student .drawer-footer .btn-primary');
    if(saveBtn){ saveBtn.disabled=false; saveBtn.style.opacity=''; saveBtn.textContent=t('btn_save'); }
  },

  buildStudentForm(st, heardText){
    const L = getLabels();
    // Students saved under the old manual per-day picker don't have
    // availabilityExceptions populated — derive the equivalent exceptions
    // from their real st.availability so their actual constraints stay
    // visible/correct now that manual mode is gone.
    this._editingExceptions = st
      ? (st.availabilityMode==='exceptions' ? (st.availabilityExceptions||[]).map(e=>({...e})) : this.computeExceptionsFromAvailability(st))
      : [];

    return `
      ${!st || heardText != null ? `<div class="card-sm" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <button type="button" class="btn btn-secondary fab-mic" id="st-mic" style="flex:0 0 52px;min-height:48px" onclick="App.formVoice()" aria-label="${esc(t('fab_voice'))}">${ico('mic', 20)}</button>
        <div style="flex:1;font-size:13px;color:var(--text2)">${esc(t('form_voice_hint'))}<div id="st-heard" style="color:var(--text);margin-top:4px">${heardText ? esc('«' + heardText + '»') : ''}</div></div>
      </div>` : ''}
      <div class="form-group">
        <label>${t('form_fullname_label')}</label>
        <input type="text" id="st-name" placeholder="${t('form_fullname_placeholder')}" value="${esc(st?.name||'')}">
      </div>
      ${state.settings.workplaceAddress ? `<div class="form-group">
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="st-at-work" ${(st ? st.atWorkplace : state.settings.workMode !== 'both') ? 'checked' : ''}
          onchange="document.getElementById('st-addr-block').style.display=this.checked?'none':''"> ${t('form_at_workplace')}</label>
        <div class="settings-sub" style="margin-top:4px">${esc(state.settings.workplaceAddress)}</div>
      </div>` : ''}
      <div id="st-addr-block" style="display:${state.settings.workplaceAddress && (st ? st.atWorkplace : state.settings.workMode !== 'both') ? 'none' : ''}">
      <div class="form-group" style="position:relative">
        <label>${t('student_address_label')}</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="st-addr" placeholder="${t('form_address_placeholder')}" value="${esc(st?.address||'')}" autocomplete="off" style="flex:1"
            oninput="App.onAddrInput(this.value)" onkeydown="App.onAddrKey(event)" onblur="setTimeout(()=>App.hideAddrSuggest(),200)">
          <button type="button" class="btn-icon" title="${t('form_pick_on_map')}" aria-label="${t('form_pick_on_map')}" onclick="App.openMapPicker('st-addr')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <button type="button" class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="App.hereNow('st-addr')">${ico('pin', 13)} ${esc(t('gps_here'))}</button>
          <button type="button" class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="App.findInGoogleMaps('st-addr','st-name')">${ico('search', 13)} ${esc(t('gmaps_find'))}</button>
          <button type="button" class="chip chip-gray" id="st-map-btn" aria-pressed="false" style="border:none;cursor:pointer;min-height:36px" onclick="App.toggleStudentMap()">${ico('map', 13)} ${esc(t('form_map_show'))}</button>
        </div>
        <div id="st-loc-wrap" style="display:none;margin-top:8px">
          <div id="st-loc-map" style="height:170px;border-radius:10px;overflow:hidden;background:var(--bg3);position:relative;isolation:isolate"></div>
          <div class="settings-sub" style="margin-top:4px">${t('form_location_map_hint')}</div>
        </div>
        <div id="addr-suggest" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
      </div>
      </div>
      <div class="form-group">
        <label id="st-dur-label">${t('form_duration_label')}</label>
        ${(() => { const cur = st?.lessonDuration ?? (state.settings.defaultLessonDuration || Professions.preset(state.settings.profession).dur), presets = Professions.durations(state.settings), other = !presets.includes(cur);
          return `<input type="hidden" id="st-dur" value="${cur}">
        <div class="seg" id="st-dur-seg" role="group" aria-labelledby="st-dur-label">
          ${presets.map(v => `<button type="button" class="seg-btn${cur === v ? ' on' : ''}" aria-pressed="${cur === v}" onclick="App._setDur(${v},this)">${v}′</button>`).join('')}
          <button type="button" class="seg-btn${other ? ' on' : ''}" aria-pressed="${other}" onclick="App._setDur(null,this)">${esc(t('form_dur_other'))}</button>
        </div>
        <input type="number" id="st-dur-other" inputmode="numeric" min="15" max="480" step="5" value="${other ? cur : ''}" placeholder="${esc(t('form_dur_other_ph'))}"
          aria-label="${esc(t('form_dur_other_ph'))}" style="margin-top:8px;display:${other ? '' : 'none'}"
          oninput="if(Number(this.value)>0)document.getElementById('st-dur').value=this.value">`; })()}
      </div>
      <div class="form-row">
        <div class="form-group" style="margin:0">
          <label>${t('form_times_per_week')}</label>
          <select id="st-freq" onchange="App.toggleMergeField()">
            ${[1,2,3,4,5,6,7].map(v=>`<option value="${v}" ${(st ? st.lessonsPerWeek : Professions.defaultPerWeek(state.settings))===v?'selected':''}>${v}×</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label for="st-cadence">${t('cad_label')}</label>
          <select id="st-cadence">
            ${[1,2,4].map(n=>`<option value="${n}" ${Cadence.of(st)===n?'selected':''}>${t('cad_opt_'+n)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group" id="merge-field" style="margin-top:14px;display:${(st?.lessonsPerWeek||1)>=2?'block':'none'}">
        ${this._mergeFieldHtml(st?.lessonsPerWeek||1, st)}
      </div>
      <div class="section-title" style="padding:0;margin:16px 0 8px">${t('form_time_constraints_title')}</div>
      <div id="avail-exceptions-block">
        <div class="settings-sub" style="margin-bottom:10px">${t('form_avail_mode_hint')}</div>
        <div id="avail-exceptions-list">${this.renderAvExceptionsList()}</div>
        <div class="form-row" style="margin-top:10px;align-items:flex-end">
          <div class="form-group" style="margin:0;flex:1">
            <label style="font-size:12px">${t('form_avail_exceptions_title')}</label>
            <select id="avex-day">
              ${(state.settings.workDays||[1,2,3,4,5]).map(d=>`<option value="${d}">${DAYS_FULL[d]}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <input type="time" id="avex-start" value="17:00">
          </div>
          <div class="form-group" style="margin:0">
            <input type="time" id="avex-end" value="18:00">
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn-full" style="margin-top:8px" onclick="App.addAvException()">${t('form_avail_add_exception')}</button>
      </div>
      <details id="st-more" class="fold fold-plain" ${st ? 'open' : ''} style="margin:14px 0 0">
        <summary>${t('form_more')}</summary>
      <div class="form-group">
        <label>${t('form_phone_label')}</label>
        <input type="tel" id="st-phone" placeholder="${t('form_phone_ph')}" value="${esc(st?.phone||'')}" autocomplete="tel">
      </div>
      <div class="form-group">
        <label>${L.session}</label>
        ${(() => { const cur = st?.subject || '', list = getSubjects(), own = !!cur && subjectText(cur) === cur && !list.includes(cur);
          return `<select id="st-subject" onchange="document.getElementById('st-subject-own').style.display=this.value==='Άλλο'?'':'none';App._serviceDur(this.value)">
          <option value="" ${!subjectText(cur) && cur !== 'Άλλο' ? 'selected' : ''}>${esc(t('subject_none'))}</option>
          ${list.map(sub=>`<option value="${sub}" ${(cur===sub && !own) || (own && sub==='Άλλο')?'selected':''}>${esc(sub==='Άλλο' ? t('subject_own') : subjectLabel(sub))}</option>`).join('')}
        </select>
        <input type="text" id="st-subject-own" maxlength="40" value="${own ? esc(cur) : ''}" placeholder="${esc(t('subject_own_ph'))}" aria-label="${esc(t('subject_own'))}"
          style="margin-top:8px;display:${own || cur === 'Άλλο' ? '' : 'none'}">`; })()}
      </div>
      <div class="form-group" style="margin-top:10px">
        <label>${t('form_flex_label')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="st-flex-hours" min="0" max="40" step="0.5" inputmode="decimal" style="flex:1"
            value="${st?.flexMinutes ? +(st.flexMinutes/60).toFixed(2) : ''}" placeholder="${esc(t('form_flex_ph'))}">
          <select id="st-min-block" style="flex:1" aria-label="${esc(t('form_flex_min'))}">
            ${[30,45,60,90,120].map(v=>`<option value="${v}" ${(st?.minBlock||60)===v?'selected':''}>${esc(tf('form_flex_min_opt',{n:v}))}</option>`).join('')}
          </select>
          <select id="st-max-block" style="flex:1" aria-label="${esc(t('form_flex_max'))}">
            ${[60,90,120,150,180,240].map(v=>`<option value="${v}" ${(st?.maxBlock||120)===v?'selected':''}>${esc(tf('form_flex_max_opt',{n:v}))}</option>`).join('')}
          </select>
        </div>
        <p style="font-size:12px;color:var(--text3);margin-top:4px">${esc(t('form_flex_hint'))}</p>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label>${t('form_durations_label')}</label>
        <input type="text" id="st-durations" inputmode="text" autocomplete="off"
          value="${esc(!st?.flexMinutes && Array.isArray(st?.durations) && st.durations.length > 1 ? st.durations.join(', ') : '')}"
          placeholder="${esc(t('form_durations_ph'))}">
        <p style="font-size:12px;color:var(--text3);margin-top:4px">${esc(t('form_durations_hint'))}</p>
      </div>
      <div class="form-row" style="margin-top:14px">
        <div class="form-group" style="margin:0">
          <label>${t('form_type_label')}</label>
          <select id="st-type" onchange="App.toggleGroupField()">
            <option value="solo" ${st?.type!=='group'?'selected':''}>${t('form_type_solo')}</option>
            <option value="group" ${st?.type==='group'?'selected':''}>${t('form_type_group')}</option>
          </select>
        </div>
        <div class="form-group" id="group-field" style="margin:0;display:${st?.type==='group'?'block':'none'}">
          <label>${t('form_group_code_label')}</label>
          <input type="text" id="st-group" placeholder="${t('form_group_code_placeholder')}" value="${esc(st?.group||'')}">
        </div>
      </div>
      <div class="form-group" style="margin-top:14px">
        <label>${t('student_paired_label')}</label>
        <select id="st-paired" onchange="App.onPairedChange(this.value)">
          <option value="">${t('form_paired_none')}</option>
          ${state.students.filter(s=>s.id!==(st?.id||'')).map(s=>`<option value="${s.id}" ${(st?.pairedWith||'')=== s.id?'selected':''}>${esc(s.name)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-secondary btn-full" style="margin-top:8px"
          onclick="App.findMatchForForm()">${ico('search', 14)} ${esc(t('form_find_match'))}</button>
      </div>
      <div class="form-group" style="margin-top:14px">
        <label>${t('form_spacing_label')}</label>
        <select id="st-spacing">
          <option value="" ${!st?.spacing?'selected':''}>${t('form_spacing_auto')}</option>
          <option value="on" ${st?.spacing==='on'?'selected':''}>${t('form_spacing_on')}</option>
          <option value="off" ${st?.spacing==='off'?'selected':''}>${t('form_spacing_off')}</option>
        </select>
      </div>
      <div class="form-group" style="margin-top:14px">
        <label>${t('student_notes_label')}</label>
        <textarea id="st-notes" placeholder="${t('form_notes_placeholder')}">${esc(st?.notes||'')}</textarea>
      </div>
      <div class="form-group" style="margin-top:14px">
        <label for="st-price">${t('pay_price_label')}</label>
        <input type="number" id="st-price" inputmode="decimal" min="0" max="1000" step="0.5" value="${st?.price || ''}" placeholder="${esc(t('pay_price_ph'))}">
      </div>
      </details>
    `;
  },

  initStudentFormEvents(st){
    this.toggleGroupField();
    // Reset any picked-but-unsaved coord from a previous drawer session before
    // seeding the inline map from this student's actual saved location.
    this._addrPendingCoord = null;
    this._locStudent = st || null;   // the map is built only when it is asked for
    // Someone with a known position: the map shows it straight away.
    if(st && Scheduler.validCoord(state.coords[st.id]) && this._googleMapsApiKey())
      setTimeout(() => this._openLocMap('st-loc-wrap', () => this.toggleStudentMap()), 0);
  },

  // The map under the address: closed until wanted, built the first time it
  // is opened, from a position already picked (suggestion, GPS) if there is one.
  toggleStudentMap(){
    const wrap = document.getElementById('st-loc-wrap');
    if(!wrap) return;
    const open = wrap.style.display === 'none';
    wrap.style.display = open ? '' : 'none';
    const btn = document.getElementById('st-map-btn');
    if(btn) btn.setAttribute('aria-pressed', String(open));
    if(!open) return;
    const el = document.getElementById('st-loc-map');
    if(el && el.__google_map) setTimeout(() => google.maps.event.trigger(el.__google_map, 'resize'), 50);
    else this.initStudentLocationMap(this._locStudent);
  },

  // Inline draggable-pin map shown right in the edit form (in addition to the
  // "pick on map" button/full-screen picker) — lets you fine-tune or set the
  // exact location without leaving the drawer or knowing the address.
  initStudentLocationMap(st){
    const el = document.getElementById('st-loc-map');
    if(!el) return;
    const existing = this._addrPendingCoord || (st && state.coords[st.id]);
    const home = state.coords['home'] || {lat:38.2466, lon:21.7346};
    const start = existing || home;
    const onPin = (lat, lon)=>{
      this._addrPendingCoord = {lat, lon};
      this.reverseGeocodeIntoField(lat, lon, 'st-addr');
    };
    this._googleMapUpdate(el,{
      center:start,zoom:existing?16:13,
      markers:[{lat:start.lat,lon:start.lon,draggable:true,onDrag:p=>onPin(p.lat(),p.lng()),title:''}],
      fitBounds:[start]
    }).then(map=>{
      if(!map) return;
      map.addListener('click',e=>this._googleMapUpdate(el,{
        center:{lat:e.latLng.lat(),lon:e.latLng.lng()},zoom:16,
        markers:[{lat:e.latLng.lat(),lon:e.latLng.lng(),draggable:true,onDrag:p=>onPin(p.lat(),p.lng()),title:''}],
        fitBounds:[{lat:e.latLng.lat(),lon:e.latLng.lng()}]
      }).then(()=>onPin(e.latLng.lat(),e.latLng.lng())));
    });
  },

  // Moves the inline location-map's marker (if currently open) to match a
  // coordinate picked another way (search suggestion, full-screen map picker).
  updateStudentLocationMapMarker(coord){
    // An address was just picked: show where it is, so a wrong pin is seen
    // now and not at the door. Opening builds the map from this position.
    const w = document.getElementById('st-loc-wrap');
    if(w && w.style.display === 'none' && this._googleMapsApiKey()){ this.toggleStudentMap(); return; }
    const el = document.getElementById('st-loc-map');
    if(!el || !el.__google_map) return;   // not opened yet: it will start from this position
    this._googleMapUpdate(el,{center:coord,zoom:16,
      markers:[{lat:coord.lat,lon:coord.lon,draggable:true,title:''}],fitBounds:[coord]});
  },

  // Same inline draggable-pin map as the student form, for the tutor's own
  // home address in Settings — shown even before a coord exists (defaults to
  // Patras) so the field never looks broken/empty.
  initHomeLocationMap(){
    const el = document.getElementById('set-home-map');
    if(!el) return;
    const existing = state.coords['home'];
    const start = existing || {lat:38.2466, lon:21.7346};
    const onPin = async (lat, lon)=>{
      this.commitHomeLocation({lat, lon});
      await this.reverseGeocodeIntoField(lat, lon, 'set-home');
      // Sync the resolved display text back into the saved address too —
      // reverseGeocodeIntoField only updates the input's visible value.
      const inp = document.getElementById('set-home');
      if(inp) this.commitHomeLocation({lat, lon}, inp.value);
    };
    this._googleMapUpdate(el,{
      center:start,zoom:existing?16:13,
      markers:[{lat:start.lat,lon:start.lon,draggable:true,onDrag:p=>onPin(p.lat(),p.lng()),title:''}],
      fitBounds:[start]
    }).then(map=>{
      if(!map) return;
      map.addListener('click',e=>this._googleMapUpdate(el,{
        center:{lat:e.latLng.lat(),lon:e.latLng.lng()},zoom:16,
        markers:[{lat:e.latLng.lat(),lon:e.latLng.lng(),draggable:true,onDrag:p=>onPin(p.lat(),p.lng()),title:''}],
        fitBounds:[{lat:e.latLng.lat(),lon:e.latLng.lng()}]
      }).then(()=>onPin(e.latLng.lat(),e.latLng.lng())));
    });
  },

  updateHomeLocationMapMarker(coord){
    const el = document.getElementById('set-home-map');
    if(!el) return;
    this._googleMapUpdate(el,{center:coord,zoom:16,
      markers:[{lat:coord.lat,lon:coord.lon,draggable:true,title:''}],fitBounds:[coord]});
  },

  // Saves the home address/coord immediately, without waiting for the
  // Settings screen's own "Αποθήκευση" — picking a location (search
  // suggestion, map tap/drag, full-screen picker) is a complete action on
  // its own, not a draft that should be lost if the tab closes before the
  // rest of the form is saved.
  commitHomeLocation(coord, addressText){
    state.coords['home'] = coord;
    if(addressText != null) state.settings.homeAddress = addressText;
    // A new home location invalidates any cached routing matrix (it was
    // built around the old one) — same reset saveSettings already does.
    state.travelMatrix = null;
    state.travelMatrixPeak = null;
    state.travelMatrixOffPeak = null;
    Storage.saveCoords(state.coords);
    Storage.saveSettings(state.settings);
    this._homeAddrPendingCoord = null;
    this._openLocMap('set-home-wrap', () => this.toggleHomeMap());
    this.updateHomeLocationMapMarker(coord);
    // Surgical DOM update instead of a full renderSettings() — that would
    // rebuild the whole screen (losing scroll position/keyboard focus) just
    // to refresh this one "✓ geocoded" label.
    const statusEl = document.getElementById('set-home-geo-status');
    if(statusEl) statusEl.innerHTML = this._homeGeoStatusHtml();
  },

  _homeGeoStatusHtml(){
    const c = state.coords['home'];
    return c
      ? `<span style="color:var(--green);font-size:11px;font-weight:400;margin-left:6px">${t('settings_home_geocoded')} ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}</span>`
      : `<span style="color:var(--orange);font-size:11px;font-weight:400;margin-left:6px">${t('settings_home_not_geocoded')}</span>`;
  },

  // A bad geocode match (wrong-city same-named street, a POI that matched
  // something in an entirely different town) can silently place a student
  // dozens of km away — nothing else surfaces this until the route/map
  // visibly detours there. 40km is generous for a home-tutoring radius
  // (Patras itself is ~10km across); flag anything past that so a bad match
  // gets noticed and fixed via the map picker instead of shipping silently.
  _FAR_FROM_HOME_KM: 40,
  _farFromHomeWarning(studentId){
    const home = state.coords['home'];
    const c = state.coords[studentId];
    if(!home || !c) return '';
    const km = Scheduler.haversineKm(home, c);
    if(km <= this._FAR_FROM_HOME_KM) return '';
    return `<span style="color:var(--orange);font-size:10px" title="${tf('student_far_from_home_title',{km:Math.round(km)})}">⚠ ${Math.round(km)}km</span>`;
  },

  toggleGroupField(){
    const type = document.getElementById('st-type')?.value;
    const gf = document.getElementById('group-field');
    if(gf) gf.style.display = type==='group'?'block':'none';
  },

  toggleMergeField(){
    const freq = Number(document.getElementById('st-freq')?.value)||1;
    const mf = document.getElementById('merge-field');
    if(!mf) return;
    mf.style.display = freq>=2?'block':'none';
    if(freq>=2) mf.innerHTML = this._mergeFieldHtml(freq, null);
  },

  // For exactly 2x/week, "same day as a double lesson, or two separate
  // days?" is a genuinely binary choice — a 3-option dropdown with jargon
  // ("block", "Auto") just makes the tutor guess what those mean. 3x/week+
  // keeps the full dropdown since "same day" isn't a single well-defined
  // choice anymore (which days, how many together?).
  _mergeFieldHtml(freq, st){
    if(freq===2){
      const isMerged = st ? (st.mergeMode==='always' || (st.forceMerge && !st.mergeMode)) : false;
      return `
        <label style="font-size:13px;font-weight:500;display:block;margin-bottom:6px">${t('form_merge_2x_question')}</label>
        <select id="st-mergemode" onchange="App.toggleMergeSizeField()" style="margin-bottom:0">
          <option value="always" ${isMerged?'selected':''}>${t('form_merge_2x_sameday')}</option>
          <option value="off" ${!isMerged?'selected':''}>${t('form_merge_2x_separate')}</option>
        </select>
        <input type="hidden" id="st-mergesize" value="2">
      `;
    }
    return `
      <label style="font-size:13px;font-weight:500;display:block;margin-bottom:6px">${t('form_merge_label')}</label>
      <select id="st-mergemode" onchange="App.toggleMergeSizeField()" style="margin-bottom:0">
        <option value="off" ${!st?.mergeMode||st?.mergeMode==='off'?'selected':''}>${t('form_merge_off')}</option>
        <option value="always" ${st?.mergeMode==='always'||(st?.forceMerge&&!st?.mergeMode)?'selected':''}>${t('form_merge_always')}</option>
        <option value="auto" ${st?.mergeMode==='auto'?'selected':''}>${t('form_merge_auto')}</option>
      </select>
      <div class="settings-sub" style="margin-top:4px">${t('form_merge_auto_hint')}</div>
      <div id="merge-size-field" style="margin-top:8px;display:${(st?.mergeMode==='always'||st?.mergeMode==='auto'||(st?.forceMerge&&!st?.mergeMode))?'block':'none'}">
        <label style="font-size:12px">${t('form_max_per_block')} — <span id="st-mergesize-val">${st?.maxMergeSessions||st?.lessonsPerWeek||2}</span>× (${((st?.maxMergeSessions||st?.lessonsPerWeek||2)*(st?.lessonDuration??(state.settings.defaultLessonDuration||60)))}${t('unit_min')})</label>
        <input type="range" id="st-mergesize" min="2" max="${st?.lessonsPerWeek||5}" step="1" value="${st?.maxMergeSessions||st?.lessonsPerWeek||2}"
          style="width:100%;accent-color:var(--green)"
          oninput="document.getElementById('st-mergesize-val').textContent=this.value; App._updateMergeSizeLabel()">
        <div class="settings-sub" style="margin-top:2px">${t('form_max_per_block_hint')}</div>
      </div>
    `;
  },

  toggleMergeSizeField(){
    const mode = document.getElementById('st-mergemode')?.value;
    const mf = document.getElementById('merge-size-field');
    if(mf) mf.style.display = (mode==='always'||mode==='auto')?'block':'none';
  },

  _updateMergeSizeLabel(){
    const n = Number(document.getElementById('st-mergesize')?.value)||2;
    const dur = Number(document.getElementById('st-dur')?.value)||60;
    const lbl = document.querySelector('#merge-size-field label');
    if(lbl) lbl.innerHTML = `${t('form_max_per_block')} — <span id="st-mergesize-val">${n}</span>× (${n*dur}${t('unit_min')})`;
  },

  _addrTimer: null,
  _addrPendingCoord: null,
  _jobAddrPendingCoord: null,

  /**
   * Addresses already in the app, matched locally.
   *
   * Someone with twenty clients has them in three or four neighbourhoods, and
   * types the same streets over and over. Those answers are already on the
   * device, already geocoded and already correct — waiting half a second for
   * a server to say what we know is pure latency. These appear instantly, on
   * the first keystroke, before any request is made.
   */
  _knownAddresses(val){
    const needle = normalizeSearchText(val.trim());
    if(!needle) return [];
    const seen = new Set(), out = [];
    const consider = (address, label, id) => {
      if(!address) return;
      const key = normalizeSearchText(address);
      if(seen.has(key)) return;
      if(!key.includes(needle)) return;
      const c = state.coords && state.coords[id];
      seen.add(key);
      out.push({ name: address, _known: true, _label: label,
                 lat: c && c.lat, lon: c && c.lon });
    };
    consider(state.settings.homeAddress, t('settings_home_address'), 'home');
    for(const st of state.students) consider(st.address, st.name, st.id);
    for(const j of (state.jobs || [])) consider(j.address, j.name, j.id);
    return out.slice(0, 4);
  },

  // A Google Maps link pasted into an address field. Full links carry the
  // position (".../@38.2466,21.7346,17z", "!3d38.24!4d21.73", "?q=38.24,21.73",
  // "ll=38.24,21.73"); the short "maps.app.goo.gl" ones do not, and can only
  // be opened, not read, from inside the app. Returns {lat,lon}, 'short', or null.
  parseMapsLink(text){
    const s = String(text || '').trim();
    if(!/^https?:\/\//i.test(s) || !/google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(s)) return null;
    const num = '(-?\\d{1,3}\\.\\d+)';
    const pats = [new RegExp('!3d' + num + '!4d' + num), new RegExp('@' + num + ',' + num),
                  new RegExp('[?&](?:q|query|ll|center|destination|daddr)=' + num + '(?:,|%2C)' + num, 'i')];
    for(const re of pats){
      const m = s.match(re);
      if(m){ const c = { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
        if(Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 && Scheduler.validCoord(c)) return c; }
    }
    return /maps\.app\.goo\.gl|goo\.gl\/maps/i.test(s) ? 'short' : null;
  },

  // Open Google Maps on the name or address, for the person to find the
  // place themselves and paste its link (or address) back. The app reads
  // nothing from Google: the person does the looking.
  findInGoogleMaps(addrId, nameId){
    const addr = (document.getElementById(addrId)?.value || '').trim();
    const name = (document.getElementById(nameId)?.value || '').trim();
    let q = addr || name;
    if(!q){ Toast.show(t('gmaps_type_first'), 'info'); return; }
    const town = this._homeTown();
    if(town && !normalizeSearchText(q).includes(normalizeSearchText(town))) q += ', ' + town;
    const web = 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query: q }).toString();
    Toast.show(t('gmaps_paste_hint'), 'info', 9000);
    if(this._isIOS()){ window.location.href = 'comgooglemaps://?' + new URLSearchParams({ q }).toString(); return; }
    window.open(web, '_blank', 'noopener');
  },

  onAddrInput(val, boxId='addr-suggest'){
    const link = this.parseMapsLink(val);
    if(link === 'short'){
      const b0 = document.getElementById(boxId);
      if(b0){ b0.style.display = 'block'; b0.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:var(--text2)">${esc(t('gmaps_short_link'))}</div>`; }
      return;
    }
    if(link){
      // The position is in the link; the address to show comes from it too.
      const b0 = document.getElementById(boxId);
      if(b0) b0.style.display = 'none';
      const fallback = `${link.lat.toFixed(5)}, ${link.lon.toFixed(5)}`;
      Promise.resolve(this._reverseGeocode(link.lat, link.lon)).catch(() => null)
        .then(display => this.selectAddr(display || fallback, link.lat, link.lon, boxId));
      return;
    }
    if(boxId==='addr-suggest') this._addrPendingCoord = null;
    else if(boxId==='jb-addr-suggest') this._jobAddrPendingCoord = null;
    else if(boxId==='set-home-suggest') this._homeAddrPendingCoord = null;
    else if(boxId==='ob-work-suggest') this._obWorkCoord = null;
    else this._obCoord = null;
    clearTimeout(this._addrTimer);
    const box = document.getElementById(boxId);
    if(!box) return;
    if(val.length < 3){ box.style.display='none'; return; }
    box.style.display='block';

    // Show what we already know while the network is still being asked. On a
    // street the user has visited before, this is the whole answer and the
    // request that follows never changes it.
    const known = this._knownAddresses(val);
    if(known.length) this._renderSuggestions(boxId, known, val);
    else box.innerHTML=`<div style="padding:10px 14px;font-size:12px;color:var(--text3)">${t('search_searching')}</div>`;

    // Responses can arrive out of order: type "Γούναρη", then "Γούναρη 58",
    // and if the first request is the slower one it lands last and replaces
    // the right answers with older ones. Each request carries a number and
    // only the newest may draw.
    const seq = (this._addrSeq = (this._addrSeq || 0) + 1);
    const hereKey = getHereKey();
    this._addrTimer = setTimeout(async ()=>{
      try{
        let results;
        // Google first; if it fails or finds nothing, the other sources
        // still answer rather than leaving the box empty.
        let googleResults = null;
        if(this._googleMapsApiKey()){
          try{ googleResults = await this._googlePlacesAutocomplete(val, boxId); }
          catch(e){ console.warn('Google Places failed, using the other sources:', e && e.message); }
          if(seq !== this._addrSeq) return;
          if(googleResults && googleResults.length){
            const b = document.getElementById(boxId);
            if(!b) return;
            this._renderSuggestions(boxId, googleResults.slice(0,6), val);
            return;
          }
        }
        if(hereAvailable()){
          // Both at once: autosuggest is better at partial text, geocode is
          // the one that knows buildings. Asking them in series would double
          // the wait for the case this exists to fix.
          const wantNumber = this._hasHouseNumber(val);
          // A house number means an address; without one it may be a shop's
          // name or kind, which Discover answers with the shops themselves.
          const [sugg, exact, places] = await Promise.all([
            this._searchHere(val, hereKey).catch(()=>[]),
            wantNumber ? this._geocodeHereForSuggest(val, hereKey).catch(()=>[]) : Promise.resolve([]),
            wantNumber ? Promise.resolve([]) : this._discoverHere(val, hereKey).catch(()=>[]),
          ]);
          // Building-level answers first, then the rest, with duplicates of
          // the same address dropped.
          const seenAddr = new Set();
          results = [...(exact||[]), ...(places||[]), ...(sugg||[])].filter(r=>{
            const k = normalizeSearchText(r.name||'');
            if(!k || seenAddr.has(k)) return false;
            seenAddr.add(k); return true;
          });
          // HERE knows the street but not the number: ask Google, once, for
          // the building. Its answer goes first; its wording is shown here
          // and never saved (see selectAddr).
          if(wantNumber && !results.some(r => r._precise)){
            const town = this._homeTown();
            const q = val.trim() + (town && !normalizeSearchText(val).includes(normalizeSearchText(town)) ? ', ' + town : '');
            const g = await Router.geocodeGoogle(q);
            if(g && g.precise && Scheduler.validCoord(g))
              results.unshift({ name: g.label, _src: 'google', _precise: true, placeId: g.placeId,
                                _matchText: g.label + ' ' + val, lat: g.lat, lon: g.lon });
          }
          // HERE came first; only if it had nothing, the free service tries.
          if(!results.length) results = await this._searchNominatim(val).catch(()=>[]);
        } else {
          results = await this._searchNominatim(val);
        }
        if(seq !== this._addrSeq) return;
        const b = document.getElementById(boxId);
        if(!b) return;
        // Both providers can return "fuzzy" matches — typo-corrected or
        // semantically-related results that don't actually contain what was
        // typed (e.g. sharing only a couple of letters). Keep only results
        // that contain every WORD typed, accent/case-insensitive ("Ψαρων"
        // without a tonos still matches "Ψαρών" with one) — checked
        // word-by-word, not as one contiguous phrase. A multi-word query
        // ("Ψαρών 11 Ρίο") checked as a single substring would reject a
        // perfectly correct result whose formatted address has anything
        // else between those words (a postal code, "Ελλάδα", …), which is
        // normal and expected, not "the API returned something unrelated".
        //
        // Relevance is SCORED, not gated. Requiring every typed word to
        // appear was too strict for the way people actually type addresses:
        // "Ψαρών 11 Αραχωβίτικα" gets back results for the street ("Ψαρών,
        // Ρίο") and for the settlement ("Κάτω Αραχωβίτικα") as separate
        // items — no single result contains both words, so an all-words
        // filter threw away every result and showed "no results" for an
        // address that plainly exists. Instead, count how many typed words
        // each result matches and rank by that; only results matching
        // nothing at all are dropped. Numbers count toward the score but
        // never gate a result, since a geocoder often has the street
        // without that exact house number.
        const needleWords = normalizeSearchText(val.trim()).split(/\s+/).filter(Boolean);
        if(results && results.length && needleWords.length){
          results.forEach(res=>{
            const hay = normalizeSearchText([res._matchText, res.name, res.poiName].filter(Boolean).join(' '));
            // A number must match as a whole token. As a substring, "58"
            // scores a point against the postcode 26558 — so a result on the
            // wrong street outranks the right one because its postcode
            // happens to contain the digits.
            res._score = needleWords.reduce((n,w)=>{
              const hit = /^\d+$/.test(w)
                ? new RegExp('(^|[^0-9])' + w + '([^0-9]|$)').test(hay)
                : hay.includes(w);
              return n + (hit ? 1 : 0);
            }, 0);
            // A shop HERE found for this kind of business matches by its
            // category, not by the words in its name.
            if(res._place && res._score === 0) res._score = 1;
          });
          const anyMatched = results.some(res=>res._score>0);
          if(anyMatched) results = results.filter(res=>res._score>0);
        }
        if(!results || results.length===0){
          b.innerHTML=`<div style="padding:10px 14px;font-size:12px;color:var(--text3)">${t('search_no_results')}</div>`;
          return;
        }
        // Rank: most typed words matched first, then closest to home — the
        // right match is usually the nearby one, not a same-named street in
        // another city.
        const home = state.coords && state.coords['home'];
        results.forEach(res=>{
          res._distKm = home ? Scheduler.haversineKm(res, home) : null;
        });
        results.sort((a,b)=>{
          const ds = (b._score||0) - (a._score||0);
          if(ds !== 0) return ds;
          // Between two equally relevant answers, the one that resolved to a
          // building beats the one that stopped at the street. Concatenation
          // order does not decide this — the sort does, and a tie used to
          // fall through to distance, which is unrelated to precision.
          const dp = (b._precise?1:0) - (a._precise?1:0);
          if(dp !== 0) return dp;
          if(a._distKm==null || b._distKm==null) return 0;
          return a._distKm - b._distKm;
        });
        const shown = results.slice(0,6);
        // Results are looked up by index from this closure array at selection
        // time — NOT embedded into inline onclick/ontouchstart attribute
        // strings. A place name containing a quote character (real addresses
        // do: "Ο Καφές" etc.) would silently corrupt an inline handler
        // string, breaking the attribute (and the tap) with no visible error.
        this._renderSuggestions(boxId, shown, val);
      }catch(e){
        if(seq !== this._addrSeq) return;
        console.warn('Address search failed:', e);
        const b = document.getElementById(boxId);
        if(b) b.innerHTML=`<div style="padding:10px 14px;font-size:12px;color:var(--red)">${t('search_error')}</div>`;
      }
    }, 400);
  },

  /**
   * Draw a list of suggestions. One implementation for both sources: the
   * addresses already on the device and the ones a server sent back. Two
   * renderers would drift, and the local list is the one shown first.
   */
  _renderSuggestions(boxId, shown, val){
    const b = document.getElementById(boxId);
    if(!b) return;
    b.style.display = 'block';
    b._suggestResults = shown;
    b._activeIdx = -1;
    {
      b.innerHTML = shown.map((res, i)=>{
          // Named places (shops, cafes, landmarks — e.g. searching "Starbucks" instead of
          // a street address) show their actual name as the headline, with the full
          // address as context underneath, instead of a raw address fragment.
          let short = res.poiName || res.name.split(',').slice(0,3).join(',');
          if(!res._precise && !res._place && !res._known && this._hasHouseNumber(val || '')) short = this._keepTypedNumber(short, val);
          // A known address says whose it is instead of how far it is: "you
          // already go here, for Νίκος" is the useful fact, and it needs no
          // network to know.
          const streetOnly = !res._precise && !res._place && !res._known && this._hasHouseNumber(val || '');
          const precise = res._category ? `<span style="color:var(--text2);font-weight:600">${esc(res._category)}</span> · `
            : res._precise ? `<span style="color:var(--green);font-weight:600">${t('addr_exact')}</span> · `
            : streetOnly ? `<span style="color:var(--orange);font-weight:600">${esc(t('addr_street_only'))}</span> · ` : '';
          const distTag = res._known
            ? `<span style="color:var(--purple,#7c3aed);font-weight:600">${esc(res._label||'')}</span> · `
            : (res._distKm!=null ? `<span style="color:var(--green);font-weight:600">${res._distKm<1?Math.round(res._distKm*1000)+t('unit_meter'):res._distKm.toFixed(1)+t('unit_km')}</span> · ` : '');
          return `<div class="addr-suggest-item" data-idx="${i}" style="padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);line-height:1.4">
            <div style="font-weight:500;color:var(--text)">${esc(short)}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${precise}${distTag}${esc(res.name)}</div>
          </div>`;
        }).join('');
        // One delegated listener pair per box (bound once, reused across
        // re-renders via the _suggestResults closure above) using Pointer
        // Events — a single unified model for mouse/touch/pen, avoiding the
        // classic "input blur hides the list before the click registers"
        // race that separate onmousedown/ontouchstart/onclick handling is
        // prone to. Selection happens on pointerUP, not pointerdown, and
        // NEVER calls preventDefault — calling it on pointerdown blocked
        // native touch scrolling inside this list entirely (a real
        // regression from an earlier fix: taps worked, but you could no
        // longer scroll down to see more suggestions on a phone). Instead,
        // a genuine tap vs. a scroll/drag is told apart by how far the
        // finger moved between down and up — small movement selects,
        // anything more is treated as scrolling and ignored.
        if(!b._suggestBound){
          b._suggestBound = true;
          let downX=0, downY=0, downItem=null;
          b.addEventListener('pointerdown', (e)=>{
            downX=e.clientX; downY=e.clientY;
            downItem = e.target.closest('.addr-suggest-item');
          });
          b.addEventListener('pointerup', (e)=>{
            if(!downItem) return;
            const dx=e.clientX-downX, dy=e.clientY-downY;
            if(Math.hypot(dx,dy) > 10) return; // moved too far — a scroll, not a tap
            const item = e.target.closest('.addr-suggest-item');
            if(item !== downItem) return; // finger drifted onto a different row
            const res = b._suggestResults && b._suggestResults[Number(item.dataset.idx)];
            if(!res) return;
            App.selectAddr(res.name, res.lat, res.lon, boxId, res);
          });
        }
    }
  },

  /**
   * Arrow keys and Enter, the way every search box works.
   *
   * Without this the list can only be tapped, which on a laptop means leaving
   * the keyboard mid-address to reach for the mouse — the single thing that
   * makes a suggestion list feel unlike the one people are used to.
   */
  onAddrKey(ev, boxId='addr-suggest'){
    const b = document.getElementById(boxId);
    const list = b && b._suggestResults;
    if(!b || !list || !list.length || b.style.display === 'none') return;
    const key = ev.key;
    if(key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter' && key !== 'Escape') return;

    if(key === 'Escape'){ b.style.display = 'none'; return; }
    if(key === 'Enter'){
      // Enter with nothing highlighted means "I typed it myself, take it" —
      // hijacking that would overwrite what the user deliberately wrote.
      if(b._activeIdx == null || b._activeIdx < 0) return;
      ev.preventDefault();
      const res = list[b._activeIdx];
      if(res) App.selectAddr(res.name, res.lat, res.lon, boxId, res);
      return;
    }
    ev.preventDefault();
    const step = key === 'ArrowDown' ? 1 : -1;
    const n = list.length;
    // Wraps, so holding one arrow never dead-ends.
    b._activeIdx = ((b._activeIdx == null ? -1 : b._activeIdx) + step + n + 1) % (n + 1) - 1;
    if(b._activeIdx < 0) b._activeIdx = step === 1 ? 0 : n - 1;
    [...b.querySelectorAll('.addr-suggest-item')].forEach((el, i)=>{
      const on = i === b._activeIdx;
      el.style.background = on ? 'var(--bg3)' : '';
      if(on && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  },

  // HERE Autosuggest — used when the user has set a HERE API key (Settings > Maps &
  // Routing), for Google-grade business/POI name matching. Falls back to Nominatim
  // (free, no key needed) when no key is configured — see _searchNominatim below.
  // Both providers format their own display string in whatever order suits
  // them (HERE and Nominatim don't agree with each other, let alone with
  // what a tutor here actually wants). Build the display text ourselves, in
  // a fixed order — street, number, area, city, postal code — from each
  // provider's structured address fields instead of using their raw label.
  _formatAddressOrdered(street, houseNumber, area, city, postalCode){
    const streetPart = [street, houseNumber].filter(Boolean).join(' ');
    return [streetPart, area, city, postalCode].filter(Boolean).join(', ');
  },

  /** Does what was typed name a house number at all? */
  _hasHouseNumber(val){
    return /[^\s\d]\s+\d+[α-ωΑ-Ωa-zA-Z]?(?![0-9])/.test(String(val||'').trim());
  },

  /**
   * HERE's geocode endpoint, which resolves to the building.
   *
   * Autosuggest is built for partial queries and very often answers at street
   * level — it is trying to complete what you are typing, not to pin a
   * doorway. So when the text already contains a house number, ask the
   * endpoint whose job is exactly that, and put its answers first.
   */
  async _geocodeHereForSuggest(val, key){
    const q = val.trim();
    const url = key
      ? `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(q)}&limit=4&lang=${Router._geoLang()}&apiKey=${key}`
      : apiUrl('/here/geocode', { q, limit: '4', lang: Router._geoLang() });
    if(!url) return [];
    const r = await Router._fetch(url);
    if(!r.ok) return [];
    const d = await r.json();
    return (d.items||[]).filter(it=>it.position).map(it=>{
      const a = it.address || {};
      const ordered = this._formatAddressOrdered(a.street, a.houseNumber, a.district, a.city, a.postalCode);
      return { name: ordered || a.label || it.title || '', poiName: it.title,
        _matchText: [a.label, a.street, a.houseNumber, a.district, a.city, a.postalCode].filter(Boolean).join(' '),
        _precise: !!a.houseNumber,
        lat: it.position.lat, lon: it.position.lng };
    });
  },

  async _searchHere(val, key){
    const home = (state.coords && state.coords['home']) || {lat:38.2466, lon:21.7346};
    const q = encodeURIComponent(val.trim());
    const url = key
      ? `https://autosuggest.search.hereapi.com/v1/autosuggest?q=${q}&at=${home.lat},${home.lon}&limit=8&lang=${Router._geoLang()}&apiKey=${key}`
      : apiUrl('/here/autosuggest', { q: decodeURIComponent(q), at: `${home.lat},${home.lon}`,
                                      limit: '8', lang: Router._geoLang() });
    if(!url) return;
    const r = await Router._fetch(url);
    if(!r.ok) throw new Error(`HERE Autosuggest ${r.status}`);
    const d = await r.json();
    const items = (d.items||[]).filter(it=>it.position); // skip query-refinement items with no coordinates
    return items.map(it=>{
      const a = it.address || {};
      const ordered = this._formatAddressOrdered(a.street, a.houseNumber, a.district, a.city, a.postalCode);
      // A named place (shop, café, landmark) keeps its title in front — "Starbucks,
      // <ordered address>" — since that's what the tutor searched for, not the raw street.
      const name = ordered || a.label || it.title || '';
      const withTitle = (it.title && !name.startsWith(it.title)) ? `${it.title}, ${name}` : name;
      // Keep the provider's own full label (plus every address field) purely
      // for relevance matching. The displayed `name` is deliberately trimmed
      // to a fixed field order, which drops context the user may well have
      // typed — HERE puts a settlement like "Αραχωβίτικα" in county/
      // subdistrict, not in `district`, so matching against the trimmed
      // string alone would reject a result the user explicitly asked for.
      const matchText = [a.label, a.street, a.houseNumber, a.district, a.subdistrict,
        a.city, a.county, a.state, a.postalCode, it.title].filter(Boolean).join(' ');
      return { name: withTitle, poiName: it.title, _matchText: matchText,
               _precise: !!a.houseNumber, lat: it.position.lat, lon: it.position.lng };
    });
  },

  // HERE Discover: places by NAME or KIND ("φανοποιείο", "Κομμωτήριο Μαρία"),
  // nearest first. Autosuggest answers a kind with a "search for…" item that
  // has no position; Discover answers with the actual shops. Their category
  // names go into the match text, and they are marked as places so the word
  // filter below does not throw out "Car Body Νικολάου" for "φανοποιείο".
  async _discoverHere(val, key){
    const home = (state.coords && state.coords['home']) || {lat:38.2466, lon:21.7346};
    const params = { q: val.trim(), at: `${home.lat},${home.lon}`, limit: '8', lang: Router._geoLang() };
    const url = key
      ? 'https://discover.search.hereapi.com/v1/discover?' + new URLSearchParams({ ...params, apiKey: key }).toString()
      : apiUrl('/here/discover', params);
    if(!url) return [];
    const r = await Router._fetch(url);
    if(!r.ok) throw new Error(`HERE Discover ${r.status}`);
    const d = await r.json();
    return (d.items || []).filter(it => it.position).map(it => {
      const a = it.address || {};
      const ordered = this._formatAddressOrdered(a.street, a.houseNumber, a.district, a.city, a.postalCode);
      const addr = ordered || a.label || '';
      const cats = (it.categories || []).map(c => c.name).filter(Boolean);
      return { name: it.title && !addr.startsWith(it.title) ? `${it.title}, ${addr}` : addr,
               poiName: it.title, _place: true, _category: cats[0] || '',
               _matchText: [it.title, a.label, ...cats].filter(Boolean).join(' '),
               _precise: !!a.houseNumber, lat: it.position.lat, lon: it.position.lng };
    });
  },

  async _searchNominatim(val){
    // Search the raw text as typed, worldwide — no country restriction, only
    // a soft bias toward the tutor's home area via the viewbox param (falls
    // through to an unbounded retry below when nothing matches nearby, e.g.
    // the student genuinely lives outside that area or in another country).
    const q = encodeURIComponent(val.trim());
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=8&addressdetails=1&namedetails=1${Router._viewboxParam()}`;
    const r = await Router._fetch(url, {headers:{'Accept-Language':Router._geoLang()}});
    if(!r.ok) throw new Error(`Nominatim ${r.status}`);
    let results = await r.json();
    if((!Array.isArray(results) || results.length===0) && Router._viewboxParam()){
      const url2 = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=8&addressdetails=1&namedetails=1`;
      const r2 = await Router._fetch(url2, {headers:{'Accept-Language':Router._geoLang()}});
      if(r2.ok) results = await r2.json();
    }
    if(!Array.isArray(results)) results = [];
    return results.map(res=>{
      const a = res.address || {};
      const street = a.road || a.pedestrian || a.footway || '';
      const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
      const city = a.city || a.town || a.village || a.municipality || '';
      const ordered = this._formatAddressOrdered(street, a.house_number, area, city, a.postcode);
      return {
        name: ordered || res.display_name,
        poiName: res.namedetails && res.namedetails.name,
        // Full unfiltered text for relevance matching only — see the same
        // note in _searchHere above.
        _matchText: [res.display_name, (res.namedetails && res.namedetails.name)].filter(Boolean).join(' '),
        lat: parseFloat(res.lat), lon: parseFloat(res.lon)
      };
    });
  },

  /**
   * The house number the user typed, if the chosen result dropped it.
   *
   * Greek house numbers are sparsely mapped: Nominatim usually knows the
   * street and not the building, and HERE's autosuggest often answers at
   * street level too. Both then return an address with no number in it — and
   * saving that verbatim silently deletes the "58" the user typed, leaving
   * "Γούναρη, Πάτρα" and a coordinate somewhere along the street.
   *
   * The number is kept, on the street it was typed against. The coordinate is
   * still the provider's (we have nothing better), but the address the user
   * reads, sends to a client and navigates to is the one they meant.
   */
  _keepTypedNumber(chosen, typed){
    const t = String(typed || '').trim();
    if(!t) return chosen;
    // "Γούναρη 58" → street "Γούναρη", number "58". Only a number that FOLLOWS
    // a word: "58 Γούναρη" is not how addresses are written here, and a lone
    // number is not an address at all.
    // (?![0-9]) rather than \b: \b is an ASCII word boundary, so a Greek
    // suffix letter is not a word character and "12α" was being cut to "12".
    const m = t.match(/^(.*?[^\s\d])\s+(\d+[α-ωΑ-Ωa-zA-Z]?)(?![0-9])/);
    if(!m) return chosen;
    const street = normalizeSearchText(m[1]).trim(), number = m[2];
    const got = normalizeSearchText(chosen);
    // Already there? Then the provider knew the building and nothing is needed.
    if(new RegExp('(^|[^0-9])' + number.toLowerCase() + '([^0-9]|$)').test(got)) return chosen;
    // Only if this really is the street that was typed — otherwise we would be
    // stapling a number onto somewhere else entirely.
    if(!street || !got.includes(street)) return chosen;
    const parts = chosen.split(',');
    parts[0] = parts[0].trim() + ' ' + number;
    return parts.join(',');
  },

  async selectAddr(name, lat, lon, boxId='addr-suggest', res=null){
    if(res && res._googlePlaceId){
      const details = await this._googlePlacesPlaceDetails(res._googlePlaceId, boxId);
      if(details){
        name = details.formattedAddress || name;
        lat = details.lat;
        lon = details.lon;
        res = {...res, _googleDetails:details};
      }
    }
    let coord = {lat:parseFloat(lat), lon:parseFloat(lon)};
    if(res && res._googleDetails){
      coord = {
        ...coord,
        src:'google',
        placeId:res._googleDetails.placeId,
        formattedAddress:res._googleDetails.formattedAddress,
        at:Date.now()
      };
    }
    // The name is already built in the fixed street/number/area/city/postal-
    // code order (_formatAddressOrdered) — saved as-is, not truncated to the
    // first 3 comma-parts like before, which would have silently dropped the
    // postal code off the end.
    const typedIn = { 'ob-addr-suggest':'ob-addr', 'ob-work-suggest':'ob-work', 'set-home-suggest':'set-home', 'jb-addr-suggest':'jb-addr' }[boxId] || 'st-addr';
    const typed = document.getElementById(typedIn)?.value || '';
    let short = this._keepTypedNumber(name.trim(), typed);
    if(res && res._src === 'google'){
      // Google's wording is not ours to keep: the field keeps what the person
      // typed. Its position is kept with its date and place id, to be asked
      // again within 30 days (refreshGoogleCoords) or dropped.
      short = typed.trim() || short;
      coord = { ...coord, src: 'google', placeId: res.placeId || '', at: Date.now() };
    } else if(res && this._hasHouseNumber(typed) && !res._precise && !res._place && !res._known){
      // The street is right, the building is not known: the pin stands on the street.
      coord.approx = true;
    }
    if(boxId==='ob-addr-suggest'){
      const inp = document.getElementById('ob-addr');
      if(inp) inp.value = short;
      this._obCoord = coord;
    } else if(boxId==='ob-work-suggest'){
      const inp = document.getElementById('ob-work');
      if(inp) inp.value = short;
      this._obWorkCoord = coord;
    } else if(boxId==='set-home-suggest'){
      const inp = document.getElementById('set-home');
      if(inp) inp.value = short;
      // Saved immediately — picking an address is a complete action, not a
      // draft waiting on the rest of the Settings form's own Save button.
      // Updates the inline map marker in place (no full re-render, so
      // scroll position/keyboard focus aren't disturbed).
      this.commitHomeLocation(coord, short);
      Toast.show(t('toast_home_location_saved'), 'success');
    } else if(boxId==='jb-addr-suggest'){
      const inp = document.getElementById('jb-addr');
      if(inp) inp.value = short;
      this._jobAddrPendingCoord = coord;
    } else {
      const inp = document.getElementById('st-addr');
      if(inp) inp.value = short;
      this._addrPendingCoord = coord;
      this.updateStudentLocationMapMarker(coord);
    }
    const box = document.getElementById(boxId);
    if(box) box.style.display='none';
  },

  hideAddrSuggest(boxId='addr-suggest'){
    const box = document.getElementById(boxId);
    if(box) box.style.display='none';
  },

  // ---- "I'm here": the phone's own position ----------------------------
  // Standing at the door is the one way to get the building exactly, with no
  // map provider's data in it at all — so this position is the person's own
  // and is kept for good. The text already in the field stays; an empty
  // field gets the address of the point.
  hereNow(inputId){
    const geo = typeof navigator !== 'undefined' && navigator.geolocation;
    if(!geo){ Toast.show(t('gps_unavailable'), 'error'); return; }
    Toast.show(t('gps_locating'), 'info', 4000);
    geo.getCurrentPosition(pos => {
      const c = { lat: pos.coords.latitude, lon: pos.coords.longitude, src: 'gps' };
      const acc = Math.round(pos.coords.accuracy || 0);
      this._applyPickedCoord(inputId, c);
      Toast.show(tf(acc > 60 ? 'gps_rough' : 'gps_ok', { m: acc }), acc > 60 ? 'info' : 'success', 7000);
    }, err => Toast.show(t(err && err.code === 1 ? 'gps_denied' : 'gps_failed'), 'error', 8000),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  },

  _applyPickedCoord(inputId, c){
    const input = document.getElementById(inputId);
    const typed = input ? String(input.value || '').trim() : '';
    const fill = (text) => {
      if(input) input.value = text;
      if(inputId === 'set-home') this.commitHomeLocation(c, text);
      else if(inputId === 'jb-addr') this._jobAddrPendingCoord = c;
      else if(inputId === 'ob-addr') this._obCoord = c;
      else if(inputId === 'ob-work') this._obWorkCoord = c;
      else { this._addrPendingCoord = c; this.updateStudentLocationMapMarker(c); }
    };
    if(typed) return fill(typed);
    return Promise.resolve(this._reverseGeocode(c.lat, c.lon)).catch(() => null)
      .then(d => fill(d ? d.split(',').slice(0, 3).join(',').trim() : `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`));
  },

  // A short note beside a client or a job whose position is not the building:
  // on the street (approx), or Google's for now (expires). Both go away when
  // the person sets it themselves — "I'm here", the pin, or a pasted link.
  _locationNote(id){
    const c = state.coords && state.coords[id];
    if(!c) return '';
    if(c.approx) return `<span style="color:var(--orange);font-size:10px;font-weight:600" title="${esc(t('loc_fix_hint'))}">⚠ ${esc(t('loc_approx'))}</span>`;
    if(c.src === 'google') return `<span style="color:var(--text3);font-size:10px;font-weight:600" title="${esc(t('loc_fix_hint'))}">${ico('clock', 10)} ${esc(t('loc_temp'))}</span>`;
    return '';
  },

  // Google positions may be kept 30 days. Past 28 they are asked again by
  // place id; one that cannot be renewed by day 30 is deleted, and the
  // ordinary lookup (HERE) finds the street again when it is next needed.
  GOOGLE_RENEW_DAYS: 28,
  GOOGLE_KEEP_DAYS: 30,
  async refreshGoogleCoords(now){
    const t0 = now || Date.now(), day = 86400000;
    let changed = false;
    for(const [id, c] of Object.entries(state.coords || {})){
      if(!c || c.src !== 'google') continue;
      const age = t0 - (Number(c.at) || 0);
      if(age < this.GOOGLE_RENEW_DAYS * day) continue;
      const g = await Router.googlePlace(c.placeId);
      if(g && Scheduler.validCoord(g)){
        state.coords[id] = { lat: g.lat, lon: g.lon, src: 'google', placeId: g.placeId || c.placeId, at: t0 };
        changed = true;
      } else if(age >= this.GOOGLE_KEEP_DAYS * day){
        delete state.coords[id];
        changed = true;
      }
    }
    if(changed) Storage.saveCoords(state.coords);
    return changed;
  },

  // ---- MAP PICKER (drop a pin instead of typing an address/name) ----
  _mapPickerTarget: null,
  _mapPickerCoord: null,
  _mapPickerTimer: null,

  openMapPicker(targetId){
    this._mapPickerTarget = targetId;
    const input = document.getElementById(targetId);
    const overlay = document.getElementById('map-picker-overlay');
    document.getElementById('map-picker-title').textContent = t('form_pick_on_map');
    document.getElementById('map-picker-confirm-label').textContent = t('form_pick_confirm');
    document.getElementById('map-picker-address').textContent = t('search_searching');
    overlay.style.display = 'flex';

    const startC = state.coords['home'] || {lat:38.2466, lon:21.7346}; // Πάτρα fallback
    setTimeout(()=>{
      const el = document.getElementById('map-picker-map');
      if(!el) return;
      const onMove = (lat,lon)=>{
        this._mapPickerCoord = {lat,lon};
        clearTimeout(this._mapPickerTimer);
        const addrBox = document.getElementById('map-picker-address');
        if(addrBox) addrBox.textContent = t('search_searching');
        this._mapPickerTimer = setTimeout(()=>this.reverseGeocodePreview(lat,lon), 500);
      };
      this._googleMapUpdate(el,{
        center:startC,zoom:15,
        markers:[{lat:startC.lat,lon:startC.lon,draggable:true,
          onDrag:p=>onMove(p.lat(),p.lng()),title:''}],
        fitBounds:[startC]
      }).then(map=>{
        if(!map) return;
        onMove(startC.lat,startC.lon);
        map.addListener('click',e=>{
          const lat=e.latLng.lat(),lon=e.latLng.lng();
          this._googleMapUpdate(el,{center:{lat,lon},zoom:map.getZoom()||15,
            markers:[{lat,lon,draggable:true,onDrag:p=>onMove(p.lat(),p.lng()),title:''}],
            fitBounds:[{lat,lon}]}).then(()=>onMove(lat,lon));
        });
      });
    }, 30);
  },

  // Reverse-geocode with Google when configured; HERE/Nominatim remain only as
  // offline fallbacks for deployments that have not supplied a Google key.
  async _reverseGeocode(lat, lon){
    if(this._googleMapsApiKey()){
      try{
        const googleMaps = await this._ensureGoogleMapsReady();
        const res = await new googleMaps.Geocoder().geocode({location:{lat,lng:lon}});
        if(res.results?.length) return res.results[0].formatted_address || null;
      }catch(e){}
    }
    const hereKey = getHereKey();
    if(hereAvailable()){
      const url = hereKey
        ? `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${lat},${lon}&lang=${Router._geoLang()}&apiKey=${hereKey}`
        : apiUrl('/here/revgeocode', { at: `${lat},${lon}`, lang: Router._geoLang() });
      if(!url) throw new Error('no reverse geocoder configured');
      const r = await Router._fetch(url);
      if(!r.ok) throw new Error(`HERE reverse ${r.status}`);
      const d = await r.json();
      const item = d.items && d.items[0];
      if(!item) return null;
      const a = item.address || {};
      return this._formatAddressOrdered(a.street, a.houseNumber, a.district, a.city, a.postalCode) || (a.label || item.title);
    }
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18`;
    const r = await Router._fetch(url, {headers:{'Accept-Language':Router._geoLang(),'User-Agent':'RoutePal/1.0'}});
    const d = await r.json();
    if(!d) return null;
    const a = d.address || {};
    const street = a.road || a.pedestrian || a.footway || '';
    const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
    const city = a.city || a.town || a.village || a.municipality || '';
    return this._formatAddressOrdered(street, a.house_number, area, city, a.postcode) || d.display_name;
  },

  async reverseGeocodePreview(lat, lon){
    const addrBox = document.getElementById('map-picker-address');
    try{
      const display = await this._reverseGeocode(lat, lon);
      if(addrBox) addrBox.textContent = display ? display.split(',').slice(0,4).join(',') : t('search_no_results');
      this._mapPickerAddress = display;
    }catch(e){
      if(addrBox) addrBox.textContent = t('search_error');
    }
  },

  // Drops the reverse-geocoded short address directly into a text input (used by
  // the inline location map's drag/click pin) instead of a separate preview box.
  async reverseGeocodeIntoField(lat, lon, inputId){
    const input = document.getElementById(inputId);
    try{
      const display = await this._reverseGeocode(lat, lon);
      if(input && display) input.value = display.split(',').slice(0,3).join(',').trim();
    }catch(e){ /* keep whatever the user had typed */ }
  },

  closeMapPicker(){
    const overlay = document.getElementById('map-picker-overlay');
    if(overlay) overlay.style.display = 'none';
    const el = document.getElementById('map-picker-map');
    if(el && el.__google_markers) el.__google_markers.forEach(marker=>marker.setMap(null));
    el && (el.__google_markers=[]);
    this._mapPickerTarget = null;
    this._mapPickerCoord = null;
  },

  confirmMapPicker(){
    if(!this._mapPickerCoord){ this.closeMapPicker(); return; }
    const coord = { ...this._mapPickerCoord, src: 'pin' };
    const short = this._mapPickerAddress ? this._mapPickerAddress.split(',').slice(0,3).join(',').trim() : `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`;
    const input = document.getElementById(this._mapPickerTarget);
    if(input) input.value = short;
    if(this._mapPickerTarget === 'ob-addr') this._obCoord = coord;
    else if(this._mapPickerTarget === 'ob-work') this._obWorkCoord = coord;
    else if(this._mapPickerTarget === 'set-home') this.commitHomeLocation(coord, short);
    else if(this._mapPickerTarget === 'jb-addr') this._jobAddrPendingCoord = coord;
    else { this._addrPendingCoord = coord; this.updateStudentLocationMapMarker(coord); }
    Toast.show(t('toast_location_picked'), 'success');
    this.closeMapPicker();
  },

  onPairedChange(partnerId){
    // Just stores choice in the select; actual bidirectional save happens in saveStudent
  },

  renderAvExceptionsList(){
    const list = this._editingExceptions||[];
    if(list.length===0) return `<p style="font-size:13px;color:var(--text3);padding:4px 0">${t('form_avail_no_exceptions')}</p>`;
    return list.map((e,i)=>`
      <div class="blocked-slot">
        <div class="blocked-slot-info">
          <div class="blocked-slot-time">${e.start} – ${e.end}</div>
          <div class="blocked-slot-day">${DAYS_FULL[e.day]}</div>
        </div>
        <button class="btn-icon" type="button" onclick="App.removeAvException(${i})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`).join('');
  },

  addAvException(){
    const day = Number(document.getElementById('avex-day')?.value);
    const start = document.getElementById('avex-start')?.value;
    const end = document.getElementById('avex-end')?.value;
    if(!day || !start || !end || start>=end){ Toast.show(t('toast_avail_exception_invalid'),'error'); return; }
    this._editingExceptions = this._editingExceptions||[];
    this._editingExceptions.push({day, start, end});
    const box = document.getElementById('avail-exceptions-list');
    if(box) box.innerHTML = this.renderAvExceptionsList();
  },

  removeAvException(i){
    this._editingExceptions = (this._editingExceptions||[]).filter((_,idx)=>idx!==i);
    const box = document.getElementById('avail-exceptions-list');
    if(box) box.innerHTML = this.renderAvExceptionsList();
  },

  // Given exceptions [{day,start,end}], returns per-day {on,start,end} availability
  // by taking the working-hours window and keeping the largest free gap left after
  // removing the exception blocks (single-window schema, so only one gap can win).
  //
  // A day cut into several usable stretches keeps all of them, in av.windows.
  // It used to survive only as the largest one, and the rest were reported to
  // the user as time that would not be used. Nothing is dropped any more; the
  // second parameter remains only so an old caller cannot break, and is always
  // left empty.
  computeAvailabilityFromExceptions(exceptions, dropped){
    const workDays = state.settings.workDays||[1,2,3,4,5];
    const dayHours = state.settings.dayHours||{};
    const availability = {};
    workDays.forEach(d=>{
      const dh = dayHours[d];
      // No working hours set for this day yet — nothing to build a window
      // from, so it stays off rather than inventing a default.
      if(!dh){ availability[d] = {on:false}; return; }
      const dayStart = Scheduler.toMin(dh.start), dayEnd = Scheduler.toMin(dh.end);
      const blocks = (exceptions||[]).filter(e=>Number(e.day)===d)
        .map(e=>[Scheduler.toMin(e.start), Scheduler.toMin(e.end)])
        .filter(([s,e])=>e>s)
        .sort((a,b)=>a[0]-b[0]);
      const merged = [];
      blocks.forEach(([s,e])=>{
        const cs=Math.max(s,dayStart), ce=Math.min(e,dayEnd);
        if(cs>=ce) return;
        if(merged.length && cs<=merged[merged.length-1][1]) merged[merged.length-1][1]=Math.max(merged[merged.length-1][1],ce);
        else merged.push([cs,ce]);
      });
      let cursor = dayStart;
      const gaps = [];
      merged.forEach(([s,e])=>{
        if(s>cursor) gaps.push([cursor,s]);
        cursor = Math.max(cursor,e);
      });
      if(cursor<dayEnd) gaps.push([cursor,dayEnd]);
      if(gaps.length===0){ availability[d] = {on:false}; return; }
      // Every free stretch is kept. start/end still name the largest one, so
      // any code not yet reading `windows` behaves exactly as it did.
      let best = gaps[0];
      gaps.forEach(g=>{ if((g[1]-g[0])>(best[1]-best[0])) best=g; });
      availability[d] = {
        on: true,
        start: Scheduler.minToTime(best[0]),
        end: Scheduler.minToTime(best[1]),
        windows: gaps.map(g=>[g[0], g[1]]),
      };
    });
    return availability;
  },

  // Student availability is DERIVED: computed once from their exceptions and
  // the working hours in force at the moment they were saved. Nothing ever
  // recomputed it when those hours later changed, so extending a day gained
  // nothing (everyone stayed pinned to the old window) and adding a working day
  // gained nothing at all — nobody had any availability recorded for it, so the
  // scheduler treated the whole new day as unusable.
  //
  // `days` limits the work to the days that actually changed, so every other
  // day keeps exactly the window it had. Students saved by an older build with
  // no exceptions list are left alone rather than guessed at.
  // A split shift — 09:00-13:00 and 17:00-21:00, say — is stored as the OUTER
  // hours plus an automatic break covering each gap. Blocked times are already
  // honoured by every phase and heavily tested, so a split day needs no new
  // scheduler logic at all.
  //
  // Auto breaks are tagged so that re-editing the hours replaces them without
  // touching breaks the user added by hand.
  // One "from — to" pair. A day can have several: a split shift is normal for
  // anyone who teaches mornings and evenings.
  _dayIntervalRowHtml(day, k, iv){
    return `<div class="dh-row" data-day="${day}" style="display:flex;align-items:center;gap:6px">
      <input type="time" class="dh-start" data-day="${day}" value="${esc(iv.start||'')}" style="flex:1;min-width:0">
      <span style="font-size:12px;color:var(--text3)">–</span>
      <input type="time" class="dh-end" data-day="${day}" value="${esc(iv.end||'')}" style="flex:1;min-width:0">
      ${k>0 ? `<button class="chip chip-gray" style="border:none;cursor:pointer;font-size:12px;padding:2px 7px"
        onclick="App.removeDayInterval(${day},${k})">✕</button>` : '<span style="width:26px"></span>'}
    </div>`;
  },

  addDayInterval(day){
    const box = document.getElementById('dh-rows-'+day);
    if(!box) return;
    const rows = box.querySelectorAll('.dh-row').length;
    box.insertAdjacentHTML('beforeend', this._dayIntervalRowHtml(day, rows, {start:'',end:''}));
  },

  removeDayInterval(day, k){
    const box = document.getElementById('dh-rows-'+day);
    if(!box) return;
    const rows = box.querySelectorAll('.dh-row');
    if(rows[k]) rows[k].remove();
  },

  // What the form currently shows for one day.
  readDayIntervals(day){
    const box = document.getElementById('dh-rows-'+day);
    if(!box) return [];
    return [...box.querySelectorAll('.dh-row')].map(r=>({
      start: r.querySelector('.dh-start')?.value || '',
      end:   r.querySelector('.dh-end')?.value || '',
    }));
  },

  setDayIntervals(day, intervals){
    const clean = (intervals||[])
      .filter(iv => iv && iv.start && iv.end && Scheduler.toMin(iv.end) > Scheduler.toMin(iv.start))
      .sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    state.settings.blockedSlots = (state.settings.blockedSlots||[])
      .filter(b => !(b.day===day && b.auto==='hours'));
    if(!clean.length){ delete state.settings.dayHours[day]; return []; }

    // Overlapping or touching intervals are one interval.
    const merged = [clean[0]];
    for(const iv of clean.slice(1)){
      const last = merged[merged.length-1];
      if(Scheduler.toMin(iv.start) <= Scheduler.toMin(last.end)){
        if(Scheduler.toMin(iv.end) > Scheduler.toMin(last.end)) last.end = iv.end;
      } else merged.push({...iv});
    }
    state.settings.dayHours[day] = { start: merged[0].start, end: merged[merged.length-1].end };
    for(let i=1;i<merged.length;i++){
      state.settings.blockedSlots.push({
        day, start: merged[i-1].end, end: merged[i].start,
        reason: t('hours_gap_reason'), auto: 'hours',
      });
    }
    return merged;
  },

  // Read the split back out of the two places it lives.
  dayIntervals(day){
    const dh = state.settings.dayHours && state.settings.dayHours[day];
    if(!dh) return [];
    const gaps = (state.settings.blockedSlots||[])
      .filter(b => b.day===day && b.auto==='hours')
      .sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const out = []; let cur = dh.start;
    for(const g of gaps){
      if(Scheduler.toMin(g.start) > Scheduler.toMin(cur)) out.push({start:cur, end:g.start});
      cur = g.end;
    }
    if(Scheduler.toMin(dh.end) > Scheduler.toMin(cur)) out.push({start:cur, end:dh.end});
    return out.length ? out : [{start:dh.start, end:dh.end}];
  },

  reapplyWorkingHours(days){
    if(!days || !days.length) return { students:0, days:[] };
    let changed = 0;
    for(const st of state.students){
      if(!Array.isArray(st.availabilityExceptions)) continue;
      const fresh = this.computeAvailabilityFromExceptions(st.availabilityExceptions);
      let touched = false;
      for(const d of days){
        const before = JSON.stringify((st.availability && st.availability[d]) || null);
        const after  = JSON.stringify(fresh[d] || { on:false });
        if(before !== after){
          st.availability = st.availability || {};
          st.availability[d] = fresh[d] || { on:false };
          touched = true;
        }
      }
      if(touched) changed++;
    }
    if(changed) Storage.saveStudents(state.students);
    return { students: changed, days };
  },

  // Migration helper: students saved under the old "manual per-day" picker
  // (now removed in favor of exceptions-only) still have their real
  // constraints sitting in st.availability — this converts that into the
  // equivalent exception blocks so they show up correctly (and stay
  // correct) the first time such a student is opened after the change,
  // instead of silently looking "available every day" with zero exceptions.
  computeExceptionsFromAvailability(student){
    const workDays = state.settings.workDays||[1,2,3,4,5];
    const dayHours = state.settings.dayHours||{};
    const exceptions = [];
    workDays.forEach(d=>{
      const dh = dayHours[d];
      if(!dh) return; // no teacher hours for this day — nothing to derive an exception from
      const dayStart = Scheduler.toMin(dh.start), dayEnd = Scheduler.toMin(dh.end);
      const av = student.availability && student.availability[d];
      if(!av || !av.on){
        exceptions.push({day:d, start:dh.start, end:dh.end});
        return;
      }
      const avStart = Scheduler.toMin(av.start), avEnd = Scheduler.toMin(av.end);
      if(avStart>dayStart) exceptions.push({day:d, start:dh.start, end:av.start});
      if(avEnd<dayEnd) exceptions.push({day:d, start:av.end, end:dh.end});
    });
    return exceptions;
  },

  // "120, 90" -> [120, 90]. Null when empty, or when it is one length (or all
  // the same): then the ordinary length and weekly count apply.
  parseDurations(text){
    const vals = String(text || '').split(/[,;\s+]+/).map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0);
    if(vals.length < 2) return null;
    const ok = vals.map(v => Math.round(Math.min(480, Math.max(15, v)) / 5) * 5);
    return new Set(ok).size > 1 ? ok.slice(0, 7) : null;
  },

  // Everyone marked "comes to my place" gets the workplace's address and
  // position. `moved`: the workplace itself changed, so look it up again.
  async syncWorkplace(moved){
    const addr = state.settings.workplaceAddress || '';
    const at = state.students.filter(x => x.atWorkplace);
    if(moved) delete state.coords.workplace;
    if(!addr){ for(const x of at) x.atWorkplace = false; Storage.saveStudents(state.students); return; }
    for(const x of at) x.address = addr;
    state.travelMatrix = state.travelMatrixPeak = state.travelMatrixOffPeak = null;
    Storage.saveStudents(state.students);
    let c = state.coords.workplace;
    if(!c){ try{ c = await Router.geocode(addr); }catch(e){ c = null; } }
    if(!c) return;
    state.coords.workplace = c;
    for(const x of state.students.filter(y => y.atWorkplace)) state.coords[x.id] = { ...c };
    Storage.saveCoords(state.coords);
    state._scheduleStale = true;
  },

  // ── The example ─────────────────────────────────────────────────────────
  // Eight made-up clients in two neighbourhoods and a week laid out the way
  // people do it by hand — whoever asked first, back and forth across town.
  // One tap plans it, and the before/after card shows what the app is for.
  // Nobody real: the names are plainly examples and the positions are
  // offsets from the person's own home (or a default centre).
  DEMO_CLIENTS: [
    // name key, north(+)/south(-) km, east km, times a week
    ['demo_c1',  3.4,  0.6, 2], ['demo_c2',  3.9, -0.4, 1], ['demo_c3',  3.1,  1.2, 2], ['demo_c4',  4.2,  0.3, 1],
    ['demo_c5', -2.6,  0.8, 2], ['demo_c6', -3.1, -0.5, 1], ['demo_c7', -2.2,  1.5, 1], ['demo_c8', -3.4,  0.4, 2],
  ],
  // By hand: north and south mixed on every day.
  DEMO_WEEK: { 1: [0, 4, 2], 2: [5, 1, 7], 3: [2, 6, 0], 4: [4, 3], 5: [7] },
  startDemo(){
    if(state.students.length || (state.jobs || []).length){ Toast.show(t('demo_not_empty'), 'info', 5000); return; }
    const st0 = state.settings;
    st0.demo = true;
    st0.workDays = [1, 2, 3, 4, 5];
    st0.dayHours = Object.fromEntries(st0.workDays.map(d => [d, { start: '15:00', end: '21:00' }]));
    if(!st0.homeAddress) st0.homeAddress = t('demo_home');
    const home = state.coords.home || { lat: 38.2466, lon: 21.7346 };
    state.coords.home = home;
    const availability = this.computeAvailabilityFromExceptions([]);
    const kmLat = 1 / 111.32, kmLon = 1 / (111.32 * Math.cos(home.lat * Math.PI / 180));
    state.students = this.DEMO_CLIENTS.map(([key, north, east, n], i) => {
      const id = 'demo' + (i + 1);
      state.coords[id] = { lat: home.lat + north * kmLat, lon: home.lon + east * kmLon };
      return { id, name: t(key), address: t('demo_street') + ' ' + (i + 1) + ', ' + t(north > 0 ? 'demo_area_n' : 'demo_area_s'), phone: '', subject: '',
        lessonDuration: 60, lessonsPerWeek: n, hoursPerWeek: n, type: 'solo', group: '', pairedWith: null, notes: '',
        mergeMode: 'off', forceMerge: false, availability: JSON.parse(JSON.stringify(availability)),
        availabilityMode: 'exceptions', availabilityExceptions: [], color: i % 10 };
    });
    const week = {};
    for(const d of st0.workDays){
      const slots = (this.DEMO_WEEK[d] || []).map(i => Scheduler._lessonSlot(state.students[i], 60));
      week[d] = Scheduler.relayoutDay(slots, d, state.students, st0) || [];
    }
    state.schedule = week; state._ownWeek = true; state._scheduleStale = false;
    state.travelMatrix = state.travelMatrixPeak = state.travelMatrixOffPeak = null;
    Storage.saveSettings(st0); Storage.saveStudents(state.students); Storage.saveCoords(state.coords); Storage.saveSchedule(state.schedule);
    state.scheduleDay = 1; state.weekOpen = 1;
    this.nav('schedule');
    Toast.show(t('demo_started'), 'info', 6000);
    // Plan it straight away: the point is the difference.
    setTimeout(() => { if(state.settings.demo && !state._schedulingInProgress) this.runAndNotify(); }, 1800);
  },
  // Out of the example: everything it put in goes, the person's own settings stay.
  endDemo(){
    const ids = new Set(state.students.filter(x => /^demo\d+$/.test(x.id)).map(x => x.id));
    state.students = state.students.filter(x => !ids.has(x.id));
    for(const id of ids) delete state.coords[id];
    for(const d of Object.keys(state.schedule || {})) state.schedule[d] = (state.schedule[d] || []).filter(sl => !ids.has(sl.studentId));
    if(!state.students.length) state.schedule = {};
    if(state.settings.homeAddress === t('demo_home')){ state.settings.homeAddress = ''; delete state.coords.home; }
    state.settings.demo = false;
    state.savings = { week: null, days: {} }; Storage.saveSavings(state.savings);
    state.schedulerResult = null; state.scheduleAttempts = []; state._scheduleStale = false; state._ownWeek = false;
    Storage.saveSettings(state.settings); Storage.saveStudents(state.students); Storage.saveCoords(state.coords); Storage.saveSchedule(state.schedule);
    this.nav('home');
    Toast.show(t('demo_ended'), 'success', 5000);
  },

  // Several clients at once, one per line: "name, address, times a week".
  parseClientLines(text){
    const out = [];
    for(const raw of String(text || '').split(/\r?\n/)){
      const parts = raw.split(/[,;\t]/).map(x => x.trim()).filter(Boolean);
      if(!parts.length) continue;
      let freq = 1;
      const m = parts.length > 1 && parts[parts.length - 1].match(/^(\d)\s*(x|φορ\S*|times?|fois|mal)?\.?$/i);
      if(m){ freq = Math.min(5, Math.max(1, Number(m[1]))); parts.pop(); }
      out.push({ name: parts[0], address: parts.slice(1).join(', '), freq });
    }
    return out;
  },
  openPasteClients(){
    const ov = document.createElement('div');
    ov.id = 'paste-overlay';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'paste-title');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:flex-end;justify-content:center';
    ov.innerHTML = `<div style="background:var(--bg2);width:100%;max-width:520px;border-radius:18px 18px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom))">
      <div id="paste-title" style="font-weight:700;font-size:17px;margin-bottom:6px">${esc(t('paste_title'))}</div>
      <div class="settings-sub" style="margin-bottom:10px">${esc(t('paste_hint'))}</div>
      <textarea id="paste-text" rows="7" aria-label="${esc(t('paste_title'))}" placeholder="${esc(t('paste_ph'))}" style="width:100%"></textarea>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('paste-overlay').remove()">${esc(t('btn_cancel'))}</button>
        <button class="btn btn-primary" style="flex:2" onclick="App.importClients(document.getElementById('paste-text').value)">${esc(t('paste_add'))}</button>
      </div></div>`;
    ov.addEventListener('click', (e) => { if(e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    setTimeout(() => { const x = document.getElementById('paste-text'); if(x) x.focus(); }, 50);
  },
  importClients(text){
    const rows = this.parseClientLines(text);
    const work = state.settings.workplaceAddress || '';
    const availability = this.computeAvailabilityFromExceptions([]);
    let added = 0, skipped = 0;
    for(const r of rows){
      const atWork = !r.address && !!work;
      if(!r.name || (!r.address && !atWork)){ skipped++; continue; }
      const st = { id: 's' + Date.now() + '_' + added, name: r.name, address: atWork ? work : r.address, phone: '',
        subject: '', lessonDuration: state.settings.defaultLessonDuration || 60,
        lessonsPerWeek: r.freq, hoursPerWeek: r.freq, type: 'solo', group: '', pairedWith: null, notes: '',
        mergeMode: 'off', forceMerge: false, availability: JSON.parse(JSON.stringify(availability)),
        availabilityMode: 'exceptions', availabilityExceptions: [], atWorkplace: atWork, color: state.students.length % 10 };
      state.students.push(st); added++;
      if(atWork && state.coords.workplace) state.coords[st.id] = { ...state.coords.workplace };
      else if(!atWork) Router.geocode(st.address).then(c => { if(c && state.students.includes(st)){ state.coords[st.id] = c; Storage.saveCoords(state.coords); } }).catch(() => {});
    }
    if(!added){ Toast.show(t(skipped ? 'paste_skipped' : 'paste_none').replace('{n}', skipped), 'error', 5000); return; }
    state.travelMatrix = state.travelMatrixPeak = state.travelMatrixOffPeak = null;
    Storage.saveStudents(state.students); Storage.saveCoords(state.coords);
    state._scheduleStale = true;
    document.getElementById('paste-overlay')?.remove();
    Toast.show(tf('paste_done', { n: added }) + (skipped ? ' · ' + tf('paste_skipped', { n: skipped }) : ''), 'success', 5000);
    this.renderStudents(); this.renderHome();
  },

  openCalendarImport(){
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.ics,.zip,text/calendar,application/zip'; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []); if(!files.length) return;
      // Google's export is a .zip of .ics files, one per calendar: all are read.
      const texts = [];
      for(const f of files){
        try{
          if(/\.zip$/i.test(f.name) || f.type === 'application/zip') texts.push(await CalendarImport.unzipIcs(await f.arrayBuffer()));
          else texts.push(await f.text());
        }catch(e){ console.warn('calendar file not read', f.name, e); }
      }
      this.importCalendarText(texts.join('\n'));
    };
    inp.click();
  },
  // The clients of one calendar week, and — if the week here is empty — that
  // week as the current schedule, so the first plan is measured against what
  // the person really drives today.
  importCalendarText(text, today){
    let evs;
    try{ evs = CalendarImport.events(text); }catch(e){ evs = []; }
    const wk = CalendarImport.pickWeek(evs, today);
    const groups = CalendarImport.toClients(wk.occ);
    if(!groups.length){ Toast.show(t('cal_import_none'), 'error', 6000); return { added: 0 }; }
    const known = new Map(state.students.map(st => [normalizeSearchText(st.name).replace(/\s+/g, ' ').trim(), st]));
    const work = state.settings.workplaceAddress || '';
    const availability = this.computeAvailabilityFromExceptions([]);
    let added = 0, skipped = 0;
    const week = {};
    const ownWeek = !Scheduler.countTotal(state.schedule || {});
    for(const g of groups){
      const key = normalizeSearchText(g.name).replace(/\s+/g, ' ').trim();
      let st = known.get(key);
      if(!st){
        const atWork = !g.address && !!work;
        if(!g.address && !atWork){ skipped++; continue; }
        const lens = g.slots.map(x => x.len);
        const same = lens.every(x => x === lens[0]);
        st = { id: 's' + Date.now() + '_' + added, name: g.name, address: atWork ? work : g.address, phone: g.phone || '',
          subject: '', lessonDuration: Math.max(...lens), lessonsPerWeek: lens.length, hoursPerWeek: lens.length,
          ...(same ? {} : { durations: lens.slice().sort((a, b) => b - a) }),
          type: 'solo', group: '', pairedWith: null, notes: '', mergeMode: 'off', forceMerge: false,
          availability: JSON.parse(JSON.stringify(availability)), availabilityMode: 'exceptions', availabilityExceptions: [],
          atWorkplace: atWork, color: state.students.length % 10 };
        state.students.push(st); known.set(key, st); added++;
        if(atWork && state.coords.workplace) state.coords[st.id] = { ...state.coords.workplace };
        else if(!atWork) Router.geocode(st.address).then(c => { if(c && state.students.includes(st)){ state.coords[st.id] = c; Storage.saveCoords(state.coords); } }).catch(() => {});
      }
      if(g.phone && !st.phone) st.phone = g.phone;
      for(const x of g.slots){
        (week[x.day] = week[x.day] || []).push({ ...Scheduler._lessonSlot(st, x.len), start: Scheduler.minToTime(x.start), end: Scheduler.minToTime(x.end) });
      }
    }
    // The week as it stands becomes the schedule only when there was none:
    // it is what the person drives today, the "before" of the first plan.
    if(ownWeek && Object.keys(week).length){
      for(const d of Object.keys(week)) week[d].sort((a, b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start));
      for(const d of Object.keys(week)) if(!(state.settings.workDays || []).includes(Number(d))){
        state.settings.workDays = [...(state.settings.workDays || []), Number(d)].sort((a, b) => a - b);
        const sl = week[d]; state.settings.dayHours = { ...(state.settings.dayHours || {}),
          [d]: { start: sl[0].start, end: sl[sl.length - 1].end } };
      }
      state.schedule = week; state._ownWeek = true;
      Storage.saveSchedule(state.schedule); Storage.saveSettings(state.settings);
    }
    state.travelMatrix = state.travelMatrixPeak = state.travelMatrixOffPeak = null;
    Storage.saveStudents(state.students); Storage.saveCoords(state.coords);
    state._scheduleStale = true;
    Toast.show(tf('cal_import_done', { n: added, k: wk.occ.length }) + (skipped ? ' · ' + tf('cal_import_skipped', { n: skipped }) : ''), 'success', 8000);
    if(state.currentScreen === 'students') this.renderStudents(); else if(state.currentScreen === 'home') this.renderHome();
    return { added, skipped, ownWeek: ownWeek && Object.keys(week).length > 0 };
  },

  // A sentence about a client — a change to one on the list, or a new one —
  // is never applied as heard. What was understood is shown first, in words,
  // with "Correct", "Fix" (the form, filled in) and "Cancel".
  // A draft (from the rules or from AI) to the right card: an update when it
  // names someone on the list, a new client otherwise.
  proposeDraft(draft){
    const toks = ClientCommand._words(draft.name).norm;
    const who = draft.explicit ? null : ClientCommand.findClient(toks, state.students || []);
    if(who && who.ambiguous){ Toast.show(tf('cmd_ambiguous', { names: who.ambiguous.map(x => x.name).join(', ') }), 'error', 6000); return; }
    if(who && who.len === toks.length){ draft.name = who.st.name; this.proposeClient(draft, who.st); return; }
    this.proposeClient(draft, null);
  },

  // With AI on, a sentence that looks like it is about a client is read by
  // AI first; if that fails (offline, no answer) the rules read it as before.
  // Returns true if it was handled as a client.
  async clientCommandSmart(text){
    if(AiAssist.available() && AiAssist.looksLikeClient(text)){
      if(AiAssist.on()){
        Toast.show(t('ai_reading'), 'info', 2500);
        const d = await AiAssist.draft(text);
        if(d){ this.proposeDraft(d); return true; }
      }
    }
    const handled = this.clientCommand(text);
    if(!handled && AiAssist.available() && AiAssist.looksLikeClient(text)) AiAssist.maybeAsk();
    return handled;
  },

  clientCommand(text){
    const raw = String(text || '').trim();
    if(!raw) return false;
    const N = (x) => ClientCommand._words(x).norm;
    const explicitNew = ClientCommand.NEW_WORDS.some(p => p.every((w, k) => N(raw)[k] === w));
    // Read the whole sentence once, as if it named a client: name, address,
    // length, times a week, flexible hours, subject, the times they cannot.
    let draft = null;
    try{ draft = ClientCommand.parseNew(explicitNew ? raw : 'νέος πελάτης ' + raw, getSubjects()); }catch(e){ draft = null; }
    if(!draft) return false;
    const facts = [draft.address, draft.minutes, draft.perWeek, draft.cannot.length, draft.subject, draft.flex].filter(Boolean).length;
    if(!explicitNew){
      // Someone already on the list, named by their name (or first name when
      // only one client has it) and nothing more: one fact is enough —
      // "Γιώργος 3 ώρες", "Γιώργος δεν μπορεί Τετάρτη 5 με 7".
      const toks = N(draft.name);
      const who = ClientCommand.findClient(toks, state.students || []);
      if(who && who.ambiguous){ Toast.show(tf('cmd_ambiguous', { names: who.ambiguous.map(x => x.name).join(', ') }), 'error', 6000); return true; }
      if(who && who.len === toks.length){
        if(!facts) return false;
        draft.name = who.st.name;
        this.proposeClient(draft, who.st);
        return true;
      }
      // A new client without saying so: the stricter reading (two facts, a
      // capitalised name, no errand words) decides.
      let strict = null;
      try{ strict = ClientCommand.parseNew(raw, getSubjects()); }catch(e){ strict = null; }
      if(!strict) return false;
      this.proposeClient(strict, null);
      return true;
    }
    this.proposeClient(draft, null);
    return true;
  },

  // Dictation into the new-client form: what is said fills the form in, and
  // the person checks it and saves as usual. Without speech recognition in
  // the browser, the keyboard's own microphone does the same into the name.
  formVoice(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = document.getElementById('st-mic'), heard = document.getElementById('st-heard');
    if(this._formRec){ try{ this._formRec.stop(); }catch(e){} return; }
    if(!SR){ Toast.show(t('fab_voice_none'), 'info', 5000); document.getElementById('st-name')?.focus(); return; }
    try{
      const rec = new SR();
      rec.lang = { el: 'el-GR', en: 'en-US', fr: 'fr-FR', de: 'de-DE' }[state.settings.language] || 'el-GR';
      rec.interimResults = true; rec.continuous = false;
      let said = '';
      rec.onresult = (e) => { said = Array.from(e.results).map(x => x[0].transcript).join(' ').trim(); if(heard) heard.textContent = '«' + said + '»'; };
      rec.onerror = (e) => { if(e && e.error === 'not-allowed') Toast.show(t('fab_voice_denied'), 'error', 6000); };
      rec.onend = () => { this._formRec = null; mic?.classList.remove('on'); if(said) this.fillFormFromSentenceSmart(said); };
      rec.start(); this._formRec = rec; mic?.classList.add('on');
    }catch(e){ this._formRec = null; Toast.show(t('fab_voice_none'), 'info', 5000); }
  },
  // A sentence into the open new-client form. Returns true if it understood it.
  async fillFormFromSentenceSmart(text){
    if(AiAssist.available() && AiAssist.on()){
      const heard = document.getElementById('st-heard'); if(heard) heard.textContent = '«' + text + '» · ' + t('ai_reading');
      const d = await AiAssist.draft(text);
      if(d) return this._fillFormWith(d, text);
    }
    const ok = this.fillFormFromSentence(text);
    if(AiAssist.available()) AiAssist.maybeAsk();
    return ok;
  },
  _fillFormWith(d, text){
    const st = this.clientFromDraft(d, null);
    if(!d.address && !st.atWorkplace) st.address = '';
    document.getElementById('drawer-student-body').innerHTML = this.buildStudentForm(st, text);
    this.initStudentFormEvents(null);
    state.editingStudentId = null;
    Toast.show(t('form_voice_filled'), 'success', 5000);
    return true;
  },
  fillFormFromSentence(text){
    let d = null;
    try{ d = ClientCommand.parseNew('νέος πελάτης ' + text, getSubjects()); }catch(e){ d = null; }
    if(!d){ Toast.show(t('form_voice_none'), 'error', 6000); return false; }
    const st = this.clientFromDraft(d, null);
    if(!d.address && !st.atWorkplace) st.address = '';
    document.getElementById('drawer-student-body').innerHTML = this.buildStudentForm(st, text);
    this.initStudentFormEvents(null);
    state.editingStudentId = null;
    Toast.show(t('form_voice_filled'), 'success', 5000);
    return true;
  },

  // The client a draft describes: a new one, or `base` with the draft's changes.
  clientFromDraft(draft, base){
    const st = base ? JSON.parse(JSON.stringify(base)) : {
      id: 's' + Date.now(), name: draft.name, address: '', phone: '', subject: '',
      lessonDuration: state.settings.defaultLessonDuration || 60, lessonsPerWeek: 1, hoursPerWeek: 1,
      type: 'solo', group: '', pairedWith: null, notes: '', mergeMode: 'off', forceMerge: false,
      availabilityMode: 'exceptions', availabilityExceptions: [], atWorkplace: false, color: state.students.length % 10 };
    if(draft.address){ st.address = draft.address; st.atWorkplace = false; }
    else if(!base && state.settings.workplaceAddress){ st.address = state.settings.workplaceAddress; st.atWorkplace = true; }
    if(draft.subject) st.subject = draft.subject;
    if(draft.phone) st.phone = draft.phone;
    if(draft.perWeek){ st.lessonsPerWeek = st.hoursPerWeek = draft.perWeek; }
    if(draft.minutes){
      delete st.durations;
      if(draft.flex){
        st.flexMinutes = draft.minutes; st.minBlock = Math.min(60, draft.minutes); st.maxBlock = draft.minutes;
        Scheduler.flexStart(st);
      } else { delete st.flexMinutes; st.lessonDuration = draft.minutes; }
    }
    const ex = (st.availabilityMode === 'exceptions' ? (st.availabilityExceptions || []) : this.computeExceptionsFromAvailability(st)).map(e => ({ ...e }));
    for(const c of (draft.cannot || [])) for(const d of c.days){
      const dh = (state.settings.dayHours || {})[d];
      ex.push({ day: d, start: c.start != null ? Scheduler.minToTime(c.start) : (dh ? dh.start : '00:00'),
        end: c.end != null ? Scheduler.minToTime(c.end) : (dh ? dh.end : '23:59') });
    }
    st.availabilityExceptions = ex; st.availabilityMode = 'exceptions';
    st.availability = this.computeAvailabilityFromExceptions(ex);
    return st;
  },

  // What was understood, one line per fact.
  _draftLines(draft, st, isNew){
    const L = [];
    // a change shows only what changes
    if(st.address && (isNew || draft.address)) L.push([t('cf_address'), st.atWorkplace ? t('form_at_workplace') : st.address]);
    if(draft.minutes) L.push([t('cf_length'), draft.flex ? tf('cf_flex', { h: +(draft.minutes / 60).toFixed(2), min: st.minBlock }) : tf('cf_minutes', { n: draft.minutes })]);
    if(draft.perWeek) L.push([t('cf_perweek'), tf('cf_times', { n: draft.perWeek })]);
    if(draft.subject) L.push([getLabels().session, subjectLabel(draft.subject)]);
    if(draft.phone) L.push([t('student_phone_label'), draft.phone]);
    for(const c of (draft.cannot || []))
      L.push([t('cf_cannot'), c.days.map(d => DAYS_FULL[d]).join(', ') + (c.start != null ? ' ' + Scheduler.minToTime(c.start) + '–' + Scheduler.minToTime(c.end) : ' ' + t('cf_all_day'))]);
    return L;
  },

  proposeClient(draft, base){
    const st = this.clientFromDraft(draft, base);
    this._proposal = { draft, base, st };
    const lines = this._draftLines(draft, st, !base);
    const canSave = !!st.address;
    document.getElementById('propose-overlay')?.remove();
    const ov = document.createElement('div');
    ov.id = 'propose-overlay';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'propose-title');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:flex-end;justify-content:center';
    ov.innerHTML = `<div style="background:var(--bg2);width:100%;max-width:520px;border-radius:18px 18px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom))">
      <div style="font-size:12px;font-weight:700;letter-spacing:.05em;color:var(--text3);text-transform:uppercase">${esc(t(base ? 'cf_change' : 'cf_new'))}</div>
      <div id="propose-title" style="font-weight:800;font-size:19px;margin:2px 0 10px">${esc(st.name)}</div>
      ${draft.viaAi ? `<div class="settings-sub" style="margin:-6px 0 8px">${esc(t('ai_understood'))}</div>` : ''}
      ${lines.map(([k, v]) => `<div style="display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--border);font-size:14px">
        <span style="flex:0 0 38%;color:var(--text2)">${esc(k)}</span><b style="flex:1;font-weight:600">${esc(v)}</b></div>`).join('')}
      ${!canSave ? `<p class="settings-sub" style="margin-top:8px;color:var(--orange)">${esc(t('cf_need_address'))}</p>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('propose-overlay').remove()">${esc(t('btn_cancel'))}</button>
        <button class="btn btn-secondary" style="flex:1" onclick="App.proposalFix()">${esc(t('cf_fix'))}</button>
        ${canSave ? `<button class="btn btn-primary" style="flex:1.4" onclick="App.proposalAccept()">${esc(t('cf_ok'))}</button>` : ''}
      </div></div>`;
    ov.addEventListener('click', (e) => { if(e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  },

  proposalAccept(){
    const p = this._proposal; if(!p) return;
    document.getElementById('propose-overlay')?.remove();
    this._proposal = null;
    const st = p.st;
    let before = null;
    if(p.base){
      const i = state.students.indexOf(p.base);
      before = JSON.parse(JSON.stringify(p.base));
      if(i >= 0){ Object.keys(p.base).forEach(k => delete p.base[k]); Object.assign(p.base, st); }
    } else state.students.push(st);
    const target = p.base || st;
    const moved = !p.base || (p.draft.address && before && before.address !== target.address);
    if(moved){
      delete state.coords[target.id];
      state.travelMatrix = state.travelMatrixPeak = state.travelMatrixOffPeak = null;
      if(target.atWorkplace && state.coords.workplace) state.coords[target.id] = { ...state.coords.workplace };
      else Router.geocode(target.address).then(c => {
        if(!c || !state.students.includes(target)) return;
        state.coords[target.id] = c; Storage.saveCoords(state.coords);
        if(!p.base && this.placeNewClient(target)){ state._scheduleStale = false; if(state.currentScreen === 'home') this.renderHome(); }
      }).catch(() => {});
    }
    Storage.saveStudents(state.students); Storage.saveCoords(state.coords);
    state._scheduleStale = true;
    Toast.show(tf(p.base ? 'cf_saved_change' : 'cf_saved_new', { name: target.name }), 'success', 7000, { label: t('swipe_undo'), run: () => {
      if(p.base && before){ Object.keys(p.base).forEach(k => delete p.base[k]); Object.assign(p.base, before); }
      else { state.students = state.students.filter(x => x !== st); delete state.coords[st.id]; }
      Storage.saveStudents(state.students); Storage.saveCoords(state.coords);
      if(state.currentScreen === 'home') this.renderHome(); else if(state.currentScreen === 'students') this.renderStudents(); } });
    if(state.currentScreen === 'home') this.renderHome(); else if(state.currentScreen === 'students') this.renderStudents();
  },

  // The form, filled in with what was understood; saving it is the usual save.
  proposalFix(){
    const p = this._proposal; if(!p) return;
    document.getElementById('propose-overlay')?.remove();
    this._proposal = null;
    this._restoreStudentSave();
    state.editingStudentId = p.base ? p.base.id : null;
    const L = getLabels();
    document.getElementById('drawer-student-title').textContent = `${t(p.base ? 'drawer_edit_prefix' : 'drawer_new_prefix')} ${L.client}`;
    document.getElementById('drawer-student-body').innerHTML = this.buildStudentForm(p.st);
    this.initStudentFormEvents(p.base ? p.st : null);
    document.getElementById('drawer-student-overlay').classList.add('open');
  },

  // "This one stays here": the next plan is built around a locked lesson.
  dismissLockHintQuiet(){ try{ localStorage.setItem('rp_lock_hint', '1'); }catch(e){} },
  _lockHintSeen(){ try{ return localStorage.getItem('rp_lock_hint') === '1'; }catch(e){ return true; } },
  dismissLockHint(){ try{ localStorage.setItem('rp_lock_hint', '1'); }catch(e){} if(state.currentScreen === 'schedule') this.renderSchedule(); },
  // Length of a session from the buttons; "other" opens the number field.
  // A service with a length of its own (a manicure, a lash set) sets the length
  // buttons to it. The person can still pick another.
  _serviceDur(subject){
    const m = Professions.serviceDuration(state.settings, subject);
    if(!m) return;
    const btn = Array.from(document.querySelectorAll('#st-dur-seg .seg-btn')).find(b => b.textContent.trim() === m + '′');
    if(btn) this._setDur(m, btn);
    else {
      const other = Array.from(document.querySelectorAll('#st-dur-seg .seg-btn')).pop();
      const inp = document.getElementById('st-dur-other');
      if(inp) inp.value = m;
      if(other) this._setDur(null, other);
      document.getElementById('st-dur').value = m;
    }
    Toast.show(tf('prof_service_dur', { min: m }), 'info', 2500);
  },
  _setDur(v, btn){
    document.querySelectorAll('#st-dur-seg .seg-btn').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
    btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
    const other = document.getElementById('st-dur-other');
    if(v){ document.getElementById('st-dur').value = v; if(other) other.style.display = 'none'; }
    else if(other){ other.style.display = ''; other.focus(); if(Number(other.value) > 0) document.getElementById('st-dur').value = other.value; }
  },
  toggleSlotLock(day, sid, start){
    this.dismissLockHintQuiet();
    const sl = (state.schedule[day] || []).find(x => x.studentId === sid && x.start === start);
    if(!sl) return;
    if(sl.locked) delete sl.locked; else sl.locked = true;
    Storage.saveSchedule(state.schedule);
    Toast.show(t(sl.locked ? 'lock_set' : 'lock_cleared'), 'info');
    if(state.currentScreen === 'schedule') this.renderSchedule();
  },

  // A new or changed client goes into the week as it stands, where a lesson
  // fits without moving anyone. Only what does not fit asks for a new plan.
  placeNewClient(st){
    if(!Scheduler.countTotal(state.schedule)) return false;
    const trial = JSON.parse(JSON.stringify(state.schedule));
    for(const d of (state.settings.workDays || [])) if(!trial[d]) trial[d] = [];
    let res;
    try{ res = Scheduler.placeKeeping(trial, st, state.students, state.settings); }catch(e){ return false; }
    if(!res.placed.length || res.missing) return false;
    state.schedule = trial;
    Storage.saveSchedule(state.schedule);
    Toast.show(tf('placed_keeping', { name: st.name,
      when: res.placed.map(x => DAYS_FULL[x.day] + ' ' + x.start).join(', ') }), 'success', 6000);
    return true;
  },

  saveStudent(){
    const saveBtn = document.querySelector('#drawer-student .drawer-footer .btn-primary');
    const name = document.getElementById('st-name')?.value?.trim();
    const atWork = !!(document.getElementById('st-at-work')?.checked && state.settings.workplaceAddress);
    const addr = atWork ? state.settings.workplaceAddress : document.getElementById('st-addr')?.value?.trim();
    if(!name){ Toast.show(t('toast_enter_fullname'),'error'); return }
    if(!addr){ Toast.show(t('toast_enter_address'),'error'); return }
    if(saveBtn){ saveBtn.disabled=true; saveBtn.style.opacity='0.6'; saveBtn.textContent=t('saving_ellipsis'); }

    const availabilityExceptions = this._editingExceptions||[];
    const availability = this.computeAvailabilityFromExceptions(availabilityExceptions);
    if(!Object.values(availability).some(av=>av.on)){
      // The button was already set to "Saving…": give it back, or the form is stuck.
      if(saveBtn){ saveBtn.disabled=false; saveBtn.style.opacity=''; saveBtn.textContent=t('btn_save'); }
      Toast.show(t('toast_select_day'),'error'); return
    }

    const st = {
      id: state.editingStudentId||('s'+Date.now()),
      name,
      address: addr,
      phone: document.getElementById('st-phone')?.value?.trim()||'',
      // the profession's word, the person's own words, or nothing
      subject: (() => { const v = document.getElementById('st-subject')?.value || ''; if(v !== 'Άλλο') return v;
        return document.getElementById('st-subject-own')?.value?.trim() || ''; })(),
      lessonDuration: Number(document.getElementById('st-dur')?.value)||60,
      lessonsPerWeek: Number(document.getElementById('st-freq')?.value)||2,
      hoursPerWeek: Number(document.getElementById('st-freq')?.value)||2,
      type: document.getElementById('st-type')?.value||'solo',
      group: document.getElementById('st-group')?.value?.trim()||'',
      pairedWith: document.getElementById('st-paired')?.value||null,
      notes: document.getElementById('st-notes')?.value?.trim()||'',
      cadence: (() => { const n = Number(document.getElementById('st-cadence')?.value); return n === 2 || n === 4 ? n : undefined; })(),
      cadenceFrom: (() => { const n = Number(document.getElementById('st-cadence')?.value); if(n !== 2 && n !== 4) return undefined;
        const was = state.editingStudentId && state.students.find(s => s.id === state.editingStudentId);
        return (was && Cadence.of(was) === n && was.cadenceFrom) || this.todayISO(); })(),
      price: (() => { const v = Number(String(document.getElementById('st-price')?.value || '').replace(',', '.')); return v > 0 ? Math.min(1000, v) : undefined; })(),
      spacing: document.getElementById('st-spacing')?.value || undefined,
      mergeMode: document.getElementById('st-mergemode')?.value||'off',
      forceMerge: document.getElementById('st-mergemode')?.value==='always',
      maxMergeSessions: Number(document.getElementById('st-mergesize')?.value)||undefined,
      availability,
      availabilityMode: 'exceptions',
      availabilityExceptions,
      atWorkplace: atWork,
      color: state.editingStudentId
        ? (state.students.find(s=>s.id===state.editingStudentId)?.color||0)
        : (state.students.length % 10)
    };
    // Different lengths in one week ("120, 90"): they decide the number of
    // lessons and the longest one; such lessons are never merged into a block.
    // Flexible weekly time ("4 hours, pieces of at least 1 hour") wins over
    // fixed lengths: the run chooses the pieces.
    const flexH = Number(String(document.getElementById('st-flex-hours')?.value || '').replace(',', '.'));
    if(flexH > 0){
      st.flexMinutes = Math.round(Math.min(40, flexH) * 60 / 15) * 15;
      st.minBlock = Number(document.getElementById('st-min-block')?.value) || 60;
      st.maxBlock = Math.max(st.minBlock, Number(document.getElementById('st-max-block')?.value) || 120);
      Scheduler.flexStart(st);
    } else {
      const durs = App.parseDurations(document.getElementById('st-durations')?.value);
      if(durs){
        st.durations = durs;
        st.lessonsPerWeek = st.hoursPerWeek = durs.length;
        st.lessonDuration = Math.max(...durs);
        st.mergeMode = 'off'; st.forceMerge = false; delete st.maxMergeSessions;
      }
    }

    const L2 = getLabels();
    // Read the PREVIOUS record before overwriting it — the un-pairing check
    // below compares old vs new partner, and looking it up afterwards would
    // just find the new object (making the comparison always false and
    // leaving the old partner with a dangling pairedWith link).
    const prevSt = state.editingStudentId ? state.students.find(s=>s.id===state.editingStudentId) : null;
    if(prevSt && prevSt.address === st.address && Number.isFinite(Number(prevSt.lat)) && Number.isFinite(Number(prevSt.lng))){
      st.lat = prevSt.lat;
      st.lng = prevSt.lng;
      if(prevSt.formattedAddress) st.formattedAddress = prevSt.formattedAddress;
    }
    const oldPaired = prevSt ? prevSt.pairedWith : null;
    if(state.editingStudentId){
      const idx = state.students.findIndex(s=>s.id===state.editingStudentId);
      if(idx>=0) state.students[idx]=st;
      Toast.show(`${L2.client} ${t('toast_client_updated')}`,'success');
    } else {
      state.students.push(st);
      Toast.show(`${L2.client} ${t('toast_client_added')}`,'success');
    }
    if(oldPaired && oldPaired !== st.pairedWith){
      const oldPartner = state.students.find(s=>s.id===oldPaired);
      if(oldPartner && oldPartner.pairedWith===st.id) oldPartner.pairedWith = null;
    }
    if(st.pairedWith){
      const partner = state.students.find(s=>s.id===st.pairedWith);
      if(partner) partner.pairedWith = st.id;
    }

    // Clear old coords for this student (address may have changed)
    delete state.coords[st.id];
    state.travelMatrix = null;
    state.travelMatrixPeak = null;
    state.travelMatrixOffPeak = null;
    // Use coord already resolved by autocomplete selection, or re-geocode
    const pendingCoord = atWork ? null : this._addrPendingCoord;
    this._addrPendingCoord = null;
    Storage.saveStudents(state.students);
    if(atWork){
      // The workplace has one position, shared by everyone who comes to it.
      if(state.coords.workplace){ state.coords[st.id] = { ...state.coords.workplace }; Storage.saveCoords(state.coords); }
      else this.syncWorkplace(false);
      state._scheduleStale = prevSt || !state.coords[st.id] ? true : !this.placeNewClient(st);
      this.closeStudentDrawer(); this.renderStudents(); this.renderHome();
      return;
    }
    Storage.saveCoords(state.coords);
    // Save coord immediately if available from autocomplete, else geocode in background
    if(pendingCoord){
      state.coords[st.id] = pendingCoord;
      st.lat = pendingCoord.lat;
      st.lng = pendingCoord.lon;
      if(pendingCoord.formattedAddress) st.formattedAddress = pendingCoord.formattedAddress;
      Storage.saveStudents(state.students);
      Storage.saveCoords(state.coords);
      if(state.currentScreen==='route') this.renderRoute();
      else if(state.currentScreen==='students' && state._mapExpanded) this.initStudentsMap();
    } else if(addr && !(Number.isFinite(Number(st.lat)) && Number.isFinite(Number(st.lng)))) {
      Router.geocode(addr).then(c=>{
        if(c){
          state.coords[st.id]=c; Storage.saveCoords(state.coords);
          if(!prevSt && state.students.includes(st) && this.placeNewClient(st)){ state._scheduleStale = false; if(state.currentScreen==='home') this.renderHome(); }
          // Address changed after the map was already drawn — refresh it so the pin isn't stale
          if(state.currentScreen==='route') this.renderRoute();
          else if(state.currentScreen==='students' && state._mapExpanded) this.initStudentsMap();
        }
      }).catch(()=>{});
    }
    // A new client with a known position goes into the week as it stands;
    // anything else marks the plan stale — never an automatic recalculation.
    state._scheduleStale = !prevSt && pendingCoord ? !this.placeNewClient(st) : true;
    this.closeStudentDrawer();
    this.renderStudents();
    this.renderHome();
  },

  deleteStudent(id){
    const st = state.students.find(s=>s.id===id);
    const L = getLabels();
    this.confirm(
      tf('confirm_delete_client_title',{client:L.client.toLowerCase()}),
      tf('confirm_delete_client_text',{name:st?.name}),
      ()=>{
        this._removeStudent(id);
        this.renderStudents();
        this.renderHome();
        Toast.show(`${L.client} ${t('toast_client_deleted')}`,'info');
      }
    );
  },

  // Take a client out everywhere: the list, their position, their lessons,
  // and the other half of a pairing.
  _removeStudent(id){
        state.students = state.students.filter(s=>s.id!==id);
        delete state.coords[id];
        // Drop their lessons too — a leftover slot referencing a deleted
        // student still renders on the schedule/route as a real visit and
        // survives reloads until some later run happens to overwrite it.
        for(const d in state.schedule){
          state.schedule[d] = (state.schedule[d]||[]).filter(sl =>
            sl.studentId !== id &&
            !(sl.groupMemberIds && sl.groupMemberIds.includes(id)) &&
            sl.pairedStudentId !== id);
        }
        // Clear the other half of a pairing, so the partner isn't left
        // pointing at someone who no longer exists.
        state.students.forEach(s=>{ if(s.pairedWith===id) s.pairedWith = null; });
        Storage.saveStudents(state.students);
        Storage.saveCoords(state.coords);
        Storage.saveSchedule(state.schedule);
        state._scheduleStale = true;
  },

  async geocodeAllStudents(){
    const btn = document.getElementById('btn-geocode-all');
    if(btn){ btn.disabled=true; btn.textContent='…'; }
    const toGeocode = state.students.filter(s=>!state.coords[s.id]);
    if(!state.coords['home'] && state.settings.homeAddress){
      const c = await Router.geocode(state.settings.homeAddress);
      if(c){ state.coords['home']=c; Storage.saveCoords(state.coords); }
      await new Promise(r=>setTimeout(r,1100));
    }
    for(const s of toGeocode){
      const c = await Router.geocode(s.address);
      if(c){ state.coords[s.id]=c; Storage.saveCoords(state.coords); }
      await new Promise(r=>setTimeout(r,1100));
    }
    Toast.show(`${t('toast_geocoded_count')}: ${Object.keys(state.coords).filter(k=>k!=='home'&&k!=='workplace').length}/${state.students.length} geocoded`,'ok');
    this.renderStudents();
  },

  // Rebuild the unplaced-students diagnostic list from current state
  // (used when schedulerResult was lost, e.g. after a page reload)
  computeUnplacedLive(){
    const placedByStudent = {};
    Object.values(state.schedule).flat().forEach(e=>{
      if(e.isGroup){
        const ids = e.groupMemberIds || [e.studentId, e.pairedStudentId].filter(Boolean);
        ids.forEach(id=>{ placedByStudent[id] = (placedByStudent[id]||0) + 1; });
      } else {
        placedByStudent[e.studentId] = (placedByStudent[e.studentId]||0) + (e.mergedCount||1);
      }
    });
    const unplaced = [];
    for(const st of state.students){
      const cnt = placedByStudent[st.id]||0;
      if(cnt < st.lessonsPerWeek){
        const u = { student: st, placed: cnt, needed: st.lessonsPerWeek,
          reason: Scheduler.diagnoseUnplaced(st, state.schedule, state.settings) };
        Scheduler.computeSuggestion(u, state.schedule, state.settings);
        unplaced.push(u);
      }
    }
    return unplaced;
  },

  // ---- SCHEDULE ----
  // The Schedule screen holds two ways of working, because the app serves two
  // shapes of business. A tutor or physiotherapist has the same people every
  // week; a plumber or courier has whatever came in for tomorrow. Neither model
  // can be expressed in the other, so the screen carries both and the toggle
  // says which one you are looking at. Nothing about the weekly path changes.
  // ---- DAY PLANNER -----------------------------------------------------
  todayISO(){ const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); },

  isErrands(){ return state.scheduleMode === 'errands'; },
  // The two kinds of day never mix: what a person does for work and what they
  // have to get done are different lists with different hours.
  jobsFor(dateISO){
    const errands = this.isErrands();
    return (state.jobs||[]).filter(j => j.date === dateISO && (j.kind === 'errand') === errands);
  },
  ERRAND_HOURS: { start: '09:00', end: '20:00' },
  _hoursKey(date){ return (this.isErrands() ? 'e:' : '') + date; },

  renderDayPlanner(){
    const s = document.getElementById('screen-schedule');
    const date = state.planDate || this.todayISO();
    state.planDate = date;
    const jobs = this.jobsFor(date);
    // A plan belongs to one kind of day: switching between work and errands on
    // the same date must not show the other list's stops.
    const plan = (state.dayPlan && state.dayPlan.date === date && !!state.dayPlan.errand === this.isErrands())
      ? state.dayPlan : null;
    const placedIds = new Set(plan ? plan.stops.map(x=>x.job.id) : []);
    const L = getLabels();
    const dayHours = this.dateHoursFor(date);
    const errands = this.isErrands();

    s.innerHTML = `
      <div class="topbar">
        <div class="topbar-inner">
          <div>
            <div class="logo">Route<span>Pal</span></div>
            <div class="topbar-sub">${errands ? t('errand_title') : t('day_title')}</div>
          </div>
          <button class="btn btn-secondary" style="padding:8px 12px;font-size:13px"
            onclick="App.planTheDay()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            ${t('day_plan_btn')}
          </button>
        </div>
      </div>
      ${this._modeTabsHtml()}

      <div style="padding:0 16px 12px;display:flex;gap:8px;align-items:center">
        <input type="date" id="plan-date" value="${esc(date)}" style="flex:1"
               onchange="App.setPlanDate(this.value)">
        <button class="chip chip-gray" style="border:none;cursor:pointer;padding:6px 10px;font-size:12px"
          onclick="App.setPlanDate(App.todayISO())">${esc(t('day_today'))}</button>
        <button class="chip chip-gray" style="border:none;cursor:pointer;padding:6px 10px;font-size:12px"
          onclick="App.setPlanDate(App.shiftDate(1))">${esc(t('day_tomorrow'))}</button>
      </div>

      <div id="day-map" style="margin:0 16px 12px;height:clamp(150px,22vh,240px);border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--bg3)"></div>
      <div style="padding:0 16px 12px">
        <div style="display:flex;gap:8px">
          <input type="text" id="qn-text" style="flex:1" autocomplete="off"
            placeholder="${esc(t(errands ? 'errand_ph' : 'qn_placeholder'))}" onkeydown="if(event.key==='Enter')App.quickNoteAdd()">
          <button class="btn btn-primary" style="padding:8px 14px;font-size:13px" onclick="App.quickNoteAdd()">${esc(t('qn_add'))}</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;font-size:12px;color:var(--text3)">
          <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t('day_hours_for'))}</span>
          <input type="time" id="day-h-from" style="flex:0 1 132px;min-width:92px" value="${esc(dayHours.start)}" onchange="App.setDateHours()">
          <span>–</span>
          <input type="time" id="day-h-to" style="flex:0 1 132px;min-width:92px" value="${esc(dayHours.end)}" onchange="App.setDateHours()">
        </div>
      </div>

      ${plan ? `
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-val">${plan.stops.length}<span></span></div>
            <div class="stat-label">${esc(t('day_stops'))}</div></div>
          <div class="stat-card"><div class="stat-val">${plan.km.toFixed(1)}<span>km</span></div>
            <div class="stat-label">${esc(t('day_driving'))} · ${esc(t('km_incl_return'))}</div></div>
        </div>
        ${plan.stops.length ? `<div style="margin:-6px 16px 12px;font-size:11px;color:var(--text3)">${esc(t('day_map_note'))}</div>` : ''}
        ${plan.before && plan.after ? this._savingsCardHtml({ kind: plan.before.kind, before: plan.before, after: plan.after }, 'day') : ''}
        ${plan.timesFrom === 'estimate' ? `
          <div style="margin:0 16px 12px;font-size:12px;color:#d97706">⚠ ${esc(t('day_times_estimate'))}</div>` : ''}
        ${plan.hours && plan.hours.assumed ? `
          <div style="margin:0 16px 12px;background:rgba(217,119,6,.1);border:1.5px solid rgba(217,119,6,.35);border-radius:12px;padding:10px 14px;font-size:12px;color:var(--text2)">
            ${tf('day_hours_assumed',{day:DAYS_FULL[plan.day]||'', from:plan.hours.start, to:plan.hours.end})}
          </div>`:''}
        ${(plan.waits||[]).length ? `
          <div style="margin:0 16px 12px;background:var(--bg3);border-radius:12px;padding:10px 14px">
            <div style="font-size:12px;font-weight:700;color:var(--text2);margin-bottom:4px">${
              tf('day_waiting_total',{n:(plan.waits||[]).reduce((a,w)=>a+w.minutes,0)})}</div>
            ${plan.waits.map(w=>`<div style="font-size:12px;color:var(--text3)">${
              tf(w.reason==='window'?'day_wait_window':'day_wait_gap',
                 {n:w.minutes, after:esc(w.after), before:esc(w.before)})}</div>`).join('')}
          </div>`:''}
        ${plan.stops.length ? `<div style="padding:0 0 8px">${plan.stops.map((x,i)=>`
          <div class="stop-item" data-swipe="job:${esc(x.job.id)}" style="background:var(--bg)">
            <div class="stop-num">${i+1}</div>
            <div class="stop-info">
              <div class="stop-name">${esc(x.job.name)}</div>
              <div class="stop-addr">${esc(x.job.address||'')}</div>
              ${this.suspiciousDistanceKm(x.job.id) ? `<div style="font-size:11px;color:#d97706;font-weight:600">⚠ ${esc(tf('day_far_warn',{km:Math.round(this.suspiciousDistanceKm(x.job.id))}))}</div>` : ''}
              <div class="stop-travel"><span class="stop-travel-row">${ico('clock', 12)} ${esc(x.start)} – ${esc(x.end)}${
                x.job.service ? ' · '+esc(subjectLabel(x.job.service)) : ''}</span></div>
              ${Number(x.job.durationMax) > Number(x.job.durationMin||0) ? `
                <div style="font-size:11px;color:var(--text3)">${
                  tf('day_reserved_max',{n:Number(x.job.durationMax), min:Number(x.job.durationMin)||0})}</div>`:''}
              <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:3px 9px;margin-top:6px;margin-right:6px"
                ${i===0?'disabled':''}
                onclick="App.moveStop(${i},-1)" aria-label="${esc(t('day_move_up'))}">▲ ${esc(t('day_move_up'))}</button>
              <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:3px 9px;margin-top:6px;margin-right:6px"
                ${i===plan.stops.length-1?'disabled':''}
                onclick="App.moveStop(${i},1)" aria-label="${esc(t('day_move_down'))}">▼ ${esc(t('day_move_down'))}</button>
              <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:3px 9px;margin-top:6px"
                onclick="App.openJobInMaps('${esc(x.job.id)}')">${ico('map', 12)} Google Maps</button>
              ${errands ? '' : `<button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:3px 9px;margin-top:6px;margin-left:6px"
                onclick="App.openSendSheet('job','${esc(x.job.id)}')">${ico('send', 12)} ${esc(t('send_times_btn'))}</button>`}
            </div>
          </div>`).join('')}</div>` : ''}
        ${(plan.unlocated||[]).length ? `
          <div style="margin:0 16px 12px;background:rgba(217,119,6,.1);border:1.5px solid rgba(217,119,6,.35);border-radius:12px;padding:12px">
            <div style="font-weight:700;font-size:13px;color:#d97706;margin-bottom:6px">${
              tf('day_unlocated',{n:plan.unlocated.length})}</div>
            <div style="font-size:12px;color:var(--text2)">${
              plan.unlocated.map(j=>`${esc(j.name)}${j.address?` (${esc(j.address)})`:` — ${esc(t('day_no_address'))}`}`).join(' · ')}</div>
          </div>` : ''}
        ${plan.unplanned.length ? `
          <div style="margin:0 16px 12px;background:rgba(220,38,38,.07);border:1.5px solid rgba(220,38,38,.25);border-radius:12px;padding:12px">
            <div style="font-weight:700;font-size:13px;color:#dc2626;margin-bottom:6px">${
              tf('day_unplanned',{n:plan.unplanned.length})}</div>
            <div style="font-size:12px;color:var(--text2)">${
              plan.unplanned.map(j=>esc(j.name)).join(' · ')}</div>
          </div>` : ''}
      ` : ''}

      <div style="padding:0 16px 8px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:13px;font-weight:700;color:var(--text2)">${
          tf('day_jobs_count',{n:jobs.length, date: this.prettyDate(date)})}</span>
        <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px"
          onclick="App.openJobDrawer()">+ ${esc(t(errands ? 'errand_add' : 'day_add_job'))}</button>
      </div>
      <div style="padding:0 16px 24px">
        ${jobs.length ? jobs.map(j=>`
          <div class="card-sm" data-swipe="job:${esc(j.id)}" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:10px 12px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:14px">${esc(j.name)}${
                placedIds.has(j.id)?'':` <span style="font-size:11px;color:var(--orange)">${esc(t('day_not_planned'))}</span>`}</div>
              <div style="font-size:12px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(j.address||'')}</div>
              ${this._locationNote(j.id) ? `<div>${this._locationNote(j.id)}</div>` : ''}
              <div style="font-size:11px;color:var(--text3);margin-top:2px">${
                this.jobDurationLabel(j)}${j.window?` · ${esc(j.window.start)}–${esc(j.window.end)}`:''}</div>
            </div>
            <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:12px;padding:4px 9px"
              onclick="App.moveJobDay('${esc(j.id)}',1)" title="${esc(t('day_to_next'))}">→</button>
            <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:12px;padding:4px 9px"
              onclick="App.openJobDrawer('${esc(j.id)}')">${esc(t('btn_edit'))}</button>
            <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:12px;padding:4px 9px"
              onclick="App.deleteJob('${esc(j.id)}')">✕</button>
          </div>`).join('')
        : `<div class="card-sm" style="text-align:center;color:var(--text2);font-size:13px;padding:18px">${
            errands ? esc(t('errand_none')) : tf('day_no_jobs',{clients:L.clients.toLowerCase()})}</div>`}
      </div>
    `;
    this._drawDayMap(plan);
  },

  // The day on a map: home, then the stops in order, joined by a line. The line
  // is straight between stops — it shows the ORDER, not the road (the road and
  // its length are in the km figure above).
  // One map routine for every schedule view. `stops` are drawn in order and,
  // with opts.line, joined from home and back. With nothing to show, the map
  // still opens — on home, or on the town when there is no home yet — so the
  // screen always has its map.
  // The theme's accent as a plain colour, for map layers that cannot read CSS.
  _accent(){
    try{ const v = getComputedStyle(document.documentElement).getPropertyValue('--green').trim(); return v || '#059669'; }
    catch(e){ return '#059669'; }
  },
  _drawStopsMap(elId, stops, opts){
    this._maps = this._maps || {};
    const el = document.getElementById(elId);
    if(!el) return null;
    const home = state.coords && state.coords['home'];
    const hasHome = Scheduler.validCoord(home);
    const pts = (hasHome ? [{ c: home, label: '', home: true }] : []).concat((stops || []).filter(p => Scheduler.validCoord(p.c)));
    const ll = pts.map(p => ({lat:p.c.lat,lon:p.c.lon}));
    const stopPts = pts.filter(p=>!p.home);
    const center = stopPts.length ? stopPts[0].c : (hasHome ? home : {lat:38.2466,lon:21.7346});
    const polyline = (opts && opts.line && ll.length>1) ? ll.concat(hasHome ? [{lat:home.lat,lon:home.lon}] : []) : null;
    const promise = this._googleMapUpdate(el,{
      center,zoom:stopPts.length?14:12,zoomControl:true,
      markers:pts.map(p=>({lat:p.c.lat,lon:p.c.lon,label:p.label,title:''})),
      polyline,polylineColor:this._accent(),polylineWeight:3,polylineOpacity:.8,
      fitBounds:stopPts.length ? stopPts.map(p=>({lat:p.c.lat,lon:p.c.lon})) : (hasHome?[{lat:home.lat,lon:home.lon}]:[])
    });
    this._maps[elId]=promise;
    return promise;
  },

  // The day on a map: home, then the stops in order, joined by a line. The line
  // is straight between stops — it shows the ORDER, not the road (the road and
  // its length are in the km figure above). Before planning, the day's jobs
  // are shown unnumbered so the person sees where they are going.
  _drawDayMap(plan){
    const pos = (id) => state.coords && state.coords[id];
    const stops = plan
      ? plan.stops.map((x, i) => ({ c: pos(x.job.id), label: String(i + 1) }))
      : this.jobsFor(state.planDate || this.todayISO()).map(j => ({ c: pos(j.id), label: '•', color: 'var(--text2)' }));
    this._dayMap = this._drawStopsMap('day-map', stops, { line: !!plan });
  },

  // The selected weekday of the weekly schedule, in lesson order.
  _drawWeekMap(){
    const d = state.scheduleDay;
    const slots = ((state.schedule && state.schedule[d]) || []).slice()
      .sort((a, b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start));
    const stops = this._mergeConsecutiveRouteStops(slots)
      .map((sl, i) => ({ c: state.coords && state.coords[sl.studentId], label: String(i + 1) }));
    this._drawStopsMap('week-map', stops, { line: true });
  },

  // Euros per litre, as the person set it (1.80 until they do).
  fuelPrice(){ const p = Number(state.settings && state.settings.fuelPrice); return p > 0 ? p : 1.8; },

  // Push a job to another day: what does not fit today goes to tomorrow.
  moveJobDay(id, delta){
    const j = (state.jobs||[]).find(x => x.id === id);
    if(!j || !j.date) return;
    j.date = QuickNote._addDays(j.date, delta);
    Storage.saveJobs(state.jobs);
    state.dayPlan = null;
    Toast.show(tf('day_moved_to',{date:this.prettyDate(j.date)}),'success');
    this.renderDayPlanner();
  },

  // Adding a job reuses the student drawer's shell rather than introducing a
  // second one, but the fields are the ones a one-off job actually has: how
  // long it might take, and the window the customer gave you.
  openJobDrawer(id, prefill){
    this._jobAddrPendingCoord = null;
    // A prefill fills the form of a NEW job (from a quick note); it is not a
    // saved job and must not make the save overwrite one.
    const j = id ? (state.jobs||[]).find(x=>x.id===id) : (prefill || null);
    state.editingJobId = id && j ? j.id : null;
    if(!id && prefill && Scheduler.validCoord(prefill._coord)) this._jobAddrPendingCoord = prefill._coord;
    const body = document.getElementById('drawer-student-body');
    const title = document.getElementById('drawer-student-title');
    const saveBtn = document.querySelector('#drawer-student .drawer-footer .btn-primary');
    if(!body || !saveBtn) return;
    const errand = this.isErrands();
    if(title) title.textContent = id && j ? t('day_edit_job') : t(errand ? 'errand_add' : 'day_add_job');
    saveBtn.setAttribute('onclick','App.saveJob()');

    body.innerHTML = `
      <div class="form-group"><label>${t(errand ? 'errand_name' : 'day_job_name')}</label>
        <input type="text" id="jb-name" value="${esc(j?.name||'')}" placeholder="${esc(t(errand ? 'errand_name_ph' : 'day_job_name_ph'))}"></div>
      <div class="form-group" style="position:relative"><label>${t('student_address_label')}</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="jb-addr" value="${esc(j?.address||'')}" placeholder="${esc(t('form_address_placeholder'))}" autocomplete="off" style="flex:1"
            oninput="App.onAddrInput(this.value,'jb-addr-suggest')" onkeydown="App.onAddrKey(event,'jb-addr-suggest')" onblur="setTimeout(()=>App.hideAddrSuggest('jb-addr-suggest'),200)">
          <button type="button" class="btn-icon" title="${esc(t('gmaps_find'))}" onclick="App.findInGoogleMaps('jb-addr','jb-name')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          <button type="button" class="btn-icon" title="${esc(t('gps_here'))}" onclick="App.hereNow('jb-addr')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
          </button>
          <button type="button" class="btn-icon" title="${t('form_pick_on_map')}" onclick="App.openMapPicker('jb-addr')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </button>
        </div>
        <div id="jb-addr-suggest" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div></div>
      ${errand ? '' : `<div class="form-group"><label>${t('form_phone_label')}</label>
        <input type="tel" id="jb-phone" value="${esc(j?.phone||'')}" placeholder="${esc(t('form_phone_ph'))}" autocomplete="tel"></div>
      <div class="form-group"><label>${getLabels().session}</label>
        <select id="jb-service">${getSubjects().map(sub=>
          `<option value="${esc(sub)}" ${j?.service===sub?'selected':''}>${esc(subjectLabel(sub))}</option>`).join('')}</select></div>`}
      <div class="form-row">
        <div class="form-group" style="margin:0"><label>${t('day_dur_min')}</label>
          <input type="number" id="jb-dmin" min="5" max="600" step="5" value="${Number(j?.durationMin)||60}"></div>
        <div class="form-group" style="margin:0"><label>${t('day_dur_max')}</label>
          <input type="number" id="jb-dmax" min="0" max="600" step="5" value="${Number(j?.durationMax)||''}"
                 placeholder="${esc(t('day_dur_max_ph'))}"></div>
      </div>
      <div class="form-group" style="margin-top:14px"><label>${t('day_window')}</label>
        <div class="form-row">
          <div class="form-group" style="margin:0"><input type="time" id="jb-wfrom" value="${esc(j?.window?.start||'')}"></div>
          <div class="form-group" style="margin:0"><input type="time" id="jb-wto" value="${esc(j?.window?.end||'')}"></div>
        </div>
        <p style="font-size:12px;color:var(--text3);margin-top:4px">${esc(t('day_window_hint'))}</p>
      </div>
      <div class="form-group" style="margin-top:14px"><label>${t('student_notes_label')}</label>
        <textarea id="jb-notes">${esc(j?.notes||'')}</textarea></div>
    `;
    document.getElementById('drawer-student-overlay')?.classList.add('open');
  },

  saveJob(){
    const name = document.getElementById('jb-name')?.value?.trim();
    if(!name){ Toast.show(t('toast_enter_fullname'),'error'); return; }
    const addr = document.getElementById('jb-addr')?.value?.trim() || '';
    const lo = Number(document.getElementById('jb-dmin')?.value) || 60;
    const hiRaw = Number(document.getElementById('jb-dmax')?.value) || 0;
    const wf = document.getElementById('jb-wfrom')?.value || '';
    const wt = document.getElementById('jb-wto')?.value || '';
    if(wf && wt && Scheduler.toMin(wt) <= Scheduler.toMin(wf)){
      Toast.show(t('day_window_invalid'),'error'); return;
    }
    const job = {
      id: state.editingJobId || ('j'+Date.now()),
      date: state.planDate || this.todayISO(),
      name, address: addr,
      phone: document.getElementById('jb-phone')?.value?.trim() || '',
      service: document.getElementById('jb-service')?.value || '',
      durationMin: lo,
      // A max below the min is not a range, it is a typo.
      durationMax: hiRaw > lo ? hiRaw : 0,
      window: (wf && wt) ? { start: wf, end: wt } : null,
      notes: document.getElementById('jb-notes')?.value || '',
      done: false,
    };
    if(this.isErrands()) job.kind = 'errand';
    const idx = (state.jobs||[]).findIndex(x=>x.id===job.id);
    // A new address makes the stored position WRONG, not merely old. It used to
    // stay until a background lookup replaced it — and if that lookup failed,
    // the job was planned at the place it used to be.
    const prevAddr = idx >= 0 ? (state.jobs[idx].address || '') : null;
    if(prevAddr !== addr) delete state.coords[job.id];
    // A position the user picked (from the list or the map) is the answer, not
    // something to look up again. Typing after picking clears it (onAddrInput).
    const picked = this._jobAddrPendingCoord;
    this._jobAddrPendingCoord = null;
    if(addr && Scheduler.validCoord(picked)) state.coords[job.id] = picked;
    if(idx >= 0) state.jobs[idx] = { ...state.jobs[idx], ...job };
    else (state.jobs = state.jobs||[]).push(job);
    Storage.saveJobs(state.jobs);

    // The plan was made for a different set of jobs, so it no longer describes
    // this day. Showing it beside a changed list would be a lie.
    state.dayPlan = null;
    state.editingJobId = null;
    Storage.saveCoords(state.coords);
    if(addr && !Scheduler.validCoord(state.coords[job.id]))
      this._geocodeOne(addr).then(c=>{
        // Only if the address is still the one that was asked about: a second
        // edit may have replaced it while this was on its way.
        const now = (state.jobs||[]).find(x=>x.id===job.id);
        if(Scheduler.validCoord(c) && now && now.address === addr){
          state.coords[job.id]=c; Storage.saveCoords(state.coords);
        }
      }).catch(()=>{});
    this.closeStudentDrawer();
    this.renderDayPlanner();
  },

  jobDurationLabel(j){
    const lo = Number(j.durationMin)||Number(j.duration)||60;
    const hi = Number(j.durationMax)||0;
    return hi && hi>lo ? `${lo}–${hi}${t('unit_min')}` : `${lo}${t('unit_min')}`;
  },

  prettyDate(iso){
    const d = new Date(iso+'T12:00:00');
    return Number.isNaN(d.getTime()) ? iso
      : `${DAYS_FULL[Scheduler.weekdayOf(iso)]||''} ${d.getDate()}/${d.getMonth()+1}`;
  },

  shiftDate(days){
    const d = new Date((state.planDate||this.todayISO())+'T12:00:00');
    d.setDate(d.getDate()+days);
    return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  },

  setPlanDate(iso){
    if(!iso) return;
    state.planDate = iso;
    // A plan belongs to the date it was made for; showing yesterday's beside
    // today's list would be worse than showing none.
    if(state.dayPlan && state.dayPlan.date !== iso) state.dayPlan = null;
    this.renderDayPlanner();
  },

  /**
   * One address to a position, by the same rule the weekly run uses: HERE when
   * it is reachable (own key or the proxy), Nominatim otherwise. The day planner
   * used Nominatim alone, even with HERE available.
   */
  async _geocodeOne(addr){
    if(!addr) return Promise.resolve(null);
    if(hereAvailable()){
      let c=null;
      try{ c=await Router.geocodeHere(addr,getHereKey()); }catch(e){ c=null; }
      if(c) return c;
      return Router.geocodeNominatim(addr);
    }
    // Without HERE, the one shared door (which is Nominatim then).
    return Router.geocode(addr);
  },

  /**
   * Make sure the home and every job of the day has a position BEFORE planning.
   * Saving a job geocodes it in the background and the result is never checked,
   * so a lookup that failed or had not landed yet left the job with none.
   * Returns which of them still have no position after trying.
   */
  async _ensureDayCoords(date){
    try{ await this.refreshGoogleCoords(); }catch(e){}
    const missing = [];
    const need = [];
    if(!Scheduler.validCoord(state.coords['home']))
      need.push({ id: 'home', addr: state.settings.homeAddress || 'Πλατεία Γεωργίου 1, Πάτρα' });
    for(const j of this.jobsFor(date))
      if(j.address && !Scheduler.validCoord(state.coords[j.id])) need.push({ id: j.id, addr: j.address });

    for(let i = 0; i < need.length; i++){
      const { id, addr } = need[i];
      let c = null;
      try{ c = await this._geocodeOne(addr); }catch(e){ console.warn('geocode failed for', id, e); }
      if(Scheduler.validCoord(c)) state.coords[id] = c; else missing.push(id);
      // Nominatim's public server asks for about one request a second; HERE and
      // the proxy do not.
      if(!hereAvailable() && i < need.length - 1) await new Promise(r => setTimeout(r, 1100));
    }
    if(need.length) Storage.saveCoords(state.coords);
    return { missing, homeOk: Scheduler.validCoord(state.coords['home']) };
  },

  /** The next moment that weekday and hour occur, so HERE is asked about a future moment. */
  _departureFor(dateISO, hour){
    const d = new Date(dateISO + 'T00:00:00');
    if(Number.isNaN(d.getTime())) return new Date();
    d.setHours(hour, 0, 0, 0);
    const now = new Date();
    while(d < now) d.setDate(d.getDate() + 7);
    return d;
  },

  /**
   * Road times and distances for the day's jobs.
   *
   * The day planner used to go without: its jobs are not in the weekly matrix,
   * so every leg between two of them was a straight line at 25 km/h. No road,
   * no traffic, and none of the correction for OSRM's optimistic times.
   *
   * Returns where the figures came from — 'here', 'osrm', or 'estimate' when
   * neither answered — so the screen can say so rather than let a straight
   * line pass for a route.
   */
  async loadDayMatrix(date){
    state.dayMatrixPeak = null; state.dayMatrixOffPeak = null;
    const jobs = this.jobsFor(date).filter(j => Scheduler.validCoord(state.coords[j.id]));
    const home = state.coords['home'];
    if(!Scheduler.validCoord(home) || !jobs.length) return 'estimate';
    const ids = ['home', ...jobs.map(j => j.id)];
    const pts = ids.map(id => state.coords[id]);
    const shape = (m) => ({ durations: m.durations, distances: m.distances, coordIds: ids });

    try{
      if(hereAvailable()){
        const key = getHereKey();
        const peak = await Router.getHereMatrix(pts, key, this._departureFor(date, 17).toISOString());
        const off  = await Router.getHereMatrix(pts, key, this._departureFor(date, 11).toISOString());
        state.dayMatrixPeak = shape(peak); state.dayMatrixOffPeak = shape(off);
        return 'here';
      }
    }catch(e){ console.warn('HERE matrix for the day failed, trying OSRM', e); }
    try{
      const m = await Router.getMatrix(pts);
      if(m && m.durations){
        state.dayMatrixPeak = shape(m); state.dayMatrixOffPeak = shape(m);
        return 'osrm';
      }
    }catch(e){ console.warn('OSRM matrix for the day failed', e); }
    return 'estimate';
  },

  async planTheDay(opts){
    const render = !(opts && opts.render === false);
    const date = state.planDate || this.todayISO();
    if(!this.jobsFor(date).length){ Toast.show(t('day_nothing_to_plan'),'info'); return; }
    Toast.show(t('day_planning'),'info');
    try{
      const geo = await this._ensureDayCoords(date);
      if(!geo.homeOk){ Toast.show(t('day_home_missing'),'error',8000); return; }
      const source = await this.loadDayMatrix(date);
      const errand = this.isErrands();
      const plan = await Scheduler.planDay(this.jobsFor(date), state.settings, state.coords, date,
        { hours: this.dateHoursFor(date), errand });
      if(plan){ plan.timesFrom = source; plan.errand = errand; }
      if(plan && plan.before && plan.after)
        this.recordSavings('day', date + '|' + (errand ? 'errands' : 'day'), { kind: plan.before.kind, before: plan.before, after: plan.after });
      state.dayPlan = plan;
      if(render) this.renderDayPlanner();
      if(plan.unplanned.length) Toast.show(tf('day_unplanned',{n:plan.unplanned.length}),'error',7000);
      else Toast.show(tf('day_planned_ok',{n:plan.stops.length, km:plan.km.toFixed(1)}),'success');
    }catch(e){
      console.error('planDay failed', e);
      Toast.show(tf('toast_scheduler_failed',{reason:e.message||'—'}),'error',9000);
    }
  },

  // This date's own hours: what was typed for it, else the weekly hours for
  // that weekday, else the same stand-in the planner uses.
  dateHoursFor(date){
    const own = (state.settings.dateHours || {})[this._hoursKey(date)];
    if(own && own.start && own.end) return { start: own.start, end: own.end };
    // Errands do not follow working hours: nobody runs errands from nine to five.
    if(this.isErrands()) return { ...this.ERRAND_HOURS };
    const h = Scheduler.hoursForDay(state.settings, Scheduler.weekdayOf(date));
    return { start: h.start, end: h.end };
  },

  setDateHours(){
    const date = state.planDate || this.todayISO();
    const start = document.getElementById('day-h-from')?.value || '';
    const end = document.getElementById('day-h-to')?.value || '';
    if(!start || !end || Scheduler.toMin(end) <= Scheduler.toMin(start)){
      Toast.show(t('day_hours_invalid'),'error');
      this.renderDayPlanner();
      return;
    }
    state.settings.dateHours = { ...(state.settings.dateHours || {}), [this._hoursKey(date)]: { start, end } };
    Storage.saveSettings(state.settings);
    // The plan was made for other hours.
    state.dayPlan = null;
    this.renderDayPlanner();
  },

  // Somewhere the person has already been, by what they called it. A new note
  // for "dentist" needs no address the second time.
  rememberedPlace(name){
    const key = normalizeSearchText(name).trim();
    if(!key) return null;
    const pools = [...(state.jobs || []).slice().reverse(), ...(state.students || [])];
    for(const x of pools){
      if(normalizeSearchText(x.name || '').trim() !== key || !x.address) continue;
      const c = state.coords && state.coords[x.id];
      return { address: x.address, coord: Scheduler.validCoord(c) ? c : null };
    }
    return null;
  },

  quickNoteAdd(){
    const box = document.getElementById('qn-text');
    const text = box ? box.value.trim() : '';
    if(!text) return;
    const many = QuickNote.parseMany(text, this.todayISO(),
      [...(state.jobs || []).map(j => j.name), ...(state.students || []).map(s => s.name)]);
    if(many.length >= 2){ this._addNoteItems(many); if(box) box.value = ''; return; }
    const r = QuickNote.parse(text, this.todayISO());
    if(r.date) state.planDate = r.date;
    const dur = r.durationMin || (this.isErrands() ? 30 : 60);
    const prefill = { name: r.title, durationMin: dur, address: '' };
    if(r.start){
      const end = Scheduler.toMin(r.start) + dur;
      // An exact time is a window exactly as long as the job.
      if(end <= 24*60) prefill.window = { start: r.start, end: Scheduler.toTime(end) };
    }
    const place = this.rememberedPlace(r.title);
    if(place){ prefill.address = place.address; prefill._coord = place.coord; }
    if(box) box.value = '';
    if(r.date) this.renderDayPlanner();
    this.openJobDrawer(null, prefill);
  },

  // Where "κέντρο" in a note points: the town of the home address.
  _homeTown(){
    const parts = String(state.settings.homeAddress || '').split(',').map(x => x.trim()).filter(Boolean);
    for(let i = parts.length - 1; i >= 0; i--) if(!/^\d[\d\s]*$/.test(parts[i]) && !/^(ελλαδα|greece)$/i.test(normalizeSearchText(parts[i]))) return parts[i];
    return '';
  },

  // A note with several things to do becomes several boxes on that day, each
  // editable before anything is planned. Planning is the person's own press.
  _addNoteItems(items, opts){
    const town = this._homeTown();
    const errand = this.isErrands();
    const base = Date.now();
    const added = [];
    items.forEach((it, k) => {
      const date = it.date || state.planDate || this.todayISO();
      const dur = it.durationMin || (errand ? 30 : 60);
      let address = it.place || '';
      let coord = null;
      if(address && QuickNote.CENTRE_WORDS.has(normalizeSearchText(address))) address = town;
      else if(address && town && !normalizeSearchText(address).includes(normalizeSearchText(town))) address = address + ', ' + town;
      if(!address){
        const p = this.rememberedPlace(it.title);
        if(p){ address = p.address; coord = p.coord; }
      }
      const job = { id: 'j' + (base + k), date, name: it.title.charAt(0).toUpperCase() + it.title.slice(1),
        address, phone: '', service: '', durationMin: dur, durationMax: 0, notes: '', done: false,
        window: null };
      if(it.start){
        const end = Scheduler.toMin(it.start) + dur;
        if(end <= 24*60) job.window = { start: it.start, end: Scheduler.toTime(end) };
      }
      if(errand) job.kind = 'errand';
      (state.jobs = state.jobs || []).push(job);
      if(Scheduler.validCoord(coord)) state.coords[job.id] = coord;
      added.push(job);
    });
    Storage.saveJobs(state.jobs); Storage.saveCoords(state.coords);
    state.planDate = added[0].date;
    state.dayPlan = null;
    if(!opts || opts.render !== false) this.renderDayPlanner();
    Toast.show(tf(added.length > 1 ? 'qn_added_many' : 'qn_added_one', { n: added.length, name: added[0].name }), 'success');
    return added;
  },

  // One step up or down in the day's order; Scheduler.reorderDay decides
  // whether that order is possible. The plan is replaced only when it is.
  moveStop(i, dir){
    const plan = state.dayPlan;
    if(!plan) return;
    const r = Scheduler.reorderDay(plan, state.settings, state.coords, i, i + dir);
    if(!r.ok){
      if(r.reason === 'illegal') Toast.show(t('day_move_illegal'),'error',7000);
      return;
    }
    state.dayPlan = r.plan;
    this.renderDayPlanner();
    Toast.show(t('day_moved'),'success');
  },

  openJobInMaps(jobId){
    const j = (state.jobs||[]).find(x=>x.id===jobId);
    if(!j) return;
    const stops = (state.dayPlan && state.dayPlan.stops) || [];
    const i = stops.findIndex(x => x.job && x.job.id === jobId);
    const from = i > 0 ? stops[i-1].job : null;
    this.openLegInMaps(from, j);
  },

  deleteJob(id){
    const j = (state.jobs||[]).find(x=>x.id===id);
    if(!j) return;
    this.confirm(tf('day_delete_title',{name:j.name}), t('day_delete_text'), ()=>{
      state.jobs = state.jobs.filter(x=>x.id!==id);
      delete state.coords[id];
      if(state.dayPlan) state.dayPlan = null;
      Storage.saveJobs(state.jobs); Storage.saveCoords(state.coords);
      this.renderDayPlanner();
    });
  },

  setScheduleMode(mode){
    state.scheduleMode = (mode === 'day' || mode === 'errands') ? mode : 'week';
    this.renderSchedule();
  },

  _modeTabsHtml(){
    const m = (state.scheduleMode === 'day' || state.scheduleMode === 'errands') ? state.scheduleMode : 'week';
    const tab = (key, label) => `<button class="day-tab ${m===key?'active':''}" style="flex:1;text-align:center"
      onclick="App.setScheduleMode('${key}')">${esc(label)}</button>`;
    return `<div style="display:flex;gap:6px;padding:0 16px 12px">
      ${tab('week', t('mode_week'))}${tab('day', t('mode_day'))}${tab('errands', t('mode_errands'))}
    </div>`;
  },

  renderSchedule(){
    if(state.scheduleMode === 'day' || state.scheduleMode === 'errands') return this.renderDayPlanner();
    const s = document.getElementById('screen-schedule');
    // schedulerResult is session-only (not persisted), so on a fresh page load
    // recompute the unplaced list live from state.schedule/state.students instead
    const result = state.schedulerResult || { unplaced: this.computeUnplacedLive() };
    const total = state.students.reduce((a,s)=>a+s.lessonsPerWeek,0);
    const placed = Scheduler.countTotal(state.schedule);

    s.innerHTML = `
      <div class="topbar">
        <div class="topbar-inner">
          <div>
            <div class="logo">Route<span>Pal</span></div>
            <div class="topbar-sub">${t('schedule_title')}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-icon" onclick="App.printSchedule()" title="${t('schedule_export_pdf_title')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            </button>
            <button class="btn btn-secondary" onclick="App.runAndNotify()" style="padding:8px 12px;font-size:13px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
              ${t('schedule_refresh')}
            </button>
          </div>
        </div>
      </div>
      ${this._modeTabsHtml()}
      <div style="padding:0 16px 10px"><button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" aria-expanded="${state.weekMapOpen ? 'true' : 'false'}"
        onclick="state.weekMapOpen=!state.weekMapOpen;App.renderSchedule()">${ico('map', 14)} ${esc(t('week_map_toggle'))}</button>
        <button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px;margin-left:6px" onclick="state.routeDay=state.scheduleDay;App.nav('route')">${ico('nav', 14)} ${esc(t('nav_route'))} ›</button></div>
      ${state.weekMapOpen ? `<div id="week-map" style="margin:0 16px 12px;height:clamp(150px,22vh,240px);border-radius:12px;overflow:hidden;border:1px solid var(--border);background:var(--bg3)"></div>` : ''}
      <div style="padding:0 16px 12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:14px;color:var(--text2)">${t('schedule_placed')}</span>
          <span class="badge">${placed}/${total}</span>
        </div>
        <div class="progress-bar" style="height:6px">
          <div class="progress-fill" style="width:${total?placed/total*100:0}%"></div>
        </div>
      </div>
      ${state.savings && state.savings.week && (!state.savings.week.after || !state.savings.week.after.key || state.savings.week.after.key === this.scheduleKey()) ? this._savingsCardHtml(state.savings.week, 'week') : ''}
      ${this.renderUnplaced(result.unplaced)}
      ${Notify.bannerHtml()}
      ${placed > 0 ? `<div style="padding:0 16px 10px"><button class="chip chip-gray" style="border:none;cursor:pointer" onclick="App.exportWeekCalendar()">${ico('calendar', 14)} ${esc(t('cal_add_week'))}</button></div>` : ''}
      ${placed > 0 && !this._lockHintSeen() ? `<div class="card-sm" style="margin:0 16px 12px;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text2)">
        ${ico('lock', 16)}<span style="flex:1">${esc(t('lock_hint'))}</span>
        <button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="App.dismissLockHint()">${esc(t('lock_hint_ok'))}</button></div>` : ''}
      <div id="week-ribbon">${this._weekRibbonHtml()}</div>
    `;
    this.renderDaySlots();
    if(state.weekMapOpen) try{ this._drawWeekMap(); }catch(e){ console.warn('week map failed', e); }
  },

  // ── The week as a ribbon ───────────────────────────────────────────────
  // One row per working day: its lessons as blocks along the day, coloured by
  // the area they are in, and its kilometres. Tapping a day opens it in place:
  // where the day goes (area to area), when you are home, and its lessons.

  // The place an address is in: "Δημοτική Ενότητα X" if given, else the last
  // part with letters that is not the country. Street first, place after, is
  // how every geocoder here writes them.
  _placeOf(addr){
    const parts = String(addr || '').split(',').map(x => x.trim()).filter(Boolean);
    const de = parts.find(p => /^(Δημοτική Ενότητα|Δ\.Ε\.|Municipal Unit)\s+/i.test(p));
    if(de) return de.replace(/^(Δημοτική Ενότητα|Δ\.Ε\.|Municipal Unit)\s+/i, '').trim();
    const cands = parts.slice(1).map(p => p.replace(/\d+/g, '').trim())
      .filter(p => p && /\p{L}/u.test(p) && !/^(Ελλάδα|Greece|Hellas|Griechenland|Grèce)$/i.test(p));
    return cands.length ? cands[cands.length - 1] : (parts[0] || '');
  },
  // Areas of everyone on the list, biggest first. Names that differ only in
  // their ending (Πάτρα / Πατρέων, Ρίο / Ρίου) are one area.
  _zones(){
    const norm = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const same = (a, b) => { let i = 0; while(i < a.length && i < b.length && a[i] === b[i]) i++; return i >= 3 && i >= Math.min(a.length, b.length) - 1 || a === b; };
    const groups = [];
    const byId = {};
    for(const st of (state.students || [])){
      const name = this._placeOf(st.address); if(!name) continue;
      const k = norm(name);
      let g = groups.find(g => same(g.key, k));
      if(!g){ g = { key: k, names: {}, ids: [] }; groups.push(g); }
      g.names[name] = (g.names[name] || 0) + 1; g.ids.push(st.id);
    }
    groups.sort((a, b) => b.ids.length - a.ids.length);
    const colours = ['var(--green)', 'var(--blue)', 'var(--accent3)', '#ec4899', '#06b6d4'];
    groups.forEach((g, i) => {
      g.name = Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0];
      g.colour = colours[i] || 'var(--text3)';
      for(const id of g.ids) byId[id] = g;
    });
    return { list: groups, byId };
  },
  _weekRibbonHtml(){
    const Z = this._zones(), many = Z.list.length > 1;
    const days = state.settings.workDays || [];
    const sorted = (d) => [...(state.schedule[d] || [])].sort((a, b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start));
    let lo = 24 * 60, hi = 0;
    for(const d of days) for(const sl of (state.schedule[d] || [])){ lo = Math.min(lo, Scheduler.toMin(sl.start)); hi = Math.max(hi, Scheduler.toMin(sl.end)); }
    if(hi <= lo){ lo = 14 * 60; hi = 22 * 60; }
    lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
    const pct = (m) => ((m - lo) / (hi - lo) * 100).toFixed(2);
    const zoneOf = (sl) => Z.byId[sl.studentId] || null;
    const open = state.weekOpen === undefined ? state.scheduleDay : state.weekOpen;
    const hours = []; for(let h = lo; h <= hi; h += 120) hours.push(h);
    const legend = many ? `<div class="wk-legend">${Z.list.slice(0, 5).map(g => `<span><i style="background:${g.colour}"></i>${esc(g.name)}</span>`).join('')}</div>` : '';
    const rows = days.map(d => {
      const sl = sorted(d), isOpen = open === d;
      const km = sl.length ? Scheduler.dayKm(sl, d, state.settings) : 0;
      const bar = sl.map(x => { const z = zoneOf(x);
        return `<i style="left:${pct(Scheduler.toMin(x.start))}%;width:calc(${(pct(Scheduler.toMin(x.end)) - pct(Scheduler.toMin(x.start))).toFixed(2)}% - 2px);background:${many && z ? z.colour : 'var(--green)'}"></i>`; }).join('');
      let body = '';
      if(isOpen){
        const path = [];
        for(const x of sl){ const z = zoneOf(x); const n = z ? z.name : '—'; if(path[path.length - 1] !== n) path.push(n); }
        const last = sl[sl.length - 1];
        let home = '';
        if(last){ const back = Scheduler.travelEstMin(last.studentId, last.address, 'home', state.settings.homeAddress || '', d, Scheduler.toMin(last.end));
          home = Scheduler.toTime(Scheduler.toMin(last.end) + back); }
        const chip = (n) => { const g = Z.list.find(g => g.name === n); const c = g ? g.colour : 'var(--text3)';
          return `<span class="wk-zone" style="color:${c};background:color-mix(in srgb, ${c} 14%, transparent)">${esc(n)}</span>`; };
        body = `<div class="wk-body">
          ${sl.length ? `<div class="wk-path">${many ? path.map(chip).join('<span class="wk-arrow">→</span>') : ''}
            ${home ? `<span class="wk-home">${esc(t('wk_home_at'))} ${esc(home)}</span>` : ''}</div>` : ''}
          <div id="day-slots"></div></div>`;
      }
      return `<div class="wk-row${isOpen ? ' open' : ''}${sl.length ? ' has-lessons' : ''}">
        <div class="wk-head day-tab${isOpen ? ' active' : ''}" role="button" tabindex="0" onclick="App.toggleWeekDay(${d})"
             ondragover="event.preventDefault();this.classList.add('drag-over')"
             ondragleave="this.classList.remove('drag-over')"
             ondrop="this.classList.remove('drag-over');App._onDayTabDrop(event,${d})">
          <b class="wk-day">${DAYS[d]}</b>
          <span class="wk-bar">${bar}</span>
          <span class="wk-km">${sl.length ? km.toFixed(1) + ' km' : '—'}</span>
        </div>${body}</div>`;
    }).join('');
    return `<div class="wk-axis"><span></span><span class="wk-ticks">${hours.map(h => `<em style="left:${pct(h)}%">${h / 60}:00</em>`).join('')}</span><span></span></div>
      ${rows}${legend}`;
  },
  // Tap a day: open it, or close it if it is the open one. With a lesson
  // picked up (tap-to-move), the tap means "move it here", as the tabs did.
  toggleWeekDay(d){
    const cur = state.weekOpen === undefined ? state.scheduleDay : state.weekOpen;
    if(!_drag && cur === d){
      state.weekOpen = null;
      const rib = document.getElementById('week-ribbon');
      if(rib) rib.innerHTML = this._weekRibbonHtml();
      return;
    }
    this.switchDay(d);
  },

  switchDay(d){
    // If a lesson is currently "picked up" (tap-to-move, the touch-friendly
    // alternative to drag-and-drop — see _onSlotTap), tapping a day tab means
    // "move it here", not "just look at this day".
    if(_drag){
      this._performSlotMoveToDay(_drag.day, _drag.slot, d);
      _drag = null;
      document.querySelectorAll('.slot-block.drag-picked').forEach(el=>el.classList.remove('drag-picked'));
      return;
    }
    state.scheduleDay = d;
    state.weekOpen = d;
    const rib = document.getElementById('week-ribbon');
    if(rib) rib.innerHTML = this._weekRibbonHtml();
    this.renderDaySlots();
    // The map shows the chosen day: it has to follow the tab.
    if(state.weekMapOpen) try{ this._drawWeekMap(); }catch(e){ console.warn('week map failed', e); }
  },

  // Touch-friendly alternative to native HTML5 drag-and-drop, which only
  // works with a mouse — iOS/Android touch events never fire dragstart/drop
  // at all, so on a phone the drag handles simply did nothing. Tap a lesson
  // to "pick it up", then tap another lesson (swap times) or a day tab
  // (move there) to complete it; tap the same lesson again to cancel.
  _onSlotTap(e, day, idx){
    const slots = [...(state.schedule[day]||[])].sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const slot = slots[idx];
    if(!slot) return;
    if(!_drag){
      _drag = {day, idx, slot};
      document.querySelectorAll('.slot-block.drag-picked').forEach(el=>el.classList.remove('drag-picked'));
      e.currentTarget.classList.add('drag-picked');
      Toast.show(tf('toast_slot_picked',{name:slot.studentName}), 'info', 6000,
        { label: t('rs_other_day'), run: () => {
          _drag = null;
          document.querySelectorAll('.slot-block.drag-picked').forEach(el=>el.classList.remove('drag-picked'));
          this.openDayChooser({ studentId: slot.studentId, day, start: slot.start });
        } });
      return;
    }
    if(_drag.day===day && _drag.idx===idx){
      _drag = null;
      e.currentTarget.classList.remove('drag-picked');
      return;
    }
    this._performSlotSwap(_drag.day, _drag.idx, day, idx);
    _drag = null;
    document.querySelectorAll('.slot-block.drag-picked').forEach(el=>el.classList.remove('drag-picked'));
  },

  // Shared by both the native-drag drop handler (desktop mouse) and the
  // tap-to-pick flow (touch) — swaps the two slots' times.
  _performSlotSwap(srcDay, srcIdx, targetDay, targetIdx){
    const srcSlots = [...(state.schedule[srcDay]||[])].sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const tgtSlots = [...(state.schedule[targetDay]||[])].sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    if(srcDay===targetDay && srcIdx===targetIdx) return;
    const sameDay = String(srcDay) === String(targetDay);
    // The real objects in state.schedule, not the sorted copies — positions are
    // matched by identity below.
    const srcSlot0 = srcSlots[srcIdx];
    const tgtSlot0 = tgtSlots[targetIdx];
    if(!srcSlot0 || !tgtSlot0) return;

    // The two lessons trade places in the day's order, and then the whole day
    // is timed again from scratch.
    //
    // The times of course change — that is the point. What does not work is
    // each lesson simply taking over the other's start time, which is what
    // this used to do: that only holds when both are the same length. Put a
    // 90-minute lesson where a 60-minute one was and it runs into the next
    // lesson, so the swap was refused even though the day had plenty of room
    // and merely needed the rest of it shifted along. Recomputing the day
    // handles any mix of lengths, and works across days too.
    const srcOrder = state.schedule[srcDay].slice()
      .sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const tgtOrder = sameDay ? srcOrder : state.schedule[targetDay].slice()
      .sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const srcPos = srcOrder.findIndex(x=>x===srcSlot0);
    const tgtPos = tgtOrder.findIndex(x=>x===tgtSlot0);
    if(srcPos<0 || tgtPos<0) return;

    const trial = {};
    for(const d of Object.keys(state.schedule)) trial[d] = state.schedule[d].slice();
    if(sameDay){
      const day = trial[srcDay].slice()
        .sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
      [day[srcPos], day[tgtPos]] = [day[tgtPos], day[srcPos]];
      trial[srcDay] = day;
    } else {
      const a2 = trial[srcDay].slice().sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
      const b2 = trial[targetDay].slice().sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
      a2[srcPos] = tgtSlot0;
      b2[tgtPos] = srcSlot0;
      trial[srcDay] = a2; trial[targetDay] = b2;
    }

    // Re-lay out every day the swap touched. null means it cannot be done
    // legally at all — reject rather than apply half of it.
    const touched = sameDay ? [srcDay] : [srcDay, targetDay];
    for(const d of touched){
      const laid = Scheduler.relayoutDay(trial[d], Number(d), state.students, state.settings);
      if(!laid){
        if(!this.openRescheduleOptions({studentId:srcSlot0.studentId, day:srcDay, start:srcSlot0.start}, targetDay, tgtSlot0.start))
          Toast.show(tf('toast_swap_blocked',{reason:t('swap_reason_no_room')}),'error',6000);
        return;
      }
      trial[d] = laid;
    }

    // The two lessons traded places, and that can leave a hole: the one now in
    // front may not be free until late, and the lessons behind it wait for it.
    // Gather the touched days up again, with the pair frozen — the point of a
    // swap is that they trade places, and a tidy-up that put them back would
    // undo it. Everyone else is free to move up into the hole.
    Scheduler.gatherDays(trial, state.students, state.settings, touched,
      new Set([srcSlot0.studentId, tgtSlot0.studentId]));

    // Only problems this swap INTRODUCES may block it, judged by
    // verifySchedule — the SAME rule set the scheduler holds itself to,
    // rather than a second, partial copy of the rules living here. That copy
    // was wrong in the worst direction: its overlap check took only the slot
    // being moved off the board, found the other one still sitting at the time
    // being moved into, and reported a clash. Every same-day swap was refused.
    // It also checked nothing about blocked times or travel.
    let introduced = [];
    try{
      const before = new Set(Scheduler.verifySchedule(state.schedule, state.students, state.settings));
      introduced = Scheduler.verifySchedule(trial, state.students, state.settings)
        .filter(issue => !before.has(issue));
    }catch(e){ introduced = []; }
    if(introduced.length){
      if(!this.openRescheduleOptions({studentId:srcSlot0.studentId, day:srcDay, start:srcSlot0.start}, targetDay, tgtSlot0.start))
        Toast.show(tf('toast_swap_blocked',{reason:introduced[0]}),'error',6000);
      return;
    }

    for(const d of touched) state.schedule[d] = trial[d];
    Storage.saveSchedule(state.schedule);
    this.renderSchedule();
    this.renderHome();
  },


  // Shared by both the native-drag day-tab drop handler (desktop mouse) and
  // the tap-to-pick flow (touch) — moves a slot to a different day, finding
  // it a genuinely valid new time on that day.
  _performSlotMoveToDay(srcDay, srcSlot, targetDay){
    if(srcDay===targetDay) return;
    const existing = state.schedule[targetDay]||[];
    const student = state.students.find(s=>s.id===srcSlot.studentId);
    if(!student) return;
    // Diagnose WHY it doesn't fit, so the message names the student and the
    // actual reason instead of a generic "no free time" — the same move can
    // fail because the day is off for them, they're already booked that day,
    // or the day just happens to be full; each deserves a different message.
    const av = student.availability && student.availability[targetDay];
    if(!av || !av.on){
      Toast.show(tf('toast_move_no_availability',{name:student.name, day:DAYS_FULL[targetDay]}),'error');
      return;
    }
    if(existing.some(s=>s.studentId===student.id)){
      Toast.show(tf('toast_move_already_booked',{name:student.name, day:DAYS_FULL[targetDay]}),'error');
      return;
    }
    const newTime = Scheduler.findSlotFixed(student, targetDay, existing, state.settings, srcSlot.duration);
    if(!newTime){
      // Instead of a bare refusal: ways to make it fit, if there are any.
      if(!this.openRescheduleOptions({studentId:srcSlot.studentId, day:srcDay, start:srcSlot.start}, targetDay, null))
        Toast.show(tf('toast_move_no_room',{name:student.name, day:DAYS_FULL[targetDay]}),'error');
      return;
    }
    const srcArrIdx = state.schedule[srcDay].findIndex(s=>s.studentId===srcSlot.studentId && s.start===srcSlot.start);
    if(srcArrIdx>=0) state.schedule[srcDay].splice(srcArrIdx,1);
    if(!state.schedule[targetDay]) state.schedule[targetDay]=[];
    state.schedule[targetDay].push({...srcSlot, start: newTime.start, end: newTime.end});
    // splice() above left a hole where the lesson was, and nothing closed it:
    // the day it came FROM kept its gap until the next full recalculation.
    // Gather both days, the moved lesson staying where the user put it.
    Scheduler.gatherDays(state.schedule, state.students, state.settings,
      [srcDay, targetDay], new Set([student.id]));
    Storage.saveSchedule(state.schedule);
    this.renderSchedule();
    this.renderHome();
  },

  // ---- SMART RESCHEDULING: the panel ----------------------------------
  // Called where a move was refused. Shows the ways Scheduler found to make it
  // fit and returns true; returns false when there is nothing to offer, so the
  // caller keeps its own message. Nothing is changed until a button is pressed.
  openRescheduleOptions(ref, targetDay, targetTime){
    let res;
    try{
      res = Scheduler.findRescheduleOptions(state.schedule, state.students, state.settings, ref, targetDay, targetTime);
      // Nothing simple: try re-planning that one day (level 4).
      if(res && !res.options.length && !res.notes.some(n => ['day_off','unavailable','already','not_movable','multi_block','no_lesson'].includes(n)))
        res.options = Scheduler.replanDayOptions(state.schedule, state.students, state.settings, ref, targetDay, targetTime);
      if(res && !res.options.length && !res.notes.some(n => ['day_off','already','not_movable','multi_block','no_lesson'].includes(n)))
        res.options = Scheduler.forceDayOptions(state.schedule, state.students, state.settings, ref, targetDay);
      if(res && !res.options.length && !res.notes.some(n => ['day_off','unavailable','already','not_movable','multi_block','no_lesson'].includes(n)))
        res.options = Scheduler.bumpDayOptions(state.schedule, state.students, state.settings, ref, targetDay);
    }catch(e){ console.warn('reschedule options failed', e); return false; }
    if(!res || !res.options.length) return false;
    state._reschedule = { res };
    const st = state.students.find(x => x.id === res.ref.studentId);
    const name = (st && st.name) || '';
    const target = (DAYS_FULL[res.targetDay] || '') + (res.targetTime ? ' ' + res.targetTime : '');
    document.getElementById('rs-title').textContent = t('rs_title');
    document.getElementById('rs-hint').textContent = tf('rs_hint', { name, target });
    document.getElementById('rs-cancel-btn').textContent = t('btn_cancel');
    document.getElementById('rs-list').innerHTML = this._rsOptionsHtml(res.options);
    document.getElementById('rs-overlay').classList.add('open');
    return true;
  },

  // The option cards, shared by the refused-move panel and the day chooser.
  _rsOptionsHtml(options){
    const kindText = (o) => {
      if(o.kind === 'swap') return tf('rs_kind_swap', { name: o.partner.name });
      if(o.kind === 'shift') return tf(o.shiftMin < 0 ? 'rs_kind_shift_earlier' : 'rs_kind_shift_later',
        { name: o.partner.name, min: Math.abs(o.shiftMin) });
      if(o.kind === 'replan') return tf('rs_kind_replan', { n: o.moves.length - 1 });
      if(o.kind === 'bump') return tf('rs_kind_bump', { list: o.bumped.join(', ') });
      if(o.kind === 'force' && o.swapWith && o.moves.length === 2) return tf('rs_kind_swap', { name: o.swapWith });
      if(o.kind === 'force' && o.swapWith) return tf('rs_kind_force_swap', { name: o.swapWith, n: o.moves.length - 2 });
      if(o.kind === 'force') return o.moves.length > 1 ? tf('rs_kind_force', { n: o.moves.length - 1 }) : t('rs_kind_force_alone');
      return t('rs_kind_relocate');
    };
    const deltaText = (n) => n > 0 ? tf('rs_delta_plus', { n }) : n < 0 ? tf('rs_delta_minus', { n: -n }) : t('rs_delta_zero');
    const shiftText = (m) => m.shiftMin ? ` (${tf('rs_shift_by', { min: Math.abs(m.shiftMin), dir: t(m.shiftMin < 0 ? 'rs_dir_earlier' : 'rs_dir_later') })})` : '';
    return options.map((o, i) => `
      <div class="card-sm" style="margin-bottom:8px;padding:10px 12px;text-align:left">
        <div style="font-weight:600">${esc(kindText(o))}</div>
        ${this._rsTimelineHtml(o.moves[0].toDay, o)}
        ${o.moves.map(m => `<div style="font-size:13px;margin-top:3px">${esc(m.toDay == null ? tf('rs_line_bumped', { name: m.name }) : tf('rs_line',
          { name: m.name, day: DAYS_FULL[m.toDay] || '', from: m.toStart, to: m.toEnd }) + shiftText(m))}</div>`).join('')}
        ${o.recalc ? `<div style="font-size:12px;margin-top:4px;color:var(--text3)">${esc(t('rs_bump_note'))}</div>` : ''}
        ${o.displacedMin ? `<div style="font-size:12px;margin-top:4px;color:var(--text3)">${esc(tf('rs_moved_total', { n: o.displacedMin }))}</div>` : ''}
        ${o.relax ? `<div style="font-size:12px;margin-top:4px;color:var(--red)">⚠ ${esc(tf('rs_force_outside', { name: o.moves[0].name, from: o.moves[0].toStart, to: o.moves[0].toEnd }))}</div>` : ''}
        ${o.kind === 'force' && (o.touchedDays || []).length > 2 ? `<div style="font-size:12px;margin-top:4px;color:var(--red)">${esc(tf('rs_force_days', { n: o.touchedDays.length - 2 }))}</div>` : ''}
        ${(o.unlocked || []).length ? `<div style="font-size:12px;margin-top:4px;color:var(--red)">🔓 ${esc(tf('rs_force_unlock', { list: o.unlocked.join(', ') }))}</div>` : ''}
        ${(o.spacing || []).map(v => `<div style="font-size:12px;margin-top:4px;color:var(--orange,#c2410c)">⚠ ${esc(tf('rs_spacing_warn',
          { name: v.name, days: v.days.map(d => DAYS_FULL[d] || '').join('–') }))}</div>`).join('')}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px">
          <span style="font-size:12px;font-weight:600;color:${o.deltaTravelMin < 0 ? 'var(--green)' : 'var(--text3)'}">${o.recalc ? '' : esc(deltaText(o.deltaTravelMin))}</span>
          <button class="btn btn-primary" style="padding:6px 14px" onclick="App.applyRescheduleOption(${i})">${esc(t('rs_apply'))}</button>
        </div>
      </div>`).join('');
  },

  // A day as a bar from its first to its last hour: the lessons that stay in
  // grey, the ones the option moves at their new place in the option's
  // colour. Without an option it just shows the day as it is.
  _rsTimelineHtml(day, option){
    const dh = state.settings.dayHours && state.settings.dayHours[day];
    if(!dh) return '';
    const lo = Scheduler.toMin(dh.start), hi = Math.max(lo + 60, Scheduler.toMin(dh.end));
    const col = { 1: 'var(--green)', 2: 'var(--yellow,#ca8a04)', 3: 'var(--yellow,#ca8a04)', 4: 'var(--orange,#d97706)', 5: 'var(--red)' };
    const moved = new Set(((option && option.moves) || []).map(m => m.studentId + '|' + m.fromDay + '|' + Scheduler.toMin(m.fromStart)));
    const blocks = [];
    for(const sl of (state.schedule[day] || [])){
      if(moved.has(sl.studentId + '|' + day + '|' + Scheduler.toMin(sl.start))) continue;
      blocks.push({ s: Scheduler.toMin(sl.start), e: Scheduler.toMin(sl.end), c: 'var(--text3)', n: sl.studentName || '', dim: true });
    }
    for(const m of ((option && option.moves) || []).filter(m => Number(m.toDay) === Number(day)))
      blocks.push({ s: Scheduler.toMin(m.toStart), e: Scheduler.toMin(m.toEnd),
        c: m.role === 'primary' ? (col[option.level] || 'var(--green)') : 'var(--blue)', n: m.name, strong: m.role === 'primary' });
    const pct = (x) => Math.max(0, Math.min(100, (x - lo) / (hi - lo) * 100));
    return `<div style="position:relative;height:18px;border-radius:6px;background:var(--bg3);margin:6px 0 2px;overflow:hidden" aria-hidden="true">
      ${blocks.map(b => `<div title="${esc(b.n)} ${Scheduler.toTime(b.s)}–${Scheduler.toTime(b.e)}" style="position:absolute;top:${b.strong ? 0 : 3}px;bottom:${b.strong ? 0 : 3}px;left:${pct(b.s)}%;width:${Math.max(1.5, pct(b.e) - pct(b.s))}%;background:${b.c};border-radius:4px;opacity:${b.strong ? 1 : b.dim ? .35 : .85}"></div>`).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3)"><span>${esc(dh.start)}</span><span>${esc(dh.end)}</span></div>`;
  },

  // ---- MOVE TO ANOTHER DAY: every day at a glance ----------------------
  // Green = fits in a gap, yellow = a swap or a 15-30' nudge, orange = the
  // day is re-planned, grey = not possible. ⚠ when every way puts someone on
  // two days in a row.
  openDayChooser(ref){
    let rows;
    try{ rows = Scheduler.dayChoices(state.schedule, state.students, state.settings, ref); }
    catch(e){ console.warn('day choices failed', e); return false; }
    const r = Scheduler._slotRef(ref);
    const st = state.students.find(x => x.id === r.studentId);
    state._dayChooser = { ref: r, rows };
    state._reschedule = null;
    document.getElementById('rs-title').textContent = t('rs_days_title');
    document.getElementById('rs-hint').textContent = tf('rs_days_hint', { name: (st && st.name) || '' });
    document.getElementById('rs-cancel-btn').textContent = t('btn_cancel');
    const dot = { free: 'var(--green)', shift: 'var(--yellow,#ca8a04)', replan: 'var(--orange,#d97706)', force: 'var(--red)',
      none: 'var(--text3)', off: 'var(--bg4)', current: 'var(--blue)' };
    const label = { free: 'rs_day_free', shift: 'rs_day_shift', replan: 'rs_day_replan', force: 'rs_day_force',
      none: 'rs_day_none', off: 'rs_day_off', current: 'rs_day_current' };
    // The one to suggest: the easiest kind of change, then no two-days-in-a-row,
    // then the least extra driving.
    const rank = { free: 0, shift: 1, replan: 2, force: 3 };
    const bestOf = (row) => row.options.slice().sort((a, b) => (a.spacing.length - b.spacing.length) || (a.level - b.level) || (a.deltaTravelMin - b.deltaTravelMin))[0];
    const rec = rows.filter(r => r.options && r.options.length && rank[r.status] != null)
      .sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.spacing ? 1 : 0) - (b.spacing ? 1 : 0)) ||
        (bestOf(a).deltaTravelMin - bestOf(b).deltaTravelMin))[0];
    document.getElementById('rs-list').innerHTML = rows.map(row => {
      const can = row.options && row.options.length;
      const best = can ? row.options.slice().sort((a, b) => (a.spacing.length - b.spacing.length) || (a.level - b.level))[0] : null;
      return `<div class="card-sm" style="margin-bottom:8px;padding:10px 12px;text-align:left;${can ? 'cursor:pointer' : 'opacity:.55'}"
        ${can ? `onclick="App.showDayOptions(${row.day})"` : ''}>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:10px;height:10px;border-radius:50%;background:${dot[row.status]};flex:none"></span>
          <span style="font-weight:600">${esc(DAYS_FULL[row.day] || '')}</span>
          ${rec === row ? `<span class="chip" style="font-size:11px;padding:2px 8px;background:rgba(var(--accent-rgb),.12);color:var(--green);font-weight:700">${esc(t('rs_day_best'))}</span>` : ''}
          <span style="font-size:12px;color:var(--text2)">${esc(t(row.reason === 'already' ? 'rs_day_already' : row.status === 'force' && row.reason === 'unavailable' ? 'rs_day_force' : label[row.status]))}</span>
          ${row.spacing ? `<span style="font-size:12px;color:var(--orange,#c2410c);margin-left:auto">⚠ ${esc(t('rs_day_spacing'))}</span>` : ''}
        </div>
        ${row.status !== 'off' ? this._rsTimelineHtml(row.day, best) : ''}
      </div>`;
    }).join('');
    document.getElementById('rs-overlay').classList.add('open');
    return true;
  },

  showDayOptions(day){
    const dc = state._dayChooser;
    const row = dc && dc.rows.find(x => x.day === Number(day));
    if(!row || !row.options.length) return;
    const options = row.options.slice()
      .sort((a, b) => (a.spacing.length - b.spacing.length) || (a.level - b.level) || (a.deltaTravelMin - b.deltaTravelMin))
      .slice(0, 4);
    state._reschedule = { res: { ref: dc.ref, targetDay: row.day, options } };
    document.getElementById('rs-title').textContent = DAYS_FULL[row.day] || '';
    { const st = state.students.find(x => x.id === dc.ref.studentId);
      document.getElementById('rs-hint').textContent = tf('rs_day_hint', { name: (st && st.name) || '', day: DAYS_FULL[row.day] || '' }); }
    document.getElementById('rs-list').innerHTML =
      `<button class="btn btn-secondary" style="width:100%;margin-bottom:8px" onclick="App.openDayChooser(state._dayChooser.ref)">← ${esc(t('rs_back'))}</button>` +
      this._rsOptionsHtml(options);
  },

  closeRescheduleOptions(){
    document.getElementById('rs-overlay')?.classList.remove('open');
    state._reschedule = null;
    state._dayChooser = null;
  },

  // All or nothing: the week is rebuilt and checked again against the
  // schedule as it is now, and only then are the days replaced together.
  applyRescheduleOption(idx){
    const rs = state._reschedule;
    const o = rs && rs.res.options[idx];
    if(!o) return;
    const r = Scheduler.applyRescheduleOption(state.schedule, state.students, state.settings, o);
    this.closeRescheduleOptions();
    if(!r.ok){ Toast.show(t('rs_stale'), 'error', 6000); return; }
    // What the person chose by hand stays put: the next full calculation
    // fills the gap around it instead of putting the old week back. The lock
    // shows on the lesson and can be undone there.
    for(const m of o.moves){
      if(m.role !== 'primary' && m.role !== 'evicted') continue;
      const sl = (state.schedule[m.toDay] || []).find(x => x.studentId === m.studentId && x.start === m.toStart);
      const st = state.students.find(x => x.id === m.studentId);
      if(sl && Scheduler.lockable(sl, st)) sl.locked = true;
    }
    const after = JSON.stringify(r.days.map(d => state.schedule[d]));
    Storage.saveSchedule(state.schedule);
    if(r.availability) Storage.saveStudents(state.students);
    this.renderSchedule();
    this.renderHome();
    const first = o.moves[0];
    if(o.recalc){
      // Those pushed out are placed again by a full calculation, around the
      // lesson, which is locked where it was put.
      Toast.show(tf('rs_bump_applied', { name: first.name, target: (DAYS_FULL[first.toDay] || '') + ' ' + first.toStart }), 'success', 6000);
      this.runAndNotify();
      return;
    }
    Toast.show(tf('rs_applied', { name: first.name, target: (DAYS_FULL[first.toDay] || '') + ' ' + first.toStart }),
      'success', 9000, { label: t('swipe_undo'), run: () => this.undoReschedule(r, after) });
  },

  // Undo puts the touched days back, unless something has changed them since:
  // then it would erase newer work, and says so instead.
  undoReschedule(applied, afterJson){
    if(JSON.stringify(applied.days.map(d => state.schedule[d])) !== afterJson){
      Toast.show(t('rs_undo_blocked'), 'error', 5000);
      return;
    }
    Scheduler.restoreDays(state.schedule, applied.before, state.students, applied.availability);
    if(applied.availability) Storage.saveStudents(state.students);
    Storage.saveSchedule(state.schedule);
    this.renderSchedule();
    this.renderHome();
    Toast.show(t('rs_undone'), 'success');
  },

  renderDaySlots(){
    const container = document.getElementById('day-slots');
    if(!container) return;
    const rawSlots = [...(state.schedule[state.scheduleDay]||[])].sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    if(rawSlots.length===0){
      container.innerHTML = `<div style="padding:16px"><div class="card-sm" style="text-align:center;color:var(--text2);font-size:14px;padding:20px">${t('schedule_no_lessons_day')}</div></div>`;
      return;
    }
    // Merge consecutive same-student slots into one display block
    const slots = [];
    for(let i=0;i<rawSlots.length;i++){
      const s = rawSlots[i];
      const prev = slots.length>0 ? slots[slots.length-1] : null;
      const prevRaw = rawSlots[i-1];
      if(prev && prevRaw && s.studentId===prevRaw.studentId && Scheduler.toMin(s.start)<=Scheduler.toMin(prevRaw.end)+15){
        // Extend the last display block
        prev._end = s.end;
        prev._totalDur = (prev._totalDur||prev.duration) + s.duration;
        prev._blockCount = (prev._blockCount||1) + 1;
      } else {
        slots.push({...s, _end: s.end, _totalDur: s.duration, _blockCount: 1});
      }
    }
    let html = '';
    for(let i=0;i<slots.length;i++){
      const slot = slots[i];
      const isMultiBlock = slot._blockCount > 1;
      const displayEnd = slot._end;
      const mergeTag = slot.merged ? `<span class="merge-badge" style="margin-left:6px">${t('merge_badge_label')} ${slot.mergedCount}×${slot.originalDuration}${t('unit_min')}</span>`
        : isMultiBlock ? `<span class="merge-badge" style="margin-left:6px">${slot._blockCount}×${slot.duration}${t('unit_min')}</span>` : '';
      html += `
        <div class="slot-block ${COLORS[slot.color||0]}${(slot.merged||isMultiBlock)?' merged':''}${slot.isGroup?' group-slot':''}${slot.locked?' locked':''}${!isMultiBlock && Scheduler.lockable(slot, state.students.find(x => x.id === slot.studentId))?' has-lock':''}"
             draggable="true" data-slot-idx="${i}" data-slot-day="${state.scheduleDay}" data-swipe="slot:${state.scheduleDay}:${esc(slot.studentId)}:${slot.start}:${displayEnd}"
             ondragstart="App._onSlotDragStart(event,${state.scheduleDay},${i})"
             ondragover="event.preventDefault()" ondrop="App._onSlotDrop(event,${state.scheduleDay},${i})"
             onclick="App._onSlotTap(event,${state.scheduleDay},${i})">
          ${!isMultiBlock && Scheduler.lockable(slot, state.students.find(x => x.id === slot.studentId)) ? `<button class="slot-lock${slot.locked ? ' on' : ''}" aria-pressed="${slot.locked ? 'true' : 'false'}"
            aria-label="${esc(t(slot.locked ? 'lock_on' : 'lock_off'))}" title="${esc(t(slot.locked ? 'lock_on' : 'lock_off'))}"
            onclick="event.stopPropagation();App.toggleSlotLock(${state.scheduleDay},'${esc(slot.studentId)}','${slot.start}')">${ico(slot.locked ? 'lock' : 'unlock', 15)}</button>` : ''}
          <div class="slot-time">${slot.start} – ${displayEnd}</div>
          <div class="slot-name" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">${esc(slot.studentName)}${mergeTag}${slot.isGroup?`<span style="font-size:10px;background:rgba(139,92,246,.2);color:#a78bfa;padding:1px 6px;border-radius:10px;margin-left:4px">${t('form_type_group').toLowerCase()}</span>`:''}</div>
          <div class="slot-meta">
            ${subjectText(slot.subject) ? `<span class="chip chip-gray">${esc(subjectText(slot.subject))}</span>` : ''}
            <span class="chip chip-gray">${slot._totalDur}${t('unit_min')}</span>
            <span class="chip chip-gray" style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(slot.address)}</span>
          </div>
        </div>`;
      if(i<slots.length-1){
        const sameLocation = slot.studentId===slots[i+1].studentId ||
          (slot.groupCode && slot.groupCode===slots[i+1].groupCode);
        if(sameLocation){
          html += `<div class="slot-gap" style="color:var(--text-muted,#888)">${t('schedule_gap_same_location')}</div>`;
        } else {
          // Real travel-time estimate between these two addresses (uses the
          // fetched OSRM/HERE road matrix when available, falling back to
          // haversine otherwise) — NOT derived from the gap between the two
          // lesson times. That used to be "whatever's left after subtracting
          // the safety margin", which reads as a real driving estimate but
          // silently showed 0 minutes whenever a lesson happened to be
          // scheduled with only the margin's worth of room, regardless of
          // how far the two addresses actually are.
          const samePl = Scheduler.samePlace(slot.studentId, slot.address, slots[i+1].studentId, slots[i+1].address);
          const margin = samePl ? 0 : (state.settings.travelMargin ?? 3);
          const driveMin = Scheduler.travelEstMin(slot.studentId, slot.address, slots[i+1].studentId, slots[i+1].address, state.scheduleDay);
          // Whatever is left over after the drive and the margin is genuine
          // waiting time. It used to be invisible, so a 10-minute drive with an
          // hour of dead air behind it looked identical to a tight handover.
          const idle = Scheduler.toMin(slots[i+1].start) - Scheduler.toMin(slot.end) - driveMin - margin;
          html += `<div class="slot-gap">${tf('schedule_gap_travel',{min:driveMin})}${margin?tf('schedule_gap_safety',{min:margin}):''}` +
            (idle >= 5 ? `<span style="color:var(--text-muted,#888)">${tf('schedule_gap_idle',{min:idle})}</span>` : '') +
            this._breakMenuHtml(displayEnd) + `</div>`;
          // A gap worth filling gets a way to fill it by hand: tap, see who
          // fits, choose. Under half an hour nothing useful fits, so the
          // button would only ever answer "nobody".
          if(idle >= 30){
            html += `<div class="slot-gap"><button class="chip chip-gray" style="border:none;cursor:pointer;font-size:12px;padding:4px 10px;font-weight:600"
              onclick="event.stopPropagation();App.openGapFill(${state.scheduleDay},'${slot.end}','${slots[i+1].start}')">${esc(t('gap_who_fits'))}</button></div>`;
          }
          // A long wait is not the scheduler being lazy — say what is holding
          // the next lesson back, since only the user can change it.
          if(idle >= 20){
            let why = null;
            try{ why = Scheduler.explainGap(slot, slots[i+1], state.scheduleDay, state.students, state.settings); }catch(e){}
            if(why && why.kind==='availability'){
              html += `<div class="slot-gap" style="color:var(--text-muted,#888);font-size:11px">${
                tf('gap_because_availability',{name:esc(why.name), from:esc(why.from)})}</div>`;
            } else if(why && why.kind==='break'){
              html += `<div class="slot-gap" style="color:var(--text-muted,#888);font-size:11px">${
                tf('gap_because_break',{end:esc(why.end)})}</div>`;
            } else if(why && why.kind==='dayStart'){
              html += `<div class="slot-gap" style="color:var(--text-muted,#888);font-size:11px">${
                t('gap_because_day_start')}</div>`;
            } else {
              // No constraint accounts for it, so the honest thing is to say
              // so rather than leave a silent hole that reads as a broken app.
              // This is also the only case the user can act on by pressing
              // recalculate, so the row offers exactly that.
              html += `<div class="slot-gap" style="color:var(--text-muted,#888);font-size:11px">${
                t('gap_unexplained')} <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:10px;padding:1px 7px;margin-left:5px" onclick="event.stopPropagation();App.runAndNotify()">${
                esc(t('btn_calculate'))}</button></div>`;
            }
          }
        }
        // Any break the user has put in this gap, shown where it actually
        // falls and removable from here — otherwise it exists only in Settings
        // and looks like unexplained dead time on the schedule.
        (state.settings.blockedSlots||[]).forEach((b, bi)=>{
          if(b.day!==state.scheduleDay) return;
          if(Scheduler.toMin(b.start) < Scheduler.toMin(displayEnd)) return;
          if(Scheduler.toMin(b.start) >= Scheduler.toMin(slots[i+1].start)) return;
          html += `<div class="slot-gap" style="color:var(--text-muted,#888)">${ico('coffee', 12)} ${esc(b.start)}–${esc(b.end)}${b.reason?' · '+esc(b.reason):''}
            <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:2px 7px;margin-left:6px"
              onclick="event.stopPropagation();App.removeBreak(${bi})">✕</button></div>`;
        });
      }
    }
    container.innerHTML = html;
  },

  // "+ break" affordance on a gap row. The schedule is packed tight now, so a
  // pause has to be asked for rather than found — this is where the user buys
  // back the time the compaction pass removed, and because a break is stored
  // as a normal blocked slot the scheduler counts it like any other constraint.
  // Keyed by the end TIME of the block above, not by its index: the schedule
  // view merges consecutive same-student slots for display, so a display index
  // does not address the same lesson as a raw schedule index.
  _breakMenuHtml(afterEnd){
    const opts = [15,30,45,60].map(m =>
      `<button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:2px 7px"
        onclick="event.stopPropagation();App.addBreakAfter(${state.scheduleDay},'${afterEnd}',${m})">${m}${t('unit_min')}</button>`
    ).join('');
    return `<span class="break-add" style="display:inline-flex;align-items:center;gap:4px;margin-left:8px">
      <button class="chip chip-gray" title="${esc(t('schedule_add_break'))}"
        style="border:none;cursor:pointer;font-size:12px;padding:2px 8px;font-weight:700"
        onclick="event.stopPropagation();this.nextElementSibling.hidden=!this.nextElementSibling.hidden">＋</button>
      <span hidden style="display:inline-flex;gap:4px">${opts}</span>
    </span>`;
  },

  // Insert a break of `mins` right after slot `idx`, pushing the rest of the
  // day later. Refuses rather than half-applies: everything after the break is
  // re-laid out in a dry run first, and if any lesson would fall outside its
  // student's availability or past the end of the working day, nothing changes
  // and the user is told.
  addBreakAfter(day, afterEnd, mins){
    const slots = [...(state.schedule[day]||[])].sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const breakStart = Scheduler.toMin(afterEnd), breakEnd = breakStart + mins;
    // Last lesson finishing at or before the break — the one we drive from.
    const after = slots.filter(s=>Scheduler.toMin(s.end)<=breakStart).pop();
    if(!after) return;
    const margin = state.settings.travelMargin ?? 2;
    const dh = state.settings.dayHours && state.settings.dayHours[day];

    const moves = [];
    let prevEnd = breakEnd, prev = after;
    for(const sl of slots){
      if(Scheduler.toMin(sl.start) < breakStart) continue;
      const dur = Scheduler.toMin(sl.end) - Scheduler.toMin(sl.start);
      const need = prev.studentId === sl.studentId ? 0
        : Scheduler.legMin(margin, prev.studentId, prev.address, sl.studentId, sl.address, day);
      const start = Math.max(Scheduler.toMin(sl.start), prevEnd + need), end = start + dur;
      for(const id of Scheduler.occupantIds(sl)){
        const st = state.students.find(s=>s.id===id);
        const av = st && st.availability && st.availability[day];
        // fitsAvailability, not av.end: a student free 15:00-17:00 and again
        // 19:00-22:00 has av.end of 22:00, so pushing their lesson into the
        // hour they said they are busy passed this check unnoticed.
        if(!av || !av.on || !Scheduler.fitsAvailability(st, day, start, end)){
          Toast.show(tf('toast_break_no_room',{name: st?st.name:''}),'error'); return;
        }
      }
      if(dh && end > Scheduler.toMin(dh.end)+Scheduler.endFlex()){
        Toast.show(tf('toast_break_no_room',{name:''}),'error'); return;
      }
      moves.push({slot: sl, start, end});
      prevEnd = end; prev = sl;
    }

    moves.forEach(m=>{ m.slot.start = Scheduler.toTime(m.start); m.slot.end = Scheduler.toTime(m.end); });
    state.settings.blockedSlots = state.settings.blockedSlots || [];
    state.settings.blockedSlots.push({
      day, start: Scheduler.toTime(breakStart), end: Scheduler.toTime(breakEnd), reason: t('schedule_break_reason'),
    });
    Storage.saveSettings(state.settings);
    Storage.saveSchedule(state.schedule);
    Toast.show(tf('toast_break_added',{min:mins}),'info');
    this.renderSchedule();
    this.renderHome();
  },

  // Removing a break gives the time straight back: compaction pulls the rest
  // of the day up again, so the schedule never keeps a hole the user cancelled.
  removeBreak(bi){
    const list = state.settings.blockedSlots || [];
    if(!list[bi]) return;
    list.splice(bi, 1);
    Storage.saveSettings(state.settings);
    try{ Scheduler.compactDays(state.schedule, state.students, state.settings); }catch(e){}
    Storage.saveSchedule(state.schedule);
    this.renderSchedule();
    this.renderHome();
  },

  _onSlotDragStart(e, day, idx){
    const slots = [...(state.schedule[day]||[])].sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    _drag = {day, idx, slot: slots[idx]};
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  },

  // Desktop mouse drag (native HTML5 DnD) — same underlying logic as the
  // touch-friendly tap-to-pick flow, see _performSlotSwap/_performSlotMoveToDay.
  _onSlotDrop(e, targetDay, targetIdx){
    e.preventDefault();
    document.querySelectorAll('.slot-block.dragging').forEach(el=>el.classList.remove('dragging'));
    if(!_drag) return;
    const {day: srcDay, idx: srcIdx} = _drag;
    _drag = null;
    this._performSlotSwap(srcDay, srcIdx, targetDay, targetIdx);
  },

  _onDayTabDrop(e, targetDay){
    e.preventDefault();
    document.querySelectorAll('.slot-block.dragging').forEach(el=>el.classList.remove('dragging'));
    if(!_drag) return;
    const {day: srcDay, slot: srcSlot} = _drag;
    _drag = null;
    this._performSlotMoveToDay(srcDay, srcSlot, targetDay);
  },

  renderUnplaced(unplaced){
    if(!unplaced.length) return '';
    // One line until it is opened: the week itself must stay on screen.
    return `
      <details class="fold fold-unplaced" ${state.unplacedOpen ? 'open' : ''} ontoggle="state.unplacedOpen=this.open">
        <summary><span>${unplaced.length} ${t('schedule_unplaced_students')}</span><em>· ${esc(t('unplaced_see'))}</em></summary>
      <div style="margin-top:8px;background:rgba(220,38,38,.07);border:1.5px solid rgba(220,38,38,.25);border-radius:12px;padding:14px">
        <button class="btn btn-secondary" style="width:100%;font-size:13px;margin-bottom:12px"
          onclick="App.findPairSuggestions()">${ico('users', 14)} ${esc(t('pairs_find_btn'))}</button>
        ${unplaced.map(u=>{
          const missing = u.needed - u.placed;
          // forceMergeAndReschedule combines ALL weekly lessons into one block, not just the missing ones
          const blockMin = u.student.lessonDuration * u.needed;
          const blockH = blockMin >= 60 ? Math.floor(blockMin/60)+t('unit_hr')+(blockMin%60?blockMin%60+t('unit_min'):'') : blockMin+t('unit_min');
          return `
          <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-weight:600;font-size:14px">${esc(u.student.name)}</span>
              <span class="chip chip-red">${u.placed}/${u.needed} ${t('unplaced_group_badge')}</span>
            </div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:8px">${u.reason}</div>
            ${u.needed >= 2 ? `
            <div style="background:rgba(var(--accent-rgb),.07);border:1px solid rgba(var(--accent-rgb),.2);border-radius:8px;padding:10px;margin-bottom:6px">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span style="font-weight:700;font-size:12px;color:var(--green)">${tf('unplaced_solution_combo',{block:blockH})}</span>
              </div>
              <div style="font-size:12px;color:var(--text2);margin-bottom:8px">${tf('unplaced_combo_detail',{needed:u.needed,dur:u.student.lessonDuration,total:blockMin})}</div>
              <button class="btn btn-primary" style="font-size:12px;padding:6px 14px;width:100%" onclick="App.forceMergeAndReschedule('${u.student.id}')">
                ${tf('unplaced_apply_block',{block:blockH})}
              </button>
            </div>` : ''}
            ${u.suggestionTeacher ? `
            <div style="background:rgba(var(--accent2-rgb),.07);border:1px solid rgba(var(--accent2-rgb),.2);border-radius:8px;padding:10px;margin-bottom:6px">
              <div style="font-weight:700;font-size:12px;color:#7c3aed;margin-bottom:4px">${tf('unplaced_solution_extend_hours',{letter:missing>=2?'B':'A'})}</div>
              <div style="font-size:12px;color:var(--text2);margin-bottom:8px">${tf('unplaced_extend_hours_detail',{day:`<strong>${DAYS_FULL[u.suggestionTeacher.day]}</strong>`,min:`<strong>${u.suggestionTeacher.extensionMin}</strong>`})}</div>
              <button class="btn btn-secondary" style="font-size:12px;padding:6px 14px;width:100%;border-color:rgba(var(--accent2-rgb),.3)" onclick="App.applyTeacherExtension(${u.suggestionTeacher.day},${u.suggestionTeacher.extensionMin})">
                ${tf('unplaced_extend_hours_btn',{min:u.suggestionTeacher.extensionMin,day:DAYS_FULL[u.suggestionTeacher.day]})}
              </button>
            </div>` : ''}
            ${u.suggestionStudent ? `
            <div style="background:rgba(217,119,6,.07);border:1px solid rgba(217,119,6,.2);border-radius:8px;padding:10px">
              <div style="font-weight:700;font-size:12px;color:var(--orange);margin-bottom:4px">${tf('unplaced_solution_extend_window',{letter:missing>=2?(u.suggestionTeacher?'C':'B'):(u.suggestionTeacher?'B':'A')})}</div>
              <div style="font-size:12px;color:var(--text2);margin-bottom:8px">${tf('unplaced_extend_window_detail',{name:esc(u.student.name),day:`<strong>${DAYS_FULL[u.suggestionStudent.day]}</strong>`,min:u.suggestionStudent.extensionMin})}</div>
              <button class="btn btn-secondary" style="font-size:12px;padding:6px 14px;width:100%" onclick="App.applyWindowExtension('${u.student.id}',${u.suggestionStudent.day},${u.suggestionStudent.extensionMin})">
                ${tf('unplaced_extend_window_btn',{min:u.suggestionStudent.extensionMin,name:esc(u.student.name),day:DAYS_FULL[u.suggestionStudent.day]})}
              </button>
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>
      </details>`;
  },

  applyWindowExtension(studentId, day, extMin){
    const student = state.students.find(s=>s.id===studentId);
    if(!student || !student.availability[day]) return;
    const av = student.availability[day];
    const newEnd = Scheduler.toTime(Scheduler.toMin(av.end)+extMin);
    student.availability[day] = {...av, end: newEnd};
    Storage.saveStudents(state.students);
    this.runAndNotify();
    Toast.show(tf('toast_window_extended',{day:DAYS_FULL[day],min:extMin}),'success');
  },

  applyTeacherExtension(day, extMin){
    const dayH = state.settings.dayHours[day];
    if(!dayH) return;
    state.settings.dayHours[day] = {...dayH, end: Scheduler.toTime(Scheduler.toMin(dayH.end)+extMin)};
    Storage.saveSettings(state.settings);
    this.runAndNotify();
    Toast.show(tf('toast_hours_extended',{day:DAYS_FULL[day],min:extMin}),'success');
  },

  // Ask whether to look for clients who could share a session, show what was
  // found, and only act on a yes. Nothing is created without the user seeing
  // exactly who would be paired with whom.
  findPairSuggestions(){
    const L = getLabels();
    let pairs = [];
    try{
      pairs = Scheduler.suggestPairs(state.students, state.settings, state.coords,
        this.computeUnplacedLive().map(u=>u.student.id));
    }catch(e){ console.error('suggestPairs failed', e); }

    if(!pairs.length){
      Toast.show(tf('toast_no_pairs',{clients:L.clients.toLowerCase()}),'info',7000);
      return;
    }
    const lines = pairs.map(p=>
      `• ${p.a.name} + ${p.b.name} — ${p.dur}${t('unit_min')}, ${tf('pair_days_count',{n:p.days.length})}` +
      (p.km!=null ? `, ${p.km.toFixed(1)}km` : '')).join('\n');

    this.confirm(
      tf('confirm_pairs_title',{n:pairs.length}),
      tf('confirm_pairs_text',{list:lines}),
      ()=>this.applyPairSuggestions(pairs),
      t('btn_apply'), false);
  },

  // Create the pairs and recalculate. Everything the user set stays: each
  // client keeps their own availability, and the shared session is placed only
  // where BOTH are genuinely free.
  applyPairSuggestions(pairs){
    let made = 0;
    for(const p of pairs){
      const a = state.students.find(x=>x.id===p.a.id);
      const b = state.students.find(x=>x.id===p.b.id);
      if(!a || !b || a.pairedWith || b.pairedWith) continue;   // changed underneath us
      a.pairedWith = b.id;
      b.pairedWith = a.id;
      made++;
    }
    if(!made) return;
    Storage.saveStudents(state.students);
    Toast.show(tf('toast_pairs_created',{n:made}),'success');
    if(state.currentScreen==='students') this.renderStudents();
    this.runAndNotify();
  },

  // Build a client record from whatever is currently typed in the form, so a
  // match can be looked for BEFORE the client is saved. Returns null when the
  // form does not yet describe someone concrete enough to match.
  _studentFromForm(){
    const name = document.getElementById('st-name')?.value?.trim();
    if(!name) return null;
    const exceptions = this._editingExceptions || [];
    return {
      id: state.editingStudentId || '__new__',
      name,
      address: document.getElementById('st-addr')?.value?.trim() || '',
      subject: document.getElementById('st-subject')?.value || '',
      lessonDuration: Number(document.getElementById('st-dur')?.value) || 60,
      lessonsPerWeek: Number(document.getElementById('st-freq')?.value) || 1,
      type: document.getElementById('st-type')?.value || 'solo',
      group: document.getElementById('st-group')?.value || '',
      pairedWith: document.getElementById('st-paired')?.value || null,
      availability: this.computeAvailabilityFromExceptions(exceptions),
      availabilityExceptions: exceptions,
    };
  },

  // "Does anyone already on the books fit with this one?" — asked from inside
  // the client form, while the record is still being typed. Same rules as the
  // sweep over everybody; there is only one definition of a workable pair.
  findMatchForForm(){
    const me = this._studentFromForm();
    if(!me){ Toast.show(t('toast_enter_fullname'),'error'); return; }
    if(me.pairedWith){ Toast.show(t('toast_already_paired'),'info'); return; }

    // An unsaved client has no geocoded address yet. Use the coordinate the
    // address autocomplete already resolved, so distance is still checked
    // rather than quietly skipped.
    const coords = {...state.coords};
    if(this._addrPendingCoord) coords[me.id] = this._addrPendingCoord;

    let matches = [];
    try{ matches = Scheduler.matchesFor(me, state.students, state.settings, coords); }
    catch(e){ console.error('matchesFor failed', e); }

    if(!matches.length){ Toast.show(t('toast_no_match'),'info',7000); return; }

    const best = matches[0];
    const other = best.a.id === me.id ? best.b : best.a;
    this.confirm(
      tf('confirm_match_title',{name:other.name}),
      tf('confirm_match_text',{
        name: other.name, mins: best.dur,
        days: tf('pair_days_count',{n:best.days.length}),
        dist: best.km!=null ? `, ${best.km.toFixed(1)}km` : `, ${t('pair_distance_unknown')}`,
        more: matches.length>1 ? tf('confirm_match_more',{n:matches.length-1}) : '',
      }),
      ()=>{
        const sel = document.getElementById('st-paired');
        if(sel) sel.value = other.id;
        // saveStudent already links both records and clears any previous
        // partner, so a pair is only ever created down one path.
        this.saveStudent();
        this.runAndNotify();
      },
      t('btn_apply'), false);
  },

  forceMergeAndReschedule(studentId){
    const student = state.students.find(s=>s.id===studentId);
    if(!student) return;
    const blockMin = student.lessonsPerWeek * student.lessonDuration;
    if(blockMin > 120){
      const blockH = blockMin >= 60 ? `${Math.floor(blockMin/60)}${t('unit_hr')}${blockMin%60?(' '+blockMin%60+t('unit_min')):''}` : `${blockMin}${t('unit_min')}`;
      if(!confirm(tf('confirm_merge_block',{block:blockH}))) return;
    }
    student.forceMerge = true;
    Storage.saveStudents(state.students);
    this.runAndNotify();
    Toast.show(tf('toast_placed_as_block',{name:student.name}),'success');
  },

  // ---- ROUTE ----
  renderRoute(){
    const s = document.getElementById('screen-route');
    const rr = this.routeFor(state.routeDay);
    const slots = (state.schedule[state.routeDay]||[]).sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));

    s.innerHTML = `
      <div class="topbar">
        <div class="topbar-inner">
          <div>
            <div class="logo">Route<span>Pal</span></div>
            <div class="topbar-sub">${t('route_title')}</div>
          </div>
          <button class="btn btn-primary" onclick="App.calcRoute()" id="calc-route-btn" style="padding:8px 12px;font-size:13px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 10-16 0c0 3 2.7 6.9 8 11.7z"/></svg>
            ${t('route_calc')}
          </button>
        </div>
      </div>
      <div style="padding:0 16px 10px"><button class="chip chip-gray" style="border:none;cursor:pointer;min-height:36px" onclick="state.scheduleDay=state.routeDay;state.weekOpen=state.routeDay;App.nav('schedule')">‹ ${esc(t('nav_schedule'))}</button></div>
      <div class="route-day-tabs">
        ${state.settings.workDays.map(d=>`
          <div class="day-tab ${d===state.routeDay?'active':''}" onclick="App.switchRouteDay(${d})">
            ${DAYS[d]}
            ${(state.schedule[d]||[]).length>0?`<span class="badge" style="margin-left:4px;font-size:10px">${(state.schedule[d]||[]).length}</span>`:''}
            ${this.routeFor(d)?`<span style="font-size:10px;color:var(--green);margin-left:2px">✓</span>`:''}
          </div>`).join('')}
      </div>
      ${this.routeFor(state.routeDay)?`
        <div style="margin:0 16px 8px;background:rgba(var(--accent-rgb),.07);border:1px solid rgba(var(--accent-rgb),.2);border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:8px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <span style="font-size:13px;color:#059669;font-weight:600">OpenStreetMap — ${t('route_real_distance')}</span>
        </div>`:''}
      <div id="route-map" style="height:220px;border-radius:12px;margin:0 16px 8px;overflow:hidden;background:var(--bg2);position:relative;isolation:isolate"></div>
      <div id="route-content">
        ${this.buildRouteContent(slots, rr)}
      </div>
    `;
    this.initRouteMap(slots);
  },

  initRouteMap(slots){
    const el = document.getElementById('route-map');
    if(!el) return;
    const homeC = state.coords['home'] || Scheduler.coordsHash(state.settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα');
    const stopCoords = slots.map(s => state.coords[s.studentId] || Scheduler.coordsHash(s.address));
    const allPts = [homeC, ...stopCoords];
    const latlngs = allPts.map(c => [c.lat, c.lon]);
    const center = latlngs.reduce((a,p) => [a[0]+p[0]/latlngs.length, a[1]+p[1]/latlngs.length], [0,0]);
    const markers=[{lat:homeC.lat,lon:homeC.lon,label:'',title:t('home_marker_tooltip')}];
    slots.forEach((slot,i)=>markers.push({lat:stopCoords[i].lat,lon:stopCoords[i].lon,label:String(i+1),title:slot.studentName}));
    this._googleMapUpdate(el,{
      center:{lat:center[0],lon:center[1]},zoom:13,zoomControl:false,
      markers,
      polyline:allPts.map(p=>({lat:p.lat,lon:p.lon})),
      polylineColor:this._accent(),polylineWeight:3,polylineOpacity:.7,
      fitBounds:allPts.map(p=>({lat:p.lat,lon:p.lon}))
    });

    // Fetch real road-following route from OSRM and swap in once ready
    if(allPts.length > 1){
      Router.getRouteGeometry(allPts).then(roadCoords=>{
        if(!roadCoords) return;
        this._googleMapUpdate(el,{
          center:{lat:center[0],lon:center[1]},zoom:13,zoomControl:false,
          markers,
          polyline:roadCoords.map(p=>({lat:p[0],lon:p[1]})),
          polylineColor:this._accent(),polylineWeight:4,polylineOpacity:.85,
          fitBounds:roadCoords.map(p=>({lat:p[0],lon:p[1]}))
        });
      });
    }
  },

  switchRouteDay(d){
    state.routeDay = d;
    this.renderRoute();
  },

  // Same "merge consecutive same-student slots" rule as the Schedule
  // screen's renderDaySlots — stops are already in the schedule's fixed
  // chronological order, so consecutive here really does mean "back to
  // back", not just "same student somewhere in the list".
  _mergeConsecutiveRouteStops(stops){
    const merged=[];
    for(let i=0;i<stops.length;i++){
      const s=stops[i];
      const prev=merged.length>0?merged[merged.length-1]:null;
      const prevEnd = prev ? Scheduler.toMin(prev._mergedEnd||prev._end||prev.end) : null;
      const sStart = Scheduler.toMin(s._start||s.start);
      if(prev && prev.studentId===s.studentId && sStart<=prevEnd+15){
        prev._mergedEnd = s._end||s.end;
        prev._mergedDur = (prev._mergedDur||prev.duration) + s.duration;
        prev._mergedCount = (prev._mergedCount||1) + 1;
      } else {
        merged.push({...s});
      }
    }
    return merged;
  },

  buildRouteContent(slots, rr){
    if(slots.length===0){
      return `<div class="empty-state" style="padding:32px 24px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 10-16 0c0 3 2.7 6.9 8 11.7z"/></svg>
        <h3>${t('route_no_route')}</h3>
        <p>${t('route_no_lessons_text')}</p>
      </div>`;
    }

    const hasReal = rr && rr.stops;
    // Estimate using pseudo-coords for all stops
    const buf = state.settings.travelMargin??3;
    const fuel = state.settings.fuelConsumption||7;

    // Compute estimate from pseudo-coords even without API key
    const homeC = state.coords['home'] || Scheduler.coordsHash(state.settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα');
    let estKm = 0;
    let prev = homeC;
    // Visit order MUST follow the already-scheduled lesson times (`slots` is
    // sorted chronologically by the caller) — a "shortest driving route"
    // reorder would happily visit a 20:00 lesson before a 15:00 one just
    // because it's geographically closer, which is meaningless when lesson
    // times are fixed and can't actually be swapped.
    const orderedEst = slots;
    prev = homeC;
    for(const sl of orderedEst){
      const c = state.coords[sl.studentId]||Scheduler.coordsHash(sl.address);
      estKm += Router.estimateKm(prev,c);
      prev = c;
    }
    const estReturnKm = slots.length ? Router.estimateKm(prev, homeC) : 0;
    estKm += estReturnKm;
    const estMin = Math.round(estKm/30*60);
    const estFuel = (estKm/100*fuel*this.fuelPrice()).toFixed(2);

    const totalKm = hasReal ? rr.totalKm.toFixed(1) : estKm.toFixed(1);
    const totalMin = hasReal ? rr.totalMinutes : estMin;
    const totalFuel = hasReal ? rr.fuelCost : estFuel;
    // Consecutive same-student stops (e.g. a δίωρο/double lesson) show as one
    // visit, not two separate numbered stops with a fake "trip" between them
    // — the tutor never actually leaves and comes back.
    const stopsToShow = this._mergeConsecutiveRouteStops(hasReal ? rr.stops : orderedEst);

    return `
      <div class="route-stats-row">
        <div class="route-stat">
          <div class="route-stat-val" style="color:var(--green)">${totalKm}<span style="font-size:14px;color:var(--text2)">km</span></div>
          <div class="route-stat-label">${hasReal?t('route_real'):t('route_estimated')} ${t('route_distance')} · ${t('km_incl_return')}</div>
        </div>
        <div class="route-stat">
          <div class="route-stat-val" style="color:var(--blue)">${totalMin}<span style="font-size:14px;color:var(--text2)">${t('unit_min')}</span></div>
          <div class="route-stat-label">${t('route_travel')}${hasReal?'':t('route_travel_estimated_suffix')}</div>
        </div>
        <div class="route-stat">
          <div class="route-stat-val" style="color:var(--orange)">€${totalFuel}</div>
          <div class="route-stat-label">${t('route_fuel')}${hasReal?'':t('route_travel_estimated_suffix')}</div>
        </div>
      </div>
      <div class="section-title">${t('route_stops')} · ${DAYS_FULL[state.routeDay]||'—'}</div>
      ${this._detourNoteHtml(slots)}
      <div style="padding:0 0 8px">
        ${this.buildStopList(stopsToShow, hasReal, hasReal
          ? {km: rr.returnKm, min: rr.returnMin}
          : {km: estReturnKm, min: Math.round(estReturnKm/30*60)})}
      </div>
    `;
  },

  // ---- HANDOFF TO GOOGLE MAPS ----
  // The app plans the week; the phone drives it. A standard Maps link, one
  // stop at a time — no API key, no account, nothing leaves the device until
  // the user taps.
  //
  // Deliberately per stop rather than a whole-day route: Google's URL API
  // accepts at most 9 intermediate waypoints, so a full day would silently
  // lose stops on a busy afternoon. One stop always works.
  //
  // A geocoded coordinate is preferred over the address text. The address was
  // already resolved once here, and re-resolving the same string in another
  // app is where "it took me to the wrong Γούναρη" comes from.
  _mapPoint(id, address){
    const c = id && state.coords[id];
    if(c && typeof c.lat === 'number' && typeof c.lon === 'number') return `${c.lat},${c.lon}`;
    return address || '';
  },

  // Directions FROM the previous stop TO this one. Sending only a destination
  // makes Google start from wherever the phone is; the leg the person actually
  // drives is previous stop -> this stop. The FIRST stop has no start here on
  // purpose: Google then starts from where the phone is, which is where the
  // person is when they set off.
  buildGoogleLegUrl(from, to){
    const dest = this._mapPoint(to && to.id, to && to.address);
    if(!dest) return null;
    const origin = from ? this._mapPoint(from.id, from.address) : '';
    const params = { api:'1', travelmode:'driving', destination: dest };
    if(origin) params.origin = origin;
    return 'https://www.google.com/maps/dir/?' + new URLSearchParams(params).toString();
  },

  // The Google Maps APP's own link. An https://www.google.com/maps link opened
  // from a home-screen web app stays in a browser sheet on iPhone instead of
  // opening the app; this scheme opens the app when it is installed.
  buildGoogleAppUrl(from, to){
    const dest = this._mapPoint(to && to.id, to && to.address);
    if(!dest) return null;
    const origin = from ? this._mapPoint(from.id, from.address) : '';
    const params = { daddr: dest, directionsmode: 'driving' };
    if(origin) params.saddr = origin;
    return 'comgooglemaps://?' + new URLSearchParams(params).toString();
  },

  _isIOS(){
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return /iPhone|iPad|iPod/.test(ua) ||
      (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  // Open the leg in the Maps app. On iPhone the app's own scheme is used and
  // NOTHING else is opened: iOS keeps the page in front while it asks "Open in
  // Google Maps?", so a timed fallback to the web link fired alongside the
  // question and sent the person to the app store instead. If the app is not
  // installed iOS says so itself. Elsewhere the web link is enough: Android
  // hands it to the app by itself.
  openLegInMaps(from, to){
    const web = this.buildGoogleLegUrl(from, to);
    if(!web){ Toast.show(t('toast_no_stop_location'),'error'); return; }
    if(!this._isIOS()){ window.open(web, '_blank', 'noopener'); return; }
    window.location.href = this.buildGoogleAppUrl(from, to);
  },

  // A position far from home is almost always a wrong lookup (a street name
  // that also exists in another city), and it sends the map to the wrong town.
  // Returns the distance in km when it is suspicious, else 0.
  FAR_KM: 60,
  suspiciousDistanceKm(id){
    const c = state.coords && state.coords[id];
    const h = state.coords && state.coords['home'];
    if(!Scheduler.validCoord(c) || !Scheduler.validCoord(h)) return 0;
    const km = Scheduler.haversineKm(h, c);
    return km > this.FAR_KM ? km : 0;
  },

  buildGoogleStopUrl(id, address){
    const pt = this._mapPoint(id, address);
    if(!pt) return null;
    // URLSearchParams, not string concatenation: an address containing & or #
    // would otherwise inject parameters into the link.
    return 'https://www.google.com/maps/dir/?' +
      new URLSearchParams({ api:'1', travelmode:'driving', destination: pt }).toString();
  },

  openStopInMaps(day, idx){
    const slots = (state.schedule[day]||[]).sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    const stop = this._mergeConsecutiveRouteStops(slots)[idx];
    if(!stop) return;
    const merged = this._mergeConsecutiveRouteStops(slots);
    const prev = idx > 0 ? { id: merged[idx-1].studentId, address: merged[idx-1].address } : null;
    this.openLegInMaps(prev, { id: stop.studentId, address: stop.address });
  },

  // Say plainly when a day's driving is longer than the stops require.
  //
  // The scheduler already tries to untangle each day, so whatever is left is
  // forced by when people are actually free — which is worth telling the user,
  // because they are the only one who can change it (move a lesson, widen a
  // window).
  _detourNoteHtml(slots){
    if(!slots || slots.length < 3) return '';
    let d;
    try{ d = Scheduler.dayDetour(slots, state.routeDay, state.settings); }catch(e){ return ''; }
    if(!d || !d.best || d.ratio < 1.15) return '';
    const extra = d.km - d.best;
    if(extra < 1) return '';
    return `<div style="margin:0 16px 8px;background:rgba(217,119,6,.07);border:1px solid rgba(217,119,6,.25);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--orange,#d97706);line-height:1.45">
      ${tf('route_detour_note',{km:extra.toFixed(1), pct:Math.round((d.ratio-1)*100)})}
    </div>`;
  },

  buildStopList(stops, hasReal, back){
    let html = `
      <div class="stop-item">
        <div class="stop-num home">${ico('home', 16)}</div>
        <div class="stop-info">
          <div class="stop-name">${t('route_start')}</div>
          <div class="stop-addr">${esc(state.settings.homeAddress||t('route_home_label'))}</div>
        </div>
      </div>
      <div class="stop-connector" style="margin-left:29px"></div>
    `;
    stops.forEach((stop, i) => {
      const travelRow = hasReal && stop.travelMin
        ? `<span class="stop-travel-row" style="color:var(--blue)">${stop.travelMin}${t('unit_min')} ${t('route_driving_suffix')} · ${Number(stop.travelKm||0).toFixed(1)}km</span>` : '';
      const displayEnd = stop._mergedEnd || stop._end || stop.end;
      const mergeTag = stop._mergedCount>1 ? `<span class="merge-badge" style="margin-left:6px">${stop._mergedCount}×${stop.duration}${t('unit_min')}</span>` : '';
      html += `
        <div class="stop-item" data-swipe="slot:${state.routeDay}:${esc(stop.studentId)}:${stop.start}:${stop._mergedEnd||stop.end}" style="background:var(--bg)">
          <div class="stop-num">${i+1}</div>
          <div class="stop-info">
            <div class="stop-name">${esc(stop.studentName||'—')}${mergeTag}</div>
            <div class="stop-addr">${esc(stop.address||'—')}</div>
            <div class="stop-travel"><span class="stop-travel-row">${ico('clock', 12)} ${t('route_arrival_label')} ${stop._start||stop.start} – ${displayEnd}${subjectText(stop.subject) ? ' · ' + esc(subjectText(stop.subject)) : ''}</span>${travelRow}</div>
            <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:11px;padding:3px 9px;margin-top:6px"
              onclick="App.openStopInMaps(${state.routeDay},${i})">${ico('map', 12)} Google Maps</button>
          </div>
        </div>
        ${i<stops.length-1?'<div class="stop-connector" style="margin-left:29px"></div>':''}
      `;
    });
    html += `
      <div class="stop-connector" style="margin-left:29px"></div>
      <div class="stop-item">
        <div class="stop-num home">${ico('home', 16)}</div>
        <div class="stop-info">
          <div class="stop-name">${t('route_return')}</div>
          <div class="stop-addr">${esc(state.settings.homeAddress||t('route_home_label'))}</div>
          ${back && back.km!=null && stops.length ? `<div class="stop-travel"><span class="stop-travel-row" style="color:var(--blue)">${back.min||0}${t('unit_min')} ${t('route_driving_suffix')} · ${Number(back.km||0).toFixed(1)}km</span></div>` : ''}
        </div>
      </div>
    `;
    return html;
  },

  async calcRoute(){
    const btn = document.getElementById('calc-route-btn');
    const day = state.routeDay;
    const slots = (state.schedule[day]||[]).sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start));
    if(btn){ btn.innerHTML='<span class="spinner"></span>'; btn.disabled=true }

    try{
      // Use the same provider the scheduler uses. This screen previously
      // hardcoded Nominatim + OSRM even when a HERE key was configured, so the
      // distances/times shown here were computed by a different engine (and
      // without traffic) than the ones the schedule was actually built from —
      // two different answers for the same journey.
      const hereKey = getHereKey();
      const geo = (addr)=> Router.geocode(addr);
      // Nominatim's public server requires ~1 req/sec. HERE has no such limit,
      // and neither does the proxy — it caches and paces on its own side.
      const geoPause = hereAvailable() ? 0 : 1100;

      if(!state.coords['home']){
        const c = await geo(state.settings.homeAddress);
        if(c){ state.coords['home']=c; Storage.saveCoords(state.coords) }
        if(geoPause) await new Promise(r=>setTimeout(r,geoPause));
      }
      for(const slot of slots){
        if(!state.coords[slot.studentId]){
          const c = await geo(slot.address);
          if(c){ state.coords[slot.studentId]=c; Storage.saveCoords(state.coords) }
          if(geoPause) await new Promise(r=>setTimeout(r,geoPause));
        }
      }

      const homeC = state.coords['home'] || Scheduler.coordsHash(state.settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα');

      // Real road matrix. With a HERE key this is traffic-aware for the day
      // actually being viewed (Saturday routes at off-peak, weekdays at the
      // afternoon peak, matching how the schedule was planned); OSRM is the
      // traffic-free fallback.
      const allCoords = [homeC, ...slots.map(s=>state.coords[s.studentId]||Scheduler.coordsHash(s.address))];
      let matrix = null;
      // hereAvailable(), not hereKey: with the proxy there is no key in the
      // browser at all, so gating on the key sent the Route screen to OSRM while
      // the schedule itself had been planned with HERE's traffic times — two
      // different figures for the same drive.
      if(hereAvailable() && allCoords.length >= 2){
        const dep = new Date();
        if(Number(day)>=6) dep.setHours(11,0,0,0); else dep.setHours(17,0,0,0);
        matrix = await Router.getHereMatrix(allCoords, hereKey, dep.toISOString()).catch(()=>null);
      }
      if(!matrix) matrix = await Router.getMatrix(allCoords);

      let orderedSlots, totalKm=0, totalMin=0;
      if(matrix && matrix.durations){
        // Visit order follows the already-scheduled lesson times (`slots` is
        // sorted chronologically), NOT a shortest-driving-route reorder —
        // lesson times are fixed, so "visit the geographically nearest stop
        // next" is meaningless when it would mean showing up before or long
        // after that lesson's actual scheduled time. allCoords[i+1]
        // corresponds to slots[i] index-for-index (allCoords[0] is home).
        orderedSlots = slots;
        const processedStops=[];
        let prevIdx=0; // home
        for(let i=0;i<orderedSlots.length;i++){
          const toIdx=i+1;
          const tMin = Math.round((matrix.durations[prevIdx][toIdx]||0)/60);
          const tKm  = ((matrix.distances?.[prevIdx]?.[toIdx]||0)/1000);
          totalMin += tMin; totalKm += tKm;
          processedStops.push({...orderedSlots[i], travelMin:tMin, travelKm:tKm.toFixed(1)});
          prevIdx = toIdx;
        }
        // Arrival time = previous stop's departure + real travel time + 2 min buffer
        // (first stop keeps its originally scheduled start as the anchor)
        for(let i=0;i<processedStops.length;i++){
          if(i===0){
            processedStops[i]._start = processedStops[i].start;
            processedStops[i]._end = processedStops[i].end;
          } else {
            const prevEndMin = Scheduler.toMin(processedStops[i-1]._end);
            const arrivalMin = prevEndMin + (processedStops[i].travelMin||0) + 2;
            processedStops[i]._start = Scheduler.toTime(arrivalMin);
            processedStops[i]._end = Scheduler.toTime(arrivalMin + processedStops[i].duration);
          }
        }
        // Return home
        const returnKm = (matrix.distances?.[prevIdx]?.[0]||0)/1000;
        const returnMin = Math.round((matrix.durations[prevIdx][0]||0)/60);
        totalKm += returnKm;
        totalMin += returnMin;

        const fuel=state.settings.fuelConsumption||7;
        state.routeResults[day] = {
          stops: processedStops, totalKm, totalMinutes: totalMin, returnKm, returnMin,
          fuelCost: (totalKm/100*fuel*this.fuelPrice()).toFixed(2),
          _key: this.dayKey(day)
        };
      } else {
        // Fallback: NN with estimate
        // Same fixed-chronological-order rule as the matrix path above.
        orderedSlots=slots;
        let prev=homeC;
        const ps=[];
        for(const sl of orderedSlots){
          const c=state.coords[sl.studentId]||Scheduler.coordsHash(sl.address);
          const km=Router.estimateKm(prev,c);
          totalKm+=km; totalMin+=Math.round(km/30*60);
          ps.push({...sl,travelMin:Math.round(km/30*60),travelKm:km.toFixed(1)});
          prev=c;
        }
        // Arrival time = previous stop's departure + estimated travel + 2 min buffer
        for(let i=0;i<ps.length;i++){
          if(i===0){
            ps[i]._start = ps[i].start;
            ps[i]._end = ps[i].end;
          } else {
            const prevEndMin = Scheduler.toMin(ps[i-1]._end);
            const arrivalMin = prevEndMin + (ps[i].travelMin||0) + 2;
            ps[i]._start = Scheduler.toTime(arrivalMin);
            ps[i]._end = Scheduler.toTime(arrivalMin + ps[i].duration);
          }
        }
        const returnKm=Router.estimateKm(prev,homeC), returnMin=Math.round(returnKm/30*60);
        totalKm+=returnKm; totalMin+=returnMin;
        const fuel=state.settings.fuelConsumption||7;
        state.routeResults[day]={stops:ps,totalKm,totalMinutes:totalMin,returnKm,returnMin,fuelCost:(totalKm/100*fuel*this.fuelPrice()).toFixed(2),_key:this.dayKey(day)};
      }
    }catch(e){
      Toast.show(t('toast_calc_error'),'error');
    }

    if(btn){ btn.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 10-16 0c0 3 2.7 6.9 8 11.7z"/></svg> ${t('route_calc')}`; btn.disabled=false }
    this.renderRoute();
  },

  // ---- SETTINGS ----
  renderSettings(){
    const s = document.getElementById('screen-settings');
    const st = state.settings;
    const allDays = [1,2,3,4,5,6,7];

    const blockedHtml = (st.blockedSlots||[]).length===0
      ? `<p style="font-size:13px;color:var(--text3);padding:8px 0">${t('no_blocked_times')}</p>`
      : (st.blockedSlots||[]).map((b,i)=>`
          <div class="blocked-slot">
            <div class="blocked-slot-info">
              <div class="blocked-slot-time">${b.start} – ${b.end}</div>
              <div class="blocked-slot-day">${DAYS_FULL[b.day]}</div>
            </div>
            <button class="btn-icon" onclick="App.deleteBlock(${i})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`).join('');

    s.innerHTML = `
      <div class="topbar">
        <div class="topbar-inner">
          <div>
            <div class="logo">Route<span>Pal</span></div>
            <div class="topbar-sub">${t('settings_title')}</div>
          </div>
        </div>
      </div>

      <div class="section-title">${t('settings_personal')}</div>
      <div class="card">
        <div class="form-group" style="margin-bottom:10px">
          <label>${t('settings_name')}</label>
          <input type="text" id="set-name" value="${esc(st.teacherName||'')}" placeholder="${t('settings_name_placeholder')}">
        </div>
        <div class="form-group" style="margin:0;position:relative">
          <label>${t('settings_home_address')}
            <span id="set-home-geo-status">${this._homeGeoStatusHtml()}</span>
          </label>
          <div style="display:flex;gap:6px">
            <input type="text" id="set-home" value="${esc(st.homeAddress||'')}" placeholder="${t('settings_home_placeholder')}" autocomplete="off" style="flex:1"
              oninput="App.onAddrInput(this.value,'set-home-suggest')" onkeydown="App.onAddrKey(event,'set-home-suggest')" onblur="setTimeout(()=>App.hideAddrSuggest('set-home-suggest'),200)">
            <button type="button" class="btn-icon" title="${esc(t('gps_here'))}" onclick="App.hereNow('set-home')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
          </button>
          <button type="button" class="btn-icon" title="${t('form_pick_on_map')}" onclick="App.openMapPicker('set-home')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            </button>
          </div>
          <div id="set-home-suggest" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:220px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
          <button type="button" class="chip chip-gray" id="set-map-btn" aria-pressed="false" style="border:none;cursor:pointer;margin-top:8px;min-height:32px"
            onclick="App.toggleHomeMap()">${ico('map', 14)} ${esc(t('form_map_show'))}</button>
          <div id="set-home-wrap" style="display:none">
          <div id="set-home-map" style="height:170px;border-radius:10px;overflow:hidden;background:var(--bg3);position:relative;isolation:isolate;margin-top:8px"></div>
          </div>
        </div>
      </div>

      <div class="section-title">${t('settings_workdays')}</div>
      <div class="card">
        <div class="day-toggles">
          ${allDays.map(d=>`
            <div class="day-toggle ${st.workDays.includes(d)?'on':''}" id="wday-${d}" onclick="App.toggleWorkDay(${d})">${DAYS[d]}</div>
          `).join('')}
        </div>
      </div>

      <div class="section-title">${t('settings_hours_per_day')}</div>
      <div class="card">
        <div class="settings-sub" style="margin-bottom:6px">${esc(t('settings_split_hint'))}</div>
        ${allDays.filter(d=>st.workDays.includes(d)).map(d=>`
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="width:36px;font-size:13px;font-weight:600;color:var(--text2)">${DAYS[d]}</span>
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px" id="dh-rows-${d}">
              ${(this.dayIntervals(d).length ? this.dayIntervals(d) : [{start:'',end:''}])
                .map((iv,k)=>this._dayIntervalRowHtml(d,k,iv)).join('')}
            </div>
          </div>
          <button class="chip chip-gray" style="border:none;cursor:pointer;font-size:12px;padding:6px 10px;min-height:36px;margin:4px 0 6px 46px"
            onclick="App.addDayInterval(${d})">＋ ${esc(t('settings_add_interval'))}</button>
          ${!st.dayHours?.[d] ? `<p style="font-size:12px;color:var(--orange);padding:2px 0 6px">${tf('settings_day_hours_missing',{day:DAYS_FULL[d]})}</p>` : ''}`).join('')}
        <p id="no-workdays" style="font-size:13px;color:var(--text3);padding:8px 0;display:${st.workDays.length===0?'block':'none'}">${t('settings_workday_hint')}</p>
      </div>

      <div class="card">
        <div class="form-group" style="margin:0">
          <label>${t('settings_spacing_label')}</label>
          <select id="set-spacing">
            <option value="strict" ${st.avoidConsecutiveDays==='strict'?'selected':''}>${t('spacing_strict')}</option>
            <option value="1" ${st.avoidConsecutiveDays!==false&&st.avoidConsecutiveDays!=='strict'?'selected':''}>${t('spacing_yes')}</option>
            <option value="0" ${st.avoidConsecutiveDays===false?'selected':''}>${t('spacing_no')}</option>
          </select>
          <div class="settings-sub">${t('settings_spacing_hint')}</div>
        </div>
      </div>

      <div style="padding:16px 16px 4px">
        <button class="btn btn-primary btn-full" onclick="App.saveSettings()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          ${t('settings_save')}
        </button>
      </div>

      ${Feedback.buttonHtml()}
      <details id="set-more" class="fold fold-plain" style="margin:8px 16px 0" ontoggle="state.settingsMoreOpen=this.open" ${state.settingsMoreOpen ? 'open' : ''}>
        <summary>${t('settings_more')}</summary>
      <div style="margin:0 -16px">
      <div class="section-title">${t('settings_profession')}</div>
      <div class="card">
        <div class="form-group" style="margin:0">
          <select id="set-profession" onchange="App.setProfession(this.value)">
            ${getProfessions().map(p=>`<option value="${p.value}" ${(st.profession||'other')===p.value?'selected':''}>${p.label}</option>`).join('')}
          </select>
          <div class="settings-sub" style="margin-top:6px">${esc(Professions.summary(st.profession||'other'))}</div>
          <button type="button" class="btn btn-secondary btn-full" style="margin-top:8px" onclick="App.offerProfessionPreset(state.settings.profession||'other')">${esc(t('prof_suggested_btn'))}</button>
        </div>
        <div class="form-group" style="margin:12px 0 0">
          <label for="set-durs">${t('prof_durations_label')}</label>
          <input type="text" id="set-durs" inputmode="numeric" value="${esc((st.durationChoices||[]).join(', '))}" placeholder="${esc(Professions.preset(st.profession).durations.join(', '))}">
          <div class="settings-sub" style="margin-top:4px">${t('prof_durations_hint')}</div>
        </div>
        <div class="form-group" style="margin:12px 0 0">
          <label for="set-remind">${t('remind_before_label')}</label>
          <select id="set-remind">
            ${[15,30,60,120,1440].map(n=>`<option value="${n}" ${App.remindMin()===n?'selected':''}>${t('remind_before_'+n)}</option>`).join('')}
          </select>
          <div class="settings-sub" style="margin-top:4px">${t('remind_before_hint')}</div>
        </div>
        <div class="form-group" style="margin:12px 0 0">
          <label for="set-change-msg">${t('settings_notify_label')}</label>
          <textarea id="set-change-msg" rows="4" placeholder="${esc(t('notify_msg_default'))}">${esc(st.changeMessage||'')}</textarea>
          <div class="settings-sub" style="margin-top:4px">${t('settings_notify_hint')}</div>
        </div>
        <div class="form-group" style="margin:12px 0 0">
          <label for="set-perweek">${t('prof_perweek_label')}</label>
          <select id="set-perweek">
            ${[1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${Professions.defaultPerWeek(st)===n?'selected':''}>${n}×</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="section-title">${t('settings_personal')}</div>
      <div class="card">
        <div class="form-group" style="margin-bottom:10px">
          <label>${t('settings_country_code')}</label>
          <input type="text" id="set-country-code" inputmode="numeric" value="${esc(st.countryCode||'30')}" placeholder="30">
          <div class="settings-sub" style="margin-top:4px">${t('settings_country_code_hint')}</div>
        </div>
        <div class="form-group" style="margin:0">
          <label>${t('settings_workplace')}</label>
          <input type="text" id="set-workplace" value="${esc(st.workplaceAddress||'')}" placeholder="${esc(t('settings_workplace_ph'))}" autocomplete="off">
          <div class="settings-sub" style="margin-top:4px">${t('settings_workplace_hint')}</div>
        </div>
      </div>

      <div class="section-title">${t('settings_hours_per_day')}</div>
      <div class="card">
        <div class="form-group" style="margin:0">
          <label>${t('settings_end_flex')}</label>
          <input type="number" id="set-end-flex" value="${Number(st.endFlexMin)||0}" min="0" max="60" step="5">
          <div class="settings-sub" style="margin-top:4px">${t('settings_end_flex_hint')}</div>
        </div>
        ${AiAssist.available() ? `<div class="form-group" style="margin:12px 0 0">
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="set-ai" ${AiAssist.on() ? 'checked' : ''}
            onchange="state.settings.aiAssist=this.checked;Storage.saveSettings(state.settings)"> ${t('settings_ai')}</label>
          <div class="settings-sub" style="margin-top:4px">${t('settings_ai_hint')}</div>
        </div>` : ''}
        ${Usage.available() ? `<div class="form-group" style="margin:12px 0 0">
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="set-usage" ${Usage.on() ? 'checked' : ''}
            onchange="Usage.setConsent(this.checked)"> ${t('settings_usage')}</label>
          <div class="settings-sub" style="margin-top:4px">${t('settings_usage_hint')}</div>
        </div>` : ''}
      </div>

      <div class="section-title">${t('settings_travel_fuel')}</div>
      <div class="card">
        <div class="form-row">
          <div class="form-group" style="margin:0">
            <label>${t('settings_fuel_consumption_label')}</label>
            <input type="number" id="set-fuel" value="${st.fuelConsumption||7}" min="3" max="25" step="0.5">
          </div>
          <div class="form-group" style="margin:0">
            <label>${t('settings_fuel_price_label')}</label>
            <input type="number" id="set-fuel-price" value="${Number(st.fuelPrice)||1.8}" min="0.5" max="5" step="0.01">
          </div>
        </div>
        <div class="form-group" style="margin:10px 0 0">
          <label for="set-fuel-type">${t('settings_fuel_type')}</label>
          <select id="set-fuel-type">
            ${['petrol','diesel','lpg'].map(k => `<option value="${k}" ${(st.fuelType||'petrol')===k?'selected':''}>${t('fuel_'+k)}</option>`).join('')}
          </select>
          <div class="settings-sub" style="margin-top:4px">${t('settings_fuel_type_hint')}</div>
        </div>
        <div class="form-group" style="margin:10px 0 0">
          <label>${t('settings_margin_label')}</label>
          <input type="number" id="set-margin" value="${st.travelMargin??3}" min="0" max="30">
        </div>
        <div class="form-group" style="margin:0">
          <label>${t('settings_lunch_label')}</label>
          <select id="set-lunch">
            <option value="0" ${st.lunchBreak===0?'selected':''}>${t('settings_lunch_none')}</option>
            <option value="30" ${st.lunchBreak===30?'selected':''}>${t('settings_lunch_30')}</option>
            <option value="60" ${st.lunchBreak===60?'selected':''}>${t('settings_lunch_60')}</option>
          </select>
        </div>
        <div class="form-group" style="margin:12px 0 0">
          <label>${t('settings_maxday_label')}</label>
          <select id="set-maxday">
            ${[0,2,3,4,5,6,8].map(n=>`<option value="${n}" ${(st.maxPerDay||0)===n?'selected':''}>${n?n:t('settings_maxday_none')}</option>`).join('')}
          </select>
          <div class="settings-sub">${t('settings_maxday_hint')}</div>
        </div>
      </div>

      <div class="section-title">${t('settings_blocked')}</div>
      <div class="card" id="blocked-list">
        ${blockedHtml}
      </div>
      <div style="padding:0 16px 4px">
        <button class="btn btn-secondary btn-full" onclick="App.openBlockDrawer()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          ${t('settings_add_block')}
        </button>
      </div>

      <div class="section-title">${t('settings_install')}</div>
      <div class="card">
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.5">${t('settings_install_desc')}</p>
        <button class="btn btn-secondary btn-full" onclick="App.openInSafari()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>
          ${t('settings_open_safari')}
        </button>
      </div>

      <div class="section-title">${t('settings_language')}</div>
      <div class="card">
        <select id="set-language" onchange="App.setLanguage(this.value)">
          <option value="el" ${curLang()==='el'?'selected':''}>🇬🇷 Ελληνικά</option>
          <option value="en" ${curLang()==='en'?'selected':''}>🇬🇧 English</option>
          <option value="fr" ${curLang()==='fr'?'selected':''}>🇫🇷 Français</option>
          <option value="de" ${curLang()==='de'?'selected':''}>🇩🇪 Deutsch</option>
        </select>
      </div>

      <div class="section-title">${t('settings_theme')}</div>
      <div class="card">
        <select id="set-theme" onchange="App.setTheme(this.value)">
          <option value="system" ${(state.settings.theme||'system')==='system'?'selected':''}>${t('theme_system')}</option>
          <option value="light" ${state.settings.theme==='light'?'selected':''}>${t('theme_light')}</option>
          <option value="dark" ${state.settings.theme==='dark'?'selected':''}>${t('theme_dark')}</option>
        </select>
      </div>

      <div class="section-title">${t('settings_quality_title')}</div>
      <div class="card">
        <select id="set-quality" onchange="App.setScheduleQuality(this.value)">
          <option value="quick" ${(state.settings.scheduleQuality||'quick')==='quick'?'selected':''}>${t('settings_quality_quick')}</option>
          <option value="thorough" ${state.settings.scheduleQuality==='thorough'?'selected':''}>${t('settings_quality_thorough')}</option>
        </select>
        <div class="settings-sub" style="margin-top:4px">${t('settings_quality_hint')}</div>
      </div>


      <div class="section-title">${t('sync_title')}</div>
      <div class="card">
        ${!Sync.available() ? `
          <p style="font-size:13px;color:var(--text3);margin:0">${t('sync_unavailable')}</p>
        ` : (()=>{ const sy = this.syncState(); return sy ? `
          <div style="font-size:12px;color:var(--text2);margin-bottom:6px">${
            sy.primary ? t('sync_this_is_primary') : t('sync_this_is_reader')}</div>
          <div style="font-family:ui-monospace,monospace;font-size:16px;letter-spacing:.06em;background:var(--bg3);border-radius:10px;padding:10px 12px;text-align:center;word-break:break-all">${
            esc(Sync.format(sy.code))}</div>
          <div class="settings-sub" style="margin:6px 0 10px">${
            tf('sync_last_push',{when: this.prettyWhen(sy.lastPush)})}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-secondary" style="flex:1;min-width:110px" onclick="App.copySyncCode()">${t('sync_copy_code')}</button>
            <button class="btn btn-primary" style="flex:1;min-width:110px" onclick="App.syncPush()">${t('sync_push')}</button>
            <button class="btn btn-secondary" style="flex:1;min-width:110px" onclick="App.syncPull()">${t('sync_pull')}</button>
          </div>
          <button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="App.rotateSyncCode()">${t('sync_rotate')}</button>
          <button class="btn btn-danger" style="width:100%;margin-top:8px" onclick="App.disableSync()">${t('sync_off')}</button>
        ` : `
          <p style="font-size:13px;color:var(--text2);margin:0 0 10px">${t('sync_intro')}</p>
          <button class="btn btn-primary" style="width:100%" onclick="App.enableSync()">${t('sync_enable')}</button>
          <div class="settings-sub" style="margin:14px 0 6px">${t('sync_join_hint')}</div>
          <div style="display:flex;gap:6px">
            <input type="text" id="sync-code-input" placeholder="ABCD-EFGH-..." autocomplete="off"
              style="flex:1;font-family:ui-monospace,monospace;letter-spacing:.05em">
            <button class="btn btn-secondary" onclick="App.joinSync()">${t('sync_join')}</button>
          </div>
        `; })()}
      </div>

      <div class="section-title">${t('settings_data')}</div>
      <div class="card">
        <button class="btn btn-danger btn-full" onclick="App.resetApp()" style="margin-bottom:10px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          ${t('settings_reset')}
        </button>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-secondary" style="flex:1" onclick="App.exportData()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            ${t('settings_export')}
          </button>
          <button class="btn btn-secondary" style="flex:1" onclick="App.importData()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            ${t('settings_import')}
          </button>
        </div>
        <div class="settings-sub" style="margin:14px 0 6px">${t('diag_hint')}</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1" onclick="App.exportDiagnostic()">${t('diag_btn')}</button>
          <button class="btn btn-secondary" style="flex:1" onclick="App.copyDiagnostic()">${t('diag_copy')}</button>
        </div>
        <button class="btn btn-danger btn-full" onclick="App.fullWipe()" style="margin-top:10px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          ${t('settings_full_wipe')}
        </button>
      </div>
      <div class="section-title">${t('privacy_title')}</div>
      <div class="card">
        <div class="settings-sub" style="line-height:1.6">${t('privacy_local')}</div>
        <div class="settings-sub" style="line-height:1.6;margin-top:8px">${t('privacy_services')}</div>
        <div class="settings-sub" style="line-height:1.6;margin-top:8px">${t('privacy_minors')}</div>
        <div class="settings-sub" style="line-height:1.6;margin-top:8px">${t('privacy_delete')}</div>
      </div>
      </div>
      </details>
      <p style="text-align:center;font-size:12px;color:var(--text3);margin:14px 16px 0">${esc(tf('copyright_line', { year: new Date().getFullYear() }))}</p>
      <div style="height:16px"></div>
    `;
    // With a known home position and a map key, the map is shown under the
    // address from the start; without one it waits to be asked for.
    if(Scheduler.validCoord(state.coords && state.coords.home) && this._googleMapsApiKey())
      setTimeout(() => this._openLocMap('set-home-wrap', () => this.toggleHomeMap()), 0);
  },

  // Opens a closed address map (no-op when already open).
  _openLocMap(wrapId, toggle){
    const w = document.getElementById(wrapId);
    if(w && w.style.display === 'none') toggle();
  },

  // The home map is built only when asked for, like the one in the client form.
  toggleHomeMap(){
    const wrap = document.getElementById('set-home-wrap');
    if(!wrap) return;
    const open = wrap.style.display === 'none';
    wrap.style.display = open ? '' : 'none';
    document.getElementById('set-map-btn')?.setAttribute('aria-pressed', String(open));
    if(!open) return;
    const el = document.getElementById('set-home-map');
    if(el && el.__google_map) setTimeout(() => google.maps.event.trigger(el.__google_map, 'resize'), 50);
    else this.initHomeLocationMap();
  },

  openInSafari(){
    const url = location.href;
    // x-safari-https:// / x-safari-http:// opens URL directly in Safari on iOS
    const safariUrl = url.replace(/^(https?):\/\//, (_, p) => `x-safari-${p}://`);
    window.location.href = safariUrl;
    // Fallback after 800ms: copy link to clipboard
    setTimeout(()=>{
      if(navigator.clipboard){ navigator.clipboard.writeText(url).catch(()=>{}) }
      Toast.show(t('toast_link_copied'),'info');
    }, 800);
  },

  toggleWorkDay(d){
    const el = document.getElementById('wday-'+d);
    const idx = state.settings.workDays.indexOf(d);
    if(idx>=0){
      if(state.settings.workDays.length<=1){ Toast.show(t('toast_need_workday'),'error'); return }
      state.settings.workDays.splice(idx,1);
      el.classList.remove('on');
    } else {
      state.settings.workDays.push(d);
      state.settings.workDays.sort();
      el.classList.add('on');
    }
    // Re-render the hours section
    this.renderSettings();
  },

  setProfession(p){
    state.settings.profession = p;
    Storage.saveSettings(state.settings);
    this.updateNavLabels();
    this.renderSettings();
    this.offerProfessionPreset(p);
  },

  // The profession's suggested hours, lengths and rules, only on a yes. The
  // person's clients are not touched; every value stays changeable.
  offerProfessionPreset(p){
    const name = (getProfessions().find(x => x.value === p) || {}).label || p;
    this.confirm(tf('prof_apply_title', { prof: name }), tf('prof_apply_text', { summary: Professions.summary(p) }), () => {
      Professions.apply(state.settings, p);
      Storage.saveSettings(state.settings);
      this.updateNavLabels();
      this.renderSettings();
      Toast.show(tf('prof_applied', { prof: name }), 'success', 5000);
    }, t('prof_apply_ok'), false);
  },

  setLanguage(lang){
    state.settings.language = lang;
    Storage.saveSettings(state.settings);
    applyLanguageArrays();
    this.updateNavLabels();
    this.renderSettings();
    Toast.show(t('toast_settings_saved'),'success');
  },

  setScheduleQuality(q){
    state.settings.scheduleQuality = q;
    Storage.saveSettings(state.settings);
    Toast.show(t('toast_applies_next_refresh'),'info');
  },

  async saveSettings(){
    // Changing settings (work days/hours especially) mid-calculation means
    // whatever's running is now computing against stale input — stop it and
    // restart fresh with the new settings, instead of blocking the save or
    // silently finishing a run the user no longer wants.
    const wasRunning = state._schedulingInProgress;
    if(wasRunning){
      // Wait for the running calculation to actually unwind before rewriting
      // the settings it is reading. 3s was far too short — the persistent
      // repair phase has a 7-minute budget and only checks for cancellation
      // between iterations, so the old run routinely survived the wait and
      // then kept scheduling against half-updated settings.
      this.cancelScheduling();
      const cancelStart=Date.now();
      while(state._schedulingInProgress && Date.now()-cancelStart<15000){ await new Promise(r=>setTimeout(r,50)); }
    }
    const s = state.settings;
    const prevHome = s.homeAddress;
    // toggleWorkDay mutates state.settings.workDays as soon as it is tapped, so
    // the previous working days only survive in what was last persisted.
    const persisted = Storage.loadSettings() || {};
    const prevDays  = Array.isArray(persisted.workDays) ? persisted.workDays.slice() : [];
    const prevHours = persisted.dayHours || {};
    s.teacherName = document.getElementById('set-name')?.value?.trim()||'';
    s.homeAddress = document.getElementById('set-home')?.value?.trim()||'';
    const prevWork = s.workplaceAddress || '';
    s.workplaceAddress = document.getElementById('set-workplace')?.value?.trim() || '';
    // Digits only — '+30' or '0030' here would end up doubled inside wa.me links.
    s.countryCode = (document.getElementById('set-country-code')?.value||'').replace(/\D/g,'')
      || (s.countryCode||'30');
    // Travel is by car; speed and map corrections are no longer the person's
    // to set. A value saved earlier is kept, not reset.
    s.travelMode  = 'car';
    s.fuelConsumption = Number(document.getElementById('set-fuel')?.value)||7;
    {
      const fp = Number(document.getElementById('set-fuel-price')?.value);
      if(fp > 0) s.fuelPrice = Math.min(5, fp);
      const ft = document.getElementById('set-fuel-type')?.value;
      if(['petrol','diesel','lpg'].includes(ft)) s.fuelType = ft;
    }
    s.travelMargin = Number(document.getElementById('set-margin')?.value)??3;
    {
      const sp = Number(document.getElementById('set-speed')?.value);
      if(sp > 0) s.avgCitySpeedKmh = sp;
    }
    // Entered as "% slower than the map", stored as a multiplier. An empty or
    // missing field keeps what was there: 0 is a legitimate answer (trust the
    // map) and must not be confused with "not filled in".
    {
      const raw = document.getElementById('set-time-factor')?.value;
      if(raw !== '' && raw != null && Number.isFinite(Number(raw)))
        s.osrmTimeFactor = 1 + Math.min(200, Math.max(0, Number(raw))) / 100;
    }
    // 0 is a real answer here, so ||0 would be wrong for any other value and
    // right for this one only by accident — clamp explicitly instead.
    {
      const f = Number(document.getElementById('set-end-flex')?.value);
      s.endFlexMin = Number.isFinite(f) ? Math.min(60, Math.max(0, f)) : 0;
    }
    // Το πεδίο αφαιρέθηκε: το κλειδί ζει πλέον στο backend. Ό,τι είχε ήδη
    // αποθηκευμένος χρήστης διατηρείται — η αφαίρεση ενός πεδίου δεν είναι
    // λόγος να πάψει να δουλεύει κάτι που δούλευε.
    s.hereApiKey = s.hereApiKey || '';
    s.lunchBreak = Number(document.getElementById('set-lunch')?.value)||0;
    s.maxPerDay = Number(document.getElementById('set-maxday')?.value)||0;
    { const el = document.getElementById('set-durs'); if(el){ const v = Professions.parseDurations(el.value); if(v) s.durationChoices = v; else delete s.durationChoices; } }
    { const el = document.getElementById('set-remind'); if(el) s.remindMin = Number(el.value) || 15; }
    { const el = document.getElementById('set-change-msg'); if(el){ const v = el.value.trim(); if(v) s.changeMessage = v.slice(0, 600); else delete s.changeMessage; } }
    { const el = document.getElementById('set-perweek'); if(el) s.defaultPerWeek = Number(el.value) || Professions.preset(s.profession).perWeek; }
    { const sp = document.getElementById('set-spacing'); if(sp) s.avoidConsecutiveDays = sp.value === 'strict' ? 'strict' : sp.value !== '0'; }

    // If home address changed, use the coord already resolved by autocomplete/
    // map-picker selection if we have one — avoids an extra geocode round-trip
    // and matches how student addresses are handled in saveStudent().
    if(s.homeAddress !== prevHome){
      if(this._homeAddrPendingCoord){
        state.coords['home'] = this._homeAddrPendingCoord;
      } else {
        delete state.coords['home'];
      }
      state.travelMatrix = null;
      state.travelMatrixPeak = null;
      state.travelMatrixOffPeak = null;
      Storage.saveCoords(state.coords);
    }
    this._homeAddrPendingCoord = null;
    if(s.workplaceAddress !== prevWork) this.syncWorkplace(true);

    // Day hours — one or several intervals per day.
    s.workDays.forEach(d=>{
      const rows = this.readDayIntervals(d).filter(iv=>iv.start && iv.end);
      if(rows.length) this.setDayIntervals(d, rows);
    });

    Storage.saveSettings(s);

    // Push the new hours through to everyone's availability.
    //
    // Days whose hours merely changed are recomputed straight away: the
    // student's exceptions are the truth, the window is only derived from them.
    // A day that has just been ADDED is different — nobody has ever said
    // anything about it, and quietly declaring every student free on a new
    // Saturday is exactly the kind of silent decision this app should not make.
    // So that one is asked.
    const sameHours = (a,b) => !!a === !!b && (!a || (a.start===b.start && a.end===b.end));
    const changedDays = s.workDays.filter(d => prevDays.includes(d) && !sameHours(prevHours[d], s.dayHours[d]));
    const addedDays   = s.workDays.filter(d => !prevDays.includes(d));
    try{
      const res = this.reapplyWorkingHours(changedDays);
      if(res.students) Toast.show(tf('toast_availability_updated',{n:res.students}),'info',6000);
    }catch(e){ console.error('reapplyWorkingHours failed', e); }
    if(addedDays.length && state.students.length){
      const names = addedDays.map(d=>DAYS_FULL[d]).join(', ');
      this.confirm(
        tf('confirm_new_workday_title',{days:names}),
        tf('confirm_new_workday_text',{n:state.students.length, days:names}),
        ()=>{
          try{
            const r2 = this.reapplyWorkingHours(addedDays);
            Toast.show(tf('toast_availability_updated',{n:r2.students}),'info',6000);
            state._scheduleStale = true;
            if(state.currentScreen==='home') this.renderHome();
          }catch(e){ console.error('reapplyWorkingHours failed', e); }
        },
        t('btn_apply'), false);
    }

    // Mark stale — don't auto-recalculate on an ordinary settings save. The
    // user regenerates explicitly via "Ανανέωση" whenever they're ready.
    // Exception: a calculation we just interrupted above DOES restart
    // automatically — the user was actively correcting input mid-run, not
    // idly tweaking a setting, so leaving them with a stale/cancelled
    // schedule and no calculation running would be a worse outcome.
    state._scheduleStale = true;
    if(state.currentScreen==='home') this.renderHome();
    Toast.show(t('toast_settings_saved'),'success');
    if(wasRunning) this.runAndNotify();
  },

  openBlockDrawer(){
    document.getElementById('drawer-block-body').innerHTML = `
      <div class="form-group">
        <label>${t('block_day_label')}</label>
        <select id="bl-day">
          ${[1,2,3,4,5,6,7].map(d=>`<option value="${d}">${DAYS_FULL[d]}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group" style="margin:0">
          <label>${t('block_from_label')}</label>
          <input type="time" id="bl-start" value="12:00">
        </div>
        <div class="form-group" style="margin:0">
          <label>${t('block_to_label')}</label>
          <input type="time" id="bl-end" value="14:00">
        </div>
      </div>
      <div class="form-group">
        <label>${t('block_reason_label')}</label>
        <input type="text" id="bl-reason" placeholder="${t('block_reason_placeholder')}">
      </div>
    `;
    document.getElementById('drawer-block-overlay').classList.add('open');
  },

  closeBlockDrawer(){
    document.getElementById('drawer-block-overlay').classList.remove('open');
  },

  saveBlock(){
    const day   = Number(document.getElementById('bl-day')?.value)||1;
    const start = document.getElementById('bl-start')?.value||'12:00';
    const end   = document.getElementById('bl-end')?.value||'14:00';
    const reason= document.getElementById('bl-reason')?.value?.trim()||'';
    if(Scheduler.toMin(end)<=Scheduler.toMin(start)){
      Toast.show(t('toast_end_after_start'),'error'); return
    }
    state.settings.blockedSlots = state.settings.blockedSlots||[];
    state.settings.blockedSlots.push({day,start,end,reason});
    Storage.saveSettings(state.settings);
    state._scheduleStale = true;
    this.closeBlockDrawer();
    this.renderSettings();
    if(state.currentScreen==='home') this.renderHome();
    Toast.show(t('toast_block_added'),'success');
  },

  deleteBlock(idx){
    state.settings.blockedSlots.splice(idx,1);
    Storage.saveSettings(state.settings);
    state._scheduleStale = true;
    this.renderSettings();
    if(state.currentScreen==='home') this.renderHome();
    Toast.show(t('toast_block_removed'),'info');
  },


  resetApp(){
    this.confirm(
      t('confirm_reset_title'),
      t('confirm_reset_text'),
      ()=>{
        Storage.clear();
        this.loadDemo();
        location.reload();
      }
    );
  },

  // A small, realistic example: ten visits around Patras with fixed
  // coordinates, so it works offline and needs no geocoding. Used by
  // "Load example" in Settings; it used to clear everything and load nothing.
  loadDemo(){
    const P=[['Μαρία Κ.','Ψηλαλώνια, Πάτρα',38.2440,21.7385,60,2],['Γιώργος Π.','Αγυιά, Πάτρα',38.2655,21.7475,45,2],
      ['Ελένη Σ.','Ρίο, Πάτρα',38.2985,21.7860,60,1],['Νίκος Δ.','Μποζαΐτικα, Πάτρα',38.2770,21.7640,45,2],
      ['Κατερίνα Μ.','Ζαρουχλέικα, Πάτρα',38.2300,21.7440,60,1],['Δημήτρης Α.','Περιβόλα, Πάτρα',38.2525,21.7560,45,2],
      ['Σοφία Λ.','Αγ. Ανδρέας, Πάτρα',38.2445,21.7255,60,1],['Αντώνης Τ.','Συχαινά, Πάτρα',38.2250,21.7560,45,1],
      ['Βασιλική Ρ.','Εγλυκάδα, Πάτρα',38.2410,21.7610,60,2],['Παναγιώτα Χ.','Κάστρο, Πάτρα',38.2445,21.7425,45,1]];
    const settings=Object.assign(defaultSettings(),state.settings||{});
    settings.homeAddress=settings.homeAddress||'Πλατεία Γεωργίου 1, Πάτρα';
    // After a wipe the settings carry no working hours, and with none the
    // scheduler has nowhere to put anyone. Give the example a normal week.
    if(!settings.dayHours||!Object.keys(settings.dayHours).length){
      settings.workDays=[1,2,3,4,5];
      settings.dayHours={};
      settings.workDays.forEach(d=>{settings.dayHours[d]={start:'15:00',end:'22:00'};});
    }
    state.settings=settings;
    const avail=this.computeAvailabilityFromExceptions([]);
    const students=P.map((x,i)=>({id:'demo'+i,name:x[0],address:x[1],phone:'',subject:'',lessonDuration:x[4],
      lessonsPerWeek:x[5],hoursPerWeek:x[5],type:'solo',group:'',pairedWith:null,notes:'',mergeMode:'off',forceMerge:false,
      availability:JSON.parse(JSON.stringify(avail)),availabilityMode:'exceptions',availabilityExceptions:[],color:i%10}));
    const coords={home:{lat:38.2466,lon:21.7346}};
    P.forEach((x,i)=>{coords['demo'+i]={lat:x[2],lon:x[3]};});
    Storage.saveSettings(settings);Storage.saveStudents(students);Storage.saveCoords(coords);Storage.saveSchedule({});
  },

  // Nukes EVERY localStorage key for this origin (not just the app's known Storage.KEYS),
  // including the onboarding flag — so the app truly restarts from a blank first-run state.
  fullWipe(){
    this.confirm(
      t('confirm_full_wipe_title'),
      t('confirm_full_wipe_text'),
      ()=>{
        localStorage.clear();
        location.reload();
      },
      t('settings_full_wipe')
    );
  },

  // What a backup file has to look like before any of it is believed.
  //
  // The old check was `data.students && data.settings` — both merely present.
  // Everything after it wrote straight to localStorage, so a file with students
  // as a string, or a student that is null, replaced the user's real data and
  // left an app that threw on the next calculation. Measured: five of seven
  // malformed shapes were accepted and then broke scheduling.
  //
  // Returns what is wrong; empty means the file is usable. Nothing is written
  // until it comes back empty, and a bad file is refused whole rather than
  // partly applied or quietly repaired — a backup whose contents the user has
  // to guess at is worse than one that was rejected.
  validateBackup(data){
    const bad = [];
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if(!isObj(data)) return [t('backup_not_an_object')];

    if(!Array.isArray(data.students)) bad.push(t('backup_students_not_list'));
    else data.students.forEach((st, i) => {
      if(!isObj(st)){ bad.push(tf('backup_student_bad',{n:i+1})); return; }
      if(typeof st.id !== 'string' || !st.id) bad.push(tf('backup_student_no_id',{n:i+1}));
      if(typeof st.name !== 'string') bad.push(tf('backup_student_no_name',{n:i+1}));
      const dur = Number(st.lessonDuration), per = Number(st.lessonsPerWeek);
      if(!(dur > 0 && dur <= 24*60)) bad.push(tf('backup_student_bad_duration',{name:st.name||i+1}));
      if(!(per > 0 && per <= 50)) bad.push(tf('backup_student_bad_count',{name:st.name||i+1}));
      if(st.availability != null && !isObj(st.availability))
        bad.push(tf('backup_student_bad_avail',{name:st.name||i+1}));
      // A non-string phone would be interpolated into a wa.me link as
      // "[object Object]" and silently send nowhere.
      if(st.phone != null && typeof st.phone !== 'string')
        bad.push(tf('backup_student_bad_phone',{name:st.name||i+1}));
    });

    if(data.jobs != null && !Array.isArray(data.jobs)) bad.push(t('backup_jobs_not_list'));

    if(!isObj(data.settings)) bad.push(t('backup_settings_bad'));
    else {
      const wd = data.settings.workDays;
      if(wd != null && (!Array.isArray(wd) || wd.some(d => !(Number(d) >= 1 && Number(d) <= 7))))
        bad.push(t('backup_workdays_bad'));
      if(data.settings.dayHours != null && !isObj(data.settings.dayHours))
        bad.push(t('backup_dayhours_bad'));
      if(data.settings.blockedSlots != null && !Array.isArray(data.settings.blockedSlots))
        bad.push(t('backup_blocked_bad'));
    }

    if(data.schedule != null && !isObj(data.schedule)) bad.push(t('backup_schedule_bad'));
    if(data.coords != null && !isObj(data.coords)) bad.push(t('backup_coords_bad'));
    return bad;
  },

  importData(){
    const input=document.createElement('input');
    input.type='file'; input.accept='.json';
    input.onchange=e=>{
      const file=e.target.files[0]; if(!file) return;
      const reader=new FileReader();
      reader.onload=ev=>{
        try{
          const data=JSON.parse(ev.target.result);
          // Check everything BEFORE touching a single stored value.
          const problems = this.validateBackup(data);
          if(problems.length){
            throw new Error(problems.slice(0,3).join(' · ') +
              (problems.length>3 ? tf('backup_and_more',{n:problems.length-3}) : ''));
          }
          state.students=data.students||[];
          state.jobs=Array.isArray(data.jobs)?data.jobs:(state.jobs||[]);
          state.settings=data.settings||defaultSettings();
          state.schedule=data.schedule||{};
          state.coords=data.coords||state.coords||{}; // keep existing if the backup predates coords export
          Storage.saveStudents(state.students);
          Storage.saveJobs(state.jobs);
          Storage.saveSettings(state.settings);
          Storage.saveCoords(state.coords);
          Storage.saveSchedule(state.schedule);
          // Restore exactly what was in the backup — recalculating here would
          // silently throw away the imported schedule and replace it with a
          // fresh one nobody asked for.
          this.renderSettings();
          this.renderHome();
          Toast.show(t('toast_import_success'),'success');
        }catch(err){ Toast.show(t('toast_error_prefix')+': '+err.message,'error'); }
      };
      reader.readAsText(file);
    };
    input.click();
  },

  // ---- DIAGNOSTIC EXPORT ----
  //
  // The ordinary backup contains names, addresses, phone numbers and notes —
  // other people's data, some of it about children. Sending that to get a bug
  // looked at would be handing it to someone with no need for it.
  //
  // This keeps what reproduces a scheduling problem (who is free when, how
  // long lessons are, where the schedule put them, roughly where everyone
  // lives) and drops everything that says WHO anyone is. Same shape as a
  // backup, so validateBackup accepts it and it loads as it is.

  /** Coordinates rounded to ~100m: enough for travel times, not a doorstep. */
  _coarse(c){
    if(!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return c;
    return { lat: Math.round(c.lat * 1000) / 1000, lon: Math.round(c.lon * 1000) / 1000 };
  },

  diagnosticSnapshot(){
    // One stable pseudonym per person, used everywhere they appear — in the
    // roster, the schedule, the coordinates, the pairings — so the structure
    // survives even though the identities do not.
    const alias = {}; let n = 0;
    const idOf = (id) => {
      if(id == null || id === '') return id;
      if(id === 'home') return 'home';
      if(!(id in alias)) alias[id] = 'c' + (++n);
      return alias[id];
    };
    const people = [...state.students, ...(state.jobs||[])];
    people.forEach(x => idOf(x.id));          // fix the numbering by roster order
    const groups = {}; let g = 0;
    const groupOf = (name) => name ? (groups[name] = groups[name] || ('g' + (++g))) : '';
    const nameOf = (id) => (alias[id] ? 'Πελάτης ' + alias[id].slice(1) : '');

    const students = state.students.map(st => ({
      id: idOf(st.id), name: nameOf(st.id), address: 'addr-' + idOf(st.id),
      subject: st.subject, lessonDuration: st.lessonDuration, lessonsPerWeek: st.lessonsPerWeek,
      type: st.type, group: groupOf(st.group), pairedWith: st.pairedWith ? idOf(st.pairedWith) : null,
      mergeMode: st.mergeMode, forceMerge: !!st.forceMerge, maxMergeSessions: st.maxMergeSessions,
      color: st.color, notes: '',
      availability: st.availability, availabilityMode: st.availabilityMode,
      availabilityExceptions: (st.availabilityExceptions||[]).map(e => ({ ...e })),
    }));

    const schedule = {};
    for(const d of Object.keys(state.schedule || {})){
      schedule[d] = (state.schedule[d] || []).map(sl => {
        const o = { studentId: idOf(sl.studentId), studentName: nameOf(sl.studentId),
          subject: sl.subject, address: 'addr-' + idOf(sl.studentId), color: sl.color,
          start: sl.start, end: sl.end, duration: sl.duration,
          mergedCount: sl.mergedCount, merged: !!sl.merged };
        if(sl.isGroup) o.isGroup = true;
        if(sl.pairedStudentId) o.pairedStudentId = idOf(sl.pairedStudentId);
        if(sl.groupMemberIds) o.groupMemberIds = sl.groupMemberIds.map(idOf);
        if(sl.groupCode) o.groupCode = groupOf(sl.groupCode);
        return o;
      });
    }

    const coords = {};
    for(const k of Object.keys(state.coords || {})) coords[idOf(k)] = this._coarse(state.coords[k]);

    // Settings that shape the schedule stay. Who the user is, where they live,
    // their keys and their sync code go.
    const keep = ['workDays','dayHours','travelMode','travelMargin','travelBuffer','lunchBreak','maxPerDay',
      'avgCitySpeedKmh','endFlexMin','profession','defaultLessonDuration','language'];
    const settings = {};
    keep.forEach(k => { if(state.settings[k] !== undefined) settings[k] = state.settings[k]; });
    settings.blockedSlots = (state.settings.blockedSlots || []).map(b => ({
      day: b.day, start: b.start, end: b.end, reason: '', ...(b.auto ? { auto: b.auto } : {}) }));

    const jobs = (state.jobs || []).map(j => ({
      id: idOf(j.id), name: nameOf(j.id), address: 'addr-' + idOf(j.id), phone: '',
      service: j.service, durationMin: j.durationMin, durationMax: j.durationMax,
      window: j.window || null, date: j.date, notes: '', done: !!j.done }));

    return { students, jobs, settings, schedule, coords,
      diagnostic: true, exportDate: new Date().toISOString() };
  },

  _diagnosticText(){ return JSON.stringify(this.diagnosticSnapshot(), null, 1); },

  exportDiagnostic(){
    const st = this.diagnosticSnapshot();
    this.confirm(t('diag_title'),
      tf('diag_text', { n: st.students.length }),
      async () => {
        const text = this._diagnosticText();
        const name = 'routepal-diagnostic.json';
        try{
          // On a phone the share sheet is the shortest path: straight into a
          // message, no file manager. Fall back to a download where it is not
          // offered (desktop browsers, most notably).
          const file = (typeof File === 'function') ? new File([text], name, { type:'application/json' }) : null;
          if(file && navigator.canShare && navigator.canShare({ files:[file] })){
            await navigator.share({ files:[file], title:'RoutePal' });
            return;
          }
        }catch(e){
          if(e && e.name === 'AbortError') return;    // the user closed the sheet
        }
        const blob = new Blob([text], { type:'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
        Toast.show(t('diag_saved'), 'success');
      }, t('diag_ok'), false);
  },

  copyDiagnostic(){
    this.copyText(this._diagnosticText());
  },

  exportData(){
    const data = {
      settings: state.settings,
      students: state.students,
      // Day-mode work lives in its own list and was missing from the backup,
      // so an export→import round trip used to drop every booked job.
      jobs: state.jobs||[],
      schedule: state.schedule,
      // Must be exported: importData overwrites state.coords from the file, so
      // omitting them here meant a normal export→import round trip silently
      // wiped every geocoded location (and re-geocoding is rate-limited).
      coords: state.coords,
      exportDate: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `routepal-export-${new Date().toLocaleDateString('el-GR').replace(/\//g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    Toast.show(t('toast_export_success'),'success');
  },

  // ---- CONFIRM ----
  // `danger` defaults to true because most confirmations here really are
  // destructive; pass false for the ones that only add data, so the user isn't
  // asked to press a red "Delete" to load demo students.
  // ---- FILLING A GAP BY HAND ----
  openGapFill(day, fromTime, toTime){
    const from = Scheduler.toMin(fromTime), to = Scheduler.toMin(toTime);
    const cands = Scheduler.gapCandidates(state.schedule, state.students, state.settings, day, from, to);
    state._gapFill = { day, cands };
    document.getElementById('gap-title').textContent = t('gap_who_fits');
    document.getElementById('gap-hint').textContent = tf('gap_who_hint',
      { day: DAYS_FULL[day] || '', from: fromTime, to: toTime });
    const list = document.getElementById('gap-list');
    const kindText = (c) => {
      if(c.kind === 'unplaced') return t('gap_kind_unplaced');
      if(c.kind === 'relocate')
        return tf('gap_kind_relocate', { day: DAYS_FULL[c.toDay] || '' }) +
          (c.cheaper ? '' : ' ' + t('gap_relocate_dearer'));
      return tf('gap_kind_move', { day: DAYS_FULL[c.fromDay] || '' });
    };
    // Why the lesson after the gap cannot simply go elsewhere. Without this a
    // refusal is indistinguishable from a bug, and nobody can tell which.
    const notes = (cands.relocateNotes || []).map(n =>
      `${DAYS_FULL[n.toDay] || ''}: ${t('gap_why_' + n.reason) }`).join(' · ');
    const notesHtml = notes
      ? `<p style="font-size:11px;color:var(--text3);margin:8px 0 0;line-height:1.5">${
          esc(tf('gap_why_not_head', { name: cands.afterName || '' }))} ${esc(notes)}</p>` : '';
    list.innerHTML = (cands.length ? cands.map((c, i) => `
      <button class="btn btn-secondary" style="width:100%;text-align:left;margin-bottom:8px;padding:10px 12px;display:block"
        onclick="App.applyGapFill(${i})">
        <div style="font-weight:600">${esc(c.name)} · ${esc(c.start)}–${esc(c.end)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${esc(kindText(c))}</div>
      </button>`).join('')
      : `<p style="font-size:13px;color:var(--text2);margin:0">${esc(t('gap_nobody'))}</p>`) + notesHtml;
    document.getElementById('gap-overlay').classList.add('open');
  },

  closeGapFill(){
    document.getElementById('gap-overlay')?.classList.remove('open');
    state._gapFill = null;
  },

  applyGapFill(idx){
    const g = state._gapFill;
    const cand = g && g.cands[idx];
    if(!cand) return;
    const ok = Scheduler.applyGapCandidate(state.schedule, state.students, state.settings, g.day, cand);
    this.closeGapFill();
    if(!ok){ Toast.show(t('gap_no_longer_fits'), 'error', 5000); return; }
    // Bringing a lesson over can leave a hole behind on the day it came from.
    if(cand.kind === 'move')
      Scheduler.gatherDays(state.schedule, state.students, state.settings,
        [cand.fromDay, g.day], new Set([cand.studentId]));
    // A relocated lesson lands on ANOTHER day than the gap: gather both, with
    // the moved lesson staying where the user just put it.
    if(cand.kind === 'relocate')
      Scheduler.gatherDays(state.schedule, state.students, state.settings,
        [g.day, cand.toDay], new Set([cand.studentId]));
    Storage.saveSchedule(state.schedule);
    Toast.show(tf('gap_filled', { name: cand.name, time: cand.start }), 'success');
    this.renderSchedule();
    this.renderHome();

    // The choice is on screen and saved; now give the rest of the week a short
    // second look. Skipped while a full calculation is running — two things
    // rewriting the schedule at once is how one of them gets lost.
    if(state._schedulingInProgress || state._refining) return;
    state._refining = true;
    Scheduler.refineExcept(state.schedule, state.students, state.settings,
      cand.kind === 'relocate' ? cand.toDay : g.day)
      .then(r => {
        if(r && r.adopted){
          Storage.saveSchedule(state.schedule);
          Toast.show(tf('gap_refined', { n: r.changed }), 'info');
          if(state.currentScreen === 'schedule') this.renderSchedule();
          this.renderHome();
        }
      })
      .catch(e => console.warn('refinement failed', e))
      .finally(() => { state._refining = false; });
  },

  // ---- SYNC ----
  // Enabling sync is the one moment data leaves the device, so it asks first
  // and says what the code means before anything is sent.

  /**
   * Πόσο καιρό έχει να σταλεί αντίγραφο.
   *
   * Δεν υπάρχει email για να ειδοποιηθεί κανείς πριν λήξουν οι 12 μήνες — δεν
   * κρατάμε στοιχεία επικοινωνίας, εσκεμμένα. Άρα η μόνη ειδοποίηση που μπορεί
   * να υπάρξει είναι μέσα στην ίδια την εφαρμογή, αρκετά νωρίς ώστε να προλάβει
   * ο χρήστης να κάνει κάτι.
   */
  SYNC_STALE_DAYS: 60,
  SYNC_EXPIRY_DAYS: 365,
  syncStaleDays(){
    const st = this.syncState();
    if(!st || !st.lastPush) return null;
    return Math.floor((Date.now() - st.lastPush) / 86400000);
  },

  syncState(){
    const st = state.settings.sync;
    return (st && st.code) ? st : null;
  },

  async enableSync(){
    if(!Sync.available()){ Toast.show(t('sync_unavailable'),'error'); return; }
    const code = Sync.randomCode();
    this.confirm(t('sync_enable_title'), tf('sync_enable_text',{code: Sync.format(code)}), async ()=>{
      try{
        const res = await Sync._call('create', { spaceId: Sync.spaceIdOf(code),
          authHash: await Sync.authHash(code), deviceId: Sync.deviceId() });
        if(!res.ok) throw new Error(res.data.error || ('HTTP ' + res.status));
        state.settings.sync = { code, version: 0, primary: true, lastPush: null };
        Storage.saveSettings(state.settings);
        Toast.show(t('sync_enabled'),'success');
        await this.syncPush();
        this.renderSettings();
      }catch(e){ Toast.show(t('sync_failed') + ': ' + e.message, 'error', 6000); }
    }, t('sync_enable_ok'), false);
  },

  async syncPush(opts){
    const st = this.syncState();
    if(!st) return;
    try{
      const blob = await Sync.encrypt(st.code, Sync.snapshot());
      const res = await Sync._call('push', { spaceId: Sync.spaceIdOf(st.code),
        authHash: await Sync.authHash(st.code), deviceId: Sync.deviceId(),
        blob, baseVersion: st.version || 0, takeOver: !!(opts && opts.takeOver) });

      if(res.status === 403){
        // Another device owns the write. Never resolve this silently.
        this.confirm(t('sync_not_primary_title'), t('sync_not_primary_text'),
          ()=>this.syncPush({ takeOver: true }), t('sync_take_over'), false);
        return;
      }
      if(res.status === 409){
        // Somebody wrote in between. Pushing over it would erase them.
        this.confirm(t('sync_conflict_title'),
          tf('sync_conflict_text',{ when: this.prettyWhen(res.data.updatedAt) }),
          ()=>this.syncPull({ force: true }), t('sync_take_theirs'), false);
        return;
      }
      if(!res.ok) throw new Error(res.data.error || ('HTTP ' + res.status));

      st.version = res.data.version;
      st.primary = true;
      st.lastPush = Date.now();
      Storage.saveSettings(state.settings);
      if(!(opts && opts.quiet)) Toast.show(t('sync_pushed'),'success');
    }catch(e){
      if(!(opts && opts.quiet)) Toast.show(t('sync_failed') + ': ' + e.message,'error',6000);
    }
  },

  async syncPull(opts){
    const st = this.syncState();
    if(!st) return;
    try{
      // Tell the server what we already have. If it matches, it sends no
      // data at all — opening the app five times a day should not download
      // the whole roster five times.
      const res = await Sync._call('pull', { spaceId: Sync.spaceIdOf(st.code),
        authHash: await Sync.authHash(st.code),
        knownVersion: (opts && opts.force) ? -1 : (st.version || 0) });
      if(!res.ok) throw new Error(res.data.error || ('HTTP ' + res.status));
      if(res.data.unchanged){
        st.primary = res.data.primaryDevice === Sync.deviceId();
        Storage.saveSettings(state.settings);
        if(!(opts && opts.quiet)) Toast.show(t('sync_up_to_date'),'info');
        return;
      }
      if(!res.data.blob){ Toast.show(t('sync_nothing_yet'),'info'); return; }

      const data = await Sync.decrypt(st.code, res.data.blob);
      // The same check a backup file goes through. Data from the network is
      // not more trustworthy than data from a file just because we encrypted
      // it — a bug on another device can write a broken snapshot.
      const problems = this.validateBackup(data);
      if(problems.length) throw new Error(problems.slice(0,2).join(' · '));

      const apply = ()=>{
        state.students = data.students || [];
        state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
        state.schedule = data.schedule || {};
        state.coords = data.coords || state.coords || {};
        // Keep this device's own sync record: it holds OUR device id and the
        // version we are now at, which the other device's copy does not.
        const mySync = state.settings.sync;
        state.settings = data.settings || state.settings;
        state.settings.sync = mySync;
        mySync.version = res.data.version;
        mySync.primary = res.data.primaryDevice === Sync.deviceId();
        Storage.saveStudents(state.students); Storage.saveJobs(state.jobs);
        Storage.saveSchedule(state.schedule); Storage.saveCoords(state.coords);
        Storage.saveSettings(state.settings);
        Toast.show(t('sync_pulled'),'success');
        this.renderSettings(); this.renderHome();
      };

      if(opts && opts.force) return apply();
      this.confirm(t('sync_pull_title'),
        tf('sync_pull_text',{ when: this.prettyWhen(res.data.updatedAt) }), apply,
        t('sync_pull_ok'), false);
    }catch(e){
      Toast.show(t('sync_failed') + ': ' + e.message,'error',6000);
    }
  },

  async joinSync(){
    const raw = document.getElementById('sync-code-input')?.value;
    const code = Sync.parse(raw);
    if(!code){ Toast.show(t('sync_bad_code'),'error'); return; }
    state.settings.sync = { code, version: 0, primary: false, lastPush: null };
    Storage.saveSettings(state.settings);
    await this.syncPull({ force: false });
    this.renderSettings();
  },

  /**
   * Change the code. Every other device that had the old one is locked out at
   * that moment — its key no longer opens the data.
   */
  async rotateSyncCode(){
    const st = this.syncState();
    if(!st) return;
    const next = Sync.randomCode();
    this.confirm(t('sync_rotate_title'), tf('sync_rotate_text',{code: Sync.format(next)}), async ()=>{
      try{
        // Re-encrypted here, under the NEW key, before anything is sent. A
        // rotation that changed the credential but not the data would leave a
        // blob nobody can read.
        const blob = await Sync.encrypt(next, Sync.snapshot());
        const res = await Sync._call('rotate', { spaceId: Sync.spaceIdOf(st.code),
          authHash: await Sync.authHash(st.code), newAuthHash: await Sync.authHash(next),
          blob, deviceId: Sync.deviceId(), baseVersion: st.version || 0 });
        if(res.status === 409){ Toast.show(t('sync_conflict_title'),'error',6000); return; }
        if(!res.ok) throw new Error(res.data.error || ('HTTP ' + res.status));
        // Only now, once the server has accepted it: storing the new code
        // before the call succeeded would lock this device out of its own data.
        st.code = next;
        st.version = res.data.version;
        st.primary = true;
        st.lastPush = Date.now();
        Storage.saveSettings(state.settings);
        Toast.show(t('sync_rotated'),'success');
        this.renderSettings();
      }catch(e){ Toast.show(t('sync_failed') + ': ' + e.message,'error',6000); }
    }, t('sync_rotate_ok'), false);
  },

  disableSync(){
    this.confirm(t('sync_off_title'), t('sync_off_text'), ()=>{
      delete state.settings.sync;
      Storage.saveSettings(state.settings);
      Toast.show(t('sync_off_done'),'info');
      this.renderSettings();
    }, t('sync_off_ok'));
  },

  copySyncCode(){
    const st = this.syncState();
    if(st) this.copyText(Sync.format(st.code));
  },

  prettyWhen(ms){
    if(!ms) return '—';
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? '—'
      : d.toLocaleString(curLang()==='el' ? 'el-GR' : 'en-GB',
          { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  },

  // ---- SENDING THE TIMES TO THE CLIENT ----
  // The schedule is only worth something once the other person knows it. This
  // is the handoff: compose the times as plain text, let the user edit it, and
  // hand it to WhatsApp, SMS or the clipboard. Nothing is sent from the app
  // itself — the messaging app the user already has does the sending, so there
  // is no gateway, no account and no delivery to get wrong.

  /**
   * Turn whatever the user typed into an international number for wa.me.
   * Returns '' when that cannot be done honestly — a wrong number sends the
   * message to a stranger, which is worse than showing no button.
   */
  normalizePhone(raw, cc){
    const txt = String(raw||'').trim();
    if(!txt) return '';
    // Letters mean it is not a phone number at all (e.g. a note in the field).
    if(/[a-zA-Zα-ωΑ-Ω]/.test(txt)) return '';
    const digits = txt.replace(/\D/g,'');
    if(!digits) return '';
    let intl;
    if(/^\+/.test(txt))        intl = digits;          // already international
    else if(/^00/.test(digits)) intl = digits.slice(2); // 00 prefix form
    else {
      const code = String(cc||'').replace(/\D/g,'');
      if(!code) return '';
      // A national trunk '0' is not part of the international number.
      intl = code + digits.replace(/^0+/,'');
    }
    // Shortest real international numbers are 8 digits; longest is 15 (E.164).
    return (intl.length >= 8 && intl.length <= 15) ? intl : '';
  },

  /** All of one client's placed lessons, as day-ordered text lines. */
  _weekTimeLines(studentId){
    const lines = [];
    for(const d of [1,2,3,4,5,6,7]){
      (state.schedule[d]||[])
        .filter(e => e.studentId===studentId || e.pairedStudentId===studentId ||
                     (e.groupMemberIds||[]).includes(studentId))
        .sort((a,b)=>Scheduler.toMin(a.start)-Scheduler.toMin(b.start))
        .forEach(e => lines.push(`${DAYS_FULL[d]||''} ${e.start}–${e.end}`));
    }
    return lines;
  },

  /** The one planned stop for a job on the current plan date. */
  _jobTimeLines(jobId){
    const stop = ((state.dayPlan||{}).stops||[]).find(x => x.job && x.job.id===jobId);
    if(!stop) return [];
    return [`${this.prettyDate(state.planDate||this.todayISO())}, ${stop.start}–${stop.end}`];
  },

  /**
   * The message body. Built here rather than in the sheet so it can be tested
   * without a DOM, and so both modes produce the same shape.
   */
  timesMessage(kind, id){
    const isJob = kind === 'job';
    const who = isJob
      ? (state.jobs||[]).find(j=>j.id===id)
      : state.students.find(s=>s.id===id);
    if(!who) return '';
    const lines = isJob ? this._jobTimeLines(id) : this._weekTimeLines(id);
    if(!lines.length) return '';
    const first = String(who.name||'').trim().split(/\s+/)[0] || '';
    const intro = tf(isJob?'send_job_intro':'send_intro', { name: first });
    const me = String(state.settings.teacherName||'').trim();
    return [intro, ...lines, me ? tf('send_sign',{name:me}) : ''].filter(Boolean).join('\n');
  },

  openSendSheet(kind, id){
    const text = this.timesMessage(kind, id);
    if(!text){ Toast.show(t('send_no_times'),'error'); return; }
    const who = kind==='job'
      ? (state.jobs||[]).find(j=>j.id===id)
      : state.students.find(s=>s.id===id);
    const intl = this.normalizePhone(who && who.phone, state.settings.countryCode);
    state.sendTarget = { raw: (who && who.phone) || '', intl, sid: kind === 'job' ? null : id };
    document.getElementById('send-title').textContent = t('send_title');
    document.getElementById('send-hint').textContent = intl ? t('send_hint') : t('send_no_phone');
    const ta = document.getElementById('send-text');
    if(ta) ta.value = text;
    for(const [btnId, on] of [['send-wa-btn', !!intl], ['send-sms-btn', !!state.sendTarget.raw]]){
      const b = document.getElementById(btnId);
      if(b){ b.disabled = !on; b.style.opacity = on ? '' : '.45'; }
    }
    document.getElementById('send-overlay').classList.add('open');
  },

  closeSendSheet(){
    document.getElementById('send-overlay')?.classList.remove('open');
    state.sendTarget = null;
  },

  // encodeURIComponent, never concatenation: a message containing & or # would
  // otherwise cut itself short or inject parameters into the link.
  waLink(intl, text){ return intl ? `https://wa.me/${intl}?text=${encodeURIComponent(text)}` : null },
  smsLink(raw, text){
    const num = String(raw||'').replace(/[^\d+]/g,'');
    // '?&body=' is the form both iOS and Android accept.
    return num ? `sms:${num}?&body=${encodeURIComponent(text)}` : null;
  },

  sendVia(how){
    const text = document.getElementById('send-text')?.value || '';
    const tgt = state.sendTarget || { raw:'', intl:'' };
    if(!text.trim()) return;
    if(how === 'copy'){
      this.copyText(text);
      this.closeSendSheet();
      return;
    }
    const url = how==='whatsapp' ? this.waLink(tgt.intl, text) : this.smsLink(tgt.raw, text);
    if(!url){ Toast.show(t('send_no_phone'),'error'); return; }
    if(tgt.sid) Notify.markTold(tgt.sid);
    this.closeSendSheet();
    try{
      if(how==='whatsapp') window.open(url, '_blank');
      else window.location.href = url;   // sms: must be a navigation, not a popup
    }catch(e){ Toast.show(t('send_copy_failed'),'error'); }
  },

  copyText(text){
    const done = () => Toast.show(t('send_copied'),'success');
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done).catch(()=>this._copyFallback(text));
        return;
      }
    }catch(e){}
    this._copyFallback(text);
  },
  _copyFallback(text){
    try{
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      Toast.show(ok ? t('send_copied') : t('send_copy_failed'), ok?'success':'error');
    }catch(e){ Toast.show(t('send_copy_failed'),'error'); }
  },

  confirm(title, text, cb, okLabel, danger=true){
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const ok = document.getElementById('confirm-ok-btn');
    ok.textContent = okLabel || t('btn_delete');
    ok.classList.toggle('btn-danger', !!danger);
    ok.classList.toggle('btn-primary', !danger);
    state.confirmCallback = cb;
    document.getElementById('confirm-overlay').classList.add('open');
  },
  confirmAccept(){
    document.getElementById('confirm-overlay').classList.remove('open');
    if(state.confirmCallback) state.confirmCallback();
    state.confirmCallback = null;
  },
  confirmReject(){
    document.getElementById('confirm-overlay').classList.remove('open');
    state.confirmCallback = null;
  },

  // ---- ONBOARDING ----
  showOnboarding(){
    const ov = document.createElement('div');
    ov.id = 'onboard-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:var(--bg,#f7f6f3);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 24px;overflow-y:auto';
    ov.innerHTML = `
      <div style="max-width:400px;width:100%">
        <div style="font-family:Syne,sans-serif;font-size:28px;font-weight:800;margin-bottom:6px">Route<span style="color:var(--green)">Pal</span></div>
        <div style="font-size:15px;color:var(--text2,#64748b);margin-bottom:32px">${t('onboarding_welcome')}</div>

        <div style="margin-bottom:20px">
          <label style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.05em;display:block;margin-bottom:8px">${t('onboarding_profession_label')}</label>
          <select id="ob-prof-select" onchange="App._obProf=this.value" style="width:100%;padding:12px 14px;border:2px solid var(--border,#e2e0da);border-radius:12px;font-size:14px;background:var(--bg2,#fff);color:var(--text,#1c1c2e)">
            ${getProfessions().map(p=>`<option value="${p.value}" ${p.value==='other'?'selected':''}>${p.label}</option>`).join('')}
          </select>
        </div>

        <div style="margin-bottom:20px">
          <label style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.05em;display:block;margin-bottom:8px">${t('ob_where')}</label>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px" id="ob-mode-grid">
            ${[['clients','ob_mode_clients'],['place','ob_mode_place'],['both','ob_mode_both']].map(([m,k],i)=>`
              <button type="button" onclick="App._obSelectMode('${m}',this)" aria-pressed="${i===0}" style="min-height:48px;padding:10px 6px;border:2px solid ${i===0?'var(--green)':'var(--border,#e2e0da)'};border-radius:12px;background:var(--bg2,#fff);font-size:13px;font-weight:600;cursor:pointer;color:var(--text,#1c1c2e)">${t(k)}</button>`).join('')}
          </div>
          <div id="ob-work-wrap" style="display:none;margin-top:12px">
            <label for="ob-work" style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.05em;display:block;margin-bottom:8px">${t('settings_workplace')}</label>
            <div style="position:relative">
              <div style="display:flex;gap:6px">
                <input id="ob-work" type="text" placeholder="${esc(t('settings_workplace_ph'))}" autocomplete="off"
                  style="flex:1;min-width:0;padding:12px 14px;border:2px solid var(--border,#e2e0da);border-radius:12px;font-size:14px;background:var(--bg2,#fff);color:var(--text,#1c1c2e)"
                  oninput="App.onAddrInput(this.value,'ob-work-suggest')" onkeydown="App.onAddrKey(event,'ob-work-suggest')" onblur="setTimeout(()=>App.hideAddrSuggest('ob-work-suggest'),200)">
                <button type="button" class="btn-icon" title="${esc(t('gps_here'))}" aria-label="${esc(t('gps_here'))}" onclick="App.hereNow('ob-work')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
                </button>
                <button type="button" class="btn-icon" title="${esc(t('form_pick_on_map'))}" aria-label="${esc(t('form_pick_on_map'))}" onclick="App.openMapPicker('ob-work')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                </button>
              </div>
              <div id="ob-work-suggest" style="display:none;background:var(--bg2,#fff);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:180px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
            </div>
          </div>
        </div>

        <div style="margin-bottom:28px">
          <label style="font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.05em;display:block;margin-bottom:8px">${t('onboarding_address_label')}</label>
          <div style="position:relative">
            <div style="display:flex;gap:6px">
              <input id="ob-addr" type="text" placeholder="${t('form_address_placeholder')}" autocomplete="off"
                style="flex:1;padding:12px 14px;border:2px solid var(--border,#e2e0da);border-radius:12px;font-size:14px;background:var(--bg2,#fff);color:var(--text,#1c1c2e)"
                oninput="App.onAddrInput(this.value,'ob-addr-suggest')" onkeydown="App.onAddrKey(event,'ob-addr-suggest')" onblur="setTimeout(()=>App.hideAddrSuggest('ob-addr-suggest'),200)">
              <button type="button" class="btn-icon" title="${esc(t('gps_here'))}" onclick="App.hereNow('ob-addr')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
          </button>
          <button type="button" class="btn-icon" title="${t('form_pick_on_map')}" onclick="App.openMapPicker('ob-addr')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
              </button>
            </div>
            <div id="ob-addr-suggest" style="display:none;background:var(--bg2,#fff);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:180px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>
          </div>
        </div>

        <button onclick="App._obFinish()" style="width:100%;padding:16px;background:var(--green);color:var(--on-accent);border:none;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;font-family:Syne,sans-serif">
          ${t('onboarding_start_btn')}
        </button>
        <button onclick="App._obFinish(true)" style="width:100%;min-height:48px;margin-top:10px;padding:12px;background:transparent;color:var(--text2);border:2px solid var(--border,#e2e0da);border-radius:14px;font-size:14px;font-weight:600;cursor:pointer">
          ${t('demo_try')}
        </button>
      </div>
    `;
    document.body.appendChild(ov);
    this._obProf = 'other';
    this._obMode = 'clients';
    this._obDur = 60;
    this._obCoord = null;
    this._obWorkCoord = null;
  },

  _obSelectDur(d, btn){
    this._obDur = d;
    document.querySelectorAll('#ob-dur-grid button').forEach(b=>{ b.style.borderColor='var(--border,#e2e0da)'; b.style.background='var(--bg2,#fff)'; b.style.color='var(--text,#1c1c2e)'; });
    btn.style.borderColor='#7c3aed'; btn.style.background='rgba(var(--accent2-rgb),.08)'; btn.style.color='#7c3aed';
  },

  _obSelectMode(mode, btn){
    this._obMode = mode;
    document.querySelectorAll('#ob-mode-grid button').forEach(b=>{ b.style.borderColor='var(--border,#e2e0da)'; b.setAttribute('aria-pressed','false'); });
    btn.style.borderColor = 'var(--green)'; btn.setAttribute('aria-pressed', 'true');
    const w = document.getElementById('ob-work-wrap'); if(w) w.style.display = mode === 'clients' ? 'none' : '';
  },

  _obFinish(demo){
    let addr = document.getElementById('ob-addr')?.value?.trim();
    // Where the work happens decides which fields a client needs later.
    state.settings.workMode = this._obMode || 'clients';
    const work = state.settings.workMode === 'clients' ? '' : (document.getElementById('ob-work')?.value?.trim() || '');
    if(work){ state.settings.workplaceAddress = work; if(!addr) addr = work; }
    // A fresh profile starts from what the profession usually looks like:
    // hours, lengths, margin, rules. All of it is shown in Settings and
    // changeable there.
    const hadHours = Object.keys(state.settings.dayHours || {}).length > 0;
    Professions.apply(state.settings, this._obProf || 'other', { keepHours: hadHours });
    // Working hours to start from. Without any, every client's availability
    // came out empty and the first client could not be saved at all.
    // A wide day is the safe default: it only allows, it never forbids.
    const dh = state.settings.dayHours || (state.settings.dayHours = {});
    for(const d of (state.settings.workDays || [1,2,3,4,5])) if(!dh[d]) dh[d] = { start: '09:00', end: '21:00' };
    if(addr) state.settings.homeAddress = addr;
    // The position picked with the suggestions, "I'm here" or the pin is kept.
    // With no home address of its own, home falls back to the workplace (above),
    // so it takes the workplace's position too.
    const workC = work ? this._obWorkCoord : null;
    if(this._obCoord) state.coords['home'] = this._obCoord;
    else if(workC && !document.getElementById('ob-addr')?.value?.trim()) state.coords['home'] = { ...workC };
    if(workC) state.coords.workplace = workC;
    Storage.saveCoords(state.coords);
    Storage.saveSettings(state.settings);
    document.getElementById('onboard-overlay')?.remove();
    // moved=true asks the map again; a position already chosen needs no lookup.
    if(work) this.syncWorkplace(!workC);
    if(demo){ this.updateNavLabels(); this.registerSW(); this.startDemo(); return; }
    this.updateNavLabels();
    this.renderHome();
    this.registerSW();
  },

  // ---- SERVICE WORKER ----
  // Registers ./sw.js — a real file, deliberately NOT a Blob URL. A blob gets a
  // fresh url on every load, so the browser saw a different worker each visit
  // and re-registered it endlessly; a stable path lets it do proper update
  // detection. See sw.js for the caching strategy.
  registerSW(){
    if(!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').then(reg => {
      // Pick up a new deploy without waiting for every tab to be closed.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if(!sw) return;
        sw.addEventListener('statechange', () => {
          if(sw.state === 'installed' && navigator.serviceWorker.controller){
            // A newer version is ready; it will serve the next load.
            console.info('RoutePal: a new version is available and will load next time.');
          }
        });
      });
    }).catch(()=>{ /* unsupported or blocked — the app works fine without it */ });
  }
};

