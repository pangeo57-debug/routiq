// ============================================================
// STORAGE
// ============================================================
const Storage = {
  KEYS: { settings:'rp_settings', students:'rp_students', schedule:'rp_schedule', coords:'rp_coords', jobs:'rp_jobs', savings:'rp_savings' },
  get(k){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):null }catch(e){return null} },
  // A failed write used to be swallowed silently, which is the worst possible
  // outcome for an app whose data lives ONLY on this device: the user is told
  // the student is saved, closes the app, and it is gone. localStorage fills up
  // (a few MB), and Safari in private mode rejects writes outright.
  set(k,v){
    try{ localStorage.setItem(k,JSON.stringify(v)); return true; }
    catch(e){
      console.error('localStorage write failed', k, e);
      // Guard against a save-loop: one warning, not one per keystroke.
      if(!this._warnedFull){
        this._warnedFull = true;
        try{ Toast.show(t('toast_storage_full'), 'error', 9000); }catch(_){}
      }
      return false;
    }
  },
  _warnedFull:false,
  loadSettings(){ return this.get(this.KEYS.settings) || defaultSettings() },
  saveSettings(s){ this.set(this.KEYS.settings,s) },
  loadStudents(){ return this.get(this.KEYS.students) || [] },
  saveStudents(s){ this.set(this.KEYS.students,s) },
  loadSchedule(){ return this.get(this.KEYS.schedule) || {} },
  saveSchedule(s){ this.set(this.KEYS.schedule,s) },
  loadCoords(){ return this.get(this.KEYS.coords) || {} },
  saveCoords(c){ this.set(this.KEYS.coords,c) },
  loadJobs(){ const j = this.get(this.KEYS.jobs); return Array.isArray(j) ? j : [] },
  saveJobs(j){ return this.set(this.KEYS.jobs, j) },
  // Before/after records: { week: {...}, days: { 'YYYY-MM-DD|kind': {...} } }.
  loadSavings(){ const v = this.get(this.KEYS.savings); return v && typeof v === 'object' ? { week: v.week || null, days: v.days || {}, history: v.history || {} } : { week: null, days: {}, history: {} }; },
  saveSavings(v){ return this.set(this.KEYS.savings, v) },
  clear(){ Object.values(this.KEYS).forEach(k=>localStorage.removeItem(k)) }
};

function defaultSettings(){
  return {
    teacherName:'',
    homeAddress:'',
    profession:'other',
    workDays:[1,2,3,4,5],
    dayHours:{},
    blockedSlots:[],
    travelMode:'car',
    fuelConsumption:7,
    fuelPrice:1.8,
    travelBuffer:0,
    travelMargin:2,
    lunchBreak:0,
    // Most appointments the scheduler may put on one day. 0 = no limit.
    maxPerDay:0,
    // Offer moves that keep the same student off two days in a row. Only the
    // repair suggestions use it, not the automatic planning. Unset counts as on.
    avoidConsecutiveDays:true,
    avgCitySpeedKmh:25,
    // OSRM prices a journey at the roads' speed limits, as if there were no
    // traffic lights, no queues and no looking for a place to park, so in a city
    // it says roughly half of what the drive takes. This scales its times up.
    // 1.5 is a starting point, not a measurement: the right number depends on
    // the city and is meant to be adjusted against a few real journeys. HERE's
    // times already include traffic and are not touched by it.
    osrmTimeFactor:1.5,
    hereApiKey:'',
    // WhatsApp only accepts a full international number. Local numbers get
    // this in front of them; '30' because the app shipped in Greece first.
    countryCode:'30',
    // How many minutes a lesson may run past the end of the working day.
    // Zero: the hours the user typed are the hours they get.
    endFlexMin:0,
    language:'el',
    theme:'system',
  };
}

