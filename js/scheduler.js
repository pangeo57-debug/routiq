// ============================================================
// SCHEDULER
// ============================================================
const Scheduler = {
  // Parsing "17:00" came to 22% of the scheduler's CPU: the search re-reads the
  // same few hundred strings millions of times. Pure function, tiny key space
  // (one entry per distinct time string), so a plain memo is safe — there is
  // nothing to invalidate.
  _minCache: Object.create(null),
  toMin(t){
    const hit = Scheduler._minCache[t];
    if(hit !== undefined) return hit;
    const [h,m] = String(t).split(':').map(Number);
    const v = h*60+m;
    // A malformed string is cached too, and deliberately: it yields NaN either
    // way, so the guard that used to sit here changed nothing and no test
    // could tell it was gone. The map has a null prototype, so a key like
    // "__proto__" is an ordinary entry rather than a booby trap.
    Scheduler._minCache[t] = v;
    return v;
  },
  minToTime(m){ return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0') },
  toTime(m){ return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}` },

  // Deterministic pseudo-coordinates near Patras from address string
  coordsHash(address){
    const seed = [...(address||'')].reduce((a,c)=>a+c.charCodeAt(0),0);
    return { lat: 38.20 + (seed % 200)/1000, lon: 21.70 + ((seed*7) % 200)/1000 };
  },

  // A stored coordinate can exist (truthy object) but still be unusable —
  // e.g. {lat: NaN, lon: NaN} from a failed geocode that wasn't caught before
  // being saved. `coords[id] || fallback` doesn't catch this: the object
  // itself is truthy, so the fallback never triggers, and NaN then silently
  // propagates through every downstream distance/time calculation. Use this
  // wherever a raw coordinate is read, instead of a plain `||`.
  // coordIds.indexOf() ran a linear scan of every id on every single lookup.
  // The map is built once per matrix and hangs off the matrix itself, so it
  // dies with it — a rebuilt matrix cannot be served a stale index.
  _matIndex(mat){
    if(!mat._ix){
      const ix = Object.create(null);
      mat.coordIds.forEach((id, i) => { ix[id] = i; });
      Object.defineProperty(mat, '_ix', { value: ix, enumerable: false });
    }
    return mat._ix;
  },

  validCoord(c){
    return !!c && Number.isFinite(c.lat) && Number.isFinite(c.lon);
  },
  safeCoord(coordsObj, id, addr){
    const c = coordsObj && coordsObj[id];
    return this.validCoord(c) ? c : this.coordsHash(addr||'');
  },

  // Rush hour, in local terms: the afternoon-into-evening congestion a private
  // tutor actually drives through. Outside it, roads are clear even midweek.
  PEAK_FROM: 16*60,
  PEAK_TO:   20*60,

  // Which of the two traffic matrices applies to a journey on `day` starting at
  // `atMin` minutes past midnight.
  //
  // The app fetches BOTH a peak and an off-peak matrix from HERE on every run —
  // it pays for both — and then used off-peak only on Saturdays. So a 21:00
  // Tuesday lesson was charged rush-hour traffic, and a 15:00 one too. That is
  // wrong with data already in hand, whatever the size of the real difference.
  //
  // With no time given, the old day-only behaviour stands: a caller that does
  // not know when the journey happens should not have a time guessed for it.
  /**
   * The road matrix for the DAY planner's jobs, chosen the same way.
   *
   * The weekly matrix holds the students and the home, and nothing else. A
   * day's jobs are not in it, so every leg between two jobs fell through to a
   * straight line at 25 km/h — no road, no traffic, and none of the correction
   * for OSRM's optimistic times. The day planner fetches its own matrix for its
   * own jobs and it lives beside the weekly one, so neither disturbs the other.
   */
  dayMatrixFor(day, atMin){
    if(typeof state==='undefined') return null;
    const peak = state.dayMatrixPeak || null;
    const off  = state.dayMatrixOffPeak || null;
    if(!off) return peak;
    if(day>=6) return off;
    if(atMin==null) return peak;
    return (atMin >= this.PEAK_FROM && atMin < this.PEAK_TO) ? peak : off;
  },

  /**
   * A value out of whichever matrix knows BOTH places: the weekly one first,
   * then the day's. `null` means neither does, and the caller falls back to
   * coordinates.
   */
  _matrixValue(field, fromId, toId, day, atMin){
    if(typeof state==='undefined') return null;
    // A locked lesson runs as a client of its own (lockSplit); it is where its client is.
    const al = state.idAlias;
    if(al){ fromId = al[fromId] || fromId; toId = al[toId] || toId; }
    for(const mat of [Scheduler.matrixFor(day, atMin), Scheduler.dayMatrixFor(day, atMin)]){
      if(!mat || !mat[field]) continue;
      const ix = Scheduler._matIndex(mat);
      const ia = ix[fromId], ib = ix[toId];
      if(ia!=null && ib!=null && mat[field][ia] && mat[field][ia][ib]!=null) return mat[field][ia][ib];
    }
    return null;
  },

  matrixFor(day, atMin){
    if(typeof state==='undefined') return null;
    const peak = state.travelMatrixPeak || state.travelMatrix;
    const off  = state.travelMatrixOffPeak;
    if(!off) return peak;
    if(day>=6) return off;                                     // weekend: quiet all day
    if(atMin==null) return peak;                               // caller has no time
    return (atMin >= this.PEAK_FROM && atMin < this.PEAK_TO) ? peak : off;
  },

  // These two deliberately say `Scheduler.` rather than `this.`: they are the
  // most likely methods to be passed around as a plain function (geoOptimize
  // already takes a travelMinFn parameter), and losing `this` would turn them
  // from a useful estimate into a thrown TypeError deep inside a search.
  //
  // Estimated travel minutes between two slots/addresses using geocoords.
  // `atMin` is when the journey STARTS (minutes past midnight); omit it and the
  // peak matrix is used, as before.
  // A scheduling run asks for the same journeys over and over — two million
  // times in a seven-second search on a 24-client roster, against a few
  // hundred distinct pairs. haversineKm alone was 40% of the CPU.
  //
  // The cache is opened and closed around ONE run rather than living on the
  // Scheduler, because within a run the coordinates and the travel matrices
  // cannot change. That removes the entire question of invalidation, which is
  // where a cache like this would otherwise quietly start returning distances
  // to where somebody used to live.
  _travel: null,
  beginTravelCache(){ this._travel = { min: new Map(), km: new Map(), depth: (this._travel ? this._travel.depth : 0) + 1 }; },
  endTravelCache(){ this._travel = null; },
  _travelKey(fromId, fromAddr, toId, toAddr, day, atMin){
    // The matrix chosen depends on the day and on which side of rush hour the
    // journey starts, so both belong in the key — otherwise a morning lookup
    // would answer an evening one.
    const bucket = (atMin == null) ? 'x'
      : (atMin >= Scheduler.PEAK_FROM && atMin < Scheduler.PEAK_TO ? 'p' : 'o');
    return (fromId || fromAddr) + '>' + (toId || toAddr) + '|' + day + bucket;
  },

  // Start times fall on this grid, in minutes: 5 by default (an appointment
  // at 16:05, not 16:03). A school run, a delivery round or anything else of
  // one-minute stops needs 1, or the grid alone fills the hour.
  timeGrid(settings){ const g = Number(settings && settings.timeGrid); return g >= 1 && g <= 30 ? Math.round(g) : 5; },

  // Two stops at one place: the same client, the same address, or the same
  // position — a studio, a gym, a practice the clients come to. Between them
  // there is no drive and no margin: one session follows the other.
  _placeKey(a){ return String(a || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim(); },
  samePlace(aId, aAddr, bId, bAddr){
    if(aId === bId) return true;
    const A = this._placeKey(aAddr);
    if(A && A === this._placeKey(bAddr)) return true;
    const c = (typeof state !== 'undefined' && state.coords) || {};
    const ca = c[aId], cb = c[bId];
    return !!(ca && cb && Math.abs(ca.lat - cb.lat) < 1e-5 && Math.abs(ca.lon - cb.lon) < 1e-5);
  },
  // The time a leg takes in a plan: the drive plus the margin, or nothing at
  // all when both stops are at one place.
  legMin(margin, fromId, fromAddr, toId, toAddr, day, atMin){
    if(Scheduler.samePlace(fromId, fromAddr, toId, toAddr)) return 0;
    return Scheduler.travelEstMin(fromId, fromAddr, toId, toAddr, day, atMin) + margin;
  },
  travelEstMin(fromId, fromAddr, toId, toAddr, day, atMin){
    const tc = Scheduler._travel;
    let key;
    if(tc){
      key = Scheduler._travelKey(fromId, fromAddr, toId, toAddr, day, atMin);
      const hit = tc.min.get(key);
      if(hit !== undefined) return hit;
    }
    const v = Scheduler._travelEstMinUncached(fromId, fromAddr, toId, toAddr, day, atMin);
    if(tc) tc.min.set(key, v);
    return v;
  },

  _travelEstMinUncached(fromId, fromAddr, toId, toAddr, day, atMin){
    if(Scheduler.samePlace(fromId, fromAddr, toId, toAddr)) return 0;
    const sec = Scheduler._matrixValue('durations', fromId, toId, day, atMin);
    if(sec != null) return Math.max(1, Math.round(sec/60));
    const coords = (typeof state !== 'undefined' && state.coords) || {};
    const cA = Scheduler.safeCoord(coords, fromId, fromAddr);
    const cB = Scheduler.safeCoord(coords, toId, toAddr);
    const km = Scheduler.haversineKm(cA, cB) * 1.4;
    const spd = (typeof state!=='undefined'&&state.settings&&state.settings.avgCitySpeedKmh)||25;
    return Math.max(1, Math.round(km / spd * 60));
  },

  // Real great-circle distance (km) between two {lat,lon} points. The old
  // fallback here used Δlat/Δlon as if they were equal-length units, which
  // overstates east-west distances at any latitude away from the equator —
  // at Patras' latitude (~38°N) that's roughly a 20-25% distortion depending
  // on the leg's direction. This matters only when no OSRM/HERE matrix is
  // available (see travelMatrixPeak/OffPeak above) — once a real matrix is
  // present, this fallback isn't used at all.
  haversineKm(a, b){
    if(!a||!b) return 0;
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI/180, dLon = (b.lon - a.lon) * Math.PI/180;
    const la1 = a.lat*Math.PI/180, la2 = b.lat*Math.PI/180;
    const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    // Clamp to [0,1]: floating-point rounding can push h fractionally below 0
    // (or above 1) for near-identical/antipodal points, which turns sqrt()/asin()
    // into NaN — and a NaN distance silently breaks every downstream comparison
    // (loops that check "is this better?" never resolve, causing a hang instead
    // of a crash, which is why this shipped unnoticed until real data hit it).
    const hc = Math.min(1, Math.max(0, h));
    return 2*R*Math.asin(Math.sqrt(hc));
  },

  // Estimated real-road km between two stops (by id), same matrix travelEstMin
  // uses for minutes. Falls back to straight-line*1.4 when no matrix/distances
  // are available (e.g. HERE was used, which gives durations but not distances).
  // This is what geoOptimize/saOptimize should use for their km objective and
  // for nearest-neighbor ordering, instead of raw Euclidean distance — otherwise
  // the whole optimization pass is chasing a metric that doesn't match the roads.
  travelEstKm(fromId, fromAddr, toId, toAddr, day, atMin){
    const tc = Scheduler._travel;
    let key;
    if(tc){
      key = Scheduler._travelKey(fromId, fromAddr, toId, toAddr, day, atMin);
      const hit = tc.km.get(key);
      if(hit !== undefined) return hit;
    }
    const v = Scheduler._travelEstKmUncached(fromId, fromAddr, toId, toAddr, day, atMin);
    if(tc) tc.km.set(key, v);
    return v;
  },

  _travelEstKmUncached(fromId, fromAddr, toId, toAddr, day, atMin){
    if(Scheduler.samePlace(fromId, fromAddr, toId, toAddr)) return 0;
    const m = Scheduler._matrixValue('distances', fromId, toId, day, atMin);
    if(m != null) return m/1000;
    const coords = (typeof state !== 'undefined' && state.coords) || {};
    const cA = Scheduler.safeCoord(coords, fromId, fromAddr);
    const cB = Scheduler.safeCoord(coords, toId, toAddr);
    return Scheduler.haversineKm(cA, cB) * 1.4;
  },

  // Geographic centroid of a day's lessons
  dayCentroid(daySlots, coords){
    const pts = daySlots.map(s=>this.safeCoord(coords, s.studentId, s.address)).filter(Boolean);
    if(!pts.length) return null;
    return { lat: pts.reduce((a,p)=>a+p.lat,0)/pts.length, lon: pts.reduce((a,p)=>a+p.lon,0)/pts.length };
  },

  dist(a,b){
    if(!a||!b) return 999;
    return Math.sqrt((a.lat-b.lat)**2+(a.lon-b.lon)**2);
  },

  shuffle(arr){
    const a=[...arr];
    for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] }
    return a;
  },

  countTotal(schedule){
    return Object.values(schedule).reduce((a,d)=>a+d.reduce((b,s)=>b+(s.isGroup?(s.groupMemberCount||2):(s.mergedCount||1)),0),0);
  },

  // Score a schedule the way the user judges it: lessons placed first,
  // kilometres second. Uses the same road distances the schedule was planned
  // with, so a phase cannot look like an improvement under one metric while
  // being a regression under the one on screen.
  scoreOf(schedule, settings){
    const homeAddr = (settings && settings.homeAddress) || '';
    let km = 0;
    for(const d of (settings.workDays||[])){
      const slots = (schedule[d]||[]).slice().sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
      if(!slots.length) continue;
      let prevId='home', prevAddr=homeAddr, prevSl=null;
      for(const s of slots){
        const sameLocation = prevSl && (prevSl.studentId===s.studentId ||
          (prevSl.groupCode && prevSl.groupCode===s.groupCode));
        if(!sameLocation) km += this.travelEstKm(prevId, prevAddr, s.studentId, s.address, d);
        prevId=s.studentId; prevAddr=s.address; prevSl=s;
      }
      km += this.travelEstKm(prevId, prevAddr, 'home', homeAddr, d);
    }
    // Appointments beyond the user's daily limit, summed over the week.
    const cap = settings && settings.maxPerDay|0;
    let over = 0;
    if(cap) for(const d of (settings.workDays||[])) over += Math.max(0, (schedule[d]||[]).length - cap);
    return { placed: this.countTotal(schedule), km, over };
  },

  // Not worse = at least as many lessons placed, and not meaningfully further
  // to drive. Placing more people justifies any amount of extra driving;
  // placing the same number never does.
  notWorse(after, before){
    if(after.placed !== before.placed) return after.placed > before.placed;
    if((after.over||0) !== (before.over||0)) return (after.over||0) < (before.over||0);
    return after.km <= before.km + 0.1;
  },

  // Run one pass against a COPY and adopt its output only if it did not make
  // things worse.
  //
  // Measured on constrained weeks, lnsRepair regularly handed back the same
  // number of lessons for 4-10 more km (27.8 -> 41.5 km in the worst case) —
  // it destroys part of the schedule and repairs it, and nothing checked that
  // the repair was actually an improvement over what it tore up. That is a
  // real loss, and it is invisible: the run "succeeded".
  //
  // Only for optional improvement passes. Correctness passes
  // (enforceConstraints, collapseForceMergeFragments, compactDays) must always
  // be applied — rejecting those to save kilometres would ship a schedule that
  // violates the user's own constraints.
  async guardedPass(schedule, settings, mutate){
    const before = this.scoreOf(schedule, settings);
    const copy = JSON.parse(JSON.stringify(schedule));
    await mutate(copy);
    const after = this.scoreOf(copy, settings);
    if(!this.notWorse(after, before)) return { kept:false, before, after };
    for(const d of Object.keys(schedule)) delete schedule[d];
    for(const d of Object.keys(copy)) schedule[d] = copy[d];
    return { kept:true, before, after };
  },

  // ── TWO-PHASE SCHEDULER ──────────────────────────────────────────────────
  // Phase 1 (scheduleAll): backtracking with fixed 15-min buffer → place EVERYONE
  // Phase 2 (geoOptimize): nearest-neighbor reorder → min km, only with real coords
  // Never sacrifices students for km. No km calc during scheduling.
  run(students, settings, coords={}){
    const result = this.scheduleAll(students, settings);
    // Only geo-optimize if we have at least one real geocoded coordinate.
    // coordsHash pseudo-coords would produce meaningless orderings.
    const hasRealCoords = Object.keys(coords).length > 0;
    if(hasRealCoords) this.geoOptimize(result.schedule, students, settings, coords);
    result._attempts = 1;
    return result;
  },

  // Run several attempts with different randomized starting orders and keep the
  // one that places the MOST students — placement count always wins, km is only
  // a tie-breaker. Every student matters more than a shorter drive.
  async runMultiAttempt(students, settings, coords={}, attempts=6, fullBudget=false, budget=null, onAttempt=null){
    const hasRealCoords = Object.keys(coords).length > 0;
    // The attempts are compared on the kilometres every other pass uses —
    // HERE's road distances when there is a matrix, OSRM's, and only then
    // the straight line — not on a straight line of their own.
    const totalKm=(schedule)=>{
      if(!hasRealCoords) return 0;
      let km=0;
      for(const day of settings.workDays){
        const slots=(schedule[day]||[]).slice().sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
        if(slots.length) km+=this.dayKm(slots, day, settings);
      }
      return km;
    };
    // More attempts share a smaller per-attempt time budget so total wall-clock
    // stays bounded, instead of attempts×20s — unless fullBudget is requested
    // (user explicitly opted into a much longer, more thorough run).
    // `budget` sets the two directly (the quick plan does; see optimizeWeek).
    const backtrackMs = budget ? budget.backtrackMs : fullBudget ? 20000 : (attempts<=1 ? 20000 : Math.max(4000, Math.round(20000/Math.sqrt(attempts))));
    const repairMs = budget ? budget.repairMs : fullBudget ? 8000 : (attempts<=1 ? 8000 : Math.max(2000, Math.round(8000/Math.sqrt(attempts))));

    // "Αυτόματα" students aren't forced either way — half the attempts try them
    // merged into one block, the other half as separate sessions, and whichever
    // actually fits better with everyone else naturally wins via placed/km below.
    const hasAutoMerge = students.some(s=>s.mergeMode==='auto');

    let best=null, firstPlain=null;
    for(let i=0;i<attempts;i++){
      // Each attempt's backtracking search runs fully synchronously (it's a
      // real recursive search, not easily interruptible mid-search) — but
      // yielding HERE, between attempts, means the ✕ cancel button and the
      // progress bar actually get a chance to run every ~8-11s instead of
      // being frozen out for the whole ~50-70s multi-attempt phase in one
      // unbroken block.
      await new Promise(r=>setTimeout(r,0));
      if(typeof state!=='undefined' && state._schedulingCancelled) break;
      let order = i===0 ? students : this.shuffle(students);
      if(hasAutoMerge){
        const mergeOn = i%2===0;
        order = order.map(s => s.mergeMode==='auto' ? {...s, forceMerge:mergeOn} : s);
      }
      const result = this.scheduleAll(order, settings, backtrackMs, repairMs);
      // The "before" of the week: the first plain placement, before any
      // reordering — what simple scheduling without optimisation gives.
      if(i === 0) firstPlain = JSON.parse(JSON.stringify(result.schedule));
      if(hasRealCoords) this.geoOptimize(result.schedule, order, settings, coords);
      const placed = this.countTotal(result.schedule);
      const km = totalKm(result.schedule);
      if(!best || placed>best.placed || (placed===best.placed && km<best.km)){
        best = { result, placed, km };
      }
      // Each attempt moves the progress bar: with eight of them this phase
      // takes a minute or two, and one report at its start left the bar
      // standing still for all of it.
      if(onAttempt) try{ onAttempt(i + 1, attempts); }catch(e){}
    }
    // Cancelled before even the first attempt finished — return a valid,
    // empty-but-well-formed result instead of crashing on best===null; the
    // cancellation itself is handled by the caller (runAndNotify), which
    // discards this and restores the pre-run schedule anyway.
    if(!best){
      const empty={}; settings.workDays.forEach(d=>empty[d]=[]);
      return { schedule: empty, unplaced: [], success: true, _attempts: 0 };
    }
    best.result._attempts = attempts;
    best.result._baseline = firstPlain;
    return best.result;
  },

  // _SCHED_BUFFER kept for backward compat; dynamic travel time is used instead
  _SCHED_BUFFER: 0,

  // Phase 1: constraint-satisfaction backtracking, dynamic travel buffer
  scheduleAll(students, settings, backtrackMs=20000, repairMs=8000){
    // The cache is opened here and closed in the finally below, so it cannot
    // outlive the run that owns it.
    Scheduler.beginTravelCache();
    try{ return Scheduler._scheduleAll(students, settings, backtrackMs, repairMs); }
    finally{ Scheduler.endTravelCache(); }
  },

  // ── LESSONS OF DIFFERENT LENGTHS FOR ONE STUDENT ──────────────────────────
  // A student may have `durations`, e.g. [120, 90]: one two-hour and one
  // ninety-minute lesson a week (lessonsPerWeek is then durations.length and
  // lessonDuration the longest). Everywhere a lesson is CREATED, durOf says
  // which length is still missing; a lesson that is MOVED keeps its own. For
  // a student with one length nothing changes: durOf returns lessonDuration.
  // forceMerge as it actually applies: never to lessons of different lengths.
  mergesLessons(st){ return !!(st && st.forceMerge) && !this.hasMixedDurations(st); },
  hasMixedDurations(st){
    return !!st && Array.isArray(st.durations) && st.durations.length > 1
      && new Set(st.durations.map(Number)).size > 1;
  },
  durOf(st, schedule){
    if(!this.hasMixedDurations(st)) return st.lessonDuration;
    const need = st.durations.map(Number).sort((a, b) => b - a);   // longest first: hardest to fit
    for(const d of Object.keys(schedule || {})){
      for(const sl of (schedule[d] || [])){
        if(sl.studentId !== st.id || sl.isGroup) continue;
        const len = this.toMin(sl.end) - this.toMin(sl.start);
        let i = need.indexOf(len);
        if(i < 0){ // not an exact length (should not happen): count it against the nearest
          i = 0; for(let k = 1; k < need.length; k++) if(Math.abs(need[k] - len) < Math.abs(need[i] - len)) i = k;
        }
        if(need.length) need.splice(i, 1);
      }
    }
    return need.length ? need[0] : st.lessonDuration;
  },

  // ── Flexible weekly time ────────────────────────────────────────────────
  // "4 hours a week, in pieces of at least 1 hour": flexMinutes = 240,
  // minBlock = 60, lessonDuration = the longest piece wanted. A run starts
  // from the fewest, longest pieces (2+2); whatever does not fit is split in
  // two (2+1+1, then 1+1+1+1) and tried again, down to minBlock. The chosen
  // split is kept in `durations`, so everything else sees an ordinary
  // student with lessons of given lengths.
  isFlex(st){
    return !!st && Number(st.flexMinutes) > 0 && st.type !== 'group' && !st.pairedWith;
  },
  _flexMin(st){ return Math.max(15, Number(st.minBlock) || 60); },
  _flexCoarse(total, st){
    const min = this._flexMin(st), max = Math.max(min, Number(st.maxBlock) || Number(st.lessonDuration) || min);
    const out = [];
    let rem = Math.round(total);
    while(rem > max){ out.push(max); rem -= max; }
    if(rem > 0){
      if(rem >= min || !out.length) out.push(rem);
      else out[out.length - 1] += rem;          // a scrap shorter than allowed joins the last piece
    }
    return out;
  },
  _flexApply(st, durs){
    st.durations = durs.slice();
    st.lessonsPerWeek = st.hoursPerWeek = durs.length;
    st.lessonDuration = Math.max(...durs);
    st.mergeMode = 'off'; st.forceMerge = false; delete st.maxMergeSessions;
  },
  flexStart(st){
    if(!this.isFlex(st)) return false;
    this._flexApply(st, this._flexCoarse(st.flexMinutes, st));
    return true;
  },
  _placedLengths(schedule, st){
    const out = [];
    for(const d of Object.keys(schedule || {}))
      for(const sl of (schedule[d] || []))
        if(sl.studentId === st.id && !sl.isGroup) out.push(this.toMin(sl.end) - this.toMin(sl.start));
    return out;
  },
  _missingPieces(st, placed){
    const need = st.durations.map(Number).slice();
    for(const len of placed){ const i = need.indexOf(len); if(i >= 0) need.splice(i, 1); }
    return need;
  },
  // Split the longest piece still out, for every flexible student short of
  // time. Returns the ids that changed (empty: nothing left to try).
  flexSplit(schedule, students, settings){
    const changed = [];
    for(const st of students){
      if(!this.isFlex(st) || !Array.isArray(st.durations)) continue;
      const missing = this._missingPieces(st, this._placedLengths(schedule, st));
      if(!missing.length) continue;
      const min = this._flexMin(st);
      const days = (settings.workDays || []).filter(d => st.availability && st.availability[d] && st.availability[d].on).length;
      if(st.durations.length + 1 > Math.max(1, days)) continue;   // one per day: more pieces cannot fit
      const big = Math.max(...missing);
      const a = Math.max(min, Math.round(big / 2 / 15) * 15), b = big - a;
      if(b < min) continue;
      const durs = st.durations.map(Number), i = durs.indexOf(big);
      durs.splice(i, 1, a, b);
      this._flexApply(st, durs);
      changed.push(st.id);
    }
    return changed;
  },
  // Split what did not fit and fit again, a few rounds at most.
  async flexFit(schedule, students, settings, roundMs = 6000, stop = null){
    let rounds = 0;
    for(; rounds < 6 && !(stop && stop()); rounds++){
      const split = this.flexSplit(schedule, students, settings);
      if(!split.length) break;
      await this.refineWeek(schedule, students, settings, roundMs);
      // Smaller pieces may need several lessons moved at once (two short
      // ones on a day taken by longer ones): the wider repair does that.
      if(this._missingLessons(schedule, students).some(id => split.includes(id)))
        await this.guardedPass(schedule, settings, (c) => this.lnsRepair(c, students, settings, roundMs));
    }
    return { rounds };
  },
  // More lessons than days they fit on: a client free for an hour on only
  // three days cannot have four one-hour lessons, since a client gets one
  // lesson a day. Where a day has room for two back to back, join two into
  // one double lesson there: 4 × 60 on 3 days becomes 120 + 60 + 60.
  // Returns the new lengths, or null when nothing needs to (or can) change.
  autoCombine(st, settings){
    if(!st || st.type === 'group' || st.pairedWith || this.mergesLessons(st) || this.isFlex(st) || this.hasMixedDurations(st)) return null;
    const n = Number(st.lessonsPerWeek) || 0, dur = Number(st.lessonDuration) || 60;
    if(n < 2) return null;
    let fit = 0, fit2 = 0;
    for(const d of (settings.workDays || [])){
      const av = st.availability && st.availability[d];
      if(!av || !av.on) continue;
      const dh = (settings.dayHours || {})[d];
      const lo = dh && dh.start ? this.toMin(dh.start) : 0, hi = dh && dh.end ? this.toMin(dh.end) + this.endFlex() : 24 * 60;
      const longest = Math.max(0, ...this.availWindows(st, Number(d)).map(([a, b]) => Math.min(b, hi) - Math.max(a, lo)));
      if(longest >= dur) fit++;
      if(longest >= 2 * dur) fit2++;
    }
    const joins = n - fit;
    if(fit === 0 || joins <= 0 || joins > fit2) return null;
    return [...Array(joins).fill(2 * dur), ...Array(n - 2 * joins).fill(dur)];
  },

  // The previous schedule as a starting point: only lessons of students who
  // still exist and still take that many, with anything the current rules
  // forbid repaired or taken out. Null when nothing usable is left.
  warmStart(prev, students, settings){
    if(!prev) return null;
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const out = {};
    for(const d of (settings.workDays || [])){
      out[d] = ((prev[d] || []).filter(sl => {
        const ids = sl.isGroup ? (sl.groupMemberIds || [sl.studentId, sl.pairedStudentId].filter(Boolean)) : [sl.studentId];
        return ids.every(id => byId[id]);
      })).map(sl => ({ ...sl }));
    }
    // a student now asking for fewer lessons than the old week gave them
    const count = {};
    for(const d of Object.keys(out)) out[d] = out[d].filter(sl => {
      if(sl.isGroup) return true;
      const st = byId[sl.studentId], len = this.toMin(sl.end) - this.toMin(sl.start);
      // a lesson whose length the client no longer has is not kept
      const lens = Array.isArray(st.durations) && st.durations.length ? st.durations.map(Number) : [Number(st.lessonDuration)];
      if(!(sl.merged ? len === Number(st.lessonDuration) * (sl.mergedCount || 1) : lens.includes(len))) return false;
      const c = (count[sl.studentId] || 0) + (sl.mergedCount || 1);
      if(c > (st.lessonsPerWeek || 0)) return false;
      count[sl.studentId] = c; return true;
    });
    if(!this.countTotal(out)) return null;
    this.enforceConstraints(out, students, settings);
    return this.countTotal(out) ? out : null;
  },
  // ── Locked appointments ────────────────────────────────────────────────
  // "This one stays Tuesday at five": the person has told a client a time,
  // and a new plan must be built around it. A locked lesson is taken out of
  // its client and handed to the optimiser as a client of its own that is
  // free at exactly that time on exactly that day, so no pass can move it
  // and none needs to know locks exist. The client keeps the rest of the
  // lessons and loses that day. Afterwards the lesson goes back under the
  // client's own id (lockJoin).
  lockable(sl, st){
    return !!(sl && st && !sl.isGroup && !sl.merged && (sl.mergedCount || 1) === 1 && !sl.groupCode &&
      this._plainStudent(st) && !this.isFlex(st) && !this.mergesLessons(st));
  },
  lockSplit(students, schedule, settings){
    const list = students.map(st => st), alias = {}, dropped = [];
    const sch = {}; let n = 0;
    for(const d of Object.keys(schedule || {})){
      sch[d] = (schedule[d] || []).map(sl => {
        if(!sl.locked) return sl;
        const i = list.findIndex(x => x.id === sl.studentId), st = list[i];
        const s = this.toMin(sl.start), e = this.toMin(sl.end), len = e - s, day = Number(d);
        const lens = st && Array.isArray(st.durations) && st.durations.length ? st.durations.map(Number) : (st ? [Number(st.lessonDuration)] : []);
        // A lock that no longer holds (the client's hours, the working day or
        // the length changed) is let go rather than forced.
        if(!this.lockable(sl, st) || !lens.includes(len) || !(st.lessonsPerWeek >= 1) ||
           !(settings.workDays || []).includes(day) || !this.fitsAvailability(st, day, s, e) ||
           this.isBlocked(s, e, day, settings)){
          dropped.push(sl); const { locked, ...rest } = sl; return rest;
        }
        const vid = st.id + '§L' + (++n);
        alias[vid] = st.id;
        list.push({ ...st, id: vid, lessonsPerWeek: 1, hoursPerWeek: 1, lessonDuration: len, durations: undefined,
          pairedWith: null, group: '', availabilityExceptions: [],
          availability: { [day]: { on: true, start: sl.start, end: sl.end, windows: [[s, e]] } } });
        const left = (st.lessonsPerWeek || 1) - 1;
        if(left <= 0) list.splice(i, 1);
        else {
          const rest = { ...st, lessonsPerWeek: left, hoursPerWeek: left,
            availability: { ...st.availability, [day]: { ...(st.availability[day] || {}), on: false } } };
          if(Array.isArray(st.durations) && st.durations.length){
            const ds = st.durations.map(Number); ds.splice(ds.indexOf(len), 1);
            rest.durations = ds; rest.lessonDuration = Math.max(...ds);
          }
          list[i] = rest;
        }
        return { ...sl, studentId: vid };
      });
    }
    return { students: list, schedule: sch, alias, dropped };
  },
  lockJoin(schedule, alias){
    const out = {};
    for(const d of Object.keys(schedule || {}))
      out[d] = (schedule[d] || []).map(sl => alias[sl.studentId] ? { ...sl, studentId: alias[sl.studentId], locked: true } : sl);
    return out;
  },

  // ── A new lesson into the week as it stands ─────────────────────────────
  // Adding one client must not reshuffle a week whose times the others have
  // already been told. Every lesson the client is still owed goes into a free
  // stretch, where it costs least, and nothing else moves by a minute. What
  // does not fit is reported, not forced.
  placeKeeping(schedule, st, students, settings){
    const placed = [];
    if(!this._plainStudent(st) || this.isFlex(st) || this.mergesLessons(st)) return { placed, missing: null };
    const want = Array.isArray(st.durations) && st.durations.length ? st.durations.map(Number)
      : Array.from({ length: st.lessonsPerWeek || 1 }, () => Number(st.lessonDuration));
    for(const len of this._placedLengths(schedule, st)){ const i = want.indexOf(len); if(i >= 0) want.splice(i, 1); }
    want.sort((a, b) => b - a);
    const base = this.verifySchedule(schedule, students, settings).length;
    let missing = 0;
    for(const dur of want){
      let best = null;
      for(const d of (settings.workDays || [])){
        const day = schedule[d] || [];
        if(day.some(sl => this.occupantIds(sl).includes(st.id))) continue;
        const slot = this.findSlotFixed(st, d, day, settings, dur);
        if(!slot) continue;
        const next = day.concat([{ ...this._lessonSlot(st, dur), start: slot.start, end: slot.end }])
          .sort((a, b) => this.toMin(a.start) - this.toMin(b.start));
        if(this.verifySchedule({ ...schedule, [d]: next }, students, settings).length > base) continue;
        const cost = this.dayCost(next, d, settings) - (day.length ? this.dayCost(day, d, settings) : 0);
        if(!best || cost < best.cost - 1e-9) best = { d, next, cost, start: slot.start, end: slot.end };
      }
      if(!best){ missing++; continue; }
      schedule[best.d] = best.next;
      placed.push({ day: best.d, start: best.start, end: best.end });
    }
    return { placed, missing };
  },

  // Lexicographic, as everywhere: more lessons, then km + waiting.
  isBetterStart(a, b, settings){
    const na = this.countTotal(a), nb = this.countTotal(b);
    if(na !== nb) return na > nb;
    const ma = this.measureWeek(a, settings), mb = this.measureWeek(b, settings);
    return ma.km + ma.idle * this.IDLE_KM_PER_MIN < mb.km + mb.idle * this.IDLE_KM_PER_MIN - 0.05;
  },

  // ── The whole week, start to finish, with no screen ─────────────────────
  // The same phases, budgets and guards the app has always run, in the same
  // order, so it can run in a worker (several at once) or on the page.
  // input: { students, settings, coords, attempts, warm }  (warm: the cleaned
  // previous schedule, or null). hooks: { progress(pct, titleKey, subKey,
  // params), stopped() }. Returns { schedule, result, students } — students
  // because flexible time may have been split on the way.
  async optimizeWeek(input, hooks = {}){
    const { students, settings, coords } = input;
    const P = hooks.progress || (() => {}), stop = hooks.stopped || (() => this._stopped());
    const tick = () => new Promise(r => setTimeout(r, 0));
    // Search time grows with the week: the budgets below were set on weeks of
    // 20-40 lessons, and a list of 100 was searched a third as hard per
    // lesson. Up to 40 lessons nothing changes; beyond, up to 2.4 times.
    const lessons = students.reduce((a, s) => a + (Number(s.lessonsPerWeek) || 0), 0);
    const scale = Math.min(2.4, Math.max(1, lessons / 40));
    // input.timeScale shortens every budget (the compute server's tests use it).
    const B = (ms) => Math.round(ms * scale * (input.timeScale > 0 && input.timeScale < 1 ? input.timeScale : 1));
    // The same factor for the budgets that do not grow with the week.
    const Q = (ms) => Math.round(ms * (input.timeScale > 0 && input.timeScale < 1 ? input.timeScale : 1));
    let result, sch;
    if(input.skipPhase1 && input.warm){
      // A second round: search again from the best week found so far.
      result = { schedule: input.warm, unplaced: [], success: true, _attempts: 0 };
      sch = JSON.parse(JSON.stringify(input.warm));
    } else {
      P(15, 'phase1b_title', 'phase1b_sub', { n: input.attempts });
      // Runs side by side must not all start from the same placement.
      result = await this.runMultiAttempt(input.shuffleFirst ? this.shuffle(students) : students, settings, coords, input.attempts, false, input.p1 || null,
        (k, n) => P(15 + Math.round(40 * k / n), 'phase1b_title', 'phase1b_sub', { n }));
      sch = result.schedule;
      if(input.warm && this.isBetterStart(input.warm, sch, settings)) sch = JSON.parse(JSON.stringify(input.warm));
    }
    // The best week seen so far, by the app's own rule (more lessons, then
    // km + waiting, never a newly broken rule), is kept aside after every
    // pass and is what comes back. A pass may still hand on a week that rule
    // rates worse — some judge by their own yardstick (ALNS has no waiting
    // in it), and the way to a much better week can lead through a worse
    // one: measured, from 138.2 km a run reached 127.2 km only that way.
    const issues = (x) => this.verifySchedule(x, students, settings).length;
    let best = JSON.parse(JSON.stringify(sch)), bestIssues = issues(best);
    const keepBest = () => {
      const n = issues(sch);
      if(n < bestIssues || (n === bestIssues && this.isBetterStart(sch, best, settings))){ best = JSON.parse(JSON.stringify(sch)); bestIssues = n; }
    };
    const guard = async (fn) => { try{ await fn(sch); }catch(e){} keepBest(); };
    const done = (stopped) => {
      keepBest();
      return { schedule: best, result, students, stopped };
    };
    if(stop()) return done(true);
    P(55, 'phase3_title', 'phase3_sub_short');
    await guard((x) => this.alnsOptimize(x, students, settings, coords, B(25000), (frac) => P(55 + Math.min(1, frac) * 27, 'phase3_title', 'phase3_sub_short')));
    if(stop()) return done(true);
    P(82, 'phase4b_title', 'phase4b_sub'); await tick();
    await guard((x) => this.saRepair(x, students, settings, result));
    if(stop()) return done(true);
    P(92, 'phase5_title', 'phase5b_sub'); await tick();
    await guard((x) => this.lnsRepair(x, students, settings, B(10000)));
    try{
      this.enforceConstraints(sch, students, settings);
      this.collapseForceMergeFragments(sch, students, settings);
      this.rebalanceDays(sch, students, settings);
    }catch(e){}
    keepBest();
    if(stop()) return done(true);
    if(this._missingLessons(sch, students).length){
      try{
        P(93, 'phase_persist_title', 'phase_refine_sub');
        const before = JSON.stringify(sch), base = this.verifySchedule(sch, students, settings).length;
        await this.ejectionChains(sch, students, settings, Q(8000));
        if(this.verifySchedule(sch, students, settings).length > base){ const b = JSON.parse(before); for(const d of Object.keys(sch)) delete sch[d]; Object.assign(sch, b); }
      }catch(e){}
    }
    if(stop()) return done(true);
    if(this._missingLessons(sch, students).length){
      try{
        await this.guardedPass(sch, settings, (x) => this.lnsRepair(x, students, settings, Q(420000),
          (nLeft, elapsed) => P(93, 'phase_persist_title', 'phase_persist_sub', { n: nLeft, sec: Math.round(elapsed / 1000) }), Q(60000)));
        this.enforceConstraints(sch, students, settings);
        this.collapseForceMergeFragments(sch, students, settings);
      }catch(e){}
    }
    if(stop()) return done(true);
    await guard((x) => { this.tidyDays(x, students, settings); this.compactDays(x, students, settings); });
    await guard((x) => { const f = this.fillGaps(x, students, settings); if(f.moved.length) this.compactDays(x, students, settings); });
    await guard((x) => this.relocateForTime(x, students, settings));
    if(stop()) return done(true);
    try{
      P(94, 'phase_refine_title', 'phase_refine_sub');
      await guard((x) => this.refineWeek(x, students, settings, B(20000), (i) => P(94 + i, 'phase_refine_title', 'phase_refine_sub')));
    }catch(e){}
    // Which client on which day, searched once more the HGS way (js/genetic.js):
    // a population of weeks, crossed and educated, broken rules allowed at a
    // price on the way. Kept only if laid out legally and better.
    if(!stop() && this.geneticWeek){
      const quickRun = input.timeScale > 0 && input.timeScale < 1;
      const gms = input.geneticMs != null ? input.geneticMs : (quickRun ? this.GENETIC_MS.quick : this.GENETIC_MS.thorough);
      if(gms > 0){
        P(96, 'phase_refine_title', 'phase_refine_sub');
        await guard((x) => this.geneticWeek(x, students, settings, gms, stop, (f) => P(96 + Math.round(3 * f), 'phase_refine_title', 'phase_refine_sub')));
      }
    }
    if(!stop()) await guard((x) => this.polishDays(x, students, settings, 700));
    try{ await this.flexFit(sch, students, settings, 6000, stop); }catch(e){}
    try{ this.rebalanceDays(sch, students, settings); }catch(e){}
    return done(stop());
  },

  // Each day's order, solved by the day solver. The week's passes decide who
  // goes on which day; within a day the visit order is a TSPTW, and solveDay
  // solves those to the optimum on the literature's instances. Days holding a
  // pair, a group or a double lesson are left as they are — solveDay sees one
  // client per stop. A day changes only if it keeps every lesson, the week
  // gains no rule broken, and the day costs less.
  async polishDays(schedule, students, settings, msPerDay = 700){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const base = this.verifySchedule(schedule, students, settings).length;
    for(const d of (settings.workDays || [])){
      if(this._stopped()) return;
      const slots = (schedule[d] || []).slice().sort((a, b) => this.toMin(a.start) - this.toMin(b.start));
      if(slots.length < 3) continue;
      if(slots.some(sl => sl.isGroup || sl.merged || (sl.mergedCount || 1) > 1 || sl.groupCode)) continue;
      const ids = slots.map(sl => sl.studentId);
      if(new Set(ids).size !== ids.length || ids.some(id => !byId[id])) continue;
      if(ids.some(id => byId[id].pairedWith || byId[id].type === 'group' || byId[id].type === 'pair')) continue;
      const clients = ids.map(id => byId[id]);
      let sol = null;
      try{ sol = await this.solveDay(clients, settings, Number(d), { budgetMs: msPerDay, durations: slots.map(sl => this._len(sl)), noVerify: true }); }catch(e){ sol = null; }
      if(!sol || sol.out.length || sol.slots.length !== slots.length) continue;
      const orig = Object.fromEntries(slots.map(sl => [sl.studentId, sl]));
      const next = sol.slots.map(x => ({ ...orig[x.studentId], start: x.start, end: x.end }));
      if(!(this.dayCost(next, Number(d), settings) < this.dayCost(slots, Number(d), settings) - 1e-6)) continue;
      const trial = { ...schedule, [d]: next };
      if(this.verifySchedule(trial, students, settings).length > base) continue;
      schedule[d] = next;
    }
  },

  // Make each flexible student's pieces describe the schedule actually kept:
  // what is placed, plus the rest of the weekly time as the fewest pieces.
  flexSync(schedule, students){
    for(const st of students){
      if(!this.isFlex(st)) continue;
      const placed = this._placedLengths(schedule, st);
      const rest = Number(st.flexMinutes) - placed.reduce((a, b) => a + b, 0);
      const durs = placed.concat(rest > 0 ? this._flexCoarse(rest, st) : []);
      if(durs.length) this._flexApply(st, durs);
    }
  },

  _scheduleAll(students, settings, backtrackMs=20000, repairMs=8000){
    const schedule = {};
    settings.workDays.forEach(d => schedule[d] = []);

    // Phase 0: forceMerge students — split into blocks of at most maxMergeSessions
    // (defaults to all of them, i.e. one block) so "δίωρο" doesn't silently become a 4ωρο.
    // Group membership takes priority: a student who is ALSO paired/grouped must not
    // ALSO get a separate solo forceMerge block — that double-counts their lessonsPerWeek
    // and produces extra sessions nobody asked for. Group phase (0b, below) handles them.
    // No automatic cap on block length here — the algorithm doesn't get to
    // silently decide "that's too long, I'll split it up" on its own. If a
    // requested merge genuinely doesn't fit anywhere, the student ends up in
    // the unplaced list, where the existing "combine into one Xh block"
    // suggestion (forceMergeAndReschedule) explicitly asks the tutor to
    // confirm before applying anything — that's the one place this decision
    // gets made, and it's the tutor who makes it.
    const isGroupOrPaired = s => !!(s.pairedWith || (s.type==='group' && s.group));
    for(const s of students.filter(s => this.mergesLessons(s) && !isGroupOrPaired(s))){
      const blockSize = Math.max(1, Math.min(s.maxMergeSessions||s.lessonsPerWeek, s.lessonsPerWeek));
      let remaining = s.lessonsPerWeek;
      const usedDays = new Set();
      for(const day of settings.workDays){
        if(remaining<=0) break;
        if(usedDays.has(day)) continue;
        const av = s.availability[day];
        if(!av || !av.on) continue;
        const sessionsThisBlock = Math.min(blockSize, remaining);
        const dur = sessionsThisBlock * s.lessonDuration;
        const slot = this.findSlotFixed(s, day, schedule[day]||[], settings, dur);
        if(slot){
          schedule[day].push({ studentId:s.id, studentName:s.name, subject:s.subject||'—',
            address:s.address, color:s.color||0, start:slot.start, end:slot.end,
            duration:dur, mergedCount:sessionsThisBlock, merged:true, originalDuration:s.lessonDuration });
          schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          usedDays.add(day);
          remaining -= sessionsThisBlock;
        }
      }
    }

    // Phase 0b: group lessons — students sharing same group code OR pairedWith placed as one slot
    const groupedIds = new Set();
    const leftoverMembers = [];
    const groupDaysUsed = {}; // memberId -> [days already used by their group sessions]
    // Build pairMap from pairedWith (avoid duplicates)
    const groupMap = {};
    const seenPairs = new Set();
    for(const s of students){
      if(s.pairedWith){
        const partner = students.find(x=>x.id===s.pairedWith);
        if(!partner) continue;
        const pairKey = [s.id,partner.id].sort().join('|');
        if(seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const code = 'pair_'+pairKey;
        groupMap[code]=[s, partner];
      }
    }
    for(const s of students){
      if(s.type==='group' && s.group){
        // Normalize the code so "A1", " a1 ", "a1 " etc. are treated as the same group
        const gkey = 'grp_'+s.group.trim().toLowerCase();
        if(!groupMap[gkey]) groupMap[gkey]=[];
        // avoid duplicating pairs already added via pairedWith
        if(!groupMap[gkey].find(x=>x.id===s.id)) groupMap[gkey].push(s);
      }
    }
    // Merge any groupMap entries that share a member — e.g. a student set up via BOTH
    // "Ζεύγος με" and "Τύπος: Ομάδα" with the same partner would otherwise get scheduled
    // together twice (two separate blocks), eating into their weekly lesson count.
    {
      let mergedAny = true;
      while(mergedAny){
        mergedAny = false;
        const keys = Object.keys(groupMap);
        outerMerge:
        for(let i=0;i<keys.length;i++){
          for(let j=i+1;j<keys.length;j++){
            const ga=groupMap[keys[i]], gb=groupMap[keys[j]];
            if(ga.some(m=>gb.find(x=>x.id===m.id))){
              for(const m of gb) if(!ga.find(x=>x.id===m.id)) ga.push(m);
              delete groupMap[keys[j]];
              mergedAny = true;
              break outerMerge;
            }
          }
        }
      }
    }
    for(const [code, members] of Object.entries(groupMap)){
      if(members.length<2) continue;
      const [a] = members;
      // A group's SHARED sessions = what its LEAST demanding member needs — never force
      // someone who only wants 2x/week into a 3rd session just because their partner wants 3.
      const neededSessions = Math.min(...members.map(m=>m.lessonsPerWeek||1));
      const dur=Math.max(...members.map(m=>m.lessonDuration));
      let placedSessions = 0;
      const usedDays = [];
      for(const day of settings.workDays){
        if(placedSessions>=neededSessions) break;
        // Every stretch all members share. Intersecting only the outer bounds
        // used to invent time nobody actually had: two people each free
        // 15:00-17:00 and 18:30-22:00 would appear jointly free 15:00-22:00,
        // including the hour and a half neither of them can do.
        const shared = this.commonWindows(members, day, settings).filter(w=>w[1]-w[0] >= dur);
        if(!shared.length) continue;
        const virtual={...a, availability:{[day]:{on:true,
          start:this.minToTime(shared[0][0]), end:this.minToTime(shared[shared.length-1][1]),
          windows: shared.map(w=>[w[0],w[1]])}}};
        const slot=this.findSlotFixed(virtual,day,schedule[day]||[],settings,dur);
        if(slot){
          schedule[day].push({
            studentId:a.id, studentName:members.map(m=>m.name).join(' & '),
            pairedStudentId:members[1]?.id, groupCode:code, groupMemberIds:members.map(m=>m.id),
            groupMemberCount:members.length,
            subject:a.subject||'—', address:a.address,
            color:a.color||0, start:slot.start, end:slot.end,
            duration:dur, mergedCount:1, merged:false, isGroup:true
          });
          schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          placedSessions++;
          usedDays.push(day);
        }
      }
      if(placedSessions>0){
        members.forEach(m=>{ groupedIds.add(m.id); groupDaysUsed[m.id]=(groupDaysUsed[m.id]||[]).concat(usedDays); });
        // Whoever needs MORE sessions than the group shares gets the rest scheduled
        // solo, just for them — never forced onto (or skipped for) the other member.
        for(const m of members){
          const leftover = (m.lessonsPerWeek||1) - placedSessions;
          if(leftover>0) leftoverMembers.push({...m, lessonsPerWeek:leftover});
        }
      }
    }

    // Group members must ALWAYS be scheduled together or not at all — never fall through
    // to solo scheduling just because the group itself failed to find a common slot.
    // Exception: leftoverMembers (members whose personal need exceeds the shared count)
    // get their remaining lessons scheduled solo, on top of their group sessions.
    const allGroupMemberIds = new Set(Object.values(groupMap).flat().map(m=>m.id));
    // Lessons of different lengths are never merged, so such a student is placed
    // lesson by lesson even if an old record still says forceMerge.
    const normal = students.filter(s => !this.mergesLessons(s) && !allGroupMemberIds.has(s.id)).concat(leftoverMembers);
    // MCV: most-constrained first — fewer available hours → placed first
    const availHours = s => settings.workDays.reduce((sum,d)=>{
      const av=s.availability[d];
      if(!av||!av.on) return sum;
      const [sh,sm]=av.start.split(':').map(Number), [eh,em]=av.end.split(':').map(Number);
      return sum+(eh*60+em-sh*60-sm);
    },0);
    normal.sort((a,b)=>availHours(a)-availHours(b));
    const tasks = [];
    for(const s of normal){
      const lens = this.hasMixedDurations(s) ? s.durations.map(Number).sort((a,b)=>b-a) : null;
      for(let i=0;i<s.lessonsPerWeek;i++) tasks.push({student:s,lessonIdx:i,dur:lens ? lens[i] : s.lessonDuration});
    }

    const placedDays = {};
    // Leftover-member clones start with the days their group session already used,
    // so their solo lessons never land on the same day as their shared session.
    for(const s of normal) placedDays[s.id] = [...(groupDaysUsed[s.id]||[])];

    const availDayCount = (s) => settings.workDays.filter(d=>{const av=s.availability[d];return av&&av.on;}).length;
    const canSameDay    = (s) => false; // never place same student twice on same day

    const countSlotsFixed = (task, sch) => {
      let n=0;
      const pd=placedDays[task.student.id], sameDay=canSameDay(task.student);
      for(const day of settings.workDays){
        const av=task.student.availability[day];
        if(!av||!av.on) continue;
        if(!sameDay&&pd.includes(day)) continue;
        if(this.findSlotFixed(task.student,day,sch[day]||[],settings,task.dur||task.student.lessonDuration)) n++;
      }
      return n;
    };

    const allSlotsFixed = (student, day, existing, durIn) => {
      const margin = (settings.travelMargin ?? 3);
      const dayH=settings.dayHours[day]; if(!dayH) return [];
      const av=student.availability[day]; if(!av||!av.on) return [];
      const dur=durIn||student.lessonDuration;
      const winStart=Math.max(this.toMin(dayH.start),this.toMin(av.start));
      const winEnd  =Math.min(this.toMin(dayH.end),  this.toMin(av.end));
      if(winEnd-winStart<dur) return [];
      const winEndFlex=winEnd+this.endFlex();
      const sorted=[...existing].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
      const candidates=new Set([winStart]);
      for(const e of sorted){
        const buf=e.studentId===student.id?0:this.legMin(margin, e.studentId,e.address,student.id,student.address);
        const t=this.toMin(e.end)+buf;
        const r=Math.ceil(t/this.timeGrid(settings))*this.timeGrid(settings);
        if(r>=winStart&&r+dur<=winEndFlex) candidates.add(r);
      }
      // Blocked times: their end is a candidate start (so a block at the start
      // of the day doesn't render the rest of it unreachable), and any window
      // overlapping one is rejected below. This function previously ignored
      // settings.blockedSlots entirely, so the backtracking search could place
      // lessons straight through a user's reserved break.
      for(const b of (settings.blockedSlots||[])){
        if(b.day!==day) continue;
        const r=Math.ceil(this.toMin(b.end)/this.timeGrid(settings))*this.timeGrid(settings);
        if(r>=winStart&&r+dur<=winEndFlex) candidates.add(r);
      }
      const slots=[];
      for(const t of [...candidates].sort((a,b)=>a-b)){
        if(t+dur>winEndFlex) continue;
        if(this.isBlocked(t,t+dur,day,settings)) continue;
        let ok=true;
        for(const e of sorted){
          const es=this.toMin(e.start),ee=this.toMin(e.end);
          if(e.studentId===student.id){
            if(t<ee&&t+dur>es){ok=false;break;}
          } else {
            const bufBefore=this.legMin(margin, e.studentId,e.address,student.id,student.address);
            const bufAfter =this.legMin(margin, student.id,student.address,e.studentId,e.address);
            if(t<ee+bufBefore&&t+dur+bufAfter>es){ok=false;break;}
          }
        }
        if(ok) slots.push({start:this.toTime(t),end:this.toTime(t+dur)});
      }
      return slots;
    };

    const deadline=Date.now()+backtrackMs;
    let nodesVisited=0;
    const MAX_NODES=1000000;
    let bestSched=null, bestCount=-1;

    const saveBest=(sch)=>{
      const cnt=this.countTotal(sch);
      if(cnt>bestCount){
        bestCount=cnt;
        bestSched={};
        for(const d of settings.workDays) bestSched[d]=[...(sch[d]||[])];
      }
    };

    const backtrack=(remaining,sch)=>{
      nodesVisited++;
      if(remaining.length===0){saveBest(sch);return true;}
      if(nodesVisited>MAX_NODES||Date.now()>deadline){saveBest(sch);return false;}
      let minCount=Infinity,bestIdx=-1;
      for(let i=0;i<remaining.length;i++){
        const c=countSlotsFixed(remaining[i],sch);
        if(c===0) continue;
        if(c<minCount){minCount=c;bestIdx=i;}
      }
      if(bestIdx===-1){saveBest(sch);return false;}
      const task=remaining[bestIdx];
      const rest=remaining.filter((_,i)=>i!==bestIdx);
      const pd=placedDays[task.student.id];
      const sameDay=canSameDay(task.student);
      // Geo-aware day ordering: prefer days whose existing students are geographically closer
      const stCoords=(typeof state!=='undefined'&&state.coords)||{};
      const sC=stCoords[task.student.id];
      const geoScore=(day)=>{
        const slots=sch[day]||[];
        if(!slots.length||!sC) return 0; // no penalty for empty days
        let sum=0;
        for(const e of slots){
          const eC=stCoords[e.studentId];
          if(!eC) continue;
          const dx=sC.lon-eC.lon,dy=sC.lat-eC.lat;
          sum+=Math.sqrt(dx*dx+dy*dy);
        }
        return sum/slots.length;
      };
      const candidateDays=settings.workDays
        .filter(d=>{const av=task.student.availability[d];return av&&av.on&&(sameDay||!pd.includes(d));})
        .sort((a,b)=>geoScore(a)-geoScore(b));
      for(const day of candidateDays){
        for(const slot of allSlotsFixed(task.student,day,sch[day]||[],task.dur)){
          const entry={studentId:task.student.id,studentName:task.student.name,subject:task.student.subject||'—',
            address:task.student.address,color:task.student.color||0,start:slot.start,end:slot.end,
            duration:task.dur||task.student.lessonDuration,mergedCount:1,merged:false};
          sch[day].push(entry);
          sch[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          pd.push(day);
          if(backtrack(rest,sch)) return true;
          sch[day]=sch[day].filter(e=>e!==entry);
          pd.pop();
        }
      }
      saveBest(sch);
      return false;
    };

    const feasible=tasks.filter(t=>countSlotsFixed(t,schedule)>0);
    const success=backtrack(feasible,schedule);
    if(!success&&bestSched&&this.countTotal(bestSched)>this.countTotal(schedule))
      for(const d of settings.workDays) schedule[d]=bestSched[d];

    // Repair pass: greedily place any remaining unplaced tasks
    // (backtracking may have timed out leaving some students out)
    const placedCount = {};
    for(const d of settings.workDays)
      for(const sl of schedule[d]||[]) placedCount[sl.studentId]=(placedCount[sl.studentId]||0)+1;

    const unplacedTasks=[];
    for(const s of normal){
      const got=placedCount[s.id]||0;
      for(let i=got;i<s.lessonsPerWeek;i++) unplacedTasks.push({student:s,lessonIdx:i});
    }

    const makeEntry=(s,slot)=>({studentId:s.id,studentName:s.name,subject:s.subject||'—',
      address:s.address,color:s.color||0,start:slot.start,end:slot.end,
      duration:this.toMin(slot.end)-this.toMin(slot.start),mergedCount:1,merged:false});

    const repairDeadline=deadline+repairMs;
    const swapChain2=(s,depth)=>{
      if(Date.now()>repairDeadline) return false;
      const pd=placedDays[s.id]; const sameDay=canSameDay(s);
      // Ground truth is the actual schedule, not `pd` — pd can desync from schedule
      // after the backtracking phase swaps in a bestSched snapshot without resyncing it.
      const alreadyOn = (day) => (schedule[day]||[]).some(e=>e.studentId===s.id);
      for(const day of settings.workDays){
        const av=s.availability[day]; if(!av||!av.on) continue;
        if(!sameDay&&alreadyOn(day)) continue;
        const slot=this.findSlotFixed(s,day,schedule[day]||[],settings,this.durOf(s,schedule));
        if(slot){
          schedule[day].push(makeEntry(s,slot));
          schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          if(!pd.includes(day)) pd.push(day); return true;
        }
      }
      if(depth===0) return false;
      for(const day of settings.workDays){
        const av=s.availability[day]; if(!av||!av.on) continue;
        if(!sameDay&&alreadyOn(day)) continue;
        const daySnap=[...(schedule[day]||[])];
        for(const blocker of daySnap){
          if(blocker.merged||blocker.isGroup) continue;
          // temporarily remove blocker
          schedule[day]=schedule[day].filter(e=>e!==blocker);
          const bIdx=placedDays[blocker.studentId].indexOf(day);
          if(bIdx>=0) placedDays[blocker.studentId].splice(bIdx,1);
          const slot=this.findSlotFixed(s,day,schedule[day]||[],settings,this.durOf(s,schedule));
          if(slot){
            const entry=makeEntry(s,slot);
            schedule[day].push(entry);
            schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
            pd.push(day);
            const blockerStudent=students.find(st=>st.id===blocker.studentId);
            if(blockerStudent&&swapChain2(blockerStudent,depth-1)) return true;
            // revert s placement
            schedule[day]=schedule[day].filter(e=>e!==entry);
            pd.splice(pd.lastIndexOf(day),1);
          }
          // restore blocker
          schedule[day].push(blocker);
          schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          placedDays[blocker.studentId].push(day);
        }
      }
      return false;
    };

    // Sort by fewest available day-slots first (MRV)
    unplacedTasks.sort((a,b)=>countSlotsFixed(a,schedule)-countSlotsFixed(b,schedule));
    for(const task of unplacedTasks){
      const s=task.student;
      swapChain2(s,4); // up to 4-level swap chain
    }

    // Second repair pass: students still unplaced after first pass
    // Re-sort by MRV on the updated schedule, try depth=6
    const stillUnplaced=[];
    for(const s of students){
      if(allGroupMemberIds.has(s.id)) continue; // never repair-place group members solo
      if(this.countPlaced(s.id,schedule)<s.lessonsPerWeek) stillUnplaced.push(s);
    }
    if(stillUnplaced.length>0 && Date.now()<repairDeadline){
      stillUnplaced.sort((a,b)=>countSlotsFixed({student:a},schedule)-countSlotsFixed({student:b},schedule));
      for(const s of stillUnplaced){
        if(Date.now()>repairDeadline) break;
        if(this.countPlaced(s.id,schedule)>=s.lessonsPerWeek) continue;
        swapChain2(s,6);
      }
    }

    const unplaced=[];
    for(const s of students){
      const cnt=this.countPlaced(s.id,schedule);
      if(cnt<s.lessonsPerWeek){
        const u={student:s,placed:cnt,needed:s.lessonsPerWeek,reason:this.diagnoseUnplaced(s,schedule,settings)};
        this.computeSuggestion(u,schedule,settings);
        unplaced.push(u);
      }
    }
    return {schedule,placed:this.countTotal(schedule),total:students.reduce((a,s)=>a+s.lessonsPerWeek,0),unplaced,success};
  },

  // findSlotFixed: find earliest valid slot (exact travel gap, no 5-min rounding)
  // True when this day already holds as many appointments as the user allows
  // (settings.maxPerDay). Slots the student is already in don't count, so a
  // move within the same day is never blocked by itself.
  _dayFull(student, existing, settings){
    const cap = settings && settings.maxPerDay|0;
    if(!cap) return false;
    let n = 0;
    for(const e of existing){
      const ids = this.occupantIds(e);
      if(ids.includes(student.id)) continue;
      n++;
    }
    return n >= cap;
  },

  findSlotFixed(student, day, existing, settings, dur){
    if(this._dayFull(student, existing, settings)) return null;
    const margin = (settings.travelMargin ?? 2);
    const dayH=settings.dayHours[day]; if(!dayH) return null;
    const av=student.availability[day]; if(!av||!av.on) return null;
    // Every stretch this student is free in, clipped to the teacher's hours.
    // A student busy for an hour in the middle of the day leaves TWO usable
    // stretches and both are offered; this used to see only the larger.
    const allWins=this.commonWindows([student], day, settings);
    const wins=allWins.filter((w,i)=>w[1]+this.windowFlex(allWins,i)-w[0]>=dur);
    if(!wins.length) return null;
    const winStart=wins[0][0];
    const winEndFlex=allWins[allWins.length-1][1]+this.endFlex();
    const sorted=[...existing].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));

    // Build candidate start times: the opening of every stretch, and right
    // after each slot's travel gap.
    const candidates=wins.map(w=>w[0]);
    for(const e of sorted){
      const ee=this.toMin(e.end);
      if(e.studentId===student.id){
        candidates.push(ee);
      } else {
        const buf=this.legMin(margin, e.studentId,e.address,student.id,student.address,day);
        candidates.push(ee+buf);
      }
    }
    // …and right after each blocked time ends. Without these, a blocked slot
    // covering winStart made the whole day unusable: isBlocked() below only
    // ever REJECTS a candidate, so if no candidate happened to fall after the
    // block, the day was abandoned even when hours of it were free. That
    // silently broke the main use of blocked times — splitting a working day
    // (e.g. 14:00-17:00, break, 19:00-20:00).
    for(const b of (settings.blockedSlots||[])){
      if(b.day!==day) continue;
      candidates.push(this.toMin(b.end));
    }

    for(let t of candidates){
      t=Math.max(t,winStart);
      // Push t forward until every PRECEDING lesson leaves enough time to get
      // here.
      //
      // This used to skip any slot ending at or before t as "no conflict",
      // which is precisely the case where travel matters: a lesson finishing at
      // 12:58 does not conflict with one starting at 13:00, it makes it
      // impossible when the drive is 49 minutes. Travel from behind was only
      // ever enforced for candidate times DERIVED from that slot; a candidate
      // coming from the start of the window or the end of a break was accepted
      // with nothing checked behind it, because the verification below only
      // looks forward. The result was a schedule sending you somewhere you
      // could not physically reach — and enforceConstraints then removed the
      // lesson and re-placed it, via this same function, into another
      // impossible slot, over and over.
      let changed=true;
      while(changed){
        changed=false;
        for(const e of sorted){
          const es=this.toMin(e.start),ee=this.toMin(e.end);
          if(es>=t+dur) break; // starts after we finish — the forward check owns it
          if(e.studentId===student.id){
            if(ee>t){ t=ee; changed=true; break; }
          } else {
            const buf=this.legMin(margin, e.studentId,e.address,student.id,student.address,day,ee);
            if(t<ee+buf){ t=ee+buf; changed=true; break; }
          }
        }
      }
      if(t+dur>winEndFlex) continue;
      // …and inside one stretch, not merely between the first and the last.
      if(!allWins.some((w,i)=>t>=w[0] && t+dur<=w[1]+this.windowFlex(allWins,i))) continue;
      if(this.isBlocked(t,t+dur,day,settings)) continue;
      // Verify no next slot is too close
      let ok=true;
      for(const e of sorted){
        const es=this.toMin(e.start);
        if(es<t+dur) continue; // prev or overlapping
        if(e.studentId===student.id){
          if(t+dur>es){ok=false;break;}
        } else {
          const bufAft=this.legMin(margin, student.id,student.address,e.studentId,e.address,day);
          if(t+dur+bufAft>es){ok=false;break;}
        }
      }
      if(ok) return {start:this.toTime(t),end:this.toTime(t+dur)};
    }
    return null;
  },

  // Phase 2: nearest-neighbor reorder within each day for min km
  // Keeps original order if any availability window is violated after reorder
  geoOptimize(schedule, students, settings, coords, travelMinFn=null){
    const HOME=this.safeCoord(coords, 'home', (settings&&settings.homeAddress)||'Πάτρα');
    const getC=(slot)=>this.safeCoord(coords, slot.studentId, slot.address||'');
    // Distances between two stops (or home), from the same road estimator as
    // everything else: HERE / OSRM matrix first, the straight line last.
    const HOME_STOP={ studentId:'home', address:(settings&&settings.homeAddress)||'' };
    const roadKm=(a,b,day)=>Scheduler.travelEstKm(a.studentId, a.address||'', b.studentId, b.address||'', day);

    // Compute total km for a schedule snapshot. Includes a small per-slot
    // Saturday penalty (matching saOptimize) so cross-day moves/swaps prefer
    // filling weekdays first when the real travel-distance difference is a
    // near-tie — never at the cost of an actual placement, this function is
    // only used to compare already-equally-valid arrangements.
    const WEEKEND_PENALTY = 2;
    const totalKm=(sch)=>{
      let km=0;
      for(const day of settings.workDays){
        const slots=(sch[day]||[]).slice().sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
        if(!slots.length) continue;
        let prevS=null;
        for(const s of slots){
          if(!prevS||prevS.studentId!==s.studentId) km+=roadKm(prevS||HOME_STOP, s, day);
          prevS=s;
        }
        if(day>=6) km += slots.length*WEEKEND_PENALTY;
      }
      return km;
    };

    // Try to place a slot list for a day using real travel; returns new slots or null
    const tryAssignDay=(day,slots)=>{
      if(!slots.length) return [];
      const dayH=settings.dayHours[day];
      // nearest-neighbor order from HOME
      const rem=[...slots]; const order=[]; let cur=HOME_STOP;
      while(rem.length){
        let nearest=null,minD=Infinity;
        for(const s of rem){const d=roadKm(cur,s,day);if(d<minD){minD=d;nearest=s;}}
        order.push(nearest); rem.splice(rem.indexOf(nearest),1); cur=nearest;
      }
      let t=this.toMin(dayH.start), prev=HOME, prevSlot=null; const newSlots=[];
      let first=true;
      for(const slot of order){
        // EVERYONE in the slot, not just the id it is filed under. A pair or a
        // group is stored under one member, and re-timing it against that
        // member's hours alone put shared sessions in slots the partner could
        // not attend — B free from 17:00 was being booked at 16:05, and no
        // later pass caught it because enforceConstraints skips group slots.
        const byId = Object.fromEntries(students.map(s=>[s.id,s]));
        const occupants = Scheduler.occupantsOf(slot, byId);
        if(!occupants) return null;
        const student=occupants[0];
        const av=student.availability&&student.availability[day];
        if(!av||!av.on) return null;
        const c=getC(slot);
        const margin=(settings&&(settings.travelMargin??3))||3;
        const wins0=this.commonWindows(occupants, day, settings);
        if(!wins0.length) return null;
        // The very first lesson of the day always starts exactly at the window open —
        // travel from home is the tutor's problem to leave early for, not a scheduling delay.
        // The drive from the previous lesson, asked of the SAME estimator
        // everything else uses: the road matrix when it knows both places, the
        // straight line otherwise (which is exactly what this used to do all the
        // time). It took coordinates, so it could not consult a matrix at all,
        // and re-laid every day out with straight-line drives that the later
        // passes then found impossible against the real ones — dropping the
        // lesson in the day planner, and repairing it in the week.
        const leg = first ? 0 : (travelMinFn ? travelMinFn(prev,c)
          : Scheduler.travelEstMin(prevSlot.studentId, prevSlot.address||'', slot.studentId, slot.address||'', day, t));
        t = first ? t : t+leg+(leg === 0 && Scheduler.samePlace(prevSlot.studentId, prevSlot.address||'', slot.studentId, slot.address||'') ? 0 : margin);
        const fit0=this.earliestFit(wins0, t, c.duration||0, 0);
        if(fit0===null) return null;
        t = fit0;
        if(!first) t=Math.ceil(t/this.timeGrid(settings))*this.timeGrid(settings);
        first=false;
        const winEnd=Math.min(this.toMin(dayH.end), wins0[wins0.length-1][1]);
        // Skip past any blocked time this lesson would land on. This pass
        // re-lays out a whole day from scratch, and without this it would
        // relocate lessons into breaks the user explicitly reserved — the
        // day went in respecting them and came out ignoring them.
        const blocks=(settings.blockedSlots||[]).filter(b=>b.day===day)
          .map(b=>({start:this.toMin(b.start), end:this.toMin(b.end)}))
          .sort((a,b)=>a.start-b.start);
        for(let guard=0; guard<blocks.length+1; guard++){
          const hit=blocks.find(b=>t<b.end && t+slot.duration>b.start);
          if(!hit) break;
          t=hit.end;
        }
        if(t+slot.duration>winEnd) return null;
        newSlots.push({...slot,start:this.toTime(t),end:this.toTime(t+slot.duration)});
        t+=slot.duration; prev=c; prevSlot=slot;
      }
      return newSlots;
    };

    // Step 1: reorder within each day (nearest-neighbor TSP)
    for(const day of settings.workDays){
      const slots=schedule[day];
      if(!slots||slots.length<=1) continue;
      const reordered=tryAssignDay(day,slots);
      if(reordered) schedule[day]=reordered;
    }

    // Step 2: cross-day reassignment — try moving each slot to another day
    let improved=true;
    const deadline2=Date.now()+3000;
    while(improved && Date.now()<deadline2){
      improved=false;
      outer2:
      for(const day of settings.workDays){
        const slots=schedule[day]||[];
        for(let si=0;si<slots.length;si++){
          const slot=slots[si];
          if(slot.merged||slot.isGroup) continue;
          const student=students.find(s=>s.id===slot.studentId);
          if(!student) continue;
          for(const altDay of settings.workDays){
            if(altDay===day) continue;
            const av=student.availability&&student.availability[altDay];
            if(!av||!av.on) continue;
            // Never give the same student two slots on the same day (unless forceMerge)
            if(!this.mergesLessons(student) && (schedule[altDay]||[]).some(s=>s.studentId===slot.studentId)) continue;
            // Respect the user's daily limit: moving here would add one to altDay.
            if((settings.maxPerDay|0) && (schedule[altDay]||[]).length >= (settings.maxPerDay|0)) continue;
            const dayWithout=slots.filter((_,i)=>i!==si);
            const altWith=[...(schedule[altDay]||[]),slot];
            const altReordered=tryAssignDay(altDay,altWith);
            if(!altReordered) continue;
            const dayReordered=dayWithout.length?tryAssignDay(day,dayWithout):[];
            if(dayWithout.length>0 && !dayReordered) continue;
            const before=totalKm(schedule);
            const savedA=schedule[day], savedB=schedule[altDay];
            schedule[day]=dayReordered;
            schedule[altDay]=altReordered;
            const after=totalKm(schedule);
            if(after<before-0.01){ improved=true; break outer2; }
            schedule[day]=savedA; schedule[altDay]=savedB;
          }
        }
      }
    }

    // Step 3: cross-day swaps — swap slot A (dayX) with slot B (dayY)
    let swapImproved=true;
    const deadline3=Date.now()+5000;
    while(swapImproved && Date.now()<deadline3){
      swapImproved=false;
      const activeDays=settings.workDays.filter(d=>(schedule[d]||[]).length>0);
      outer3:
      for(let di=0;di<activeDays.length;di++){
        const dayA=activeDays[di];
        const slotsA=[...(schedule[dayA]||[])];
        for(let si=0;si<slotsA.length;si++){
          const slotA=slotsA[si];
          if(slotA.merged||slotA.isGroup) continue;
          const stA=students.find(s=>s.id===slotA.studentId);
          if(!stA) continue;
          for(let dj=di+1;dj<activeDays.length;dj++){
            const dayB=activeDays[dj];
            const slotsB=[...(schedule[dayB]||[])];
            for(let sj=0;sj<slotsB.length;sj++){
              const slotB=slotsB[sj];
              if(slotB.merged||slotB.isGroup) continue;
              if(slotA.studentId===slotB.studentId) continue;
              const stB=students.find(s=>s.id===slotB.studentId);
              if(!stB) continue;
              const avAonB=stA.availability&&stA.availability[dayB];
              if(!avAonB||!avAonB.on) continue;
              const avBonA=stB.availability&&stB.availability[dayA];
              if(!avBonA||!avBonA.on) continue;
              // Never give a student two slots on the same day (unless forceMerge)
              if(!this.mergesLessons(stA) && slotsB.some((s,i)=>i!==sj&&s.studentId===slotA.studentId)) continue;
              if(!this.mergesLessons(stB) && slotsA.some((s,i)=>i!==si&&s.studentId===slotB.studentId)) continue;
              const newSlotsA=[...slotsA.filter((_,i)=>i!==si),slotB];
              const newSlotsB=[...slotsB.filter((_,i)=>i!==sj),slotA];
              const newA=tryAssignDay(dayA,newSlotsA);
              if(!newA) continue;
              const newB=tryAssignDay(dayB,newSlotsB);
              if(!newB) continue;
              const before=totalKm(schedule);
              const savedA=schedule[dayA], savedB=schedule[dayB];
              schedule[dayA]=newA; schedule[dayB]=newB;
              const after=totalKm(schedule);
              if(after<before-0.01){ swapImproved=true; break outer3; }
              schedule[dayA]=savedA; schedule[dayB]=savedB;
            }
          }
        }
      }
    }

    // Step 4: 3-way cycles — rotate slots across 3 days: A→dayB, B→dayC, C→dayA
    const deadline4=Date.now()+4000;
    const activeDays4=settings.workDays.filter(d=>(schedule[d]||[]).length>0);
    let cycleImproved=true;
    while(cycleImproved && Date.now()<deadline4){
      cycleImproved=false;
      outer4:
      for(let di=0;di<activeDays4.length;di++){
        const dayA=activeDays4[di];
        for(let dj=0;dj<activeDays4.length;dj++){
          if(dj===di) continue;
          const dayB=activeDays4[dj];
          for(let dk=0;dk<activeDays4.length;dk++){
            if(dk===di||dk===dj) continue;
            const dayC=activeDays4[dk];
            const sA=[...(schedule[dayA]||[])];
            const sB=[...(schedule[dayB]||[])];
            const sC=[...(schedule[dayC]||[])];
            for(let si=0;si<sA.length;si++){
              const slotA=sA[si]; if(slotA.merged||slotA.isGroup) continue;
              const stA=students.find(s=>s.id===slotA.studentId); if(!stA) continue;
              if(!(stA.availability[dayB]&&stA.availability[dayB].on)) continue;
              for(let sj=0;sj<sB.length;sj++){
                const slotB=sB[sj]; if(slotB.merged||slotB.isGroup) continue;
                if(slotB.studentId===slotA.studentId) continue;
                const stB=students.find(s=>s.id===slotB.studentId); if(!stB) continue;
                if(!(stB.availability[dayC]&&stB.availability[dayC].on)) continue;
                for(let sk=0;sk<sC.length;sk++){
                  const slotC=sC[sk]; if(slotC.merged||slotC.isGroup) continue;
                  if(slotC.studentId===slotA.studentId||slotC.studentId===slotB.studentId) continue;
                  const stC=students.find(s=>s.id===slotC.studentId); if(!stC) continue;
                  if(!(stC.availability[dayA]&&stC.availability[dayA].on)) continue;
                  // Never give a student two slots on the same day after rotation
                  if(sB.some(s=>s.studentId===slotA.studentId)) continue;
                  if(sC.some(s=>s.studentId===slotB.studentId)) continue;
                  if(sA.some((s,i)=>i!==si&&s.studentId===slotC.studentId)) continue;
                  // Rotate: A→dayB, B→dayC, C→dayA
                  const newA=[...sA.filter((_,i)=>i!==si),slotC];
                  const newB=[...sB.filter((_,j)=>j!==sj),slotA];
                  const newC=[...sC.filter((_,k)=>k!==sk),slotB];
                  const rA=tryAssignDay(dayA,newA); if(!rA) continue;
                  const rB=tryAssignDay(dayB,newB); if(!rB) continue;
                  const rC=tryAssignDay(dayC,newC); if(!rC) continue;
                  const before=totalKm(schedule);
                  const svA=schedule[dayA],svB=schedule[dayB],svC=schedule[dayC];
                  schedule[dayA]=rA; schedule[dayB]=rB; schedule[dayC]=rC;
                  const after=totalKm(schedule);
                  if(after<before-0.01){ cycleImproved=true; break outer4; }
                  schedule[dayA]=svA; schedule[dayB]=svB; schedule[dayC]=svC;
                }
              }
            }
          }
        }
      }
    }

    // Step 5: 4-way cycles — A→dayB, B→dayC, C→dayD, D→dayA (budget 3s)
    const deadline5=Date.now()+3000;
    const activeDays5=settings.workDays.filter(d=>(schedule[d]||[]).length>0);
    let cycle4Improved=true;
    while(cycle4Improved && Date.now()<deadline5){
      cycle4Improved=false;
      outer5:
      for(let di=0;di<activeDays5.length&&Date.now()<deadline5;di++){
        const dA=activeDays5[di];
        for(let dj=0;dj<activeDays5.length&&Date.now()<deadline5;dj++){
          if(dj===di) continue; const dB=activeDays5[dj];
          for(let dk=0;dk<activeDays5.length&&Date.now()<deadline5;dk++){
            if(dk===di||dk===dj) continue; const dC=activeDays5[dk];
            for(let dl=0;dl<activeDays5.length&&Date.now()<deadline5;dl++){
              if(dl===di||dl===dj||dl===dk) continue; const dD=activeDays5[dl];
              const sA=[...(schedule[dA]||[])], sB=[...(schedule[dB]||[])];
              const sC=[...(schedule[dC]||[])], sD=[...(schedule[dD]||[])];
              for(let si=0;si<sA.length;si++){
                const slA=sA[si]; if(slA.merged||slA.isGroup) continue;
                const stA=students.find(s=>s.id===slA.studentId); if(!stA) continue;
                if(!(stA.availability[dB]&&stA.availability[dB].on)) continue;
                for(let sj=0;sj<sB.length;sj++){
                  const slB=sB[sj]; if(slB.merged||slB.isGroup) continue;
                  if(slB.studentId===slA.studentId) continue;
                  const stB=students.find(s=>s.id===slB.studentId); if(!stB) continue;
                  if(!(stB.availability[dC]&&stB.availability[dC].on)) continue;
                  for(let sk=0;sk<sC.length;sk++){
                    const slC=sC[sk]; if(slC.merged||slC.isGroup) continue;
                    if(slC.studentId===slA.studentId||slC.studentId===slB.studentId) continue;
                    const stC=students.find(s=>s.id===slC.studentId); if(!stC) continue;
                    if(!(stC.availability[dD]&&stC.availability[dD].on)) continue;
                    for(let sl=0;sl<sD.length;sl++){
                      const slD=sD[sl]; if(slD.merged||slD.isGroup) continue;
                      if(slD.studentId===slA.studentId||slD.studentId===slB.studentId||slD.studentId===slC.studentId) continue;
                      const stD=students.find(s=>s.id===slD.studentId); if(!stD) continue;
                      if(!(stD.availability[dA]&&stD.availability[dA].on)) continue;
                      // Never give a student two slots on the same day after rotation
                      if(sB.some(s=>s.studentId===slA.studentId)) continue;
                      if(sC.some(s=>s.studentId===slB.studentId)) continue;
                      if(sD.some(s=>s.studentId===slC.studentId)) continue;
                      if(sA.some((s,i)=>i!==si&&s.studentId===slD.studentId)) continue;
                      // Rotate: A→dB, B→dC, C→dD, D→dA
                      const nA=[...sA.filter((_,i)=>i!==si),slD];
                      const nB=[...sB.filter((_,j)=>j!==sj),slA];
                      const nC=[...sC.filter((_,k)=>k!==sk),slB];
                      const nD=[...sD.filter((_,l)=>l!==sl),slC];
                      const rA=tryAssignDay(dA,nA); if(!rA) continue;
                      const rB=tryAssignDay(dB,nB); if(!rB) continue;
                      const rC=tryAssignDay(dC,nC); if(!rC) continue;
                      const rD=tryAssignDay(dD,nD); if(!rD) continue;
                      const before=totalKm(schedule);
                      const svA=schedule[dA],svB=schedule[dB],svC=schedule[dC],svD=schedule[dD];
                      schedule[dA]=rA; schedule[dB]=rB; schedule[dC]=rC; schedule[dD]=rD;
                      const after=totalKm(schedule);
                      if(after<before-0.01){ cycle4Improved=true; break outer5; }
                      schedule[dA]=svA; schedule[dB]=svB; schedule[dC]=svC; schedule[dD]=svD;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },





  addLesson(schedule, student, day, slot){
    schedule[day].push({
      studentId:student.id, studentName:student.name,
      subject:student.subject, address:student.address,
      color:student.color, start:slot.start, end:slot.end,
      duration:student.lessonDuration
    });
    schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
  },


  // Find slot with explicit duration override
  findSlotDur(student, day, existing, settings, dur){
    if(this._dayFull(student, existing, settings)) return null;
    const margin = (settings.travelMargin ?? 3);
    const dayH = settings.dayHours[day];
    if(!dayH) return null;
    const av = student.availability[day];
    if(!av || !av.on) return null;
    const winStart = Math.max(this.toMin(dayH.start), this.toMin(av.start));
    const winEnd   = Math.min(this.toMin(dayH.end),   this.toMin(av.end));
    if(winEnd - winStart < dur) return null;
    const winEndFlex = winEnd + this.endFlex(); // the user's own end-of-day tolerance
    const sorted = [...existing].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
    for(let t=winStart; t+dur<=winEndFlex; t+=5){
      if(this.isBlocked(t, t+dur, day, settings)) continue;
      let ok = true;
      for(const e of sorted){
        const es = this.toMin(e.start), ee = this.toMin(e.end);
        const sameStudent = e.studentId === student.id;
        const bufBefore = sameStudent ? 0 : this.legMin(margin, e.studentId, e.address, student.id, student.address, day);
        const bufAfter  = sameStudent ? 0 : this.legMin(margin, student.id, student.address, e.studentId, e.address, day);
        if(t < ee + bufBefore && t + dur + bufAfter > es){ ok = false; break; }
      }
      if(ok) return { start: this.toTime(t), end: this.toTime(t+dur) };
    }
    return null;
  },


  // Compute minimum window extension to fit this student
  computeSuggestion(u, schedule, settings){
    const student = u.student;
    const candidateDays = settings.workDays.filter(d => {
      const av = student.availability[d];
      return av && av.on && !this.placedOnDays(student.id, schedule).includes(d);
    });
    let bestTeacher = null, bestStudent = null;
    for(const day of candidateDays){
      const dayH = settings.dayHours[day];
      const av = student.availability[day];
      if(!dayH||!av||!av.on) continue;
      // Try extending teacher's work hours end
      for(let ext=15; ext<=120; ext+=15){
        const fakeSettings = {...settings, dayHours:{...settings.dayHours,[day]:{...dayH, end: this.toTime(this.toMin(dayH.end)+ext)}}};
        const slot = this.findSlotDur(student, day, schedule[day]||[], fakeSettings, this.durOf(student, schedule));
        if(slot){
          if(!bestTeacher || ext < bestTeacher.extensionMin) bestTeacher = {extensionMin:ext, day};
          break;
        }
      }
      // Try extending student's availability window end
      for(let ext=15; ext<=120; ext+=15){
        const fakeStudent = {...student, availability:{...student.availability,[day]:{...av, end: this.toTime(this.toMin(av.end)+ext)}}};
        const slot = this.findSlotDur(fakeStudent, day, schedule[day]||[], settings, this.durOf(student, schedule));
        if(slot){
          if(!bestStudent || ext < bestStudent.extensionMin) bestStudent = {extensionMin:ext, day};
          break;
        }
      }
    }
    if(bestTeacher) u.suggestionTeacher = bestTeacher;
    if(bestStudent) u.suggestionStudent = bestStudent;
    // keep legacy field for compatibility
    u.suggestion = bestTeacher || bestStudent;
  },


  windowMinutes(av){
    if(!av) return 0;
    return Math.max(0, this.toMin(av.end) - this.toMin(av.start));
  },

  countPlaced(id, schedule){
    let c=0;
    Object.values(schedule).forEach(slots => { slots.forEach(s => {
      if(s.studentId===id) c+=(s.mergedCount||1);
      else if(s.isGroup && ((s.groupMemberIds&&s.groupMemberIds.includes(id)) || s.pairedStudentId===id)) c+=1;
    }) });
    return c;
  },

  placedOnDays(id, schedule){
    const days=[];
    Object.entries(schedule).forEach(([d,slots]) => {
      if(slots.some(s=>s.studentId===id || (s.isGroup && ((s.groupMemberIds&&s.groupMemberIds.includes(id)) || s.pairedStudentId===id)))) days.push(Number(d));
    });
    return days;
  },

  findSlot(student, day, existing, settings){
    return this.findSlotDur(student, day, existing, settings, student.lessonDuration);
  },

  // ---- AVAILABILITY WINDOWS -------------------------------------------
  //
  // A student can be free in SEVERAL stretches of one day: busy 17:00-18:00
  // leaves both 15:00-17:00 and 18:00-22:00 usable, and the teacher may want
  // either. The stored shape keeps both readings:
  //
  //   av.windows  every free stretch, [[startMin,endMin], ...]
  //   av.start/end  the LARGEST of them
  //
  // start/end keeping their old meaning is deliberate. Any code that has not
  // been converted to windows still reads a real, legal window — it simply
  // uses less of the day than it could. A migration that widened start/end to
  // span the gaps would instead make every unconverted call site schedule
  // lessons in the hours the student is busy.
  availWindows(student, day){
    const av = student && student.availability && student.availability[day];
    if(!av || !av.on) return [];
    if(Array.isArray(av.windows) && av.windows.length) return av.windows.map(w=>w.slice());
    return [[this.toMin(av.start), this.toMin(av.end)]];
  },

  // The scheduler has always tolerated a lesson running up to 15 minutes past
  // the end of a window. That tolerance belongs to the END OF THE DAY, where a
  // few minutes over is a judgement call. It must never apply to a stretch that
  // ends because the student SAID they are busy — running three minutes into
  // the hour someone told you they cannot do is not a rounding error.
  //
  // So only the last stretch of the day is given any slack.
  //
  // And that slack is now ZERO unless the user asks for it. It used to be a
  // hard-coded 15 minutes, which meant a user who set their day to end at
  // 21:00 could be handed a lesson finishing at 21:10 — the app quietly
  // overriding the one limit they had set by hand. Whoever wants the old
  // tolerance can turn it on in Settings; nobody gets it by surprise.
  END_FLEX: 15,
  endFlex(){
    const v = Number(((typeof state !== 'undefined' && state.settings) || {}).endFlexMin);
    return (Number.isFinite(v) && v >= 0) ? v : 0;
  },
  windowFlex(windows, i, flex){
    if(flex != null) return flex;
    return i === windows.length - 1 ? this.endFlex() : 0;
  },

  // ---- ONE PLACE FOR "WHERE MAY THIS LESSON GO" ------------------------
  //
  // Five functions used to lay out a day, each with its own copy of these
  // three steps. They drifted, as copies do: rebuildDay pinned the first
  // lesson to the opening of the working day and so rejected every
  // arrangement whose first student was not free yet, which switched the
  // optimizer off entirely for a month — while relayoutDay, doing the same
  // job twelve lines away, had it right the whole time.
  //
  // Whatever else is true of these three, every caller now gets the SAME
  // answer, and a fix lands everywhere at once.

  /**
   * Everybody a slot actually ties up. A paired or group block is filed under
   * one member's id, so reading slot.studentId alone silently ignores whether
   * the others are free — which is exactly how a student free from 17:00 was
   * booked at 16:05.
   */
  occupantIds(sl){
    return (sl.groupMemberIds && sl.groupMemberIds.length)
      ? sl.groupMemberIds.slice()
      : [sl.studentId, sl.pairedStudentId].filter(Boolean);
  },
  occupantsOf(sl, byId){
    const ids = this.occupantIds(sl);
    const out = ids.map(id => byId[id]).filter(Boolean);
    // A slot naming someone who is not in the roster is not something to
    // guess about: the caller must leave that slot alone.
    return out.length === ids.length ? out : null;
  },

  /**
   * The stretches everyone in the slot shares on this day, keeping only those
   * long enough to hold `dur`. Returns null when none can.
   */
  usableWindows(occupants, day, dur, settings){
    const all = this.commonWindows(occupants, day, settings);
    const wins = all.filter((w, i) => w[1] + this.windowFlex(all, i) - w[0] >= dur);
    return wins.length ? { all, wins } : null;
  },

  /**
   * The earliest moment at or after `notBefore` when a lesson of `dur` sits
   * inside ONE free stretch and outside every break.
   *
   * The alternation is the point: clearing a break can land inside an hour
   * someone is busy, and snapping into a free stretch can land inside a break.
   * A single pass of either check is wrong, and was, in more than one copy.
   */
  earliestLegal(wins, breaks, notBefore, dur){
    let t = notBefore;
    for(let guard = 0; guard < breaks.length + wins.length + 2; guard++){
      const snapped = this.earliestFit(wins, t, dur);
      if(snapped === null) return null;
      t = snapped;
      const hit = breaks.find(b => t < b.end && t + dur > b.start);
      if(!hit) return t;
      t = hit.end;
    }
    return null;
  },

  /** The user's reserved breaks on a day, in minutes. */
  breaksOn(day, settings){
    return (settings.blockedSlots || []).filter(b => b.day === day)
      .map(b => ({ start: this.toMin(b.start), end: this.toMin(b.end) }));
  },

  // Does a lesson from s to e fit inside ONE free stretch?
  fitsAvailability(student, day, s, e, flex){
    const wins = this.availWindows(student, day);
    for(let i=0;i<wins.length;i++){
      const [ws,we] = wins[i];
      if(s>=ws && e<=we+this.windowFlex(wins,i,flex)) return true;
    }
    return false;
  },

  // The earliest moment at or after `t` when a lesson of `dur` fits in one of
  // the stretches — or null when the day has no room left after `t`.
  earliestFit(windows, t, dur, flex){
    let best = null;
    for(let i=0;i<windows.length;i++){
      const [ws,we] = windows[i];
      const cand = Math.max(t, ws);
      if(cand+dur <= we+this.windowFlex(windows,i,flex) && (best===null || cand<best)) best = cand;
    }
    return best;
  },

  // Every stretch shared by ALL the people in a slot, intersected with the
  // teacher's own hours for that day.
  commonWindows(students, day, settings){
    const dh = settings.dayHours && settings.dayHours[day];
    let acc = dh ? [[this.toMin(dh.start), this.toMin(dh.end)]] : [[0,1440]];
    for(const st of students){
      const mine = this.availWindows(st, day);
      if(!mine.length) return [];
      const next = [];
      for(const [a1,a2] of acc) for(const [b1,b2] of mine){
        const s = Math.max(a1,b1), e = Math.min(a2,b2);
        if(e > s) next.push([s,e]);
      }
      acc = next;
      if(!acc.length) return [];
    }
    return acc.sort((x,y)=>x[0]-y[0]);
  },

  isBlocked(startMin, endMin, day, settings){
    return (settings.blockedSlots||[]).some(b => {
      if(b.day !== day) return false;
      const bs = this.toMin(b.start), be = this.toMin(b.end);
      return startMin < be && endMin > bs;
    });
  },

  overlaps(startMin, endMin, existing, buf, studentId){
    return existing.some(e => {
      const es = this.toMin(e.start), ee = this.toMin(e.end);
      // Same student or merged block at same location → no travel buffer needed
      const b = (studentId && e.studentId === studentId) ? 0 : buf;
      return startMin < ee+b && endMin+b > es;
    });
  },

  // ---- PLANNING A SINGLE DATE ----------------------------------------
  //
  // A plumber has five jobs tomorrow. A courier has twelve stops today. Neither
  // has a weekly pattern, and until now neither could enter their work at all:
  // the whole model is a template of weekdays that repeats forever.
  //
  // The important part of the design is what it does NOT add. Planning one day
  // is the same problem the scheduler already solves, with one day in it. So a
  // day's jobs become one-session clients available only on that weekday, the
  // settings get a workDays of exactly that day, and the existing pipeline runs
  // untouched — placement, travel, blocked times, the tidy pass, compaction and
  // the verifier all apply for free, and the weekly path is not modified at all.
  //
  // `date` is YYYY-MM-DD. Sunday has no weekday slot in this app, so a plan for
  // one borrows Saturday's hours rather than refusing.
  weekdayOf(dateISO){
    const d = new Date(dateISO + 'T12:00:00');
    if(Number.isNaN(d.getTime())) return null;
    const wd = d.getDay();                 // 0 Sunday … 6 Saturday
    return wd === 0 ? 7 : wd;            // Sunday is day 7, not Saturday
  },

  // A job as the scheduler understands it: someone who needs one session, on
  // one day, inside whatever window they gave.
  /**
   * The working hours to plan a given weekday with.
   *
   * The day planner used to fall back to a hard-coded 08:00–20:00 whenever the
   * chosen date fell on a day the user had not configured — so a plumber whose
   * days run 09:00–14:00 asked for a Saturday and was handed a job at 08:00.
   * The app inventing a working day is exactly the thing the user would never
   * forgive, so: use the configured hours when they exist, otherwise borrow
   * the hours the user actually works on their other days and SAY SO.
   */
  hoursForDay(settings, day){
    const dh = settings.dayHours && settings.dayHours[day];
    if(dh && dh.start && dh.end) return { start: dh.start, end: dh.end, assumed: false };
    // The widest day they actually work is the safest stand-in: it is their own
    // schedule, not ours.
    const known = Object.values(settings.dayHours||{}).filter(h => h && h.start && h.end);
    if(known.length){
      const start = known.reduce((a,h)=> this.toMin(h.start) < this.toMin(a) ? h.start : a, known[0].start);
      const end   = known.reduce((a,h)=> this.toMin(h.end)   > this.toMin(a) ? h.end   : a, known[0].end);
      return { start, end, assumed: true };
    }
    return { start:'09:00', end:'17:00', assumed: true };
  },

  jobAsClient(job, day, settings){
    const dh = this.hoursForDay(settings, day);
    const w = job.window || {};
    const start = w.start || dh.start;
    const end   = w.end   || dh.end;
    // A range books the LONGER estimate. Running over on a plumbing job costs
    // the next customer their slot; finishing early costs nobody anything.
    const dur = Math.max(Number(job.durationMax) || 0, Number(job.durationMin) || Number(job.duration) || 60);
    return {
      id: job.id, name: job.name || '', address: job.address || '',
      subject: job.service || '', color: job.color || 0,
      lessonDuration: dur, lessonsPerWeek: 1,
      type: 'solo', group: '', pairedWith: null, notes: job.notes || '',
      mergeMode: 'off', forceMerge: false,
      availabilityExceptions: [],
      availability: { [day]: { on:true, start, end, windows: [[this.toMin(start), this.toMin(end)]] } },
    };
  },

  /**
   * Why the day has holes in it.
   *
   * A day plan with a four-hour hole in the middle looks broken even when the
   * hole is the customer's own doing. Naming the cause is the difference
   * between "this app is stupid" and "of course, they said afternoon only".
   * Travel and the safety margin are not waiting, so they are subtracted.
   */
  explainWaits(stops, jobs, day, settings){
    const margin = settings.travelMargin ?? 2;
    const byId = Object.fromEntries((jobs||[]).map(j => [j.id, j]));
    const out = [];
    for(let i=1;i<stops.length;i++){
      const prev = stops[i-1], cur = stops[i];
      const drive = this.legMin(margin, prev.job.id, prev.address, cur.job.id, cur.address, day);
      const idle = this.toMin(cur.start) - this.toMin(prev.end) - drive;
      if(idle < 10) continue;
      const w = (byId[cur.job.id]||{}).window;
      // Could this stop have started as soon as we arrived? If the customer's
      // window opens later, no — and that is not the planner's fault.
      const forced = !!(w && w.start && this.toMin(w.start) >= this.toMin(prev.end) + drive);
      out.push({ after: prev.job.name, before: cur.job.name, minutes: idle,
                 reason: forced ? 'window' : 'gap' });
    }
    return out;
  },

  async planDay(jobs, settings, coords, dateISO, opts){
    const o = opts || {};
    const day = this.weekdayOf(dateISO);
    if(day == null) return null;
    const all = (jobs||[]).filter(j => !j.done && (!j.date || j.date === dateISO));
    if(!all.length) return { date: dateISO, day, stops: [], unplanned: [], unlocated: [], km: 0 };

    // Without a home there is nothing to measure a day from, and the fallback
    // (a pseudo-position hashed out of the address text) would give a distance
    // to a place that does not exist.
    if(!this.validCoord(coords && coords['home']))
      return { date: dateISO, day, stops: [], unplanned: all, unlocated: [], km: 0, idle: 0,
               waits: [], issues: [], error: 'no-home' };

    // A job whose position is not known is NOT planned on an invented one.
    // safeCoord quietly turns a missing coordinate into a position hashed from
    // the address text — somewhere in Πάτρα with no relation to where the
    // customer is — and the plan would be drawn up on it without a word. It is
    // reported instead, so the person can fix the address.
    const list = all.filter(j => this.validCoord(coords && coords[j.id]));
    const unlocated = all.filter(j => !this.validCoord(coords && coords[j.id]));
    if(!list.length)
      return { date: dateISO, day, stops: [], unplanned: [], unlocated, km: 0, idle: 0,
               waits: [], issues: [] };

    const { clients, cfg, dh } = this._dayFrame(list, day, settings, o.hours, o.errand);

    let r;
    if(o.full){
      // The whole week pipeline on this one day — every pass, ejection chains
      // and SISR included — and a second round from its best, as the week does.
      let out = await this.optimizeWeek({ students: clients, settings: cfg, coords, attempts: o.attempts || 2, warm: null });
      const again = await this.optimizeWeek({ students: clients, settings: cfg, coords, attempts: 0, warm: out.schedule, skipPhase1: true });
      if(this.isBetterStart(again.schedule, out.schedule, cfg)) out = again;
      r = { schedule: out.schedule };
    } else if(o.engine === 'week'){
      r = await this.runMultiAttempt(clients, cfg, coords, o.attempts || 2, false);
      if(o.optimise !== false) await this.alnsOptimize(r.schedule, clients, cfg, coords, o.budgetMs || 4000);
    }
    let placed;
    if(r){
      this.enforceConstraints(r.schedule, clients, cfg);
      this.tidyDays(r.schedule, clients, cfg);
      this.compactDays(r.schedule, clients, cfg);
      placed = (r.schedule[day] || []).slice().sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
    } else {
      // The day's own solver. Should it ever fail to give a legal day, or
      // leave someone out, the week machinery runs as before and the better
      // of the two is kept, so this can only add.
      let sol = null;
      try{ sol = await this.solveDay(clients, cfg, day, { budgetMs: o.dayMs }); }catch(e){ sol = null; }
      placed = sol ? sol.slots : [];
      if(!sol || sol.out.length){
        const w = await this.runMultiAttempt(clients, cfg, coords, o.attempts || 2, false);
        if(o.optimise !== false) await this.alnsOptimize(w.schedule, clients, cfg, coords, o.budgetMs || 4000);
        this.enforceConstraints(w.schedule, clients, cfg);
        this.tidyDays(w.schedule, clients, cfg);
        this.compactDays(w.schedule, clients, cfg);
        const alt = (w.schedule[day] || []).slice().sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
        if(alt.length > placed.length || (alt.length === placed.length && alt.length &&
            !this.verifySchedule({ [day]: alt }, clients, cfg).length &&
            this.dayCost(alt, day, cfg) < this.dayCost(placed, day, cfg) - 1e-9)) placed = alt;
      }
    }
    // The person's own order is the "before". The plan is never allowed to be
    // worse than it: if their order fits as many and costs less, it is the plan.
    const base = this.dayBaseline(clients, cfg, day);
    if(base && (base.slots.length > placed.length ||
        (base.slots.length === placed.length && this.dayCost(base.slots, day, cfg) < this.dayCost(placed, day, cfg) - 1e-9)))
      placed = base.slots;
    const summary = this._daySummary(placed, list, clients, cfg, dh, day, dateISO, unlocated);
    summary.errand = !!o.errand;
    summary.before = base ? { kind: base.kind, km: base.km, drive: base.drive, idle: base.idle, stops: base.stops } : null;
    summary.after = this.measureDay(placed, day, cfg);
    return summary;
  },

  // ── One day, solved as the problem it is ────────────────────────────────
  // A day of jobs is one vehicle, N stops with time windows: the travelling
  // salesman with time windows. The week's machinery treated it as a small
  // week and, measured on the Dumas et al. (1995) instances, left customers
  // out of days on which they all fit (8/25 days of 20 complete, 0/25 of 40),
  // no better at five times the time. Three things the literature's solvers
  // have and that one did not:
  //
  //  · an evaluation that costs arithmetic, not a re-layout: travel between
  //    every two stops is looked up once, and a move re-times only the part
  //    of the day after the first position it touches;
  //  · a search that may pass through days that break a window. Lateness is
  //    priced (the "time warp" of Vidal et al. 2013: arrive late, pay for
  //    every minute, carry on from the latest legal start) and the price
  //    rises while the search stays infeasible and falls while it does not,
  //    so it can cross from one legal day to a better one through illegal
  //    ones instead of being walled in by them;
  //  · iterated local search: relocate one to three consecutive stops, swap
  //    two, reverse a stretch; then shake and repeat, keeping the best legal
  //    day seen.
  //
  // Feasible days are timed by exactly the rules relayoutDay applies (the same
  // earliestLegal, windows, breaks, margin and travel lookups), and the day
  // returned is laid out by relayoutDay itself and checked by verifySchedule.
  // If not every stop fits, stops are left out only when no legal day with
  // all of them has been found, and the search keeps trying to put them back.
  //
  // Returns { slots, out } — slots laid out and legal, out the clients left
  // unplaced — or null if it could not produce a legal day at all.
  async solveDay(clients, cfg, day, opts){
    const o = opts || {};
    const n = clients.length;
    const dh = cfg.dayHours && cfg.dayHours[day];
    if(!dh) return null;
    if(!n) return { slots: [], out: [] };
    const margin = cfg.travelMargin ?? 2;
    const dayStart = this.toMin(dh.start), dayEnd = this.toMin(dh.end) + this.endFlex();
    const breaks = this.breaksOn(day, cfg);
    const IDLE = this.IDLE_KM_PER_MIN;
    const homeAddr = cfg.homeAddress || '';
    const budget = o.budgetMs || 2000, t0 = Date.now();
    let seed = (o.seed || 20240611) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const ri = (k) => Math.floor(rnd() * k);

    // Per stop: length, the windows relayoutDay would use, the latest legal start.
    const dur = new Array(n), wins = new Array(n), clipped = new Array(n), LS = new Array(n), WS = new Array(n);
    const never = [];
    for(let i = 0; i < n; i++){
      const c = clients[i];
      dur[i] = (o.durations && Number(o.durations[i])) || Number(c.lessonDuration) || 60;
      clipped[i] = this.commonWindows([c], day, cfg).map(w => [Math.max(w[0], dayStart), Math.min(w[1], dayEnd)]);
      wins[i] = clipped[i].filter((w, k) => w[1] + this.windowFlex(clipped[i], k) - w[0] >= dur[i]);
      if(!wins[i].length){ never.push(i); continue; }
      WS[i] = Math.max(dayStart, wins[i][0][0]);
      let ls = -Infinity;
      wins[i].forEach((w, k) => { ls = Math.max(ls, Math.min(w[1] + this.windowFlex(wins[i], k), dayEnd) - dur[i]); });
      LS[i] = ls;
    }

    // Travel, minutes and km, for both traffic bands. Index 0 is home.
    const N1 = n + 1, PF = this.PEAK_FROM, PT = this.PEAK_TO;
    const band = (t) => (t >= PF && t < PT) ? 1 : 0;
    const idOf = (a) => a === 0 ? 'home' : clients[a - 1].id;
    const adOf = (a) => a === 0 ? homeAddr : clients[a - 1].address;
    const tMin = [new Float64Array(N1 * N1), new Float64Array(N1 * N1)];
    const tKm = [new Float64Array(N1 * N1), new Float64Array(N1 * N1)];
    for(let b = 0; b < 2; b++){
      const at = b ? PF : PT;
      for(let a = 0; a < N1; a++) for(let c = 0; c < N1; c++){
        if(a === c) continue;
        tMin[b][a * N1 + c] = this.travelEstMin(idOf(a), adOf(a), idOf(c), adOf(c), day, at);
        tKm[b][a * N1 + c] = this.travelEstKm(idOf(a), adOf(a), idOf(c), adOf(c), day, at);
      }
    }

    // No margin between two stops at one place (see samePlace).
    const mg = new Float64Array(N1 * N1);
    for(let a = 0; a < N1; a++) for(let c = 0; c < N1; c++)
      mg[a * N1 + c] = a === c || this.samePlace(idOf(a), adOf(a), idOf(c), adOf(c)) ? 0 : margin;
    const tLo = new Float64Array(N1 * N1);           // the shorter of the two bands, for pruning
    for(let q = 0; q < N1 * N1; q++) tLo[q] = Math.min(tMin[0][q], tMin[1][q]);
    // The earliest legal start at or after `t`, by relayoutDay's own rules:
    // earliestLegal over the usable windows (each with the end-of-day
    // tolerance on its last one, as windowFlex gives it), then the same
    // clipped-window and end-of-day checks. Written out over precomputed
    // numbers because it runs millions of times; a test holds it to
    // earliestLegal on random input.
    const EF = this.endFlex();
    const wS = wins.map(w => w ? w.map(x => x[0]) : []);
    const wE = wins.map(w => w ? w.map((x, k) => x[1] + (k === w.length - 1 ? EF : 0)) : []);
    const cS = clipped.map(w => w ? w.map(x => x[0]) : []);
    const cE = clipped.map(w => w ? w.map((x, k) => x[1] + (k === w.length - 1 ? EF : 0)) : []);
    const nb = breaks.length, bS = breaks.map(b => b.start), bE = breaks.map(b => b.end);
    const legal = (i, t) => {
      const d = dur[i], S0 = wS[i], E0 = wE[i], nw = S0.length;
      let s = t;
      for(let guard = 0; guard < nb + nw + 2; guard++){
        let best = -1;
        for(let k = 0; k < nw; k++){
          const c = s > S0[k] ? s : S0[k];
          if(c + d <= E0[k] && (best < 0 || c < best)) best = c;
        }
        if(best < 0) return null;
        s = best;
        let hit = -1;
        for(let q = 0; q < nb; q++) if(s < bE[q] && s + d > bS[q]){ hit = q; break; }
        if(hit < 0){
          const CS = cS[i], CE = cE[i];
          let inside = false;
          for(let k = 0; k < CS.length; k++) if(s >= CS[k] && s + d <= CE[k]){ inside = true; break; }
          if(!inside || s + d > dayEnd) return null;
          return s;
        }
        s = bE[hit];
      }
      return null;
    };
    this._solveDayLegal = legal;                     // for the test that checks it

    // Prefix state after each position of the current order, so a move is
    // re-timed only from the first position it changes — and only until the
    // day falls back into step with the current one (same stop, same end
    // time), after which the rest is known to be unchanged.
    let lambda = 1;
    const SP = new Int32Array(n), SE = new Float64Array(n), SK = new Float64Array(n),
          SI = new Float64Array(n), SL = new Float64Array(n);
    let TK = 0, TI = 0, TL = 0;                    // totals of the current order
    const st = { prev: -1, end: 0, km: 0, idle: 0, late: 0 };
    const step = (i) => {
      let earliest = WS[i], drive = 0;
      const prev = st.prev, end = st.end;
      if(prev >= 0){
        const b = band(end);
        drive = tMin[b][(prev + 1) * N1 + i + 1];
        earliest = Math.max(earliest, end + drive + mg[(prev + 1) * N1 + i + 1]);
        st.km += tKm[b][(prev + 1) * N1 + i + 1];
      }
      let s = legal(i, earliest);
      if(s === null){
        // Late: pay for it and carry on from the latest legal start.
        st.late += Math.max(1, earliest - LS[i]);
        s = Math.min(earliest, LS[i]);
      }
      if(prev >= 0) st.idle += Math.max(0, s - end - drive - mg[(prev + 1) * N1 + i + 1]);
      else st.km += tKm[band(s)][i + 1];             // home -> first, leaving for its start
      st.prev = i; st.end = s + dur[i];
    };
    const load = (p) => {
      if(p > 0){ st.prev = SP[p - 1]; st.end = SE[p - 1]; st.km = SK[p - 1]; st.idle = SI[p - 1]; st.late = SL[p - 1]; }
      else { st.prev = -1; st.end = 0; st.km = 0; st.idle = 0; st.late = 0; }
    };
    const back = () => st.prev >= 0 ? tKm[band(st.end)][(st.prev + 1) * N1] : 0;
    const prefix = (ord) => {
      load(0);
      for(let k = 0; k < ord.length; k++){
        step(ord[k]);
        SP[k] = st.prev; SE[k] = st.end; SK[k] = st.km; SI[k] = st.idle; SL[k] = st.late;
      }
      TK = st.km + back(); TI = st.idle; TL = st.late;
    };
    const res = { cost: 0, late: 0 };
    // `buf` holds a trial order equal to the current one before p and from r on.
    const evalBuf = (buf, m, p, r) => {
      load(p);
      for(let k = p; k < m; k++){
        step(buf[k]);
        if(k >= r && st.prev === SP[k] && st.end === SE[k]){
          res.cost = (st.km + TK - SK[k]) + (st.idle + TI - SI[k]) * IDLE;
          res.late = st.late + TL - SL[k];
          return res;
        }
      }
      res.cost = st.km + back() + st.idle * IDLE; res.late = st.late;
      return res;
    };
    const evalAll = (ord) => { load(0); for(const i of ord) step(i); return { cost: st.km + back() + st.idle * IDLE, late: st.late }; };
    const value = (e) => e.cost + lambda * e.late;

    // Local search to a local optimum of cost + lambda * late: relocate a run
    // of 1-3 stops, swap two, reverse a stretch. An improving move is applied
    // at once and the scan goes on from there.
    const buf = new Int32Array(n);
    let evals = 0;
    const late = () => (++evals & 1023) === 0 && Date.now() - t0 > budget;
    const localSearch = (ordIn) => {
      const ord = Int32Array.from(ordIn), m = ord.length;
      prefix(ord);
      let curV = TK + TI * IDLE + lambda * TL;
      const take = (p, r) => {                       // accept buf as the new order
        for(let k = p; k < r; k++) ord[k] = buf[k];
        prefix(ord); curV = TK + TI * IDLE + lambda * TL;
      };
      let improved = true, stop = false;
      while(improved && !stop){
        improved = false;
        for(let L = 1; L <= 3 && !stop; L++){
          for(let i = 0; i + L <= m && !stop; i++){
            const f = ord[i], g = ord[i + L - 1];
            for(let j = 0; j <= m - L; j++){
              if(j === i) continue;
              // Skip a place where the run is late for certain: after a stop
              // that cannot finish in time for it, or before one it cannot
              // reach in time.
              const before = j < i ? (j > 0 ? ord[j - 1] : -1) : ord[j + L - 1];
              const after = j < i ? ord[j] : (j + L < m ? ord[j + L] : -1);
              if(before >= 0 && WS[before] + dur[before] + tLo[(before + 1) * N1 + f + 1] > LS[f]) continue;
              if(after >= 0 && WS[g] + dur[g] + tLo[(g + 1) * N1 + after + 1] > LS[after]) continue;
              let p, r;
              if(j < i){
                p = j; r = i + L;
                for(let k = j; k < j + L; k++) buf[k] = ord[i + k - j];
                for(let k = j + L; k < i + L; k++) buf[k] = ord[k - L];
              } else {
                p = i; r = j + L;
                for(let k = i; k < j; k++) buf[k] = ord[k + L];
                for(let k = j; k < j + L; k++) buf[k] = ord[i + k - j];
              }
              for(let k = r; k < m; k++) buf[k] = ord[k];
              const e = evalBuf(buf, m, p, r);
              if(e.cost + lambda * e.late < curV - 1e-9){ take(p, r); improved = true; }
              if(late()){ stop = true; break; }
            }
          }
        }
        for(let i = 0; i < m - 1 && !stop; i++){
          for(let j = i + 1; j < m; j++){
            for(let k = i; k < m; k++) buf[k] = ord[k];
            buf[i] = ord[j]; buf[j] = ord[i];
            let e = evalBuf(buf, m, i, j + 1);
            if(e.cost + lambda * e.late < curV - 1e-9){ take(i, j + 1); improved = true; continue; }
            if(j - i >= 2){
              for(let k = i; k <= j; k++) buf[k] = ord[j - (k - i)];
              e = evalBuf(buf, m, i, j + 1);
              if(e.cost + lambda * e.late < curV - 1e-9){ take(i, j + 1); improved = true; }
            }
            if(late()){ stop = true; break; }
          }
        }
      }
      return { ord: Array.from(ord), e: { cost: TK + TI * IDLE, late: TL } };
    };

    // Starting orders: by closing time, by opening time, as typed.
    const live = []; for(let i = 0; i < n; i++) if(!never.includes(i)) live.push(i);
    const starts = [
      live.slice().sort((a, b) => LS[a] - LS[b] || WS[a] - WS[b]),
      live.slice().sort((a, b) => WS[a] - WS[b] || LS[a] - LS[b]),
      live.slice(),
    ];
    let cur = null;
    for(const s of starts){
      const r = localSearch(s);
      if(!cur || value(r.e) < value(cur.e)) cur = r;
    }
    let out = never.slice();                       // left out, as indices
    let best = null;                               // best legal: { ord, cost }
    const better = (ord, e) => e.late === 0 && (!best || ord.length > best.ord.length ||
      (ord.length === best.ord.length && e.cost < best.cost - 1e-9));
    const remember = (ord, e) => { if(better(ord, e)) best = { ord: ord.slice(), cost: e.cost }; };
    remember(cur.ord, cur.e);

    // Put back whoever was left out, wherever it fits legally and costs least.
    const reinsert = () => {
      if(!best || out.length === never.length) return false;
      let gained = false;
      for(const i of out.slice()){
        if(never.includes(i)) continue;
        let pick = null;
        for(let j = 0; j <= best.ord.length; j++){
          const trial = best.ord.slice(0, j).concat([i], best.ord.slice(j));
          const e = evalAll(trial);
          if(e.late === 0 && (!pick || e.cost < pick.e.cost)) pick = { ord: trial, e };
        }
        if(pick){ best = { ord: pick.ord, cost: pick.e.cost }; out = out.filter(x => x !== i); gained = true; }
      }
      if(gained) cur = { ord: best.ord.slice(), e: evalAll(best.ord) };
      return gained;
    };

    let iter = 0, sinceBest = 0, sinceLegal = 0, lastYield = Date.now(), bestAt = Date.now();
    const stallLimit = Math.max(40, 3 * n);
    while(Date.now() - t0 < budget && !this._stopped()){
      iter++;
      // shake: move a few stops, or exchange two stretches (double bridge)
      let ord = cur.ord.slice();
      const m = ord.length;
      if(m >= 8 && rnd() < 0.3){
        const a = 1 + ri(m - 3), b = a + 1 + ri(m - a - 2), c = b + 1 + ri(m - b - 1);
        ord = ord.slice(0, a).concat(ord.slice(b, c), ord.slice(a, b), ord.slice(c));
      } else {
        const k = 2 + ri(Math.max(1, Math.min(6, Math.floor(m / 5))));
        for(let q = 0; q < k && m > 1; q++){
          const i = ri(m), x = ord.splice(i, 1)[0]; ord.splice(ri(m), 0, x);
        }
      }
      const r = localSearch(ord);
      // the price of lateness follows the search: up while it is illegal, down while legal
      if(r.e.late > 0) lambda = Math.min(1e4, lambda * 1.25); else lambda = Math.max(0.01, lambda * 0.9);
      const prevBest = best;
      remember(r.ord, r.e);
      if(best !== prevBest){ sinceBest = 0; bestAt = Date.now(); } else sinceBest++;
      // accept if not worse (at today's price), or now and then anyway
      if(value(r.e) <= value(evalAll(cur.ord)) + 1e-9 || rnd() < 0.05) cur = r;
      if(best && best.ord.length >= cur.ord.length) sinceLegal = 0; else sinceLegal++;

      // No legal day with everyone after a long try: leave out the one whose
      // absence costs least, and keep trying to bring it back.
      if(sinceLegal > Math.max(60, 4 * n) && cur.ord.length > 1){
        let drop = null;
        for(let q = 0; q < cur.ord.length; q++){
          const trial = cur.ord.slice(0, q).concat(cur.ord.slice(q + 1));
          const e = evalAll(trial), v = e.cost + 1e6 * e.late;
          if(!drop || v < drop.v) drop = { q, v, trial };
        }
        out.push(cur.ord[drop.q]);
        cur = localSearch(drop.trial); remember(cur.ord, cur.e); sinceLegal = 0;
      }
      if(best && best.ord.length === cur.ord.length && out.length > never.length && iter % 20 === 0) reinsert();
      if(best && out.length === never.length && sinceBest > stallLimit && Date.now() - bestAt > Math.max(300, (bestAt - t0) / 2)) break;
      if(Date.now() - lastYield > 40){ await new Promise(res => setTimeout(res, 0)); lastYield = Date.now(); }
    }
    if(best) reinsert();
    if(!best) return null;

    // Lay it out with relayoutDay and check it as every other plan is checked.
    const slots = this.relayoutDay(best.ord.map(i => this._lessonSlot(clients[i], dur[i])), day, clients, cfg);
    if(!slots) return null;
    if(!o.noVerify && this.verifySchedule({ [day]: slots }, clients, cfg).length) return null;
    const inBest = new Set(best.ord);
    return { slots, out: clients.filter((_, i) => !inBest.has(i)), iterations: iter, ms: Date.now() - t0 };
  },

  // The one-day frame every day computation shares: the jobs as clients and a
  // config that says "this weekday only, with these hours".
  //
  // `hours` is this one date's own opening and closing, typed on the day screen.
  // It replaces the weekly hours for this date only, and only if it is a real
  // span (an end before the start is a slip, not a day).
  //
  // `errand` days ignore the working breaks (lunch, blocked slots): those are
  // for work, and an errand day has hours of its own.
  _dayFrame(list, day, settings, hours, errand){
    if(errand) settings = { ...settings, blockedSlots: [] };
    const own = hours && hours.start && hours.end && this.toMin(hours.end) > this.toMin(hours.start)
      ? { start: hours.start, end: hours.end, assumed: false } : null;
    const dh = own || this.hoursForDay(settings, day);
    const cfg = { ...settings, workDays: [day],
      dayHours: { ...(settings.dayHours||{}), [day]: { start: dh.start, end: dh.end } } };
    const clients = list.map(j => this.jobAsClient(j, day, cfg));
    return { clients, cfg, dh };
  },

  // What the screen shows about a laid-out day. Planning and manual reordering
  // both end here, so the numbers cannot mean different things in the two.
  _daySummary(placed, list, clients, cfg, dh, day, dateISO, unlocated){
    const byId = Object.fromEntries(list.map(j => [j.id, j]));
    const stops = placed.map(sl => ({
      job: byId[sl.studentId], start: sl.start, end: sl.end,
      address: sl.address, slot: sl,
    })).filter(x => x.job);
    const seen = new Set(stops.map(x => x.job.id));
    return {
      date: dateISO, day, stops,
      unplanned: list.filter(j => !seen.has(j.id)),
      unlocated,
      km: this.dayKm(placed, day, cfg),
      idle: this.dayIdle(placed, day, cfg),
      hours: dh,
      // Waiting the user can do nothing about (a customer window that starts
      // later) is worth separating from waiting the planner chose.
      waits: this.explainWaits(stops, list, day, cfg),
      issues: this.verifySchedule({ [day]: placed }, clients, cfg),
    };
  },

  // Move one stop of a planned day to another position and lay the day out
  // again in that order. The person knows things the planner does not — a
  // neighbour who is only in at nine, a customer who hates to be last — and the
  // plan should bend to that, but never into something illegal: if the new
  // order cannot be laid out inside hours, windows, breaks and travel, nothing
  // changes and the reason comes back.
  reorderDay(plan, settings, coords, from, to){
    const n = plan && plan.stops ? plan.stops.length : 0;
    if(!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n)
      return { ok: false, reason: 'bad-index' };
    if(from === to) return { ok: true, plan };
    const list = plan.stops.map(x => x.job).concat(plan.unplanned || []);
    const { clients, cfg, dh } = this._dayFrame(list, plan.day, settings, plan.hours, plan.errand);
    const order = plan.stops.slice();
    order.splice(to, 0, order.splice(from, 1)[0]);
    const slots = order.map(x => ({ ...x.slot }));
    const laid = this.relayoutDay(slots, plan.day, clients, cfg);
    if(!laid) return { ok: false, reason: 'illegal' };
    const next = this._daySummary(laid, list, clients, cfg, dh, plan.day, plan.date, plan.unlocated || []);
    if(next.issues.length) return { ok: false, reason: 'illegal', issues: next.issues };
    next.timesFrom = plan.timesFrom;
    next.errand = !!plan.errand;
    next.before = plan.before || null;
    next.after = this.measureDay(laid, plan.day, cfg);
    return { ok: true, plan: next };
  },

  // Take one stop out of a planned day and close the gap: stops already under
  // way (they started before `nowMin`) stay where they are; the rest are laid
  // out again in the same order, from now — or from the end of the last one
  // under way plus the drive — so they move up. If that cannot be laid out,
  // the rest keep their old times and `refit` is false.
  dropStop(plan, settings, id, nowMin){
    const rest = plan.stops.filter(x => x.job.id !== id);
    const list = rest.map(x => x.job).concat((plan.unplanned || []).filter(j => j.id !== id));
    const { clients, cfg, dh } = this._dayFrame(list, plan.day, settings, plan.hours, plan.errand);
    const kept = nowMin == null ? [] : rest.filter(x => this.toMin(x.start) < nowMin);
    const todo = rest.filter(x => !kept.includes(x));
    let start = this.toMin(cfg.dayHours[plan.day].start);
    if(nowMin != null) start = Math.max(start, Math.ceil(nowMin / 5) * 5);
    const last = kept[kept.length - 1];
    if(last && todo.length)
      start = Math.max(start, this.toMin(last.end) + (cfg.travelMargin ?? 2) +
        this.travelEstMin(last.slot.studentId, last.slot.address, todo[0].slot.studentId, todo[0].slot.address, plan.day, this.toMin(last.end)));
    const cfg2 = { ...cfg, dayHours: { ...cfg.dayHours, [plan.day]: { ...cfg.dayHours[plan.day], start: this.toTime(start) } } };
    let laid = todo.length ? this.relayoutDay(todo.map(x => ({ ...x.slot })), plan.day, clients, cfg2) : [];
    let refit = true;
    if(!laid){ laid = todo.map(x => ({ ...x.slot })); refit = false; }
    const placed = kept.map(x => ({ ...x.slot })).concat(laid);
    const next = this._daySummary(placed, list, clients, cfg, dh, plan.day, plan.date, plan.unlocated || []);
    next.timesFrom = plan.timesFrom; next.errand = !!plan.errand;
    next.before = null;                         // the "before" was a different list
    next.after = this.measureDay(placed, plan.day, cfg);
    next.refit = refit; next.refitFrom = this.toTime(start);
    return next;
  },

  // Which two clients could share one slot?
  //
  // This is the one lever that actually creates capacity. Everything else the
  // optimizer does moves work around a fixed amount of time; putting two people
  // in one session buys an hour back. Measurements kept saying the schedule is
  // capacity-bound rather than search-bound, and this is the answer to that.
  //
  // A pair is only proposed when it is genuinely workable — never merely
  // convenient for the algorithm:
  //   · neither is already paired or in a group
  //   · same lesson length (they sit in one slot together)
  //   · same subject, so the session makes sense to teach
  //   · enough shared free time, on enough days, to cover the sessions
  //   · close to each other, since one of them has to travel
  //
  // Ranked by how much it helps: whoever is currently going unplaced first,
  // then whoever is nearest.
  // Can these two share a session, and how well? Returns null when they cannot.
  //
  // Sole home of the pairing rules. Both callers — the sweep over everybody and
  // the "find a match for this one" button in the client form — go through here,
  // so the two can never drift into disagreeing about what a workable pair is.
  //
  // How far apart two clients may live before a shared session stops being a
  // favour to either of them.
  PAIR_MAX_KM: 3,
  pairViability(a, b, settings, coords){
    if(!a || !b || a.id === b.id) return null;
    if(a.lessonDuration !== b.lessonDuration || this.hasMixedDurations(a) || this.hasMixedDurations(b)) return null;
    if((a.subject||'') !== (b.subject||'')) return null;

    const dur = a.lessonDuration;
    const need = Math.min(a.lessonsPerWeek||1, b.lessonsPerWeek||1);
    const days = [];
    for(const d of (settings.workDays||[])){
      const shared = this.commonWindows([a,b], d, settings).filter(w=>w[1]-w[0] >= dur);
      if(shared.length) days.push({day:d, minutes: shared.reduce((n,w)=>n+(w[1]-w[0]),0)});
    }
    if(days.length < need) return null;      // cannot cover the sessions they need

    // Real geocoded positions only. safeCoord would invent one from a hash of
    // the address when none exists, which is fine for ordering a route but
    // useless here — it would judge "are these two neighbours?" against a
    // position nobody lives at. Unknown stays unknown, and the caller says so
    // rather than pretending the check was made.
    const ca = this.validCoord(coords[a.id]) ? coords[a.id] : null;
    const cb = this.validCoord(coords[b.id]) ? coords[b.id] : null;
    const km = (ca && cb) ? this.haversineKm(ca, cb) : null;
    if(km != null && km > this.PAIR_MAX_KM) return null;

    return { a, b, dur, sessions: need,
      days: days.map(x=>x.day),
      sharedMinutes: days.reduce((n,x)=>n+x.minutes,0),
      km };
  },

  // Everyone `student` could share a session with, best first. `student` need
  // not be saved yet — the client form uses this while the record is still
  // being typed.
  matchesFor(student, students, settings, coords){
    if(student.pairedWith || (student.type==='group' && student.group)) return [];
    return students
      .filter(o => o.id !== student.id && !o.pairedWith && !(o.type==='group' && o.group))
      .map(o => this.pairViability(student, o, settings, coords))
      .filter(Boolean)
      .sort((x,y) => (x.km??99)-(y.km??99) || y.sharedMinutes-x.sharedMinutes);
  },

  suggestPairs(students, settings, coords, unplacedIds){
    const unplaced = new Set(unplacedIds||[]);
    const eligible = students.filter(s => !s.pairedWith && !(s.type==='group' && s.group));
    const out = [];

    for(let i=0;i<eligible.length;i++){
      for(let j=i+1;j<eligible.length;j++){
        const m = this.pairViability(eligible[i], eligible[j], settings, coords);
        if(!m) continue;
        out.push({ ...m,
          helps: (unplaced.has(m.a.id)?1:0) + (unplaced.has(m.b.id)?1:0) });
      }
    }

    // Each client appears in at most one proposal, so accepting the list
    // wholesale cannot ask someone to be in two pairs.
    out.sort((x,y)=> y.helps-x.helps || (x.km??99)-(y.km??99) || y.sharedMinutes-x.sharedMinutes);
    const taken = new Set(), picked = [];
    for(const p of out){
      if(taken.has(p.a.id) || taken.has(p.b.id)) continue;
      taken.add(p.a.id); taken.add(p.b.id);
      picked.push(p);
    }
    return picked;
  },

  diagnoseUnplaced(student, schedule, settings){
    const workDaysAvail = settings.workDays.filter(d => { const av=student.availability[d]; return av&&av.on; });
    if(workDaysAvail.length === 0) return t('diag_no_common_days');
    const cnt = this.countPlaced(student.id, schedule);
    if(cnt > 0) return tf('diag_placed_count',{c:cnt,t:student.lessonsPerWeek});
    return t('diag_no_free_slot');
  },


  // Final correctness check over a finished schedule. This is the last line of
  // defence, so it deliberately re-derives everything from the students/settings
  // rather than trusting any flag an earlier phase set. It previously checked
  // only day-hours, the slot owner's availability, and adjacent overlap — which
  // let three whole classes of real bug through silently (blocked times, the
  // second member of a pair, and travel time between consecutive addresses).
  verifySchedule(schedule, students, settings){
    const issues=[];
    const D=['','Δευ','Τρι','Τετ','Πεμ','Παρ','Σαβ'];
    const sm=Object.fromEntries(students.map(s=>[s.id,s]));
    const margin=(settings.travelMargin ?? 2);

    // Every student who occupies a slot, not just the one whose id is on it: a
    // group/paired block is stored under the leader's id, so checking only
    // sl.studentId silently ignored whether the OTHER member is actually free.
    // The reporter checks whoever it can identify and stays quiet about ids it
    // cannot — unlike the layout passes, which refuse to touch such a slot.
    const occupantsOf=(sl)=> this.occupantIds(sl).map(id=>sm[id]).filter(Boolean);

    for(const d of settings.workDays){
      const slots=(schedule[d]||[]).slice().sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
      const dh=settings.dayHours[d];
      const seenToday={};
      for(let i=0;i<slots.length;i++){
        const sl=slots[i];
        const s0=this.toMin(sl.start), e0=this.toMin(sl.end);

        if(dh && e0>this.toMin(dh.end)+this.endFlex())
          issues.push(`${sl.studentName} ${D[d]}: τελειώνει μετά το ωράριο (${sl.end}>${dh.end})`);
        if(dh && s0<this.toMin(dh.start))
          issues.push(`${sl.studentName} ${D[d]}: ξεκινά πριν το ωράριο (${sl.start}<${dh.start})`);

        for(const st of occupantsOf(sl)){
          const av=st.availability && st.availability[d];
          if(!av||!av.on) issues.push(`${st.name} δεν είναι διαθέσιμος ${D[d]}`);
          else if(!this.fitsAvailability(st, d, s0, e0))
            issues.push(`${st.name} ${D[d]} ${sl.start}-${sl.end} εκτός παραθύρου ${av.start}-${av.end}`);
        }

        // Blocked times — the user's own reserved breaks. Never checked before,
        // so an optimizer relocating a lesson into one passed verification.
        if(this.isBlocked(s0, e0, d, settings))
          issues.push(`${sl.studentName} ${D[d]} ${sl.start}-${sl.end} μέσα σε μπλοκαρισμένη ώρα`);

        // Same student twice in one day is legitimate for a merged block, and
        // for a student who explicitly chose "same day" (forceMerge) — that is
        // what they asked for, whether it ended up collapsed into one block or
        // left as two adjacent lessons.
        for(const st of occupantsOf(sl)){
          if(seenToday[st.id] && !sl.merged && !this.mergesLessons(st))
            issues.push(`${st.name} ${D[d]}: δύο μαθήματα την ίδια μέρα`);
          seenToday[st.id]=true;
        }

        if(i>0){
          const prev=slots[i-1], pe=this.toMin(prev.end);
          if(s0<pe){
            issues.push(`Επικάλυψη ${D[d]}: ${prev.studentName} & ${sl.studentName}`);
          } else if(prev.studentId!==sl.studentId){
            // Enough time to actually drive between the two addresses.
            const need=this.legMin(margin, prev.studentId, prev.address, sl.studentId, sl.address, d);
            if(s0 < pe+need)
              issues.push(`${D[d]}: μη ρεαλιστικός χρόνος μετακίνησης ${prev.studentName}→${sl.studentName} (${s0-pe}′ διαθέσιμα, ${need}′ χρειάζονται)`);
          }
        }
      }
    }

    // Weekly totals: nobody should end up with more sessions than requested.
    const placed={};
    for(const d of settings.workDays)
      for(const sl of (schedule[d]||[]))
        for(const st of occupantsOf(sl))
          placed[st.id]=(placed[st.id]||0)+(sl.mergedCount||1);
    for(const st of students){
      const n=placed[st.id]||0;
      if(n>st.lessonsPerWeek)
        issues.push(`${st.name}: ${n} μαθήματα αντί για ${st.lessonsPerWeek}`);
    }
    return issues;
  },

  // Final safety net, run after every optimization phase regardless of which
  // phase (if any) caused the problem: find any slot that violates the
  // student's own availability window or the teacher's day hours, pull it out,
  // and try to re-place that exact student on one of their genuinely available
  // days via findSlotFixed (which always re-validates availability). If no
  // valid day/time can be found, the slot is dropped rather than left
  // violating — the student then shows up in the normal "unplaced" banner
  // instead of silently sitting on a day they said they can't do.
  //
  // Skips merged/group blocks (splitting them safely needs the merge/group
  // logic itself, not a generic single-slot re-placement) — those remain
  // covered by verifySchedule()'s reporting only.
  // Deliberately ONE pass.
  //
  // While chasing impossible-travel violations on Solomon's benchmark
  // instances, running this to a fixpoint looked like the fix — one pass went
  // from 12 violations to 2. It was treating a symptom: findSlotFixed was
  // handing back unreachable slots, so this removed lessons and re-placed them
  // into equally impossible positions, forever (measured: "repaired 48,
  // dropped 0", violations unchanged). With that fixed, a second pass finds
  // nothing, and looping would only serve to hide the next producer of bad
  // placements instead of letting it surface.
  enforceConstraints(schedule, students, settings){
    const sm = Object.fromEntries(students.map(s=>[s.id,s]));
    let repaired = 0, dropped = 0;
    for(const d of settings.workDays){
      const slots = schedule[d] = schedule[d] || [];
      for(let i=slots.length-1; i>=0; i--){
        const sl = slots[i];
        if(sl.merged || sl.isGroup) continue;
        const st = sm[sl.studentId];
        if(!st) continue;
        const av = st.availability[d];
        const dh = settings.dayHours[d];
        const margin = (settings.travelMargin ?? 2);
        const s0 = this.toMin(sl.start), e0 = this.toMin(sl.end);

        // Deliberately the same rule set verifySchedule reports on, so anything
        // it would flag is repaired here first instead of surfacing to the user
        // as a warning about a schedule nothing attempted to fix. Occupancy is
        // checked per PERSON, not per slot id — a group/paired block is filed
        // under one member's id, so an id-only comparison misses the case where
        // the other member also has a solo lesson that day.
        const occupies = (slot, sid) => slot.studentId===sid
          || slot.pairedStudentId===sid
          || (slot.groupMemberIds && slot.groupMemberIds.includes(sid));
        // Not a violation for a forceMerge student: same-day is precisely what
        // they requested, so pulling one of the two out would defeat it.
        const otherSameStudent = !this.mergesLessons(st) && slots.some((o,oi)=>
          oi!==i && !o.merged && occupies(o, sl.studentId));

        // Not enough time to physically get here from the previous stop (or on
        // to the next one). An impossible schedule is worse than an incomplete
        // one, so drop it and let the normal re-placement below try again.
        const sorted = slots.slice().sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
        const pos = sorted.indexOf(sl);
        let travelImpossible = false;
        if(pos > 0){
          const p = sorted[pos-1];
          if(p.studentId !== sl.studentId){
            const need = this.legMin(margin, p.studentId, p.address, sl.studentId, sl.address, d);
            if(s0 < this.toMin(p.end) + need) travelImpossible = true;
          }
        }
        if(pos >= 0 && pos < sorted.length-1){
          const n = sorted[pos+1];
          if(n.studentId !== sl.studentId){
            const need = this.legMin(margin, sl.studentId, sl.address, n.studentId, n.address, d);
            if(this.toMin(n.start) < e0 + need) travelImpossible = true;
          }
        }

        const violates = !av || !av.on ||
          !this.fitsAvailability(st, d, s0, e0) ||
          (dh && e0 > this.toMin(dh.end) + this.endFlex()) ||
          (dh && s0 < this.toMin(dh.start)) ||
          this.isBlocked(s0, e0, d, settings) ||
          otherSameStudent ||
          travelImpossible;
        if(!violates) continue;

        slots.splice(i, 1);
        repaired++;
        let placed = false;
        for(const day2 of settings.workDays){
          if(day2 === d) continue; // already proven invalid/removed from here
          if(!this.mergesLessons(st) && (schedule[day2]||[]).some(s2 => s2.studentId === st.id)) continue;
          const newSlot = this.findSlotFixed(st, day2, schedule[day2]||[], settings, sl.duration || st.lessonDuration);
          if(newSlot){
            schedule[day2] = schedule[day2] || [];
            schedule[day2].push({ ...sl, start: newSlot.start, end: newSlot.end });
            schedule[day2].sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
            placed = true;
            break;
          }
        }
        if(!placed) dropped++;
      }
    }
    return { repaired, dropped };
  },

  // Pull every lesson as early as it can legally go, without changing the
  // order of the day.
  //
  // Why this is needed: ALNS's rebuildDay already packs a day tightly, but
  // every pass that runs AFTER it (saRepair, lnsRepair, enforceConstraints)
  // inserts, removes and relocates individual lessons without ever re-laying
  // out the day around them. So a lesson that got dropped left a hole, and
  // nothing closed it — the schedule could show a 10-minute drive followed by
  // an hour and a half of dead time, which is simply wrong to a user reading
  // it.
  //
  // This only ever moves lessons EARLIER, and never past anything: the day's
  // opening time, every occupant's own availability, travel time plus margin
  // from the previous stop, and the user's blocked times (their breaks) are
  // all respected. Reordering stays the optimizer's job; this just removes
  // dead air from the order it produced.
  // Lay out ONE day's lessons, in the order given, each as early as it legally
  // can go: the day's opening time, every occupant's availability, travel plus
  // margin from the previous stop, and the user's breaks.
  //
  // Unlike compactDays this may move a lesson LATER. compactDays is a safety
  // pass over a finished schedule and only ever pulls forward; this is for
  // edits, where making one lesson longer legitimately pushes the rest of the
  // day back.
  //
  // Returns null if the day cannot be laid out legally at all, so a caller can
  // reject the edit outright instead of applying half of it.
  relayoutDay(slots, day, students, settings){
    const sm = Object.fromEntries(students.map(s=>[s.id,s]));
    const margin = (settings.travelMargin ?? 2);
    const dh = settings.dayHours && settings.dayHours[day];
    if(!dh) return null;
    const dayStart = this.toMin(dh.start), dayEnd = this.toMin(dh.end)+this.endFlex();
    const breaks = this.breaksOn(day, settings);

    const out = []; let prev = null;
    for(const sl of slots){
      const dur = this.toMin(sl.end) - this.toMin(sl.start);
      const occupants = this.occupantsOf(sl, sm);
      if(!occupants) return null;
      // Clipped to the working day before the length filter, so a stretch that
      // only fits by running outside the user's hours is not offered.
      const clipped = this.commonWindows(occupants, day, settings)
        .map(w=>[Math.max(w[0],dayStart), Math.min(w[1],dayEnd)]);
      const wins = clipped.filter((w,i)=>w[1]+this.windowFlex(clipped,i)-w[0] >= dur);
      if(!wins.length) return null;
      let earliest = Math.max(dayStart, wins[0][0]);
      let latest = dayEnd;
      if(prev){
        // Same student back to back is one continuous block: no travel, no margin.
        const need = prev.studentId === sl.studentId ? 0
          : this.legMin(margin, prev.studentId, prev.address, sl.studentId, sl.address, day,
                              this.toMin(prev.end));
        earliest = Math.max(earliest, this.toMin(prev.end) + need);
      }
      const legal = this.earliestLegal(wins, breaks, earliest, dur);
      if(legal === null) return null;
      earliest = legal;
      if(!clipped.some((w,i)=>earliest>=w[0] && earliest+dur<=w[1]+this.windowFlex(clipped,i))) return null;
      if(earliest+dur > latest || earliest+dur > dayEnd) return null;
      const laid = {...sl, start:this.toTime(earliest), end:this.toTime(earliest+dur)};
      out.push(laid); prev = laid;
    }
    return out;
  },

  // Driving distance for one day's stops, home out and home back.
  dayKm(slots, day, settings){
    const homeAddr = (settings && settings.homeAddress) || '';
    if(!slots.length) return 0;
    let km = 0, prevId='home', prevAddr=homeAddr, prevSl=null;
    // The first leg leaves home in time for the first lesson; every later leg
    // leaves when the previous one ends. That departure time decides whether
    // the journey is charged rush-hour traffic or clear roads.
    let leaveAt = this.toMin(slots[0].start);
    for(const s of slots){
      const sameLocation = prevSl && (prevSl.studentId===s.studentId ||
        (prevSl.groupCode && prevSl.groupCode===s.groupCode));
      if(!sameLocation) km += this.travelEstKm(prevId, prevAddr, s.studentId, s.address, day, leaveAt);
      prevId=s.studentId; prevAddr=s.address; prevSl=s; leaveAt=this.toMin(s.end);
    }
    return km + this.travelEstKm(prevId, prevAddr, 'home', homeAddr, day, leaveAt);
  },

  // How much of a day's driving is wasted going back and forth.
  //
  // Visit order is fixed by lesson times — a 20:00 lesson cannot be visited
  // before a 15:00 one — so the optimizer can only choose WHICH lessons share
  // a day and in what time order. Get that wrong and you drive Rio, Patra,
  // Rio, Patra: every stop legal, the day absurd.
  //
  // Measured as a detour ratio against the shortest tour of the same stops
  // (exact for small days, nearest-neighbour + 2-opt beyond that). 1.0 means
  // the time order already is the efficient order; 1.6 means 60% of the
  // driving is backtracking.
  // Cached: this runs on every route render, including each day-tab switch, and
  // the 2-opt below is O(n^3). Measured at 20ms for 14 stops, which is a
  // visible stall on a phone when it is recomputed for a day that has not
  // changed.
  _detourCache:{},
  dayDetour(slots, day, settings){
    const key = day+'|'+slots.map(s=>s.studentId+s.start).join(',');
    if(this._detourCache.key === key) return this._detourCache.val;
    const val = this._dayDetour(slots, day, settings);
    this._detourCache = { key, val };
    return val;
  },
  _dayDetour(slots, day, settings){
    const stops = [];
    let prevSl = null;
    for(const s of slots){
      const sameLocation = prevSl && (prevSl.studentId===s.studentId ||
        (prevSl.groupCode && prevSl.groupCode===s.groupCode));
      if(!sameLocation) stops.push(s);
      prevSl = s;
    }
    if(stops.length < 2) return { km:this.dayKm(slots, day, settings), best:null, ratio:1 };
    const km = this.dayKm(slots, day, settings);

    const homeAddr = (settings && settings.homeAddress) || '';
    const leg = (a,b) => this.travelEstKm(
      a ? a.studentId : 'home', a ? a.address : homeAddr,
      b ? b.studentId : 'home', b ? b.address : homeAddr, day);
    const tourKm = (order) => {
      let t = leg(null, order[0]);
      for(let i=1;i<order.length;i++) t += leg(order[i-1], order[i]);
      return t + leg(order[order.length-1], null);
    };

    // Nearest neighbour, then 2-opt until it stops improving. Not guaranteed
    // optimal, which is fine: it is a yardstick, and any tour it finds that is
    // shorter than the scheduled one proves there was slack.
    const left = stops.slice(); const order = [];
    let cur = null;
    while(left.length){
      let bi = 0, bd = Infinity;
      left.forEach((s,i)=>{ const d = leg(cur, s); if(d < bd){ bd = d; bi = i; } });
      cur = left[bi]; order.push(cur); left.splice(bi,1);
    }
    for(let pass=0; pass<40; pass++){
      let improved = false;
      for(let i=0;i<order.length-1;i++){
        for(let j=i+1;j<order.length;j++){
          const trial = order.slice(0,i).concat(order.slice(i,j+1).reverse(), order.slice(j+1));
          if(tourKm(trial) < tourKm(order) - 1e-9){ order.splice(0, order.length, ...trial); improved = true; }
        }
      }
      if(!improved) break;
    }
    const best = tourKm(order);
    return { km, best, ratio: best > 0 ? km/best : 1 };
  },

  // Why can this lesson not start any earlier?
  //
  // The gaps that survive compaction and tidying are not the optimizer's
  // choice — measured: adding dead time to its objective changed the result by
  // exactly zero minutes. They are forced by when people are free. So the only
  // useful thing left to do is name the constraint, because the user is the one
  // who can negotiate it.
  //
  // Returns null when there is no real gap, otherwise which constraint binds.
  explainGap(prev, next, day, students, settings){
    if(!prev || !next) return null;
    const margin = (settings.travelMargin ?? 2);
    const prevEnd = this.toMin(prev.end), start = this.toMin(next.start);
    const need = prev.studentId === next.studentId ? 0
      : this.legMin(margin, prev.studentId, prev.address, next.studentId, next.address, day, prevEnd);
    const couldStart = prevEnd + need;
    if(start <= couldStart + 4) return null;      // nothing worth explaining

    // Whichever constraint pushed it latest is the one to report.
    let bound = couldStart, reason = null;
    const dh = settings.dayHours && settings.dayHours[day];
    if(dh && this.toMin(dh.start) > bound){ bound = this.toMin(dh.start); reason = {kind:'dayStart'}; }

    const ids = this.occupantIds(next);
    const dur = this.toMin(next.end) - start;

    // Windows and breaks push each other: clearing a break can land inside an
    // hour someone is busy, and snapping into a free stretch can land inside a
    // break. relayoutDay alternates between the two for exactly this reason,
    // and the explanation has to follow the same path or it names the wrong
    // culprit.
    for(let guard=0; guard<(settings.blockedSlots||[]).length+4; guard++){
      const was = bound;

      for(const id of ids){
        const st = students.find(x=>x.id===id);
        const av = st && st.availability && st.availability[day];
        if(!av || !av.on) continue;
        // The EARLIEST moment this person could actually start, across every
        // stretch they are free in. This used to read av.start — the opening
        // of their LARGEST stretch only. Someone free 15:00-18:00 and again
        // 20:00-22:00 reported 15:00, which is not a reason for anything, so
        // a four-hour wait caused entirely by their second stretch came back
        // unexplained and the schedule looked broken for no stated cause.
        const fit = this.earliestFit(this.availWindows(st, day), bound, dur, 0);
        if(fit == null) continue;
        if(fit > bound){ bound = fit; reason = {kind:'availability', name:st.name, from:this.toTime(fit)}; }
      }

      for(const b of (settings.blockedSlots||[])){
        if(b.day!==day) continue;
        const bs = this.toMin(b.start), be = this.toMin(b.end);
        if(bs < bound + dur && be > bound){ bound = be; reason = {kind:'break', end:b.end}; }
      }

      if(bound === was) break;
    }

    if(!reason) return null;
    return { ...reason, wasted: start - couldStart };
  },

  // Dead time in one day: minutes spent neither teaching nor driving.
  dayIdle(slots, day, settings){
    const margin = (settings.travelMargin ?? 2);
    let idle = 0;
    for(let i=1;i<slots.length;i++){
      if(slots[i].studentId === slots[i-1].studentId) continue;  // one continuous block
      // The drive starts when the previous lesson ends — which decides whether
      // it is a rush-hour journey or a clear-road one.
      const drive = this.travelEstMin(slots[i-1].studentId, slots[i-1].address,
                                      slots[i].studentId, slots[i].address, day,
                                      this.toMin(slots[i-1].end));
      const same = this.samePlace(slots[i-1].studentId, slots[i-1].address, slots[i].studentId, slots[i].address);
      idle += Math.max(0, this.toMin(slots[i].start) - this.toMin(slots[i-1].end) - drive - (same ? 0 : margin));
    }
    return idle;
  },

  // What a day costs its owner: kilometres driven, plus an hour of sitting
  // around waiting counted as fifteen kilometres of driving. Waiting is not
  // free, and treating it as free is how a schedule ends up with a four-hour
  // hole in the middle of an afternoon.
  //
  // It used to be five kilometres an hour (0.083), which was too forgiving: a
  // detour of a few kilometres was allowed to buy back only a few minutes of
  // gap. Measured over 35 paired weeks at 5, 9, 15, 24, 42 and 72 km an hour:
  //
  //    km/hour   waiting     gaps 30min+   driving
  //       5      1259 min       11         2425 km
  //       9      1082            8         2442
  //      15       945            8         2469     <- here
  //      24       995            9         2470
  //      42       931            8         2477
  //      72       992            9         2472
  //
  // Up to fifteen the waiting falls by a quarter for under 2% more driving.
  // Beyond it nothing further is gained and the kilometres keep rising: the
  // gaps that remain are ones somebody's availability forces, which no price
  // can close. Same lessons placed and no violations at every setting.
  //
  // Raised to thirty at the owner's request — closing idle time matters more
  // to them than a few kilometres. With the passes added since (relocation,
  // refineWeek), 15 paired weeks of 7-13 clients measured:
  //
  //    km/hour   waiting   gaps 30min+   driving    lessons
  //      15       121 min      1         1147.0 km    214
  //      30        89          1         1158.6       214   <- here
  //      45        89          1         1158.6       214
  //
  // A quarter less waiting for 1% more driving; no week worse; 45 adds nothing.
  IDLE_KM_PER_MIN: 0.5,
  // km per minute between the start of the working day and its first stop,
  // in the ALNS objective only. See alnsOptimize.
  GAP_PENALTY_PER_MIN: 0.05,

  // ── Before / after ──────────────────────────────────────────────────────
  // The two sides are always measured by the same functions, on the same
  // travel data and the same rules, so the difference is the planning alone.
  dayDriveMin(slots, day, settings){
    if(!slots.length) return 0;
    const homeAddr = (settings && settings.homeAddress) || '';
    let min = 0, prevId = 'home', prevAddr = homeAddr, prevSl = null;
    let leaveAt = this.toMin(slots[0].start);
    for(const s of slots){
      const same = prevSl && (prevSl.studentId === s.studentId || (prevSl.groupCode && prevSl.groupCode === s.groupCode));
      if(!same) min += this.travelEstMin(prevId, prevAddr, s.studentId, s.address, day, leaveAt);
      prevId = s.studentId; prevAddr = s.address; prevSl = s; leaveAt = this.toMin(s.end);
    }
    return min + this.travelEstMin(prevId, prevAddr, 'home', homeAddr, day, leaveAt);
  },
  measureDay(slots, day, settings){
    const s = (slots || []).slice().sort((a, b) => this.toMin(a.start) - this.toMin(b.start));
    return { km: this.dayKm(s, day, settings), drive: this.dayDriveMin(s, day, settings),
             idle: this.dayIdle(s, day, settings), stops: s.length };
  },
  measureWeek(schedule, settings){
    const out = { km: 0, drive: 0, idle: 0, stops: 0 };
    for(const d of (settings.workDays || [])){
      const m = this.measureDay((schedule && schedule[d]) || [], d, settings);
      out.km += m.km; out.drive += m.drive; out.idle += m.idle;
    }
    out.stops = this.countTotal(schedule || {});
    return out;
  },
  // The day as the person would have driven it: in the order they wrote the
  // jobs down. If that order cannot work (a fixed time ends up too late), the
  // next most natural order: by the time each one has to be done. Never a
  // random or a deliberately bad order — that would only inflate the saving.
  dayBaseline(clients, cfg, day){
    if(!clients.length) return null;
    const lay = (cs) => this.relayoutDay(cs.map(c => this._lessonSlot(c, c.lessonDuration)), day, clients, cfg);
    let kind = 'typed', laid = lay(clients);
    if(!laid){
      // By when each one opens, and among equals by when it closes: a job that
      // must be done by 9:40 goes before one that can wait all day.
      const win = (c) => { const w = c.availability && c.availability[day] && c.availability[day].windows; return w && w[0] ? w[0] : [0, 1440]; };
      kind = 'time'; laid = lay(clients.slice().sort((a, b) => (win(a)[0] - win(b)[0]) || (win(a)[1] - win(b)[1])));
    }
    if(!laid) return null;
    return { kind, slots: laid, ...this.measureDay(laid, day, cfg) };
  },

  dayCost(slots, day, settings){
    return this.dayKm(slots, day, settings)
         + this.dayIdle(slots, day, settings) * this.IDLE_KM_PER_MIN;
  },

  // Tidy each day: reorder its lessons to cut driving and dead time.
  //
  // Two things the earlier passes cannot do. compactDays pulls lessons earlier
  // but never reorders, so a hole stays open whenever the NEXT student is not
  // free earlier — even when someone later in the day is free the whole
  // afternoon and could simply move up. And the optimizer minimises kilometres
  // only, so it happily leaves a four-hour wait if the driving is short, and
  // can leave a day bouncing Rio, Patra, Rio, Patra because visit order is
  // locked to lesson times.
  //
  // The move is an exchange of two lessons' positions — the same move a user
  // makes by hand when they tap two lessons to trade places. Every candidate is
  // re-timed with relayoutDay and kept only if it is legal AND cheaper, so the
  // pass can only improve a day.
  //
  // Relocation moves (lift one lesson out and reinsert it elsewhere) were
  // measured too: worth about 1% over 11 days, and no test could isolate a case
  // where exchanges could not reach the same arrangement. Not kept — doubling
  // the candidates for a gain nothing can demonstrate is how untestable code
  // accumulates.
  tidyDays(schedule, students, settings, frozen){
    // `frozen` is a Set of student ids whose lessons must keep their place in
    // the order. After a hand swap the two people swapped are frozen: the point
    // of a swap is that they trade places, and a tidy-up that quietly put them
    // back would undo it. Everyone else stays free to move.
    const isFrozen = (sl) => !!(frozen && frozen.has(sl.studentId));
    let moves = 0, kmSaved = 0, idleSaved = 0;
    for(const day of (settings.workDays||[])){
      let slots = (schedule[day]||[]).slice()
        .sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
      if(slots.length < 3) continue;
      let cost = this.dayCost(slots, day, settings);
      const km0 = this.dayKm(slots, day, settings);
      const idle0 = this.dayIdle(slots, day, settings);

      for(let pass=0; pass<8; pass++){
        let improved = false;
        for(let i=0;i<slots.length-1;i++){
          for(let j=i+1;j<slots.length;j++){
            // Never reorder a student's own back-to-back block apart.
            if(slots[i].studentId === slots[j].studentId) continue;
            if(isFrozen(slots[i]) || isFrozen(slots[j])) continue;
            const trial = slots.slice();
            [trial[i], trial[j]] = [trial[j], trial[i]];
            const laid = this.relayoutDay(trial, day, students, settings);
            if(!laid) continue;
            const c = this.dayCost(laid, day, settings);
            if(c < cost - 0.05){ slots = laid; cost = c; moves++; improved = true; }
          }
        }
        // Moving ONE lesson to another place in the order, rather than trading
        // two. Only when something is frozen, and that is the point: with two
        // lessons pinned, an exchange cannot reach the arrangement that closes
        // the hole — someone free all day sits behind a frozen lesson that
        // cannot start until 20:00, and the only way to put them ahead of it is
        // to lift them and put them down earlier. Without frozen lessons the
        // exchanges already reach the same places, and measured relocation
        // moves were worth about 1% for double the work, so the ordinary
        // pipeline does not pay for them.
        if(frozen && frozen.size){
          for(let i=0;i<slots.length;i++){
            if(isFrozen(slots[i])) continue;
            for(let j=0;j<slots.length;j++){
              if(j===i) continue;
              const trial = slots.slice();
              const [moved] = trial.splice(i,1);
              trial.splice(j,0,moved);
              const laid = this.relayoutDay(trial, day, students, settings);
              if(!laid) continue;
              const c = this.dayCost(laid, day, settings);
              if(c < cost - 0.05){ slots = laid; cost = c; moves++; improved = true; i = -1; break; }
            }
          }
        }
        if(!improved) break;
      }
      schedule[day] = slots;
      kmSaved += km0 - this.dayKm(slots, day, settings);
      idleSaved += idle0 - this.dayIdle(slots, day, settings);
    }
    return { moves, kmSaved, idleSaved };
  },

  /**
   * Close the holes a change has just left, on the days it touched.
   *
   * Any move or swap leaves a hole behind: the lesson that left its day, or
   * the day that had to be re-timed around a lesson of a different length.
   * Until the day is gathered up again, the change looks worse than it is —
   * and that is not cosmetic. fillGaps used to price a candidate move BEFORE
   * gathering the day it came from, so a move that saved 7 km-equivalents
   * once Tuesday was tidied looked like it cost 2, and was refused. Measured:
   * a quarter of the gaps left at the end of a run were fillable by exactly
   * such a move.
   *
   * One place for it, so the hand swap, the hand move, the automatic gap
   * fill and the refinement all gather the same way.
   *
   * `frozen`: student ids that must keep their place in the order (see
   * tidyDays). Only the listed days are touched.
   */
  gatherDays(schedule, students, settings, days, frozen){
    const only = (days || []).map(Number).filter(d => (settings.workDays || []).includes(d));
    if(!only.length) return { moves: 0, kmSaved: 0, idleSaved: 0 };
    const cfg = { ...settings, workDays: only };
    const tidied = this.tidyDays(schedule, students, cfg, frozen);
    this.compactDays(schedule, students, cfg);
    return tidied;
  },

  compactDays(schedule, students, settings){
    const sm = Object.fromEntries(students.map(s=>[s.id,s]));
    const margin = (settings.travelMargin ?? 2);
    let moved = 0, savedMin = 0;

    for(const d of settings.workDays){
      const dh = settings.dayHours && settings.dayHours[d];
      if(!dh) continue;
      const dayStart = this.toMin(dh.start);
      const slots = (schedule[d] || []).slice()
        .sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
      if(!slots.length) continue;
      const breaks = this.breaksOn(d, settings);

      let prev = null;
      for(const sl of slots){
        const s0 = this.toMin(sl.start), dur = this.toMin(sl.end) - s0;

        // Earliest this slot may start, per the people actually in it. No
        // stretch that can hold the lesson means leave it exactly where it is.
        const occupants = this.occupantsOf(sl, sm);
        if(!occupants || !occupants.length){ prev = sl; continue; }
        const usable = this.usableWindows(occupants, d, dur, settings);
        if(!usable){ prev = sl; continue; }
        const wins = usable.wins;
        let earliest = Math.max(dayStart, wins[0][0]);

        if(prev){
          // Same student back-to-back (a δίωρο) is one continuous block: no
          // travel, no margin. Anything else needs the real drive plus margin.
          const need = prev.studentId === sl.studentId
            ? 0
            : this.legMin(margin, prev.studentId, prev.address, sl.studentId, sl.address, d,
                                this.toMin(prev.end));
          earliest = Math.max(earliest, this.toMin(prev.end) + need);
        }

        const legal = this.earliestLegal(wins, breaks, earliest, dur);
        const ok = legal !== null;
        if(ok) earliest = legal;

        if(ok && earliest < s0 && !this.isBlocked(earliest, earliest+dur, d, settings)){
          sl.start = this.toTime(earliest);
          sl.end   = this.toTime(earliest+dur);
          savedMin += s0 - earliest;
          moved++;
        }
        prev = sl;
      }
      schedule[d] = slots;
    }
    return { moved, savedMin };
  },

  // A forceMerge ("δίωρο ίδια μέρα") student is only guaranteed to land as
  // ONE continuous block by Phase 0's initial placement — a later repair
  // pass (enforceConstraints, LNS) can legally re-place their sessions as
  // separate fragments instead, since nothing after Phase 0 actually
  // enforces "must stay one block" for them, only "never twice on a day
  // unless forceMerge". The result looks like a δίωρο (same day, close
  // together) but has a few minutes of leftover travel-margin gap between
  // the fragments instead of being a clean back-to-back block. Collapse any
  // such fragments into one true block as a final normalization pass.
  // A gap this long is worth trying to close by bringing work over from
  // another day. Below it, moving someone's lesson to a different weekday is a
  // bigger imposition on them than the waiting is on the user.
  GAP_FILL_MIN: 45,

  /**
   * Last resort against dead time: if a finished day still has a long hole in
   * it, try to move a lesson from ANOTHER day into it.
   *
   * Everything before this closes gaps within one day — compactDays pulls
   * lessons earlier, tidyDays reorders them — and lnsRepair only ever places
   * students who are still short of lessons. Nothing moved an already-placed
   * lesson across days, so a hole that could only be filled from Tuesday
   * stayed open on Monday forever.
   *
   * Measured before it was written: across twelve generated weeks not one of
   * the remaining gaps could be filled this way — every one was held open by
   * the next student's own availability. So this is a guarantee rather than an
   * optimization: it makes "the gap is still here because nobody can go in it"
   * true by construction instead of true by my sampling. It is bounded
   * accordingly and does nothing on a schedule that is already tight.
   *
   * Legality is judged by verifySchedule on a trial copy — the same rule set
   * the scheduler holds itself to. A second, partial copy of the rules living
   * here is exactly the bug this codebase keeps producing.
   */
  fillGaps(schedule, students, settings, budgetMs = 1500){
    const t0 = Date.now();
    const margin = settings.travelMargin ?? 2;
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const moved = [];
    const before = new Set(this.verifySchedule(schedule, students, settings));

    // The guard the other passes use (notWorse) weighs kilometres only, so it
    // would veto exactly the trade this pass exists to make: a little more
    // driving in exchange for a lot less waiting. Judge by the week's cost in
    // the units tidyDays already uses, where a minute of dead time has a price.
    const weekCost = (sch) => (settings.workDays || []).reduce((sum, d) =>
      sum + this.dayCost((sch[d] || []).slice()
        .sort((x,y) => this.toMin(x.start) - this.toMin(y.start)), d, settings), 0);
    const placedNow = this.countTotal(schedule);

    // A lesson that shares its slot with someone else cannot travel alone.
    const movable = sl => !sl.isGroup && !sl.merged && !sl.pairedStudentId &&
      !(sl.groupMemberIds && sl.groupMemberIds.length) &&
      !this.mergesLessons(byId[sl.studentId]);

    const gapsOn = (day) => {
      const slots = (schedule[day] || []).slice()
        .sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
      const out = [];
      for(let i=1;i<slots.length;i++){
        const drive = this.legMin(margin, slots[i-1].studentId, slots[i-1].address,
          slots[i].studentId, slots[i].address, day, this.toMin(slots[i-1].end));
        const idle = this.toMin(slots[i].start) - this.toMin(slots[i-1].end) - drive;
        if(idle >= this.GAP_FILL_MIN)
          out.push({ from: this.toMin(slots[i-1].end), to: this.toMin(slots[i].start), idle });
      }
      return out;
    };

    for(const day of settings.workDays){
      for(const gap of gapsOn(day)){
        if(Date.now() - t0 > budgetMs) return { moved };
        let done = false;
        for(const other of settings.workDays){
          if(done) break;
          if(other === day) continue;
          for(const cand of (schedule[other] || []).slice()){
            if(Date.now() - t0 > budgetMs) return { moved };
            if(!movable(cand)) continue;
            const st = byId[cand.studentId];
            if(!st) continue;
            // Two lessons on one day is a different question, decided elsewhere.
            if((schedule[day] || []).some(s => s.studentId === st.id)) continue;
            const av = st.availability && st.availability[day];
            if(!av || !av.on) continue;
            const dur = this.toMin(cand.end) - this.toMin(cand.start);
            if(dur > gap.idle) continue;

            for(let t = gap.from; t + dur <= gap.to; t += 5){
              const trial = {};
              for(const d of settings.workDays) trial[d] = (schedule[d] || []).slice();
              // The two days that get gathered are COPIED down to the lesson
              // objects. gatherDays -> compactDays changes start and end in
              // place, and a shallow copy of the array shares those objects
              // with the real schedule: a candidate that was then REJECTED had
              // already moved somebody's lesson in the real week.
              trial[other] = trial[other].filter(x => x !== cand).map(x => ({ ...x }));
              trial[day] = trial[day].map(x => ({ ...x }));
              trial[day] = trial[day]
                .concat([{ ...cand, start: this.toTime(t), end: this.toTime(t + dur) }])
                .sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
              const introduced = this.verifySchedule(trial, students, settings)
                .filter(x => !before.has(x));
              if(introduced.length) continue;
              // The first legal start is the one to price. Later starts in the
              // same gap only leave more of it empty.
              //
              // Priced AFTER gathering the two days it touches. Judged as it
              // stood, the day the lesson left still has a hole where it was,
              // so a move that pays off once that day is tidied looked like a
              // loss and was refused.
              this.gatherDays(trial, students, settings, [other, day]);
              // Gathering only makes legal moves, but this is cheap and the
              // alternative is trusting it.
              if(this.verifySchedule(trial, students, settings).some(x => !before.has(x))) break;
              // Moving never drops anyone, but assert it rather than trust it:
              // a silent placement loss is the one outcome worse than the gap.
              if(this.countTotal(trial) !== placedNow) break;
              if(weekCost(trial) >= weekCost(schedule)) break;
              for(const d of settings.workDays) schedule[d] = trial[d];
              moved.push({ name: st.name, from: other, to: day, at: this.toTime(t) });
              done = true;
              break;
            }
            if(done) break;
          }
        }
      }
    }
    return { moved };
  },

  // A wait shorter than this is not worth moving anyone for.
  RELOCATE_MIN_IDLE: 15,

  /** A lesson that can travel on its own: not shared, not a merged block. */
  _movableAlone(sl, byId){
    if(sl.isGroup || sl.merged || sl.pairedStudentId) return false;
    if(sl.groupMemberIds && sl.groupMemberIds.length) return false;
    const st = byId[sl.studentId];
    return !!st && !st.pairedWith && !(st.type === 'group' && st.group) && !this.mergesLessons(st);
  },

  /**
   * The best place for ONE lesson on ANOTHER day, if it can go there at all.
   *
   * fillGaps only ever asked "who fits into this gap?". That misses the more
   * common case: a lesson that CAUSES the wait — its student is free only from
   * 20:00, so everything before it sits idle — could simply go to another day,
   * and it does not need a gap there to do it. A lesson can go at the end of a
   * day, or in the middle with the rest shifted along. So every position on
   * the target day is tried, laid out by relayoutDay (which honours
   * availability, breaks and the working day), and the cheapest legal one wins.
   *
   * Priced with both days gathered, for the reason gatherDays gives. Only
   * compaction here, not the full tidy: this runs for every candidate and the
   * tidy is the expensive part. It is conservative — a full tidy afterwards can
   * only improve the result — so a move that pays under compaction alone is
   * one that certainly pays.
   */
  /**
   * Bring every day down to the user's limit (settings.maxPerDay) by moving
   * lessons to days that still have room. Each move goes through relocateBest,
   * so it keeps every constraint and everyone placed; among the legal moves the
   * cheapest one (drive + idle time) is made first. Days that cannot be relieved
   * stay as they are: placing everyone matters more than the limit.
   */
  rebalanceDays(schedule, students, settings, budgetMs = 15000){
    const cap = settings.maxPerDay|0;
    if(!cap) return { moved: 0 };
    const t0 = Date.now();
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const weekCost = (sch) => (settings.workDays || []).reduce((sum, d) =>
      sum + this.dayCost((sch[d] || []).slice()
        .sort((x,y) => this.toMin(x.start) - this.toMin(y.start)), d, settings), 0);
    let moved = 0;
    for(let round = 0; round < 40 && Date.now() - t0 < budgetMs && !this._stopped(); round++){
      const over = (settings.workDays || []).filter(d => (schedule[d] || []).length > cap);
      if(!over.length) break;
      const ctx = { byId, weekCost,
        before: new Set(this.verifySchedule(schedule, students, settings)),
        placed: this.countTotal(schedule) };
      let best = null;
      for(const from of over){
        for(const lesson of (schedule[from] || [])){
          if(lesson.merged || lesson.isGroup) continue;
          for(const to of settings.workDays){
            if(to === from || (schedule[to] || []).length >= cap) continue;
            const r = this.relocateBest(schedule, students, settings, lesson, from, to, ctx);
            if(r && (!best || r.cost < best.cost)) best = r;
          }
        }
      }
      if(!best) break;
      for(const d of Object.keys(best.trial)) schedule[d] = best.trial[d];
      moved++;
    }
    return { moved };
  },

  relocateBest(schedule, students, settings, lesson, fromDay, toDay, ctx, out){
    // `out.reason` says WHY when the answer is no: a refusal nobody can explain
    // looks exactly like a bug, and is the hardest kind to report.
    const say = (r) => { if(out) out.reason = r; };
    const byId = ctx.byId;
    const st = byId[lesson.studentId];
    if(!st){ say('unknown'); return null; }
    const av = st.availability && st.availability[toDay];
    if(!av || !av.on){ say('unavailable'); return null; }
    if((schedule[toDay] || []).some(x => this.occupantIds(x).includes(st.id))){ say('already'); return null; }
    if((settings.maxPerDay|0) && (schedule[toDay] || []).length >= (settings.maxPerDay|0)){ say('full'); return null; }
    const target = (schedule[toDay] || []).slice()
      .sort((a,b) => this.toMin(a.start) - this.toMin(b.start));

    let best = null, laidAny = false;
    for(let pos = 0; pos <= target.length; pos++){
      const arr = target.map(x => ({ ...x }));
      arr.splice(pos, 0, { ...lesson });
      const laid = this.relayoutDay(arr, toDay, students, settings);
      if(!laid) continue;
      laidAny = true;
      const trial = {};
      for(const d of settings.workDays) trial[d] = (schedule[d] || []).slice();
      trial[fromDay] = trial[fromDay].filter(x => x !== lesson).map(x => ({ ...x }));
      trial[toDay] = laid;
      const cfg = { ...settings, workDays: [fromDay, toDay] };
      this.compactDays(trial, students, cfg);
      if(this.verifySchedule(trial, students, settings).some(x => !ctx.before.has(x))) continue;
      if(this.countTotal(trial) !== ctx.placed) continue;
      const cost = ctx.weekCost(trial);
      if(!best || cost < best.cost){
        const placedLesson = trial[toDay].find(x => x.studentId === lesson.studentId);
        best = { cost, fromDay, toDay, trial, start: placedLesson && placedLesson.start,
                 end: placedLesson && placedLesson.end };
      }
    }
    say(best ? 'ok' : (laidAny ? 'illegal' : 'noroom'));
    return best;
  },

  /**
   * Every other day a lesson could go to, and for each either where and at what
   * cost or the reason it cannot. Used to offer the move by hand and to say why
   * it was not made automatically.
   */
  relocationOptions(schedule, students, settings, lesson, fromDay){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const weekCost = (sch) => (settings.workDays || []).reduce((sum, d) =>
      sum + this.dayCost((sch[d] || []).slice()
        .sort((x,y) => this.toMin(x.start) - this.toMin(y.start)), d, settings), 0);
    const ctx = { byId, weekCost,
      before: new Set(this.verifySchedule(schedule, students, settings)),
      placed: this.countTotal(schedule) };
    const base = weekCost(schedule);
    return (settings.workDays || []).filter(d => d !== fromDay).map(toDay => {
      const out = {};
      const best = this.relocateBest(schedule, students, settings, lesson, fromDay, toDay, ctx, out);
      return { toDay, reason: out.reason, best, delta: best ? best.cost - base : null };
    });
  },

  /**
   * Time economy: move a lesson to another day when that leaves the whole week
   * cheaper — driving plus waiting, at the price of waiting set by
   * IDLE_KM_PER_MIN.
   *
   * Looks at the lessons that are preceded by a wait, since a lesson that
   * starts the moment the drive ends is not the cause of anything. The classic
   * case: a student free only from 20:00 makes the teacher sit around for half
   * an hour first, while on another day the same lesson fits with no wait at
   * all. Nobody could ask for that move by looking at a gap — the lesson that
   * should move is the one AFTER it.
   *
   * Takes the single best move, applies it, and looks again, until nothing
   * improves or the time is up. Legality is verifySchedule, as everywhere.
   */
  relocateForTime(schedule, students, settings, budgetMs = 1500){
    const t0 = Date.now();
    const margin = settings.travelMargin ?? 2;
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const moved = [];
    const weekCost = (sch) => (settings.workDays || []).reduce((sum, d) =>
      sum + this.dayCost((sch[d] || []).slice()
        .sort((x,y) => this.toMin(x.start) - this.toMin(y.start)), d, settings), 0);

    for(let round = 0; round < 12; round++){
      if(Date.now() - t0 > budgetMs) break;
      const ctx = { byId, weekCost,
        before: new Set(this.verifySchedule(schedule, students, settings)),
        placed: this.countTotal(schedule) };
      const base = weekCost(schedule);
      let best = null;

      for(const day of settings.workDays){
        const slots = (schedule[day] || []).slice()
          .sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
        for(let i = 1; i < slots.length; i++){
          if(Date.now() - t0 > budgetMs) break;
          const prev = slots[i-1], cur = slots[i];
          const drive = this.legMin(margin, prev.studentId, prev.address, cur.studentId, cur.address,
            day, this.toMin(prev.end));
          const idle = this.toMin(cur.start) - this.toMin(prev.end) - drive;
          if(idle < this.RELOCATE_MIN_IDLE) continue;
          if(!this._movableAlone(cur, byId)) continue;
          for(const other of settings.workDays){
            if(other === day) continue;
            const r = this.relocateBest(schedule, students, settings, cur, day, other, ctx);
            if(r && r.cost < base - 0.5 && (!best || r.cost < best.cost)){
              best = { ...r, lesson: cur, name: byId[cur.studentId].name, saved: base - r.cost };
            }
          }
        }
      }
      if(!best) break;
      for(const d of settings.workDays) schedule[d] = best.trial[d];
      // The full tidy on the two days it touched. It can only improve them.
      this.gatherDays(schedule, students, settings, [best.fromDay, best.toDay]);
      moved.push({ name: best.name, from: best.fromDay, to: best.toDay, at: best.start, saved: best.saved });
    }
    return { moved };
  },

  /**
   * Who could go into this gap, by the user's choice rather than the
   * scheduler's.
   *
   * fillGaps closes a hole on its own when a move is a clear win. This is the
   * other half: the user looks at a hole and asks "who fits here?", and gets a
   * list to pick from — including people the scheduler would not have chosen
   * (a longer drive, a different day) because only the user knows what is
   * worth it.
   *
   * Two kinds of candidate:
   *   move      a lesson already placed on another day, brought over
   *   unplaced  someone still short of lessons, who gets one here
   *
   * Legality is verifySchedule on a trial copy — the same rule set as
   * everything else, so nothing offered here can produce an invalid week.
   * Every 5-minute start inside the gap is tried, and the first legal one is
   * reported.
   */
  gapCandidates(schedule, students, settings, day, fromMin, toMin){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const before = new Set(this.verifySchedule(schedule, students, settings));
    const placed = {};
    for(const d of settings.workDays)
      for(const sl of (schedule[d] || []))
        for(const id of this.occupantIds(sl)) placed[id] = (placed[id] || 0) + (sl.mergedCount || 1);

    const solo = st => st && !st.pairedWith && !(st.type === 'group' && st.group) && !this.mergesLessons(st);
    const onDay = id => (schedule[day] || []).some(x => this.occupantIds(x).includes(id));
    const cands = [];

    const tryStart = (build, dur, removeFrom, removeSlot) => {
      for(let t = fromMin; t + dur <= toMin; t += 5){
        const trial = {};
        for(const d of settings.workDays) trial[d] = (schedule[d] || []).slice();
        if(removeFrom != null) trial[removeFrom] = trial[removeFrom].filter(x => x !== removeSlot);
        trial[day] = trial[day].concat([build(t)])
          .sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
        const introduced = this.verifySchedule(trial, students, settings).filter(x => !before.has(x));
        if(!introduced.length) return t;
      }
      return null;
    };

    // Someone short of lessons gets one here.
    for(const st of students){
      if(!solo(st) || onDay(st.id)) continue;
      if((placed[st.id] || 0) >= st.lessonsPerWeek) continue;
      const av = st.availability && st.availability[day];
      if(!av || !av.on) continue;
      const dur = this.durOf(st, schedule);
      const t = tryStart(t0 => ({ studentId: st.id, studentName: st.name, subject: st.subject || '—',
        address: st.address, color: st.color || 0, start: this.toTime(t0), end: this.toTime(t0 + dur),
        duration: dur, mergedCount: 1, merged: false }), dur);
      if(t != null) cands.push({ kind: 'unplaced', studentId: st.id, name: st.name,
        fromDay: null, start: this.toTime(t), end: this.toTime(t + dur), minutes: dur });
    }

    // A lesson already placed elsewhere, brought over.
    for(const other of settings.workDays){
      if(other === day) continue;
      for(const cand of (schedule[other] || [])){
        if(cand.isGroup || cand.merged || cand.pairedStudentId) continue;
        if(cand.groupMemberIds && cand.groupMemberIds.length) continue;
        const st = byId[cand.studentId];
        if(!solo(st) || onDay(st.id)) continue;
        const av = st.availability && st.availability[day];
        if(!av || !av.on) continue;
        const dur = this.toMin(cand.end) - this.toMin(cand.start);
        const t = tryStart(t0 => ({ ...cand, start: this.toTime(t0), end: this.toTime(t0 + dur) }),
          dur, other, cand);
        if(t != null) cands.push({ kind: 'move', studentId: st.id, name: st.name, fromDay: other,
          start: this.toTime(t), end: this.toTime(t + dur), minutes: dur,
          fromStart: cand.start });
      }
    }
    // The lesson RIGHT AFTER the gap, sent to another day. Often that lesson
    // is the reason for the gap — its student is free only from 20:00 — and
    // sending it elsewhere closes the wait without anyone having to fit inside.
    const after = (schedule[day] || []).find(x => this.toMin(x.start) === toMin);
    const relocateNotes = [];
    if(after && this._movableAlone(after, byId)){
      for(const o of this.relocationOptions(schedule, students, settings, after, day)){
        if(o.best){
          cands.push({ kind: 'relocate', studentId: after.studentId,
            name: (byId[after.studentId] || {}).name || '', fromDay: day, toDay: o.toDay,
            fromStart: after.start, start: o.best.start, end: o.best.end,
            minutes: this.toMin(after.end) - this.toMin(after.start),
            cheaper: o.delta < -0.5, delta: o.delta });
        } else relocateNotes.push({ toDay: o.toDay, reason: o.reason });
      }
    }
    cands.relocateNotes = relocateNotes;
    cands.afterName = after ? ((byId[after.studentId] || {}).name || '') : '';

    // Filling a hole with someone who had no lesson beats shuffling one that
    // did, and earlier in the gap beats later.
    const rank = { unplaced: 0, move: 1, relocate: 2 };
    const notes = cands.relocateNotes, afterName = cands.afterName;
    const sorted = cands.sort((a,b) => (rank[a.kind] - rank[b.kind])
      || (a.kind === 'relocate' ? (a.delta - b.delta) : 0)
      || this.toMin(a.start) - this.toMin(b.start));
    sorted.relocateNotes = notes;
    sorted.afterName = afterName;
    return sorted;
  },

  /**
   * A short second look at every day EXCEPT one.
   *
   * After the user puts someone into a gap by hand, the rest of the week may
   * no longer be the best arrangement: a lesson moved over from Tuesday leaves
   * Tuesday different, and the person just placed may have freed a slot
   * somewhere else. This gives the other days a brief refinement.
   *
   * The day the user just worked on is left exactly as they made it. That is
   * done by construction, not by checking afterwards: every pass reads
   * settings.workDays, so handing them a copy WITHOUT that day means they
   * cannot touch it, and only those days are copied back at the end. The
   * user chose that lesson; a refinement that quietly moved it again would
   * be the app overruling them a second after asking.
   *
   * Three ways this refuses to make things worse, each of which reverts to
   * the schedule as it was:
   *  - the refined week places fewer people or drives further (the same rule
   *    every other pass answers to);
   *  - it introduces a problem verifySchedule did not already report;
   *  - the schedule changed while it was thinking. The passes yield to the
   *    browser, so the user can swap two lessons mid-way, and adopting the
   *    result would silently undo what they just did.
   */
  async refineExcept(schedule, students, settings, pinnedDay, budgetMs = 1500){
    const days = (settings.workDays || []).filter(d => d !== pinnedDay);
    if(!days.length) return { changed: 0, adopted: false, reason: 'nothing to refine' };
    const cfg = { ...settings, workDays: days };
    const coords = (typeof state !== 'undefined' && state.coords) || {};

    const snapshot = JSON.stringify(schedule);
    const issuesBefore = new Set(this.verifySchedule(schedule, students, settings));
    const scoreBefore = this.scoreOf(schedule, cfg);
    const work = JSON.parse(snapshot);

    await this.alnsOptimize(work, students, cfg, coords, Math.round(budgetMs * 0.7));
    this.enforceConstraints(work, students, cfg);
    await this.lnsRepair(work, students, cfg, Math.round(budgetMs * 0.3));
    this.enforceConstraints(work, students, cfg);
    this.tidyDays(work, students, cfg);
    this.compactDays(work, students, cfg);
    this.fillGaps(work, students, cfg, 400);
    this.relocateForTime(work, students, cfg, 400);
    this.compactDays(work, students, cfg);

    if(JSON.stringify(schedule) !== snapshot)
      return { changed: 0, adopted: false, reason: 'the schedule changed meanwhile' };
    if(!this.notWorse(this.scoreOf(work, cfg), scoreBefore))
      return { changed: 0, adopted: false, reason: 'not an improvement' };
    if(this.verifySchedule(work, students, settings).some(x => !issuesBefore.has(x)))
      return { changed: 0, adopted: false, reason: 'would introduce a problem' };

    // How many lessons actually moved, for the user and for the tests.
    const sig = (sch) => { const m = {};
      for(const d of days) for(const sl of (sch[d] || [])) m[d + '|' + sl.studentId + '|' + sl.start] = 1;
      return m; };
    const a = sig(schedule), b = sig(work);
    const changed = Object.keys(b).filter(k => !(k in a)).length;

    if(changed) for(const d of days) schedule[d] = work[d];
    return { changed, adopted: changed > 0 };
  },

  // ---- SMART RESCHEDULING (repair engine) -------------------------------
  //
  // A move that does not fit used to end in a refusal. This turns the refusal
  // into up to three ways of making it fit, each fully checked and priced:
  //
  //   level 1  relocate  the lesson goes into another free gap on the wanted day
  //   level 2  swap      whoever blocks the day trades: they go to the lesson's
  //                      old place or any other gap of the week, it takes theirs
  //   level 3  shift     a neighbour moves 15 or 30 minutes, inside their own
  //                      windows, and that opens the gap
  //
  // Nothing here changes the schedule. Every option is a list of `moves`, and
  // the SAME builder (_applyMoves) turns that list into the trial week both
  // when the options are drawn and when one is applied, so what the person
  // sees is exactly what happens. Legality is verifySchedule on that trial,
  // the one rule set the rest of the app holds itself to — only problems the
  // change INTRODUCES count, as everywhere else.
  //
  // This is read-only on the optimizer: it calls verifySchedule, legMin,
  // commonWindows and friends, and changes none of them.

  // A lesson has no id of its own: it is told apart by who, which day, when.
  // Accepts {studentId, day, start} or "studentId|day|start".
  _slotRef(ref){
    if(typeof ref === 'string'){
      const p = ref.split('|');
      return { studentId: p[0], day: Number(p[1]), start: p[2] };
    }
    return { studentId: ref.studentId, day: Number(ref.day), start: ref.start };
  },

  _cloneWeek(schedule, settings){
    const w = {};
    for(const d of (settings.workDays || [])) w[d] = (schedule[d] || []).slice();
    return w;
  },

  // Drive time of the given days: every leg between different places plus the
  // way out from home and back. The same figure before and after a change, so
  // the difference is what the change costs the person on the road.
  _travelMin(sch, days, settings){
    const margin = (settings.travelMargin ?? 2);
    const home = settings.homeAddress || '';
    let total = 0;
    for(const d of days){
      const sl = (sch[d] || []).slice().sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
      if(!sl.length) continue;
      const dh = settings.dayHours && settings.dayHours[d];
      let prev = null;
      for(const s of sl){
        if(!prev) total += this.travelEstMin('home', home, s.studentId, s.address || '', d,
          dh ? this.toMin(dh.start) : this.toMin(s.start));
        else if(prev.studentId !== s.studentId)
          total += this.legMin(margin, prev.studentId, prev.address, s.studentId, s.address, d, this.toMin(prev.end));
        prev = s;
      }
      total += this.travelEstMin(prev.studentId, prev.address || '', 'home', home, d, this.toMin(prev.end));
    }
    return total;
  },

  // The one place a list of moves becomes a week. Returns null when a move
  // names a lesson that is no longer where it was (the schedule changed since
  // the options were drawn) or a day that is not a working day.
  _applyMoves(schedule, settings, moves){
    const trial = this._cloneWeek(schedule, settings);
    const picked = [];
    for(const m of moves){
      if(!trial[m.fromDay] || (m.toDay != null && !trial[m.toDay])) return null;
      const sl = trial[m.fromDay].find(x => x.studentId === m.studentId &&
        this.toMin(x.start) === this.toMin(m.fromStart));
      if(!sl || picked.some(p => p[1] === sl)) return null;
      picked.push([m, sl]);
    }
    for(const [m, sl] of picked) trial[m.fromDay] = trial[m.fromDay].filter(x => x !== sl);
    for(const [m, sl] of picked) if(m.toDay != null)
      trial[m.toDay] = trial[m.toDay].concat([Object.assign({ ...sl, start: m.toStart, end: m.toEnd }, m.unlock ? { locked: false } : {})]);
    for(const d of Object.keys(trial))
      trial[d].sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
    return trial;
  },

  /**
   * Up to `opts.max` (3) ways to move one lesson to `targetDay` (at
   * `targetTime` if the person aimed at a time), cheapest drive first.
   *
   *   ref         {studentId, day, start} or "studentId|day|start"
   *   targetDay   the day number the lesson should go to
   *   targetTime  "HH:MM" or minutes, optional; breaks ties and says whose
   *               lesson is in the way
   *
   * Returns { ref, targetDay, targetTime, options, notes }. `notes` says why
   * there is nothing to offer when `options` is empty.
   *
   * Each option: { id, level, kind, deltaTravelMin, moves, touchedDays,
   * partner: {studentId,name}|null, shiftMin|null }. `moves` is the whole
   * change, the lesson itself first; apply it with applyRescheduleOption.
   */
  findRescheduleOptions(schedule, students, settings, ref, targetDay, targetTime = null, opts = {}){
    const max = opts.max || 3;
    const deadline = Date.now() + (opts.budgetMs || 1500);
    const r = this._slotRef(ref);
    const srcDay = Number(r.day);
    targetDay = Number(targetDay);
    const tt = (targetTime == null || targetTime === '') ? null
      : (typeof targetTime === 'number' ? targetTime : this.toMin(targetTime));
    const res = { ref: r, targetDay, targetTime: tt == null ? null : this.toTime(tt), options: [], notes: [] };
    const fail = (note) => { res.notes.push(note); return res; };

    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const days = settings.workDays || [];
    const src = (schedule[srcDay] || []).find(x => x.studentId === r.studentId &&
      this.toMin(x.start) === this.toMin(r.start));
    if(!src) return fail('no_lesson');
    if(!this._movableAlone(src, byId)) return fail('not_movable');
    if((schedule[srcDay] || []).some(x => x !== src && x.studentId === src.studentId)) return fail('multi_block');
    if(!days.includes(targetDay)) return fail('day_off');
    const st = byId[src.studentId];
    const av = st.availability && st.availability[targetDay];
    if(!av || !av.on) return fail('unavailable');
    if((schedule[targetDay] || []).some(x => x !== src && this.occupantIds(x).includes(st.id))) return fail('already');
    if(srcDay === targetDay && tt == null) return fail('same_day');

    const dur = this.toMin(src.end) - this.toMin(src.start);
    const grid = this.timeGrid(settings);
    const before = new Set(this.verifySchedule(schedule, students, settings));
    const legal = (trial) => !!trial &&
      !this.verifySchedule(trial, students, settings).some(x => !before.has(x));
    const timeUp = () => Date.now() > deadline;

    const moveOf = (sl, toDay, t, role) => {
      const d = this.toMin(sl.end) - this.toMin(sl.start);
      return { studentId: sl.studentId, name: sl.studentName || (byId[sl.studentId] || {}).name || '',
        fromDay: sl === src ? srcDay : sl._day, fromStart: sl.start, toDay,
        toStart: this.toTime(t), toEnd: this.toTime(t + d), role };
    };
    // Lessons on the wanted day, each tagged with its day so a move can name it.
    const onTarget = (schedule[targetDay] || []).filter(x => x !== src)
      .map(x => Object.assign(Object.create(null), x, { _orig: x, _day: targetDay }));
    const origOf = (x) => x._orig || x;
    const isBlockerOk = (b) => this._movableAlone(origOf(b), byId) && !b.locked;

    const dh = settings.dayHours && settings.dayHours[targetDay];
    if(!dh) return fail('day_off');
    const lo = this.toMin(dh.start), hi = this.toMin(dh.end) + this.endFlex();
    const wins = this.commonWindows([st], targetDay, settings);
    const inWin = (t, d = dur) => wins.some((w, i) => t >= w[0] && t + d <= w[1] + this.windowFlex(wins, i));
    const firstGrid = (m) => Math.ceil(m / grid) * grid;
    const cands = [];
    const l1Legal = new Set();

    // ---- level 1: another gap on the wanted day --------------------------
    const spots = new Map();
    for(let t = firstGrid(lo); t + dur <= hi; t += grid){
      if(!inWin(t)) continue;
      if(srcDay === targetDay && this.toMin(src.start) === t) continue;
      if(onTarget.some(x => this.toMin(x.start) < t + dur && this.toMin(x.end) > t)) continue;
      const moves = [moveOf(src, targetDay, t, 'primary')];
      const trial = this._applyMoves(schedule, settings, moves);
      if(!legal(trial)) continue;
      l1Legal.add(t);
      const pos = onTarget.filter(x => this.toMin(x.start) < t).length;
      const score = tt == null ? t : Math.abs(t - tt);
      const cur = spots.get(pos);
      if(!cur || score < cur.score) spots.set(pos, { t, score, moves, trial });
    }
    for(const s of spots.values())
      cands.push({ level: 1, kind: 'relocate', moves: s.moves, trial: s.trial, tdist: s.score, partner: null, shiftMin: null });

    // ---- level 2: swap with whoever is in the way -------------------------
    const nearTime = (b) => tt == null ? true
      : (this.toMin(b.start) < tt + dur + 30 && this.toMin(b.end) > tt - 30);
    const blockers = onTarget.filter(b => isBlockerOk(b) && nearTime(b))
      .sort((a,b) => (tt == null ? 0 : Math.abs(this.toMin(a.start) - tt) - Math.abs(this.toMin(b.start) - tt)))
      .slice(0, 6);
    for(const B of blockers){
      if(timeUp()) break;
      const Bo = origOf(B);
      const bs = this.toMin(B.start), be = this.toMin(B.end), bDur = be - bs;
      const bSt = byId[B.studentId];
      if(!bSt) continue;
      // Where the lesson would go once B is out of the way. Checked on a week
      // without B: removing a lesson can only clear problems, never add them.
      const noB = this._cloneWeek(schedule, settings);
      noB[targetDay] = noB[targetDay].filter(x => x !== Bo);
      const others = onTarget.filter(x => x !== B);
      let bestA = null;
      for(let t = firstGrid(bs - dur); t <= be; t += grid){
        if(t < lo || t + dur > hi || !inWin(t)) continue;
        if(others.some(x => this.toMin(x.start) < t + dur && this.toMin(x.end) > t)) continue;
        const mv = [moveOf(src, targetDay, t, 'primary')];
        const trial = this._applyMoves(noB, settings, mv);
        if(!legal(trial)) continue;
        const score = Math.abs(t - (tt == null ? bs : tt));
        if(!bestA || score < bestA.score) bestA = { t, score };
      }
      if(!bestA) continue;
      const aMove = moveOf(src, targetDay, bestA.t, 'primary');
      const bFrom = { studentId: B.studentId, name: B.studentName || bSt.name, fromDay: targetDay, fromStart: B.start };
      for(const toDay of days){
        if(timeUp()) break;
        const bav = bSt.availability && bSt.availability[toDay];
        if(!bav || !bav.on) continue;
        const dayH = settings.dayHours && settings.dayHours[toDay];
        if(!dayH) continue;
        // B may not end up twice on one day.
        if(toDay !== targetDay && (schedule[toDay] || []).some(x => x !== src && this.occupantIds(x).includes(bSt.id))) continue;
        const bWins = this.commonWindows([bSt], toDay, settings);
        const bIn = (t) => bWins.some((w, i) => t >= w[0] && t + bDur <= w[1] + this.windowFlex(bWins, i));
        let pick = null;
        // After the swap, what stands on that day: its lessons, minus B and
        // the lesson if either left it, plus the lesson if it arrives.
        const standing = (schedule[toDay] || []).filter(x => x !== Bo && x !== src)
          .concat(toDay === targetDay ? [{ start: this.toTime(bestA.t), end: this.toTime(bestA.t + dur) }] : []);
        for(let t = firstGrid(this.toMin(dayH.start)); t + bDur <= this.toMin(dayH.end) + this.endFlex(); t += grid){
          if(timeUp()) break;
          if(!bIn(t)) continue;
          if(toDay === targetDay && t === bs) continue;
          if(standing.some(x => this.toMin(x.start) < t + bDur && this.toMin(x.end) > t)) continue;
          const bMove = Object.assign({}, bFrom, { toDay, toStart: this.toTime(t), toEnd: this.toTime(t + bDur), role: 'partner' });
          const moves = [aMove, bMove];
          const trial = this._applyMoves(schedule, settings, moves);
          if(!legal(trial)) continue;
          const touched = [...new Set(moves.flatMap(m => [m.fromDay, m.toDay]))];
          const cost = this._travelMin(trial, touched, settings);
          const score = Math.abs(t - bs);
          if(!pick || cost < pick.cost || (cost === pick.cost && score < pick.score)) pick = { moves, trial, cost, score };
        }
        if(pick) cands.push({ level: 2, kind: 'swap', moves: pick.moves, trial: pick.trial, tdist: bestA.score,
          partner: { studentId: bSt.id, name: bSt.name }, shiftMin: null });
      }
    }

    // ---- level 3: a neighbour moves 15 or 30 minutes ----------------------
    for(const B of onTarget.filter(isBlockerOk)){
      if(timeUp()) break;
      const Bo = origOf(B);
      const bSt = byId[B.studentId];
      if(!bSt) continue;
      const bs = this.toMin(B.start), be = this.toMin(B.end);
      for(const s of [-30, -15, 15, 30]){
        if(timeUp()) break;
        const bMove = { studentId: B.studentId, name: B.studentName || bSt.name, fromDay: targetDay,
          fromStart: B.start, toDay: targetDay, toStart: this.toTime(bs + s), toEnd: this.toTime(be + s), role: 'partner' };
        let best = null;
        for(let t = firstGrid(bs - dur - 30); t <= be + 30; t += grid){
          if(t < lo || t + dur > hi || !inWin(t) || l1Legal.has(t)) continue;
          // Only what the shift itself makes possible: a time that already
          // worked without it belongs to level 1.
          const rest = onTarget.filter(x => x !== B);
          if(rest.some(x => this.toMin(x.start) < t + dur && this.toMin(x.end) > t)) continue;
          if(bs + s < t + dur && be + s > t) continue;
          const moves = [moveOf(src, targetDay, t, 'primary'), bMove];
          const trial = this._applyMoves(schedule, settings, moves);
          if(!legal(trial)) continue;
          const score = tt == null ? t : Math.abs(t - tt);
          if(!best || score < best.score) best = { t, score, moves, trial };
        }
        if(best) cands.push({ level: 3, kind: 'shift', moves: best.moves, trial: best.trial, tdist: best.score,
          partner: { studentId: bSt.id, name: bSt.name }, shiftMin: s });
      }
    }

    // ---- rank: least extra driving first ----------------------------------
    const spBefore = new Set(this.spacingViolations(schedule, students, settings).map(v => v.key));
    for(const c of cands){
      c.touchedDays = [...new Set(c.moves.flatMap(m => [m.fromDay, m.toDay]))];
      c.deltaTravelMin = this._travelMin(c.trial, c.touchedDays, settings) -
                         this._travelMin(schedule, c.touchedDays, settings);
      // Consecutive days this change would NEWLY create. Ones already there are not its doing.
      c.spacing = this.spacingViolations(c.trial, students, settings).filter(v => !spBefore.has(v.key));
    }
    const sig = (c) => c.moves.map(m => `${m.studentId}@${m.toDay}@${m.toStart}`).sort().join('|');
    const seen = new Set();
    cands.sort((a,b) => (a.spacing.length - b.spacing.length) || (a.deltaTravelMin - b.deltaTravelMin) ||
      (a.moves.length - b.moves.length) || (a.tdist - b.tdist) || (a.level - b.level));
    for(const c of cands){
      const k = sig(c);
      if(seen.has(k)) continue;
      seen.add(k);
      res.options.push({ id: `${c.kind}:${k}`, level: c.level, kind: c.kind, deltaTravelMin: c.deltaTravelMin,
        moves: c.moves, touchedDays: c.touchedDays, partner: c.partner, shiftMin: c.shiftMin,
        spacing: c.spacing.map(v => ({ studentId: v.studentId, name: v.name, days: v.days })) });
      if(res.options.length >= max) break;
    }
    if(!res.options.length) res.notes.push('no_option');
    return res;
  },

  /**
   * Make one option happen, all or nothing. Rebuilt from the option's moves
   * against the schedule as it is NOW — the list was drawn earlier and an
   * offer is not a guarantee — and checked again before a single day is
   * replaced. On success the touched days are swapped in together and `before`
   * holds what they were, for Undo. On failure nothing has changed.
   */
  applyRescheduleOption(schedule, students, settings, option){
    const trial = this._applyMoves(schedule, settings, option.moves || []);
    if(!trial) return { ok: false, reason: 'stale' };
    const rs = this._relaxedStudents(students, option);
    const before = new Set(this.verifySchedule(schedule, students, settings));
    if(this.verifySchedule(trial, rs, settings).some(x => !before.has(x)))
      return { ok: false, reason: 'illegal' };
    const days = [...new Set((option.moves || []).flatMap(m => [m.fromDay, m.toDay]).filter(d => d != null))];
    const snapshot = {};
    for(const d of days) snapshot[d] = (schedule[d] || []).slice();
    for(const d of days) schedule[d] = trial[d];
    // A level-5 option goes outside the person's hours on that day: stretch
    // them for real, so the week stays valid; Undo puts them back.
    let availability = null;
    if(option.relax){
      const st = students.find(s => s.id === option.relax.studentId);
      if(st){
        availability = { studentId: st.id, day: option.relax.day,
          av: st.availability && st.availability[option.relax.day] ? { ...st.availability[option.relax.day] } : null };
        st.availability = Object.assign({}, st.availability, { [option.relax.day]: { ...option.relax.av } });
      }
    }
    return { ok: true, before: snapshot, days, availability };
  },

  // Undo of applyRescheduleOption: put the touched days back as they were.
  restoreDays(schedule, snapshot, students, availability){
    for(const d of Object.keys(snapshot)) schedule[d] = snapshot[d].slice();
    if(availability && students){
      const st = students.find(s => s.id === availability.studentId);
      if(st){
        const a = Object.assign({}, st.availability);
        if(availability.av) a[availability.day] = availability.av; else delete a[availability.day];
        st.availability = a;
      }
    }
  },

  // ---- LEVEL 4: fit the lesson in and re-plan that one day ----------------
  //
  // When nothing simpler works (no gap, no swap, no 15-30' nudge), the lesson
  // is put on the wanted day anyway and the REST OF THAT DAY makes room: the
  // others on it slide earlier or later, each inside its own hours. Nobody
  // leaves the day, nobody locked / merged / in a group is touched, no other
  // day changes. The price is the extra driving plus the minutes people are
  // moved, and the option names each person who moves and by how much.
  //
  // Returns the same option shape as findRescheduleOptions (level 4, kind
  // 'replan') with `displacedMin` added. The core optimizer is not used:
  // this is a small greedy repair, checked by verifySchedule like every other
  // option, applied by applyRescheduleOption, undone by restoreDays.
  replanDayOptions(schedule, students, settings, ref, targetDay, targetTime = null, opts = {}){
    const max = opts.max || 3;
    const deadline = Date.now() + (opts.budgetMs || 1200);
    const maxShift = opts.maxShift || 120;
    const r = this._slotRef(ref);
    const srcDay = Number(r.day);
    targetDay = Number(targetDay);
    const out = [];
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const src = (schedule[srcDay] || []).find(x => x.studentId === r.studentId && this.toMin(x.start) === this.toMin(r.start));
    if(!src || !this._movableAlone(src, byId) || srcDay === targetDay) return out;
    const st = byId[src.studentId];
    const av = st.availability && st.availability[targetDay];
    if(!(settings.workDays || []).includes(targetDay) || !av || !av.on) return out;
    if((schedule[targetDay] || []).some(x => this.occupantIds(x).includes(st.id))) return out;
    const dh = settings.dayHours && settings.dayHours[targetDay];
    if(!dh) return out;
    const lo = this.toMin(dh.start), hi = this.toMin(dh.end) + this.endFlex();
    const grid = this.timeGrid(settings);
    const margin = settings.travelMargin ?? 3;
    const tt = (targetTime == null || targetTime === '') ? null
      : (typeof targetTime === 'number' ? targetTime : this.toMin(targetTime));
    const before = new Set(this.verifySchedule(schedule, students, settings));
    const spBefore = new Set(this.spacingViolations(schedule, students, settings).map(v => v.key));

    const dayList = (schedule[targetDay] || []).slice();
    const multi = (sl) => dayList.filter(x => x.studentId === sl.studentId).length > 1;
    const fixed = dayList.filter(x => x.locked || !this._movableAlone(x, byId) || multi(x));
    const movable = dayList.filter(x => !fixed.includes(x));
    const winsOf = (s) => this.commonWindows([s], targetDay, settings);
    const fits = (wins, t, d) => t >= lo && t + d <= hi &&
      wins.some((w, i) => t >= w[0] && t + d <= w[1] + this.windowFlex(wins, i));
    // Room between two lessons, the drive and margin included.
    const clear = (a, b) => {
      if(a.e <= b.s) return b.s - a.e >= this.legMin(margin, a.id, a.addr, b.id, b.addr, targetDay, a.e);
      if(b.e <= a.s) return a.s - b.e >= this.legMin(margin, b.id, b.addr, a.id, a.addr, targetDay, b.e);
      return false;
    };
    const iv = (sl, s) => { const d = this.toMin(sl.end) - this.toMin(sl.start);
      return { id: sl.studentId, addr: sl.address || '', s, e: s + d, d, sl }; };
    const dur = this.toMin(src.end) - this.toMin(src.start);
    const aWins = winsOf(st);
    const fixedIv = fixed.map(x => iv(x, this.toMin(x.start)));

    const tries = [];
    for(let t = Math.ceil(lo / grid) * grid; t + dur <= hi; t += grid){
      if(!fits(aWins, t, dur)) continue;
      const A = { id: src.studentId, addr: src.address || '', s: t, e: t + dur, d: dur, sl: src };
      if(!fixedIv.every(f => clear(A, f))) continue;
      tries.push(t);
    }
    if(tt != null) tries.sort((a, b) => Math.abs(a - tt) - Math.abs(b - tt));

    const seen = new Set();
    const cands = [];
    for(const t of tries){
      if(Date.now() > deadline) break;
      const A = { id: src.studentId, addr: src.address || '', s: t, e: t + dur, d: dur, sl: src };
      // Two orders: as the day stands, and nearest-to-the-new-lesson first.
      const orders = [
        movable.slice().sort((a, b) => this.toMin(a.start) - this.toMin(b.start)),
        movable.slice().sort((a, b) => Math.abs(this.toMin(a.start) - t) - Math.abs(this.toMin(b.start) - t)),
      ];
      for(const order of orders){
        const placed = [A, ...fixedIv];
        const moves = [];
        let ok = true, displaced = 0;
        for(const sl of order){
          const s0 = this.toMin(sl.start);
          const w = winsOf(byId[sl.studentId]);
          let got = null;
          for(let k = 0; k <= maxShift && !got; k += grid){
            for(const s of (k ? [s0 - k, s0 + k] : [s0])){
              const c = iv(sl, s);
              if(fits(w, s, c.d) && placed.every(p => clear(c, p))){ got = c; break; }
            }
          }
          if(!got){ ok = false; break; }
          placed.push(got);
          if(got.s !== s0){
            displaced += Math.abs(got.s - s0);
            moves.push({ studentId: sl.studentId, name: sl.studentName || (byId[sl.studentId] || {}).name || '',
              fromDay: targetDay, fromStart: sl.start, toDay: targetDay,
              toStart: this.toTime(got.s), toEnd: this.toTime(got.e), role: 'shifted', shiftMin: got.s - s0 });
          }
        }
        if(!ok || !moves.length) continue;
        const all = [{ studentId: src.studentId, name: src.studentName || st.name, fromDay: srcDay, fromStart: src.start,
          toDay: targetDay, toStart: this.toTime(t), toEnd: this.toTime(t + dur), role: 'primary' }, ...moves];
        const sig = all.map(m => `${m.studentId}@${m.toStart}`).sort().join('|');
        if(seen.has(sig)) continue;
        seen.add(sig);
        const trial = this._applyMoves(schedule, settings, all);
        if(!trial || this.verifySchedule(trial, students, settings).some(x => !before.has(x))) continue;
        const touched = [srcDay, targetDay];
        const delta = this._travelMin(trial, touched, settings) - this._travelMin(schedule, touched, settings);
        const spacing = this.spacingViolations(trial, students, settings).filter(v => !spBefore.has(v.key));
        cands.push({ t, all, delta, displaced, spacing,
          cost: delta + displaced / 2 + (tt == null ? 0 : Math.abs(t - tt) / 10) });
      }
    }
    cands.sort((a, b) => (a.spacing.length - b.spacing.length) || (a.cost - b.cost) || (a.all.length - b.all.length));
    for(const c of cands.slice(0, max)){
      out.push({ id: 'replan:' + c.all.map(m => `${m.studentId}@${m.toStart}`).join('|'), level: 4, kind: 'replan',
        deltaTravelMin: c.delta, displacedMin: c.displaced, moves: c.all, touchedDays: [srcDay, targetDay],
        partner: null, shiftMin: null,
        spacing: c.spacing.map(v => ({ studentId: v.studentId, name: v.name, days: v.days })) });
    }
    return out;
  },

  // ---- LEVEL 5: "it can be done, but…" -----------------------------------
  //
  // For a day where nothing fits — the person is not free that day, a locked
  // lesson is in the way, or the day is simply full — the honest answer is
  // still an answer: what it WOULD take. The lesson goes on that day anyway
  // (inside the working hours, outside the person's own hours if need be),
  // the day is re-planned, locked lessons may move (and are unlocked), and
  // whoever no longer fits is sent to another day — preferring days the
  // change already touches, so as few days as possible change.
  //
  // Each option says what it costs: who moves, which days change, whose own
  // hours it goes outside of, which locked lessons it unlocks. It is checked
  // like every other option, except that the person's hours on the wanted day
  // count as stretched (applying it stretches them for real; Undo puts them
  // back).
  _relaxedStudents(students, option){
    const st = option && option.relax;
    if(!st) return students;
    return students.map(s => s.id !== st.studentId ? s
      : Object.assign({}, s, { availability: Object.assign({}, s.availability, { [st.day]: st.av }) }));
  },

  forceDayOptions(schedule, students, settings, ref, targetDay, opts = {}){
    const max = opts.max || 3;
    const deadline = Date.now() + (opts.budgetMs || 1500);
    const maxShift = opts.maxShift || 120;
    const maxEvict = opts.maxEvict || 3;
    const r = this._slotRef(ref);
    const srcDay = Number(r.day);
    targetDay = Number(targetDay);
    const out = [];
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const src = (schedule[srcDay] || []).find(x => x.studentId === r.studentId && this.toMin(x.start) === this.toMin(r.start));
    if(!src || !this._movableAlone(src, byId) || srcDay === targetDay) return out;
    const st = byId[src.studentId];
    if(!(settings.workDays || []).includes(targetDay)) return out;
    if((schedule[targetDay] || []).some(x => this.occupantIds(x).includes(st.id))) return out;
    const dh = settings.dayHours && settings.dayHours[targetDay];
    if(!dh) return out;
    const lo = this.toMin(dh.start), hi = this.toMin(dh.end) + this.endFlex();
    const grid = this.timeGrid(settings);
    const margin = settings.travelMargin ?? 3;
    const days = (settings.workDays || []).map(Number);
    const dur = this.toMin(src.end) - this.toMin(src.start);

    const av0 = st.availability && st.availability[targetDay];
    const aWins0 = (av0 && av0.on) ? this.commonWindows([st], targetDay, settings) : [];
    const fitsW = (wins, t, d) => wins.some((w, i) => t >= w[0] && t + d <= w[1] + this.windowFlex(wins, i));
    const clear = (a, b, day) => {
      if(a.e <= b.s) return b.s - a.e >= this.legMin(margin, a.id, a.addr, b.id, b.addr, day, a.e);
      if(b.e <= a.s) return a.s - b.e >= this.legMin(margin, b.id, b.addr, a.id, a.addr, day, b.e);
      return false;
    };
    const iv = (sl, s) => { const d = this.toMin(sl.end) - this.toMin(sl.start);
      return { id: sl.studentId, addr: sl.address || '', s, e: s + d, d, sl }; };
    const before = new Set(this.verifySchedule(schedule, students, settings));
    const spBefore = new Set(this.spacingViolations(schedule, students, settings).map(v => v.key));
    const nameOf = (sl) => sl.studentName || (byId[sl.studentId] || {}).name || '';

    const dayList = (schedule[targetDay] || []).slice();
    const multi = (sl) => dayList.filter(x => x.studentId === sl.studentId).length > 1;
    const fixed = dayList.filter(x => !this._movableAlone(x, byId) || multi(x));
    const movable = dayList.filter(x => !fixed.includes(x));
    const fixedIv = fixed.map(x => iv(x, this.toMin(x.start)));
    const winsOn = (s, d) => this.commonWindows([s], d, settings);

    // A free place for one lesson on another day, as that day stands in `trial`.
    const placeElsewhere = (sl, trial, prefer) => {
      const s = byId[sl.studentId];
      if(!s) return null;
      const d0 = this.toMin(sl.end) - this.toMin(sl.start);
      let best = null;
      for(const d of days){
        if(d === targetDay) continue;
        const a = s.availability && s.availability[d];
        if(!a || !a.on) continue;
        if((trial[d] || []).some(x => this.occupantIds(x).includes(s.id))) continue;
        const h = settings.dayHours && settings.dayHours[d];
        if(!h) continue;
        const w = winsOn(s, d);
        const there = (trial[d] || []).map(x => iv(x, this.toMin(x.start)));
        for(let t = Math.ceil(this.toMin(h.start) / grid) * grid; t + d0 <= this.toMin(h.end) + this.endFlex(); t += grid){
          if(!fitsW(w, t, d0)) continue;
          const c = { id: sl.studentId, addr: sl.address || '', s: t, e: t + d0 };
          if(!there.every(p => clear(c, p, d))) continue;
          // On the day the lesson leaves, the natural place is the one it
          // frees: that is a straight swap.
          const aim = d === srcDay ? this.toMin(src.start) : this.toMin(sl.start);
          const score = (prefer.has(d) ? 0 : 1000) + Math.abs(t - aim);
          if(!best || score < best.score) best = { d, t, score };
        }
      }
      return best;
    };

    const cands = [];
    const seen = new Set();
    for(let t = Math.ceil(lo / grid) * grid; t + dur <= hi; t += grid){
      if(Date.now() > deadline) break;
      const A = { id: src.studentId, addr: src.address || '', s: t, e: t + dur, d: dur, sl: src };
      if(!fixedIv.every(f => clear(A, f, targetDay))) continue;
      const outside = !fitsW(aWins0, t, dur);
      const orders = [
        movable.slice().sort((a, b) => this.toMin(a.start) - this.toMin(b.start)),
        movable.slice().sort((a, b) => Math.abs(this.toMin(a.start) - t) - Math.abs(this.toMin(b.start) - t)),
      ];
      for(const order of orders){
        const placed = [A, ...fixedIv];
        const moves = [], evicted = [], unlocked = [];
        let displaced = 0, ok = true;
        for(const sl of order){
          const s0 = this.toMin(sl.start);
          const w = winsOn(byId[sl.studentId], targetDay);
          let got = null;
          if(!sl.locked || placed.every(p => clear(iv(sl, s0), p, targetDay))){
            for(let k = 0; k <= (sl.locked ? 0 : maxShift) && !got; k += grid){
              for(const s of (k ? [s0 - k, s0 + k] : [s0])){
                const c = iv(sl, s);
                if(s >= lo && c.e <= hi && fitsW(w, s, c.d) && placed.every(p => clear(c, p, targetDay))){ got = c; break; }
              }
            }
          }
          if(!got && sl.locked){
            // A locked lesson may only move if it must; then it is unlocked.
            for(let k = grid; k <= maxShift && !got; k += grid){
              for(const s of [s0 - k, s0 + k]){
                const c = iv(sl, s);
                if(s >= lo && c.e <= hi && fitsW(w, s, c.d) && placed.every(p => clear(c, p, targetDay))){ got = c; break; }
              }
            }
            if(got) unlocked.push(nameOf(sl));
          }
          if(!got){
            if(evicted.length >= maxEvict){ ok = false; break; }
            evicted.push(sl);
            if(sl.locked) unlocked.push(nameOf(sl));
            continue;
          }
          placed.push(got);
          if(got.s !== s0){
            displaced += Math.abs(got.s - s0);
            moves.push({ studentId: sl.studentId, name: nameOf(sl), fromDay: targetDay, fromStart: sl.start, toDay: targetDay,
              toStart: this.toTime(got.s), toEnd: this.toTime(got.e), role: 'shifted', shiftMin: got.s - s0, unlock: !!sl.locked });
          }
        }
        if(!ok) continue;
        const prim = { studentId: src.studentId, name: nameOf(src), fromDay: srcDay, fromStart: src.start,
          toDay: targetDay, toStart: this.toTime(t), toEnd: this.toTime(t + dur), role: 'primary' };
        let all = [prim, ...moves];
        // Those who no longer fit go to another day, one at a time, each
        // seeing where the ones before it went.
        const touched = new Set([srcDay, targetDay]);
        for(const E of evicted){
          const base = this._applyMoves(schedule, settings, all);
          if(!base){ ok = false; break; }
          base[targetDay] = base[targetDay].filter(x => !(x.studentId === E.studentId && this.toMin(x.start) === this.toMin(E.start)));
          const p = placeElsewhere(E, base, touched);
          if(!p){ ok = false; break; }
          touched.add(p.d);
          const d0 = this.toMin(E.end) - this.toMin(E.start);
          all.push({ studentId: E.studentId, name: nameOf(E), fromDay: targetDay, fromStart: E.start, toDay: p.d,
            toStart: this.toTime(p.t), toEnd: this.toTime(p.t + d0), role: 'evicted', unlock: !!E.locked });
        }
        if(!ok) continue;
        const sig = all.map(m => `${m.studentId}@${m.toDay}@${m.toStart}`).sort().join('|');
        if(seen.has(sig)) continue;
        seen.add(sig);
        // Nothing to say beyond what levels 1-4 already offer.
        if(!outside && !unlocked.length && !evicted.length) continue;
        const relax = outside ? { studentId: st.id, day: targetDay,
          av: { on: true, start: this.toTime(Math.min(t, aWins0.length ? aWins0[0][0] : t)),
                end: this.toTime(Math.max(t + dur, aWins0.length ? aWins0[aWins0.length - 1][1] : t + dur)) } } : null;
        const opt = { moves: all, relax };
        const trial = this._applyMoves(schedule, settings, all);
        if(!trial) continue;
        const rs = this._relaxedStudents(students, opt);
        if(this.verifySchedule(trial, rs, settings).some(x => !before.has(x))) continue;
        const tDays = [...touched];
        const delta = this._travelMin(trial, tDays, settings) - this._travelMin(schedule, tDays, settings);
        const spacing = this.spacingViolations(trial, rs, settings).filter(v => !spBefore.has(v.key));
        const ev = all.filter(m => m.role === 'evicted');
        const swapWith = ev.length === 1 && Number(ev[0].toDay) === srcDay &&
          Math.abs(this.toMin(ev[0].toStart) - this.toMin(src.start)) <= 30 ? ev[0].name : null;
        cands.push({ all, relax, delta, displaced, spacing, unlocked, evicted: evicted.map(nameOf), tDays, swapWith,
          cost: tDays.length * 1000 + unlocked.length * 300 + (outside ? 200 : 0) + evicted.length * 100 +
                spacing.length * 150 + displaced / 2 + delta });
      }
    }
    cands.sort((a, b) => a.cost - b.cost);
    // One option per shape: the same people moved the same way with the
    // lesson in the same place in the day is one choice, not three.
    const shapes = new Set();
    const picked = [];
    for(const c of cands){
      const tMin = this.toMin(c.all[0].toStart);
      const pos = dayList.filter(x => this.toMin(x.start) < tMin).length;
      const k = pos + '#' + c.all.slice(1).map(m => m.studentId + '>' + m.toDay).sort().join(',') + '#' + c.unlocked.join(',');
      if(shapes.has(k)) continue;
      shapes.add(k); picked.push(c);
      if(picked.length >= max) break;
    }
    for(const c of picked){
      out.push({ id: 'force:' + c.all.map(m => `${m.studentId}@${m.toDay}@${m.toStart}`).join('|'), level: 5, kind: 'force',
        deltaTravelMin: c.delta, displacedMin: c.displaced, moves: c.all, touchedDays: c.tDays, partner: null, shiftMin: null,
        relax: c.relax, unlocked: c.unlocked, evicted: c.evicted, swapWith: c.swapWith,
        spacing: c.spacing.map(v => ({ studentId: v.studentId, name: v.name, days: v.days })) });
    }
    return out;
  },

  // ---- SPACING IN THE WEEKLY PLAN ----------------------------------------
  //
  // After the optimizer has built the week, lessons that sit on two days in a
  // row for the same person are moved apart with the same moves the repair
  // panel offers (a gap, a swap, a nudge, re-planning that day) — never a
  // locked lesson, never a move that breaks anything verifySchedule checks.
  //   'prefer' (the default when the rule is on): only if it costs at most
  //            `preferMaxMin` extra minutes of driving.
  //   'strict': whatever it costs in driving; what still cannot be split is
  //            reported, not dropped.
  spacingMode(settings){
    const v = settings && settings.avoidConsecutiveDays;
    if(v === false || v === 'off') return 'off';
    return v === 'strict' ? 'strict' : 'prefer';
  },

  enforceSpacing(schedule, students, settings, opts = {}){
    const mode = opts.mode || this.spacingMode(settings);
    const res = { moved: 0, left: [] };
    const anyOn = students.some(s => s.spacing === 'on');
    if(mode === 'off' && !anyOn) return res;
    const maxCost = mode === 'strict' ? Infinity : (opts.preferMaxMin ?? 20);
    const deadline = Date.now() + (opts.budgetMs || 8000);
    const tried = new Set();
    for(let round = 0; round < 40 && Date.now() < deadline; round++){
      const vs = this.spacingViolations(schedule, students, settings);
      const v = vs.find(x => !tried.has(x.key));
      if(!v) break;
      const total = vs.length;
      let best = null;
      for(const d of v.days){
        const sl = (schedule[d] || []).find(x => x.studentId === v.studentId);
        if(!sl || sl.locked) continue;
        const ref = { studentId: sl.studentId, day: d, start: sl.start };
        for(const td of (settings.workDays || []).map(Number)){
          if(td === Number(d) || Date.now() > deadline) continue;
          let opts2 = [];
          try{
            const f = this.findRescheduleOptions(schedule, students, settings, ref, td, null, { budgetMs: 250, max: 3 });
            opts2 = f.options;
            if(!opts2.length && mode === 'strict')
              opts2 = this.replanDayOptions(schedule, students, settings, ref, td, null, { budgetMs: 250 });
          }catch(e){ opts2 = []; }
          for(const o of opts2){
            if(o.deltaTravelMin > maxCost) continue;
            const trial = this._applyMoves(schedule, settings, o.moves);
            if(!trial) continue;
            const after = this.spacingViolations(trial, students, settings);
            if(after.length >= total || after.some(x => x.key === v.key)) continue;
            const score = after.length * 1000 + o.deltaTravelMin + o.level;
            if(!best || score < best.score) best = { o, score };
          }
        }
      }
      if(best && this.applyRescheduleOption(schedule, students, settings, best.o).ok) res.moved++;
      else tried.add(v.key);
    }
    res.left = this.spacingViolations(schedule, students, settings);
    return res;
  },

  // ---- LAST RESORT: put the lesson there, re-plan the rest ----------------
  //
  // The person is free that day, but no swap, nudge, re-plan or "what it
  // would take" works. Then: the lesson goes on that day at the time that
  // pushes out the fewest (never a locked or shared lesson), those pushed out
  // leave the week for a moment, and a full calculation puts them back,
  // around the lesson, which is locked where it was put. The option names who
  // is pushed out. Nobody is lost: the calculation places them again.
  bumpDayOptions(schedule, students, settings, ref, targetDay, opts = {}){
    const max = opts.max || 2;
    const r = this._slotRef(ref);
    const srcDay = Number(r.day);
    targetDay = Number(targetDay);
    const out = [];
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const src = (schedule[srcDay] || []).find(x => x.studentId === r.studentId && this.toMin(x.start) === this.toMin(r.start));
    if(!src || !this._movableAlone(src, byId) || srcDay === targetDay) return out;
    const st = byId[src.studentId];
    const av = st.availability && st.availability[targetDay];
    if(!(settings.workDays || []).includes(targetDay) || !av || !av.on) return out;
    if((schedule[targetDay] || []).some(x => this.occupantIds(x).includes(st.id))) return out;
    const dh = settings.dayHours && settings.dayHours[targetDay];
    if(!dh) return out;
    const grid = this.timeGrid(settings);
    const dur = this.toMin(src.end) - this.toMin(src.start);
    const lo = this.toMin(dh.start), hi = this.toMin(dh.end) + this.endFlex();
    const wins = this.commonWindows([st], targetDay, settings);
    const fits = (t) => wins.some((w, i) => t >= w[0] && t + dur <= w[1] + this.windowFlex(wins, i));
    const day = schedule[targetDay] || [];
    const multi = (sl) => day.filter(x => x.studentId === sl.studentId).length > 1;
    const canBump = (x) => !x.locked && this._movableAlone(x, byId) && !multi(x);
    const before = new Set(this.verifySchedule(schedule, students, settings));
    const nameOf = (sl) => sl.studentName || (byId[sl.studentId] || {}).name || '';
    const cands = [];
    const seen = new Set();
    for(let t = Math.ceil(lo / grid) * grid; t + dur <= hi; t += grid){
      if(!fits(t)) continue;
      for(const pad of [0, 15, 30, 60, 90]){
        const hit = day.filter(x => this.toMin(x.start) < t + dur + pad && this.toMin(x.end) > t - pad);
        if(hit.some(x => !canBump(x))) break;
        const moves = [{ studentId: src.studentId, name: nameOf(src), fromDay: srcDay, fromStart: src.start,
          toDay: targetDay, toStart: this.toTime(t), toEnd: this.toTime(t + dur), role: 'primary' },
          ...hit.map(x => ({ studentId: x.studentId, name: nameOf(x), fromDay: targetDay, fromStart: x.start,
            toDay: null, toStart: null, toEnd: null, role: 'bumped' }))];
        const trial = this._applyMoves(schedule, settings, moves);
        if(!trial || this.verifySchedule(trial, students, settings).some(x => !before.has(x))) continue;
        const k = hit.map(x => x.studentId).sort().join(',');
        if(seen.has(k)) break;
        seen.add(k);
        const minutes = hit.reduce((a, x) => a + this.toMin(x.end) - this.toMin(x.start), 0);
        cands.push({ moves, n: hit.length, minutes, t });
        break;
      }
    }
    cands.sort((a, b) => (a.n - b.n) || (a.minutes - b.minutes) || (a.t - b.t));
    for(const c of cands.slice(0, max)){
      out.push({ id: 'bump:' + c.moves.map(m => m.studentId + '@' + (m.toStart || '-')).join('|'), level: 6, kind: 'bump',
        deltaTravelMin: 0, moves: c.moves, touchedDays: [srcDay, targetDay], partner: null, shiftMin: null,
        bumped: c.moves.filter(m => m.role === 'bumped').map(m => m.name), recalc: true, spacing: [] });
    }
    return out;
  },

  /**
   * One line per working day for moving a lesson: can it go there, and how.
   *   free    — fits in a gap (level 1)
   *   shift   — fits if someone swaps or moves 15-30' (levels 2-3)
   *   replan  — fits if that day is re-planned (level 4)
   *   none    — the person is free that day but it cannot be made to fit
   *   off     — not a working day for them / already there / it is today
   * `spacing` is true when every way of doing it puts someone on two days in
   * a row. `options` are ready for applyRescheduleOption.
   */
  dayChoices(schedule, students, settings, ref, opts = {}){
    const r = this._slotRef(ref);
    const res = [];
    for(const d of (settings.workDays || []).map(Number)){
      if(d === Number(r.day)){ res.push({ day: d, status: 'current', options: [] }); continue; }
      let options = [], notes = [];
      try{
        const f = this.findRescheduleOptions(schedule, students, settings, r, d, null, { budgetMs: opts.budgetMs || 600 });
        options = f.options; notes = f.notes;
      }catch(e){ notes = ['error']; }
      const offNote = notes.find(n => ['day_off','unavailable','already','not_movable','multi_block','no_lesson'].includes(n));
      if(offNote && offNote !== 'unavailable'){ res.push({ day: d, status: 'off', reason: offNote, options: [] }); continue; }
      if(offNote === 'unavailable'){
        let f5 = [];
        try{ f5 = this.forceDayOptions(schedule, students, settings, r, d, { budgetMs: opts.budgetMs || 600 }); }catch(e){ f5 = []; }
        res.push({ day: d, status: f5.length ? 'force' : 'off', reason: offNote, spacing: false, options: f5 });
        continue;
      }
      let l4 = [];
      if(!options.some(o => o.level === 1 && !o.spacing.length)){
        try{ l4 = this.replanDayOptions(schedule, students, settings, r, d, null, { budgetMs: opts.budgetMs || 600 }); }catch(e){ l4 = []; }
      }
      const all = options.concat(l4);
      const clean = all.filter(o => !o.spacing.length);
      const pick = clean.length ? clean : all;
      const best = pick.length ? Math.min(...pick.map(o => o.level)) : null;
      let status = best == null ? 'none' : best === 1 ? 'free' : best <= 3 ? 'shift' : 'replan';
      if(status === 'none'){
        let f5 = [];
        try{ f5 = this.forceDayOptions(schedule, students, settings, r, d, { budgetMs: opts.budgetMs || 600 }); }catch(e){ f5 = []; }
        if(f5.length){ status = 'force'; all.push(...f5); }
      }
      if(status === 'none'){
        let f6 = [];
        try{ f6 = this.bumpDayOptions(schedule, students, settings, r, d); }catch(e){ f6 = []; }
        if(f6.length){ status = 'force'; all.push(...f6); }
      }
      res.push({ day: d, status, spacing: !!all.length && !clean.length, options: all });
    }
    return res;
  },

  // ---- SPACING: the same student not on two days in a row ------------------
  //
  // Nobody wants to teach the same person Tuesday and Wednesday. The rule is
  // kept OUT of verifySchedule on purpose: the optimizer does not know it yet
  // and hands back weeks with consecutive days, so putting it there would
  // raise warnings on every schedule that already exists. It lives here, and
  // the moves the person makes (the repair engine) are held to it: an option
  // that would create a new consecutive pair is offered after the ones that do
  // not, and says so.
  //
  // "When possible": with 4-5 lessons a week nobody can be spread over five
  // days, so the rule only applies where the week has room for it (up to 3 in
  // a Mon-Fri week). A student can be set to always / never regardless.

  // Sunday is 0 in the app's day numbers but the END of the week.
  _dayNo(d){ return Number(d) === 0 ? 7 : Number(d); },

  // How many lessons fit on days that are not next to each other.
  _maxSpread(days){
    const ds = (days || []).map(d => this._dayNo(d)).sort((a, b) => a - b);
    let n = 0, last = -9;
    for(const d of ds){ if(d - last >= 2){ n++; last = d; } }
    return n;
  },

  spacingApplies(st, settings){
    if(!st) return false;
    const mode = st.spacing;                              // 'on' | 'off' | unset = follow the setting
    if(mode === 'off') return false;
    if(mode !== 'on' && settings.avoidConsecutiveDays === false) return false;   // unset counts as on
    const n = st.lessonsPerWeek || 1;
    if(n < 2) return false;
    if(mode === 'on') return true;
    return n <= this._maxSpread(settings.workDays);
  },

  // Every pair of consecutive days a student (anyone in a shared block too)
  // has lessons on. { key, studentId, name, days:[a,b] }, key is stable so
  // "before" and "after" can be compared.
  spacingViolations(schedule, students, settings){
    const sm = Object.fromEntries(students.map(s => [s.id, s]));
    const daysOf = {};
    for(const d of (settings.workDays || []))
      for(const sl of (schedule[d] || []))
        for(const id of this.occupantIds(sl)) (daysOf[id] = daysOf[id] || new Set()).add(Number(d));
    const out = [];
    for(const id of Object.keys(daysOf)){
      const st = sm[id];
      if(!this.spacingApplies(st, settings)) continue;
      const ds = [...daysOf[id]].sort((a, b) => this._dayNo(a) - this._dayNo(b));
      for(let i = 0; i + 1 < ds.length; i++)
        if(this._dayNo(ds[i + 1]) - this._dayNo(ds[i]) === 1)
          out.push({ key: `${id}:${ds[i]}-${ds[i + 1]}`, studentId: id, name: st.name, days: [ds[i], ds[i + 1]] });
    }
    return out;
  },

  /**
   * Apply one candidate from gapCandidates. Re-checks against the schedule as
   * it is NOW, not as it was when the list was drawn: the user may have
   * changed something in between, and an offer is not a guarantee.
   */
  applyGapCandidate(schedule, students, settings, day, cand){
    if(cand.kind === 'relocate'){
      // Re-derived from the schedule as it is now, not from the stored trial:
      // the list was drawn earlier and an offer is not a guarantee.
      const lesson = (schedule[day] || []).find(x => x.studentId === cand.studentId &&
        this.toMin(x.start) === this.toMin(cand.fromStart));
      if(!lesson) return false;
      const opts = this.relocationOptions(schedule, students, settings, lesson, day)
        .find(o => o.toDay === cand.toDay);
      if(!opts || !opts.best) return false;
      for(const d of settings.workDays) schedule[d] = opts.best.trial[d];
      return true;
    }
    const before = new Set(this.verifySchedule(schedule, students, settings));
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const st = byId[cand.studentId];
    if(!st) return false;
    const dur = this.toMin(cand.end) - this.toMin(cand.start);
    const trial = {};
    for(const d of settings.workDays) trial[d] = (schedule[d] || []).slice();

    let slot;
    if(cand.kind === 'move'){
      const src = trial[cand.fromDay].find(x => x.studentId === cand.studentId &&
        this.toMin(x.start) === this.toMin(cand.fromStart));
      if(!src) return false;
      trial[cand.fromDay] = trial[cand.fromDay].filter(x => x !== src);
      slot = { ...src, start: cand.start, end: cand.end };
    } else {
      slot = { studentId: st.id, studentName: st.name, subject: st.subject || '—', address: st.address,
        color: st.color || 0, start: cand.start, end: cand.end, duration: dur, mergedCount: 1, merged: false };
    }
    trial[day] = trial[day].concat([slot]).sort((a,b) => this.toMin(a.start) - this.toMin(b.start));
    if(this.verifySchedule(trial, students, settings).some(x => !before.has(x))) return false;
    for(const d of settings.workDays) schedule[d] = trial[d];
    return true;
  },

  collapseForceMergeFragments(schedule, students, settings){
    const sm = Object.fromEntries(students.map(s=>[s.id,s]));
    let collapsed = 0;
    for(const d of settings.workDays){
      const slots = schedule[d] = schedule[d] || [];
      const byStudent = {};
      slots.forEach(sl=>{
        if(sl.merged || sl.isGroup) return;
        const st = sm[sl.studentId];
        if(!st || !this.mergesLessons(st)) return;
        (byStudent[sl.studentId] = byStudent[sl.studentId]||[]).push(sl);
      });
      for(const sid in byStudent){
        const frags = byStudent[sid];
        if(frags.length < 2) continue; // already one entry, nothing to collapse
        const st = sm[sid];
        frags.sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
        const totalDur = frags.reduce((a,f)=>a+f.duration,0);
        const startMin = this.toMin(frags[0].start);
        const endMin = startMin + totalDur;
        const dh = settings.dayHours[d];
        const av = st.availability[d];
        // Only collapse if the clean straight block still fits — if it
        // wouldn't, leave the (still valid) fragments alone rather than
        // trade a working placement for a broken one. Also never collapse
        // into more than a 2-hour ("δίωρο") block — if fragments genuinely
        // add up to more than that, they were placed that way for a reason
        // and shouldn't be forced into one long block just for tidiness.
        if(totalDur > 120) continue;
        if(dh && endMin > this.toMin(dh.end)+this.endFlex()) continue;
        if(av && !this.fitsAvailability(st, d, startMin, endMin)) continue;
        // The collapsed block spans the gap the fragments left — which may be
        // occupied. Bail out if anything else on the day (another student's
        // lesson, or a blocked break) sits inside that span: swallowing it
        // would turn a valid schedule into a double-booked one.
        const collapseHitsSomething = slots.some(o =>
          !frags.includes(o) &&
          this.toMin(o.start) < endMin && this.toMin(o.end) > startMin);
        if(collapseHitsSomething) continue;
        if(this.isBlocked(startMin, endMin, d, settings)) continue;
        for(const f of frags){
          const idx = slots.indexOf(f);
          if(idx>=0) slots.splice(idx,1);
        }
        slots.push({
          studentId: sid, studentName: frags[0].studentName, subject: frags[0].subject,
          address: frags[0].address, color: frags[0].color,
          start: frags[0].start, end: this.toTime(endMin),
          duration: totalDur, mergedCount: frags.length, merged: true,
          originalDuration: st.lessonDuration
        });
        collapsed++;
      }
      slots.sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
    }
    return collapsed;
  },

  // Phase 5: LNS — destroy 2-4 slots blocking an unplaced student, re-place everyone
  // stallMs: give up once this long passes with nobody more placed — a
  // search that has not found a place in a minute will not in seven.
  async lnsRepair(schedule, students, settings, budgetMs=10000, onProgress=null, stallMs=Infinity){
    const wdays = settings.workDays;
    // Group members must only ever be placed together, and forceMerge students already
    // got their combined block in Phase 0 — neither should be solo-repaired here.
    const isGroupMember = s => !!(s.pairedWith || (s.type==='group' && s.group));
    // How many days a student could theoretically be placed on — a rough proxy for
    // how easy they are to re-place if bumped. Destroying a tightly-constrained
    // student's slot to free room for someone else risks turning a fixable gap
    // into a NEW unplaced student who may never find another slot; a flexible
    // student is much more likely to land somewhere else.
    const availDayCount = s => wdays.filter(d => { const av=s.availability[d]; return av&&av.on; }).length;
    const copyS = s=>{const o={};for(const d of wdays)o[d]=[...(s[d]||[])];return o;};
    // Count by mergedCount, not raw entry count — a single 2-session merged block
    // must count as 2, or this thinks a fully-placed student is still short one.
    const countM = sch=>{const m={};Object.values(sch).flat().forEach(e=>{m[e.studentId]=(m[e.studentId]||0)+(e.mergedCount||1);});return m;};
    const getUnpl = sch=>{const m=countM(sch);return students.filter(s=>!isGroupMember(s)&&!this.mergesLessons(s)&&(m[s.id]||0)<s.lessonsPerWeek);};
    let best=copyS(schedule), bestU=getUnpl(best).length;
    if(!bestU) return;

    // Deterministic pre-pass: try placing every unplaced student directly into
    // any open slot first, with NO destruction at all. The randomized
    // destroy-and-reinsert loop below only ever tries to place someone AFTER
    // successfully destroying something first — if a student's available day
    // is simply empty or has room without bumping anyone, there's nothing to
    // destroy, `destroyed` stays empty, and the loop skips straight past the
    // placement attempt entirely. That silently missed the easy, no-conflict
    // case (an empty or lightly-loaded day within the student's own window).
    for(const target of getUnpl(best)){
      let remaining = target.lessonsPerWeek - (countM(best)[target.id]||0);
      const tdays = wdays.filter(d=>{ const av=target.availability[d]; return av&&av.on; });
      for(const d of tdays){
        if(remaining<=0) break;
        if((best[d]||[]).some(s=>s.studentId===target.id)) continue;
        const slot = this.findSlotFixed(target, d, best[d]||[], settings, this.durOf(target, best));
        if(slot){
          best[d]=best[d]||[];
          best[d].push({studentId:target.id,studentName:target.name,subject:target.subject||'—',address:target.address,color:target.color||0,start:slot.start,end:slot.end,duration:this.toMin(slot.end)-this.toMin(slot.start),mergedCount:1,merged:false});
          best[d].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          remaining--;
        }
      }
    }
    bestU = getUnpl(best).length;
    if(!bestU){ for(const d of wdays) schedule[d]=best[d]||[]; return; }

    let ss=31337;
    const rng=()=>{ss=(ss*1664525+1013904223)&0xffffffff;return(ss>>>0)/0xffffffff;};
    const t0=Date.now();
    let iter=0, lastProgress=t0;
    let lastGain=Date.now();
    while(Date.now()-t0<budgetMs && bestU>0 && Date.now()-lastGain<stallMs){
      // Yield to the browser periodically so a long budget (this can run for
      // minutes when there are still unplaced students) never looks frozen —
      // checked every 40 iterations (was 200) so pressing the ✕ cancel
      // button on the progress overlay is noticed quickly even during the
      // up-to-7-minute persistent search, not just at the end of a long batch.
      if(++iter%40===0){
        await new Promise(r=>setTimeout(r,0));
        if(typeof state!=='undefined' && state._schedulingCancelled) break;
        const now=Date.now();
        if(onProgress && now-lastProgress>1000){ lastProgress=now; onProgress(bestU, now-t0, budgetMs); }
      }
      const sc=copyS(best);
      const unpl=getUnpl(sc); if(!unpl.length) break;
      const target=unpl[Math.floor(rng()*unpl.length)];
      const tdays=wdays.filter(d=>{const av=target.availability[d];return av&&av.on;});
      if(!tdays.length) continue;
      const dc=2+Math.floor(rng()*3); const destroyed=[];
      for(let k=0;k<dc;k++){
        const d=tdays[Math.floor(rng()*tdays.length)];
        if(!sc[d]||!sc[d].length) continue;
        // Never destroy a merged/group block — it can't be correctly rebuilt with a
        // single-session reinsertion below, which would silently drop the merge.
        const candidates=sc[d].map((s,i)=>({s,i})).filter(x=>!x.s.merged&&!x.s.isGroup);
        if(!candidates.length) continue;
        // Prefer victims whose own student is flexible (available 3+ days) over
        // someone with only 1-2 available days — only fall back to a constrained
        // victim if literally nobody flexible occupies this day's schedule.
        const flexible = candidates.filter(({s})=>{
          const st = students.find(x=>x.id===s.studentId);
          return st && availDayCount(st) >= 3;
        });
        const pool = flexible.length ? flexible : candidates;
        const {s:victim,i:idx}=pool[Math.floor(rng()*pool.length)];
        destroyed.push(students.find(s=>s.id===victim.studentId));
        sc[d].splice(idx,1);
      }
      if(!destroyed.length) continue;
      let placed=false;
      for(const d of tdays){
        const m=countM(sc); if((m[target.id]||0)>=target.lessonsPerWeek) break;
        // Never place student twice on same day
        if((sc[d]||[]).some(s=>s.studentId===target.id)) continue;
        const slot=this.findSlotFixed(target,d,sc[d]||[],settings,this.durOf(target,sc));
        if(slot){
          sc[d]=sc[d]||[];
          sc[d].push({studentId:target.id,studentName:target.name,subject:target.subject||'—',address:target.address,color:target.color||0,start:slot.start,end:slot.end,duration:this.toMin(slot.end)-this.toMin(slot.start),mergedCount:1,merged:false});
          sc[d].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          placed=true;
        }
      }
      if(!placed) continue;
      for(const ds of destroyed){
        if(!ds) continue;
        for(const d of wdays){
          const m=countM(sc); if((m[ds.id]||0)>=ds.lessonsPerWeek) break;
          if((sc[d]||[]).some(s=>s.studentId===ds.id)) continue;
          const slot=this.findSlotFixed(ds,d,sc[d]||[],settings,this.durOf(ds,sc));
          if(slot){
            sc[d]=sc[d]||[];
            sc[d].push({studentId:ds.id,studentName:ds.name,subject:ds.subject||'—',address:ds.address,color:ds.color||0,start:slot.start,end:slot.end,duration:this.toMin(slot.end)-this.toMin(slot.start),mergedCount:1,merged:false});
            sc[d].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          }
        }
      }
      const nu=getUnpl(sc).length;
      if(nu<bestU){bestU=nu;Object.assign(best,copyS(sc));lastGain=Date.now();}
    }
    for(const d of wdays) schedule[d]=best[d]||[];
  },

  // Adaptive Large Neighborhood Search — destroy/repair with adaptive operator
  // weights (random/worst/Shaw removal, greedy/regret-2 insertion), 2-opt+Or-opt
  // local search per touched day, and a restart-on-stagnation kick. Used as a
  // single-pass replacement for the geoOptimize+saOptimize pipeline: both phases
  // were only ever comparing straight-line distance internally even when a real
  // OSRM/HERE road matrix was already fetched — this routes every comparison
  // through travelEstKm/travelEstMin so it optimizes against actual roads.
  // ── WEEK REFINE: fit more lessons, then win the kilometres back ──────────
  //
  // Runs after every other pass. Measured on Athens-wide weeks of 35–40
  // lessons, in this order it fitted 15 more lessons in 18 weeks than the
  // passes before it, for the same total kilometres (8.79 km per lesson
  // against 9.03):
  //
  //   1. ejectionChains  a lesson that fits nowhere goes into a day by moving
  //                      one lesson OUT of it to another day (or two steps)
  //   2. stringRemovals  take short strings of lessons out of nearby days and
  //                      put everything back, each day in its best order
  //                      (Christiaens & Vanden Berghe 2020, "SISR")
  //   3. the app's own tidy / compact / relocate passes, once more
  //   4. interDayMoves   move or swap lessons between days for fewer km
  //
  // Every step works on a copy and is kept only if no lesson is lost, the
  // week is cheaper or fuller, and verifySchedule finds nothing new. Only
  // plain one-person lessons are moved: pairs, groups and merged blocks stay
  // where they are, since moving them is a different problem.
  EXACT_ORDER_MAX: 8,
  EXACT_ORDER_NODES: 20000,

  _plainStudent(st){
    return !!st && !st.pairedWith && !(st.type === 'group' && st.group) && !this.mergesLessons(st);
  },
  _plainSlot(sl, byId){
    return !!sl && !sl.isGroup && !sl.merged && (sl.mergedCount || 1) === 1 && !sl.pairedStudentId
      && !(sl.groupMemberIds && sl.groupMemberIds.length) && this._plainStudent(byId[sl.studentId]);
  },
  // A new one-person lesson of `dur` minutes (the student's length by default).
  _lessonSlot(st, dur){
    const len = Number(dur) || st.lessonDuration;
    return { studentId: st.id, studentName: st.name, subject: st.subject || '—', address: st.address,
      color: st.color || 0, start: '00:00', end: this.toTime(len),
      duration: len, mergedCount: 1, merged: false };
  },
  _len(sl){ return this.toMin(sl.end) - this.toMin(sl.start); },
  _byStart(slots){ return slots.slice().sort((a, b) => this.toMin(a.start) - this.toMin(b.start)); },
  _weekCost(schedule, settings){
    let c = 0;
    for(const d of (settings.workDays || [])) if((schedule[d] || []).length) c += this.dayCost(schedule[d], d, settings);
    return c;
  },
  // Free that day, not already in it, and — with a daily limit set
  // (settings.maxPerDay) — room left once `removing` lessons have gone out.
  _canTake(st, d, schedule, removing = 0){
    const av = st.availability && st.availability[d];
    if(!(av && av.on) || !(schedule[d] || []).every(sl => !this.occupantIds(sl).includes(st.id))) return false;
    const settings = (typeof state !== 'undefined' && state.settings) || {};
    const cap = (this._refineCap != null ? this._refineCap : settings.maxPerDay) | 0;
    return !cap || (schedule[d] || []).length - removing < cap;
  },
  _missingLessons(schedule, students){
    const out = [];
    for(const st of students){
      if(!this._plainStudent(st)) continue;
      const k = (st.lessonsPerWeek || 1) - this.countPlaced(st.id, schedule);
      for(let i = 0; i < k; i++) out.push(st.id);
    }
    return out;
  },
  // Kept only if fuller, or as full and cheaper, and no new constraint issue.
  _refineBetter(trial, base, students, settings, baseIssues){
    const tp = this.countTotal(trial), bp = this.countTotal(base);
    if(tp < bp) return false;
    if(tp === bp && this._weekCost(trial, settings) >= this._weekCost(base, settings) - 0.05) return false;
    return this.verifySchedule(trial, students, settings).length <= baseIssues;
  },

  // The best order for one day's lessons: every order is tried (pruned on
  // cost, and capped) up to EXACT_ORDER_MAX lessons, the cheapest position
  // for the last one beyond that. relayoutDay decides what is legal, so the
  // result honours hours, availability, breaks and travel exactly as the rest
  // of the app does. Returns { laid, cost } or null when no order is legal.
  bestDayOrder(slots, day, students, settings){
    const n = slots.length;
    if(!n) return { laid: [], cost: 0 };
    const K = this.IDLE_KM_PER_MIN;
    if(n > this.EXACT_ORDER_MAX){
      let best = null;
      const base = this._byStart(slots.slice(0, -1)), add = slots[n - 1];
      for(let p = 0; p <= base.length; p++){
        const laid = this.relayoutDay(base.slice(0, p).concat([add], base.slice(p)), day, students, settings);
        if(!laid) continue;
        const c = this.dayCost(laid, day, settings);
        if(!best || c < best.cost) best = { laid, cost: c };
      }
      return best;
    }
    let best = null, nodes = 0;
    const used = new Array(n).fill(false), prefix = [];
    const dfs = () => {
      if(++nodes > this.EXACT_ORDER_NODES) return;
      if(prefix.length){
        const laid = this.relayoutDay(prefix, day, students, settings);
        if(laid === null) return;
        const cost = this.dayKm(laid, day, settings) + this.dayIdle(laid, day, settings) * K;
        // Cost never falls as lessons are appended, so a dearer prefix is done.
        if(best && cost >= best.cost - 1e-9) return;
        if(prefix.length === n){ best = { laid, cost }; return; }
      }
      for(let i = 0; i < n; i++){
        if(used[i]) continue;
        used[i] = true; prefix.push(slots[i]); dfs(); prefix.pop(); used[i] = false;
      }
    };
    dfs();
    return best;
  },
  _withLesson(daySlots, st, d, students, settings, dur){
    const r = this.bestDayOrder(this._byStart(daySlots).concat([this._lessonSlot(st, dur)]), d, students, settings);
    return r ? r.laid : null;
  },
  _without(daySlots, x, d, students, settings){
    const rest = this._byStart(daySlots.filter(y => y !== x));
    if(!rest.length) return [];
    return this.relayoutDay(rest, d, students, settings) || rest;
  },

  // The ✕ on the progress bar: every long loop checks this, so a cancel
  // takes effect within a moment, not at the end of the current phase.
  _stopped(){ return typeof state !== 'undefined' && !!(state && state._schedulingCancelled); },

  async ejectionChains(schedule, students, settings, budgetMs = 6000){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const t0 = Date.now(), timeUp = () => Date.now() - t0 > budgetMs || this._stopped();
    let lastYield = Date.now();
    const breathe = async () => { if(Date.now() - lastYield > 150){ await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); } };
    let sch = schedule, added = 0, progress = true;
    let baseIssues = this.verifySchedule(sch, students, settings).length;
    while(progress && !timeUp()){
      progress = false;
      for(const id of this._missingLessons(sch, students)){
        if(timeUp()) break;
        const st = byId[id];
        let best = null;
        const consider = (trial) => { const c = this._weekCost(trial, settings); if(!best || c < best.cost) best = { trial, cost: c }; };
        for(const d of settings.workDays){
          if(!this._canTake(st, d, sch)) continue;
          const laid = this._withLesson(sch[d] || [], st, d, students, settings, this.durOf(st, sch));
          if(laid) consider({ ...sch, [d]: laid });
        }
        for(const d of settings.workDays){
          if(timeUp()) break;
          if(!this._canTake(st, d, sch, 1)) continue;      // one lesson leaves to make room
          for(const x of (sch[d] || [])){
            await breathe();
            if(timeUp()) break;
            if(!this._plainSlot(x, byId) || x.studentId === id) continue;
            const dayD = this._withLesson(this._without(sch[d], x, d, students, settings), st, d, students, settings, this.durOf(st, sch));
            if(!dayD) continue;
            const base = { ...sch, [d]: dayD }, sx = byId[x.studentId];
            let placedX = false;
            for(const d2 of settings.workDays){
              if(d2 === d || !this._canTake(sx, d2, base)) continue;
              const l2 = this._withLesson(base[d2] || [], sx, d2, students, settings, this._len(x));
              if(l2){ consider({ ...base, [d2]: l2 }); placedX = true; }
            }
            if(placedX || best) continue;
            for(const d2 of settings.workDays){             // three steps: make room for x too
              if(timeUp() || best) break;
              if(d2 === d || !this._canTake(sx, d2, base, 1)) continue;
              for(const y of (base[d2] || [])){
                if(timeUp() || best) break;
                if(!this._plainSlot(y, byId) || y.studentId === x.studentId || y.studentId === id) continue;
                const day2 = this._withLesson(this._without(base[d2], y, d2, students, settings), sx, d2, students, settings, this._len(x));
                if(!day2) continue;
                const base2 = { ...base, [d2]: day2 }, sy = byId[y.studentId];
                for(const d3 of settings.workDays){
                  if(d3 === d2 || !this._canTake(sy, d3, base2)) continue;
                  const l3 = this._withLesson(base2[d3] || [], sy, d3, students, settings, this._len(y));
                  if(l3){ consider({ ...base2, [d3]: l3 }); break; }
                }
              }
            }
          }
        }
        if(best && this.countTotal(best.trial) > this.countTotal(sch)
           && this.verifySchedule(best.trial, students, settings).length <= baseIssues){
          for(const d of Object.keys(best.trial)) sch[d] = best.trial[d];
          added++; progress = true;
        }
      }
    }
    return { added };
  },

  // String removals: temperature (km) from T0 down to T1, strings of up to
  // maxLen lessons from up to maxDays days.
  SISR: { T0: 2.0, T1: 0.05, maxLen: 3, maxDays: 3 },
  async stringRemovals(schedule, students, settings, budgetMs = 8000){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const coords = (typeof state !== 'undefined' && state.coords) || {};
    const pos = (sl) => this.safeCoord(coords, sl.studentId, sl.address);
    const baseIssues = this.verifySchedule(schedule, students, settings).length;
    const clone = (x) => JSON.parse(JSON.stringify(x));
    let cur = clone(schedule), curP = this.countTotal(cur), curC = this._weekCost(cur, settings);
    let best = clone(cur), bestP = curP, bestC = curC;
    const t0 = Date.now(); let lastYield = t0, iters = 0;
    const T0 = this.SISR.T0, T1 = this.SISR.T1;
    while(Date.now() - t0 < budgetMs && !this._stopped()){
      iters++;
      if(Date.now() - lastYield > 150){ await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
      const trial = clone(cur);
      const all = [];
      for(const d of settings.workDays) for(const x of (trial[d] || [])) if(this._plainSlot(x, byId)) all.push({ d, x });
      if(!all.length) break;
      const seed = all[Math.floor(Math.random() * all.length)], cs = pos(seed.x);
      const near = all.slice().sort((a, b) => this.haversineKm(cs, pos(a.x)) - this.haversineKm(cs, pos(b.x)));
      const hit = new Set(), maxDays = 1 + Math.floor(Math.random() * this.SISR.maxDays);
      for(const p of near){
        if(hit.has(p.d) || hit.size >= maxDays) continue;
        hit.add(p.d);
        const sl = this._byStart(trial[p.d]);
        const at = sl.indexOf(sl.find(x => x.studentId === p.x.studentId && x.start === p.x.start));
        const len = 1 + Math.floor(Math.random() * Math.min(this.SISR.maxLen, sl.length));
        const from = Math.max(0, Math.min(at - Math.floor(Math.random() * len), sl.length - len));
        const keep = sl.slice(0, from).concat(sl.slice(from + len).filter(Boolean));
        const back = sl.slice(from, from + len).filter(x => !this._plainSlot(x, byId));
        const rest = this._byStart(keep.concat(back));
        trial[p.d] = rest.length ? (this.relayoutDay(rest, p.d, students, settings) || rest) : [];
      }
      // Recreate: everything missing, hardest (fewest possible days) first, with
      // a little randomness ("blinks") so the search does not repeat itself.
      const pending = this._missingLessons(trial, students);
      const daysFor = (id) => settings.workDays.filter(d => byId[id].availability && byId[id].availability[d] && byId[id].availability[d].on).length;
      pending.sort((a, b) => (daysFor(a) - daysFor(b)) || (Math.random() - .5));
      for(const id of pending){
        const st = byId[id];
        let bestD = null;
        for(const d of settings.workDays){
          if(!this._canTake(st, d, trial) || Math.random() < 0.01) continue;
          const cur0 = (trial[d] || []).length ? this.dayCost(trial[d], d, settings) : 0;
          const r = this.bestDayOrder(this._byStart(trial[d] || []).concat([this._lessonSlot(st, this.durOf(st, trial))]), d, students, settings);
          if(!r) continue;
          if(!bestD || r.cost - cur0 < bestD.delta) bestD = { d, laid: r.laid, delta: r.cost - cur0 };
        }
        if(bestD) trial[bestD.d] = bestD.laid;
      }
      const tp = this.countTotal(trial), tc = this._weekCost(trial, settings);
      const temp = T0 * Math.pow(T1 / T0, (Date.now() - t0) / budgetMs);
      const better = tp > curP || (tp === curP && tc < curC - 1e-9);
      const sa = tp === curP && Math.exp(-(tc - curC) / temp) > Math.random();
      if((better || sa) && this.verifySchedule(trial, students, settings).length <= baseIssues){
        cur = trial; curP = tp; curC = tc;
        if(tp > bestP || (tp === bestP && tc < bestC - 1e-9)){ best = clone(trial); bestP = tp; bestC = tc; }
      }
    }
    const improved = this._refineBetter(best, schedule, students, settings, baseIssues);
    if(improved){ for(const d of Object.keys(schedule)) delete schedule[d]; Object.assign(schedule, best); }
    return { iters, improved };
  },

  // The blocks nothing else moves: a pair or group lesson, and a merged
  // double. Every other pass works on plain one-person lessons only, so a
  // block stayed on whatever day the first placement gave it, and the rest
  // of the week was built around that accident. Here each block may move to
  // another day where every one of its people is free, or trade days with a
  // plain lesson, when that makes the week cheaper and breaks nothing.
  async blockMoves(schedule, students, settings, budgetMs = 3000){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const baseIssues = this.verifySchedule(schedule, students, settings).length;
    const t0 = Date.now(), timeUp = () => Date.now() - t0 > budgetMs || this._stopped();
    const order = (slots, d) => { const r = this.bestDayOrder(this._byStart(slots), d, students, settings); return r ? r.laid : null; };
    const cost = (sl, d) => sl.length ? this.dayCost(sl, d, settings) : 0;
    const out = { relocate: 0, swap: 0 };
    let improved = true;
    while(improved && !timeUp()){
      improved = false;
      outer:
      for(const d1 of settings.workDays){
        for(const x of (schedule[d1] || [])){
          if(timeUp()) break outer;
          if(this._plainSlot(x, byId)) continue;
          const members = this.occupantIds(x).map(id => byId[id]);
          if(!members.length || members.some(m => !m)) continue;
          const len = this._len(x), moving = { ...x, start: '00:00', end: this.toTime(len) };
          const rest1 = schedule[d1].filter(y => y !== x);
          const a1 = rest1.length ? order(rest1, d1) : [];
          if(!a1) continue;
          for(const d2 of settings.workDays){
            if(d2 === d1) continue;
            await new Promise(r => setTimeout(r, 0));
            const c0 = cost(schedule[d1], d1) + cost(schedule[d2] || [], d2);
            if(members.every(m => this._canTake(m, d2, schedule))){
              const a2 = order((schedule[d2] || []).concat([moving]), d2);
              if(a2 && cost(a1, d1) + cost(a2, d2) < c0 - 0.05){
                const trial = { ...schedule, [d1]: a1, [d2]: a2 };
                if(this.verifySchedule(trial, students, settings).length <= baseIssues){
                  schedule[d1] = a1; schedule[d2] = a2; out.relocate++; improved = true; break outer;
                }
              }
            }
            for(const y of (schedule[d2] || [])){
              if(!this._plainSlot(y, byId)) continue;
              const sy = byId[y.studentId];
              if(!sy.availability || !sy.availability[d1] || !sy.availability[d1].on) continue;
              if(rest1.some(z => this.occupantIds(z).includes(sy.id))) continue;
              const without = (schedule[d2] || []).filter(z => z !== y);
              if(!members.every(m => this._canTake(m, d2, { ...schedule, [d2]: without }))) continue;
              const b1 = order(rest1.concat([this._lessonSlot(sy, this._len(y))]), d1);
              if(!b1) continue;
              const b2 = order(without.concat([moving]), d2);
              if(!b2) continue;
              if(cost(b1, d1) + cost(b2, d2) < c0 - 0.05){
                const trial = { ...schedule, [d1]: b1, [d2]: b2 };
                if(this.verifySchedule(trial, students, settings).length <= baseIssues){
                  schedule[d1] = b1; schedule[d2] = b2; out.swap++; improved = true; break outer;
                }
              }
            }
          }
        }
      }
    }
    return out;
  },

  // 2-opt* (Potvin & Rousseau 1995): two days swap their tails. Day A keeps
  // its first i lessons and takes day B's lessons from j on; B keeps its
  // first j and takes A's rest. Both days are timed again in that order;
  // kept only if the two days cost less together and no rule is broken.
  // The other inter-day moves shift one lesson (or trade two) at a time; a
  // tail exchange moves a whole afternoon's run at once.
  async twoOptStar(schedule, students, settings, budgetMs = 3000){
    const baseIssues = this.verifySchedule(schedule, students, settings).length;
    const t0 = Date.now(), timeUp = () => Date.now() - t0 > budgetMs || this._stopped();
    const cost = (sl, d) => sl.length ? this.dayCost(sl, d, settings) : 0;
    const once = (sl) => { const seen = new Set(); for(const x of sl) for(const id of this.occupantIds(x)){ if(seen.has(id)) return false; seen.add(id); } return true; };
    // Each new day in its best order (exact up to EXACT_ORDER_MAX lessons).
    const lay = (sl, d) => { if(!sl.length) return []; const r = this.bestDayOrder(sl.map(x => ({ ...x })), d, students, settings); return r ? r.laid : null; };
    const days = settings.workDays || [];
    const cap = (settings.maxPerDay | 0);
    let moves = 0, improved = true, lastYield = t0;
    while(improved && !timeUp()){
      improved = false;
      for(let a = 0; a < days.length && !timeUp(); a++) for(let b = a + 1; b < days.length && !timeUp(); b++){
        const d1 = days[a], d2 = days[b];
        const A = this._byStart(schedule[d1] || []), B = this._byStart(schedule[d2] || []);
        if(!A.length && !B.length) continue;
        const c0 = cost(A, d1) + cost(B, d2);
        let best = null;
        for(let i = 0; i <= A.length; i++) for(let j = 0; j <= B.length; j++){
          if((i === A.length && j === B.length) || (i === 0 && j === 0)) continue;   // nothing, or everything, moves
          if(Date.now() - lastYield > 150){ await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
          if(timeUp()) break;
          const nA = A.slice(0, i).concat(B.slice(j)), nB = B.slice(0, j).concat(A.slice(i));
          if(!once(nA) || !once(nB)) continue;
          if(cap && (nA.length > cap || nB.length > cap)) continue;
          // fast: keep the order and only re-time; the winner is re-ordered below
          const lA = nA.length ? this.relayoutDay(nA.map(x => ({ ...x })), d1, students, settings) : [];
          if(!lA) continue;
          const lB = nB.length ? this.relayoutDay(nB.map(x => ({ ...x })), d2, students, settings) : [];
          if(!lB) continue;
          const c = cost(lA, d1) + cost(lB, d2);
          if(c < c0 - 0.05 && (!best || c < best.c)) best = { c, lA, lB };
        }
        if(best){
          const oA = lay(best.lA, d1), oB = lay(best.lB, d2);
          if(oA && oB && cost(oA, d1) + cost(oB, d2) < best.c){ best.lA = oA; best.lB = oB; }
          const trial = { ...schedule, [d1]: best.lA, [d2]: best.lB };
          if(this.verifySchedule(trial, students, settings).length <= baseIssues){
            schedule[d1] = best.lA; schedule[d2] = best.lB; moves++; improved = true;
          }
        }
      }
    }
    return { moves };
  },

  async interDayMoves(schedule, students, settings, budgetMs = 6000){
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const baseIssues = this.verifySchedule(schedule, students, settings).length;
    const t0 = Date.now(), timeUp = () => Date.now() - t0 > budgetMs || this._stopped();
    let lastYield = t0;
    const order = (slots, d) => { const r = this.bestDayOrder(this._byStart(slots), d, students, settings); return r ? r.laid : null; };
    const moves = { relocate: 0, swap: 0 };
    let improved = true;
    while(improved && !timeUp()){
      improved = false;
      outer:
      for(const d1 of settings.workDays){
        for(const x of (schedule[d1] || [])){
          if(Date.now() - lastYield > 150){ await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
          if(timeUp()) break outer;
          if(!this._plainSlot(x, byId)) continue;
          const sx = byId[x.studentId];
          for(const d2 of settings.workDays){
            // A swap leaves both days as full as they were, so only the move needs room.
            if(d2 === d1 || !this._canTake(sx, d2, schedule, 1)) continue;
            const canMove = this._canTake(sx, d2, schedule);
            const c0 = this.dayCost(schedule[d1], d1, settings) + ((schedule[d2] || []).length ? this.dayCost(schedule[d2], d2, settings) : 0);
            const rest1 = schedule[d1].filter(y => y !== x);
            const a1 = canMove ? (rest1.length ? order(rest1, d1) : []) : null;
            const a2 = a1 && order((schedule[d2] || []).concat([this._lessonSlot(sx, this._len(x))]), d2);
            if(a1 && a2 && (a1.length ? this.dayCost(a1, d1, settings) : 0) + this.dayCost(a2, d2, settings) < c0 - 0.05){
              const trial = { ...schedule, [d1]: a1, [d2]: a2 };
              if(this.verifySchedule(trial, students, settings).length <= baseIssues){
                schedule[d1] = a1; schedule[d2] = a2; moves.relocate++; improved = true; break outer;
              }
            }
            for(const y of (schedule[d2] || [])){
              if(!this._plainSlot(y, byId) || y.studentId === x.studentId) continue;
              const sy = byId[y.studentId];
              if(!sy.availability || !sy.availability[d1] || !sy.availability[d1].on) continue;
              if(rest1.some(z => this.occupantIds(z).includes(sy.id))) continue;
              const b1 = order(rest1.concat([this._lessonSlot(sy, this._len(y))]), d1);
              if(!b1) continue;
              const b2 = order(schedule[d2].filter(z => z !== y).concat([this._lessonSlot(sx, this._len(x))]), d2);
              if(!b2) continue;
              if(this.dayCost(b1, d1, settings) + this.dayCost(b2, d2, settings) < c0 - 0.05){
                const trial = { ...schedule, [d1]: b1, [d2]: b2 };
                if(this.verifySchedule(trial, students, settings).length <= baseIssues){
                  schedule[d1] = b1; schedule[d2] = b2; moves.swap++; improved = true; break outer;
                }
              }
            }
          }
        }
      }
    }
    return moves;
  },

  // The four steps in the order that measured best. budgetMs is the whole
  // allowance; each step gets its share and stops early when it is done.
  async refineWeek(schedule, students, settings, budgetMs = 20000, onStep = null){
    this._refineCap = settings.maxPerDay | 0;
    try{ return await this._refineWeek(schedule, students, settings, budgetMs, onStep); }
    finally{ this._refineCap = null; }
  },
  async _refineWeek(schedule, students, settings, budgetMs, onStep){
    const out = {};
    const baseIssues = () => this.verifySchedule(schedule, students, settings).length;
    if(onStep) onStep(0);
    out.blocks = await this.blockMoves(schedule, students, settings, budgetMs * 0.1);
    if(this._stopped()) return out;
    out.chains = await this.ejectionChains(schedule, students, settings, budgetMs * 0.3);
    if(this._stopped()) return out;
    if(onStep) onStep(1);
    out.strings = await this.stringRemovals(schedule, students, settings, budgetMs * 0.45);
    if(this._stopped()) return out;
    if(onStep) onStep(2);
    {
      const copy = JSON.parse(JSON.stringify(schedule)), before = baseIssues();
      try{
        this.tidyDays(copy, students, settings); this.compactDays(copy, students, settings);
        this.relocateForTime(copy, students, settings);
        if(this._refineBetter(copy, schedule, students, settings, before)){
          for(const d of Object.keys(schedule)) delete schedule[d];
          Object.assign(schedule, copy); out.passes = true;
        }
      }catch(e){ console.warn('refineWeek: clean-up passes failed', e); }
    }
    if(onStep) onStep(3);
    if(this._stopped()){ out.moves = { relocate: 0, swap: 0 }; return out; }
    out.moves = await this.interDayMoves(schedule, students, settings, budgetMs * 0.25);
    if(!this._stopped()) out.cross = await this.twoOptStar(schedule, students, settings, budgetMs * 0.15);
    if(!this._stopped()){
      const again = await this.blockMoves(schedule, students, settings, budgetMs * 0.1);
      out.blocks = { relocate: out.blocks.relocate + again.relocate, swap: out.blocks.swap + again.swap };
    }
    return out;
  },

  async alnsOptimize(schedule, students, settings, coords, budgetMs=25000, onTick=null){
    const wdays = settings.workDays;
    const dayHours = settings.dayHours;
    const HOME_ID='home', HOME_ADDR=settings.homeAddress||'';
    const studentsById = Object.fromEntries(students.map(s=>[s.id,s]));
    const isAvailable=(sid,day)=>{const av=studentsById[sid]&&studentsById[sid].availability&&studentsById[sid].availability[day];return !!(av&&av.on);};
    const roadKm=(idA,addrA,idB,addrB,day)=>this.travelEstKm(idA,addrA,idB,addrB,day);
    const trvMin=(idA,addrA,idB,addrB,day,atMin)=>this.travelEstMin(idA,addrA,idB,addrB,day,atMin);

    // Convert app's slot format -> internal {studentId,address,start,end} (minutes).
    // Merged/group blocks are left untouched throughout (never removed/moved),
    // same safeguard the existing SA already applies.
    const sc={}, merged={};
    for(const d of wdays){
      sc[d]=[]; merged[d]=[];
      for(const sl of (schedule[d]||[])){
        if(sl.merged||sl.isGroup){ merged[d].push(sl); continue; }
        sc[d].push({studentId:sl.studentId, address:sl.address||studentsById[sl.studentId]?.address||'', start:this.toMin(sl.start), end:this.toMin(sl.end)});
      }
    }

    // Which length a lesson of `sid` has on `day`: its own if it is already
    // there, otherwise the one its student is still missing elsewhere in the
    // week. ALNS moves students by id, so without this a 90-minute lesson
    // came back from a move as the student's longest one.
    const lenFor=(sid, day)=>{
      const st=studentsById[sid];
      if(!this.hasMixedDurations(st)) return st.lessonDuration;
      const here=(sc[day]||[]).find(x=>x.studentId===sid);
      if(here) return here.end-here.start;
      const need=st.durations.map(Number).sort((a,b)=>b-a);
      for(const d of Object.keys(sc)) if(+d!==+day) for(const x of (sc[d]||[])) if(x.studentId===sid){ const k=need.indexOf(x.end-x.start); if(k>=0) need.splice(k,1); }
      return need[0]||st.lessonDuration;
    };
    const rebuildDay=(slots,day)=>{
      if(!slots.length) return [];
      const dh=dayHours[day]; if(!dh) return null;
      const dayStart=this.toMin(dh.start), dayEnd=this.toMin(dh.end)+this.endFlex();
      const buf=settings.travelMargin||2;
      // Immovable regions of this day that a re-laid-out lesson must be pushed
      // past: merged/group blocks (fixed clock times, never touched by this
      // pass — see the merged[] split above) AND the user's blocked times.
      // Blocked times were missing here, so this optimizer would happily
      // relocate lessons straight into a break the user had explicitly
      // reserved — the schedule went in valid and came out violating it.
      const fixed=[
        ...(merged[day]||[]).map(m=>({start:this.toMin(m.start), end:this.toMin(m.end)})),
        ...(settings.blockedSlots||[]).filter(b=>b.day===day).map(b=>({start:this.toMin(b.start), end:this.toMin(b.end)})),
      ];
      const out=[]; let cur=dayStart;
      for(let i=0;i<slots.length;i++){
        const s=slots[i];
        const student=studentsById[s.studentId]; if(!student) return null;
        const dur=this.hasMixedDurations(student) ? lenFor(s.studentId, day) : (student.lessonDuration||(s.end-s.start)||30);
        const prevId=i===0?HOME_ID:out[i-1].studentId, prevAddr=i===0?HOME_ADDR:out[i-1].address;
        // Pass the departure time: without it travelEstMin falls back to the
        // PEAK matrix for every journey, so the optimizer judged a 10:00
        // arrangement by rush-hour driving times that no other part of the app
        // uses — and rejected layouts as too long for the day that in fact fit.
        const trav=i===0?0:trvMin(prevId,prevAddr,s.studentId,s.address,day,out[i-1].end);
        cur=i===0?dayStart:out[i-1].end+trav+buf;
        // Wait for the student rather than declaring the whole arrangement
        // impossible. This used to pin the first lesson to the exact start of
        // the working day, so if that student was not free until later,
        // dayFeasible rejected the candidate and the optimizer explored
        // NOTHING. A tutor whose hours begin at 15:00 while every student is
        // at school until 17:00 got no optimization at all — measured at 49%
        // of a day's driving on a three-stop day.
        const wins=this.availWindows(student, day);
        const fit=this.earliestFit(wins, cur, dur, 0);
        if(fit==null) return null;
        cur=fit;
        let end=cur+dur;
        // Push past any fixed block this candidate window collides with (loop:
        // pushing past one block can land inside another later block), then
        // re-seat inside the student's own free time, since being pushed past
        // a break can land the lesson outside it.
        for(let guard=0; guard<fixed.length+1; guard++){
          const hit=fixed.find(f=>cur<f.end+buf && end+buf>f.start);
          if(!hit) break;
          const next=this.earliestFit(wins, hit.end+buf, dur, 0);
          if(next==null) return null;
          cur=next; end=cur+dur;
        }
        if(end>dayEnd) return null;
        out.push({studentId:s.studentId, address:s.address, start:cur, end});
        cur=end;
      }
      return out;
    };
    const dayFeasible=(slots,day)=>{
      for(const s of slots){
        const av=studentsById[s.studentId]&&studentsById[s.studentId].availability&&studentsById[s.studentId].availability[day];
        if(!av||!av.on) return false;
        if(!this.fitsAvailability(studentsById[s.studentId], day, s.start, s.end, 0)) return false;
        // Second line of defence behind rebuildDay's push-past-blocked logic:
        // reject outright rather than accept a candidate arrangement that
        // overlaps a blocked time.
        if(this.isBlocked(s.start, s.end, day, settings)) return false;
      }
      return true;
    };
    const WEEKEND_PENALTY=2;
    // Nothing in the placement/repair logic actually prefers an early start —
    // findSlotFixed/rebuildDay both already CAN start a day's first lesson
    // exactly at dayHours.start with no travel-from-home buffer, but nothing
    // rewards doing so over leaving unused time at the front of the day, so
    // the search can settle on a valid-but-needlessly-late first lesson. A
    // small per-minute-of-gap penalty (km-equivalent, same unit as the rest
    // of this objective) nudges destroy/repair toward packing each day's
    // first lesson as close to its actual opening time as the student's own
    // availability allows, without overriding genuine travel-distance cost.
    // Idle time is deliberately NOT in this objective, and that was measured
    // rather than assumed. Adding it — same exchange rate as dayCost — changed
    // the resulting gaps by exactly zero minutes across 10 paired scenarios
    // (identical seeds, identical starting schedules): 109 -> 109, 101 -> 101,
    // 0 -> 0, every time. It only perturbed the search enough to cost km.
    //
    // The reason is that the gaps which survive are not chosen by the
    // optimizer. They are forced by when students are free — no arrangement of
    // the same people removes them, so no objective can either. Only the gap
    // before a day's first lesson is worth penalising here, because that one
    // the optimizer really can close.
    // A property, not a literal, so the Solomon benchmark can price waiting
    // at zero the way the literature does (test/benchmark.js --literature).
    const GAP_PENALTY_PER_MIN=this.GAP_PENALTY_PER_MIN;
    const calcKm=(schObj)=>{
      let km=0;
      for(const d of wdays){
        const slots=schObj[d]; if(!slots||!slots.length) continue;
        let prevId=HOME_ID, prevAddr=HOME_ADDR, prevS=null;
        for(const s of slots){ if(!prevS||prevS.studentId!==s.studentId) km+=roadKm(prevId,prevAddr,s.studentId,s.address,d); prevId=s.studentId; prevAddr=s.address; prevS=s; }
        km+=roadKm(prevId,prevAddr,HOME_ID,HOME_ADDR,d);
        if(Number(d)>=6) km+=slots.length*WEEKEND_PENALTY;
        const dh=dayHours[d];
        if(dh){
          const gap = slots[0].start - this.toMin(dh.start);
          if(gap>0) km += gap*GAP_PENALTY_PER_MIN;
        }
      }
      return km;
    };
    const placedCount=(schObj)=>wdays.reduce((n,d)=>n+(schObj[d]?schObj[d].length:0),0);

    let ss=13579;
    const rng=()=>{ss=(ss*1664525+1013904223)&0xffffffff;return(ss>>>0)/0xffffffff;};

    // Granular neighborhoods: precompute each student's K nearest others by
    // straight-line distance, so destroy/repair only considers near-candidate
    // positions instead of scanning every day×position combo.
    const K_NEIGH=10;
    const neighborsOf={};
    for(const s of students){
      const c=this.safeCoord(coords, s.id, s.address); if(!c) continue;
      const ranked=students.filter(o=>o.id!==s.id&&coords[o.id])
        .sort((a,b)=>this.haversineKm(c,coords[a.id])-this.haversineKm(c,coords[b.id]));
      neighborsOf[s.id]=ranked.slice(0,K_NEIGH).map(o=>o.id);
    }
    const candidateDays=(sid)=>{
      const days=new Set();
      for(const nb of (neighborsOf[sid]||[])){
        for(const d of wdays) if((sc[d]||[]).some(s=>s.studentId===nb) && isAvailable(sid,d)) days.add(d);
      }
      for(const d of wdays) if(isAvailable(sid,d)) days.add(d); // small day count anyway -- always keep every legal day open
      return [...days];
    };

    const insertionOptions=(sid)=>{
      const student=studentsById[sid];
      const opts=[];
      for(const d of candidateDays(sid)){
        // Never offer a day this student is already on. Removal only strips
        // them from the ONE day it picked, so their other days survive — and
        // without this check the repair step happily re-inserts them onto a
        // day they still occupy, producing two lessons in one day for someone
        // who asked for them on separate days. (A forceMerge student did ask
        // for same-day, so they are exempt.)
        if(!this.mergesLessons(student) && (sc[d]||[]).some(s=>s.studentId===sid)) continue;
        const order=(sc[d]||[]).map(s=>s.studentId);
        for(let pos=0;pos<=order.length;pos++){
          const trial=[...order.slice(0,pos), sid, ...order.slice(pos)];
          const trialSlots=trial.map(id=>({studentId:id, address:studentsById[id].address}));
          const rebuilt=rebuildDay(trialSlots,d);
          if(!rebuilt) continue;
          if(!dayFeasible(rebuilt,d)) continue;
          const before=calcKm({...sc,[d]:sc[d]}); const afterObj={...sc,[d]:rebuilt}; const after=calcKm(afterObj);
          opts.push({day:d, order:trial, cost:after-before});
        }
      }
      return opts;
    };

    // ---- destroy operators ----
    const allStops=()=>{const out=[];for(const d of wdays)for(const s of sc[d]) out.push({day:d,studentId:s.studentId}); return out;};
    const randomRemoval=(q)=>{const all=allStops();for(let i=all.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[all[i],all[j]]=[all[j],all[i]];} const rem=all.slice(0,q); for(const r of rem) sc[r.day]=sc[r.day].filter(s=>s.studentId!==r.studentId); return rem;};
    const worstRemoval=(q)=>{
      const scored=[];
      for(const d of wdays){const slots=sc[d];for(let i=0;i<slots.length;i++){
        const prevId=i===0?HOME_ID:slots[i-1].studentId, prevAddr=i===0?HOME_ADDR:slots[i-1].address;
        const nextId=i===slots.length-1?HOME_ID:slots[i+1].studentId, nextAddr=i===slots.length-1?HOME_ADDR:slots[i+1].address;
        const cur=slots[i];
        const detour=roadKm(prevId,prevAddr,cur.studentId,cur.address,d)+roadKm(cur.studentId,cur.address,nextId,nextAddr,d)-roadKm(prevId,prevAddr,nextId,nextAddr,d);
        scored.push({day:d, studentId:cur.studentId, detour});
      }}
      scored.sort((a,b)=>b.detour-a.detour);
      const rem=scored.slice(0,q).map(r=>({day:r.day,studentId:r.studentId}));
      for(const r of rem) sc[r.day]=sc[r.day].filter(s=>s.studentId!==r.studentId);
      return rem;
    };
    const shawRemoval=(q)=>{
      const all=allStops(); if(!all.length) return [];
      const seed=all[Math.floor(rng()*all.length)];
      sc[seed.day]=sc[seed.day].filter(s=>s.studentId!==seed.studentId);
      const removed=[seed];
      let remaining=allStops();
      while(removed.length<q && remaining.length){
        const ref=removed[removed.length-1]; const refC=this.safeCoord(coords, ref.studentId, studentsById[ref.studentId]?.address);
        let bestI=-1,bestScore=Infinity;
        for(let i=0;i<remaining.length;i++){
          const c=coords[remaining[i].studentId]; if(!c) continue;
          const score=this.haversineKm(refC,c);
          if(score<bestScore){bestScore=score;bestI=i;}
        }
        if(bestI===-1) break;
        const pick=remaining[bestI];
        sc[pick.day]=sc[pick.day].filter(s=>s.studentId!==pick.studentId);
        removed.push(pick);
        remaining=remaining.filter((_,i)=>i!==bestI);
      }
      return removed;
    };

    // ---- repair operators ----
    const greedyInsertion=(removedIds)=>{
      const pool=[...removedIds]; const stillUnplaced=[];
      while(pool.length){
        let best=null,bestIdx=-1;
        for(let i=0;i<pool.length;i++){
          const opts=insertionOptions(pool[i]);
          if(!opts.length) continue;
          opts.sort((a,b)=>a.cost-b.cost);
          if(!best||opts[0].cost<best.cost){best={...opts[0],sid:pool[i]};bestIdx=i;}
        }
        if(!best){stillUnplaced.push(...pool);break;}
        pool.splice(bestIdx,1);
        const rebuilt=rebuildDay(best.order.map(id=>({studentId:id,address:studentsById[id].address})), best.day);
        if(rebuilt) sc[best.day]=rebuilt;
      }
      return stillUnplaced;
    };
    const regret2Insertion=(removedIds)=>{
      const pool=[...removedIds]; const stillUnplaced=[];
      while(pool.length){
        let chosenIdx=-1,chosenOpt=null,bestRegret=-Infinity;
        for(let i=0;i<pool.length;i++){
          const opts=insertionOptions(pool[i]);
          if(!opts.length) continue;
          opts.sort((a,b)=>a.cost-b.cost);
          const regret=opts.length>1?opts[1].cost-opts[0].cost:opts[0].cost;
          if(regret>bestRegret){bestRegret=regret;chosenIdx=i;chosenOpt=opts[0];}
        }
        if(chosenIdx===-1){stillUnplaced.push(...pool);break;}
        pool.splice(chosenIdx,1);
        const rebuilt=rebuildDay(chosenOpt.order.map(id=>({studentId:id,address:studentsById[id].address})), chosenOpt.day);
        if(rebuilt) sc[chosenOpt.day]=rebuilt;
      }
      return stillUnplaced;
    };

    // ---- local search: 2-opt + Or-opt per touched day ----
    const twoOptOrOptDay=(day)=>{
      let slots=sc[day]; if(slots.length<3) return;
      let order=slots.map(s=>s.studentId);
      let bestKm=calcKm({[day]:slots});
      let improved=true;
      while(improved){
        improved=false;
        for(let i=0;i<order.length-1;i++)for(let j=i+1;j<order.length;j++){
          const trial=[...order.slice(0,i),...order.slice(i,j+1).reverse(),...order.slice(j+1)];
          const rebuilt=rebuildDay(trial.map(id=>({studentId:id,address:studentsById[id].address})),day);
          if(!rebuilt||!dayFeasible(rebuilt,day)) continue;
          const km=calcKm({[day]:rebuilt});
          if(km<bestKm-1e-9){order=trial;bestKm=km;improved=true;slots=rebuilt;}
        }
      }
      sc[day]=slots;
    };

    // ---- main ALNS loop ----
    let curPlaced=placedCount(sc), curKm=calcKm(sc);
    let bestSc=JSON.parse(JSON.stringify(sc)), bestPlaced=curPlaced, bestKm=curKm;
    const dOps=[{n:'random',fn:randomRemoval,w:1},{n:'worst',fn:worstRemoval,w:1},{n:'shaw',fn:shawRemoval,w:1}];
    const rOps=[{n:'greedy',fn:greedyInsertion,w:1},{n:'regret2',fn:regret2Insertion,w:1}];
    const pick=(ops)=>{const total=ops.reduce((a,o)=>a+o.w,0);let r=rng()*total;for(const o of ops){if(r<o.w)return o;r-=o.w;}return ops[ops.length-1];};
    const REACT=0.3;
    const STAGNATION_LIMIT=300; let stagnant=0;

    const t0=Date.now(); let iter=0; let lastTick=t0;
    while(Date.now()-t0<budgetMs){
      if(++iter%80===0) await new Promise(r=>setTimeout(r,0));
      if(typeof state!=='undefined' && state._schedulingCancelled) break;
      const now=Date.now();
      // Report real search progress (not just elapsed-time) so the UI can show
      // actual movement instead of a fake creep — throttled to ~4/sec so it
      // doesn't spam DOM updates.
      if(onTick && now-lastTick>250){ lastTick=now; onTick((now-t0)/budgetMs, bestKm, bestPlaced); }
      const T=Math.max(0.01, 2.0*(1-(now-t0)/budgetMs));
      const snapshot=JSON.parse(JSON.stringify(sc));
      const nTotal=placedCount(sc);
      const q=Math.max(1,Math.min(5,Math.floor(nTotal*(0.1+rng()*0.2))));

      const dOp=pick(dOps); const removed=dOp.fn(q);
      const rOp=pick(rOps); rOp.fn(removed.map(r=>r.studentId));
      const touched=[...new Set(removed.map(r=>r.day))];
      for(const d of touched) if((sc[d]||[]).length) twoOptOrOptDay(d);

      const trialPlaced=placedCount(sc), trialKm=calcKm(sc);
      const better=trialPlaced>curPlaced||(trialPlaced===curPlaced&&trialKm<curKm);
      const worseAccept=trialPlaced===curPlaced&&rng()<Math.exp(-(trialKm-curKm)/T);

      let reward=0;
      if(trialPlaced>bestPlaced||(trialPlaced===bestPlaced&&trialKm<bestKm-1e-6)){
        bestSc=JSON.parse(JSON.stringify(sc)); bestPlaced=trialPlaced; bestKm=trialKm; reward=3; stagnant=0;
      } else { stagnant++; reward=better?2:(worseAccept?1:0); }

      if(better||worseAccept){ curPlaced=trialPlaced; curKm=trialKm; }
      else { for(const d of wdays) sc[d]=snapshot[d]; }

      dOp.w=(1-REACT)*dOp.w+REACT*reward; rOp.w=(1-REACT)*rOp.w+REACT*reward;

      if(stagnant>=STAGNATION_LIMIT){
        // restart-on-stagnation: perturb from bestSc with a few forced random
        // relocations, resume search from there.
        for(const d of wdays) sc[d]=JSON.parse(JSON.stringify(bestSc[d]));
        for(let k=0;k<6;k++){
          const ad=wdays.filter(d=>(sc[d]||[]).length>0); if(!ad.length) break;
          const d1=ad[Math.floor(rng()*ad.length)]; const d2=wdays[Math.floor(rng()*wdays.length)];
          if(d1===d2||!sc[d1].length) continue;
          const idx=Math.floor(rng()*sc[d1].length); const moved=sc[d1][idx];
          if(!isAvailable(moved.studentId,d2)) continue;
          if((sc[d2]||[]).some(s=>s.studentId===moved.studentId)) continue;
          const s1=sc[d1].filter((_,i)=>i!==idx);
          const s2=[...(sc[d2]||[])]; s2.splice(Math.floor(rng()*(s2.length+1)),0,moved);
          const r1=rebuildDay(s1,d1), r2=rebuildDay(s2,d2);
          if(r2!=null){ sc[d1]=r1||s1; sc[d2]=r2; }
        }
        curPlaced=placedCount(sc); curKm=calcKm(sc);
        stagnant=0;
      }
    }

    // Write back: best feasible schedule found, converted to the app's slot format
    for(const d of wdays){
      const out=(bestSc[d]||[]).map(s=>{
        const student=studentsById[s.studentId];
        return {studentId:s.studentId, studentName:student.name, subject:student.subject||'—',
          address:s.address, color:student.color||0, start:this.toTime(s.start), end:this.toTime(s.end),
          duration:this.hasMixedDurations(student) ? s.end-s.start : student.lessonDuration, mergedCount:1, merged:false};
      });
      schedule[d]=[...out, ...merged[d]].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
    }
  },

  // Phase 4: after SA, try to slot in students that weren't placed
  saRepair(schedule, students, settings, schedulerResult){
    // Group members must only ever be placed together — never solo-repair one half of a group
    const isGroupMember = s => !!(s.pairedWith || (s.type==='group' && s.group));
    const placed = new Set(
      Object.values(schedule).flat().map(e=>e.studentId)
    );
    const unplaced = students.filter(s=>!isGroupMember(s)&&!this.mergesLessons(s)&&!placed.has(s.id));
    if(!unplaced.length) return;

    for(const s of unplaced){
      let remaining = s.lessonsPerWeek - this.countPlaced(s.id, schedule);
      for(const day of settings.workDays){
        if(remaining<=0) break;
        const slot = this.findSlotFixed(s, day, schedule[day]||[], settings, s.lessonDuration);
        if(slot){
          schedule[day] = schedule[day]||[];
          schedule[day].push({
            studentId:s.id, studentName:s.name, subject:s.subject||'—',
            address:s.address, color:s.color||0,
            start:slot.start, end:slot.end,
            duration:s.lessonDuration, mergedCount:1, merged:false
          });
          schedule[day].sort((a,b)=>this.toMin(a.start)-this.toMin(b.start));
          remaining--;
          if(schedulerResult) schedulerResult.placed = (schedulerResult.placed||0)+1;
        }
      }
    }
  }
};

// The shared HERE API key used to sit here, in a public file, where anyone
// could read it out of the page and spend the quota. It now lives as a secret
// inside the Worker in worker/ — see worker/README.md — and the browser never
// sees it.
//
// Set this to the deployed Worker's URL. Empty is a valid, working state: the
// app falls back to Nominatim and OSRM, which need no key at all. It is less
// accurate, not broken, so a missing or unreachable proxy degrades the app
// rather than stopping it.
const API_BASE = '';

/** Is HERE reachable at all — through the user's own key or through the proxy? */
function hereAvailable(){ return lookupMode() !== 'free'; }

/** How address lookups should be made right now. */
function lookupMode(){
  // A user's own key always wins: their quota, their choice, and it keeps
  // working for anyone who set one up before the proxy existed.
  if(state.settings && state.settings.hereApiKey) return 'own';
  if(API_BASE) return 'proxy';
  return 'free';
}

/** The URL for a proxied call, or null when there is no proxy to call. */
function apiUrl(path, params){
  if(!API_BASE) return null;
  const qs = params ? ('?' + new URLSearchParams(params).toString()) : '';
  return API_BASE.replace(/\/$/, '') + path + qs;
}

// Cloudflare Web Analytics token. Empty = analytics fully disabled (no script
// loaded, no requests made) — that is the default and the safe state.
//
// Aggregate page views ONLY. Nothing about a user's clients ever leaves the
// device: no names, addresses, notes, coordinates or schedules. Cloudflare Web
// Analytics sets no cookies and does not fingerprint, so no consent banner is
// required under GDPR — but that guarantee only holds as long as nothing
// identifying is ever passed to it. Do not extend this to send custom data.
const ANALYTICS_TOKEN = '';

// ── Computing the week off the phone ────────────────────────────────────
// A phone freezes the page as soon as the person leaves it, and a week takes
// minutes. With a compute server (compute/ in the repository) the week is
// computed there and a notification says when it is ready; coming back to the
// app picks the result up, even after the page was closed.
//
// What leaves the phone is anonymous by construction: every client becomes a
// code (§s1, §s2…), group names and subjects become codes too, and the only
// geography is a travel matrix between codes plus positions made up from that
// matrix. No name, address, phone number, note or coordinate. The codes are
// turned back into people here, on the phone, and nowhere else.
//
// Empty = off: the week is computed on the phone, as before.
const COMPUTE_BASE = '';
const VAPID_PUBLIC = '';   // the compute server's VAPID public key, for "ready" notifications

