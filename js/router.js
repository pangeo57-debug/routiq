// ============================================================
// ROUTER (OpenRouteService)
// ============================================================
// Geocoding: Nominatim (OpenStreetMap) — free, no key
// Routing:   OSRM public demo server — free, no key
// ============================================================
const Router = {
  NOMINATIM: 'https://nominatim.openstreetmap.org',
  OSRM:      'https://router.project-osrm.org',

  // Address search/reverse-geocode results (street names, POI labels) should be
  // in the app's current UI language, not hardcoded Greek.
  _geoLang(){
    return (typeof curLang === 'function') ? curLang() : 'el';
  },

  // fetch() has NO default timeout: on a flaky mobile connection a request can
  // hang indefinitely rather than failing. That's not just slow — every phase
  // of runAndNotify checks the cancel flag only AFTER its awaits resolve, so a
  // hung request freezes the whole calculation past the point where pressing ✕
  // can do anything, until the 9-minute watchdog fires. Every network call
  // goes through this instead, so a dead request fails fast and the normal
  // fallback path (or the cancel check) is reached.
  async _fetch(url, opts={}, timeoutMs=12000){
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
    try{
      return await fetch(url, {...opts, signal: ctrl.signal});
    } finally {
      clearTimeout(timer);
    }
  },

  // Bias results toward the user's actual working area (±~30km around home) so an
  // ambiguous street name doesn't accidentally resolve to a same-named street elsewhere in Greece.
  _viewboxParam(){
    const home = (typeof state!=='undefined') && state.coords && state.coords['home'];
    if(!home) return '';
    const d = 0.3; // ~30km
    return `&viewbox=${home.lon-d},${home.lat+d},${home.lon+d},${home.lat-d}&bounded=1`;
  },

  // A geocoder's exact-match data frequently doesn't cover every house
  // number on a street (see the "Γούναρη 58" search case) — geocoding the
  // full address can come back completely empty even though the street
  // itself is real and well-known. Stripping the leading house number and
  // retrying gets a real, street-level coordinate instead of nothing, which
  // is far better than the alternative (coordsHash's pseudo-coordinate,
  // hashed from the address text with no relation to where it actually is —
  // exactly what produced nonsense travel-time numbers between real,
  // distant neighborhoods that happened to hash close together).
  _stripHouseNumber(address){
    return address.replace(/^(\S+)\s+\d+[a-zA-Zα-ωΑ-Ω]?\b/, '$1').trim();
  },

  // One door for every address lookup: HERE first whenever it is available
  // (the person's own key, or the proxy's), the free Nominatim only for what
  // HERE did not find or when HERE is not available at all.
  async geocode(address){
    if(!address) return null;
    if(hereAvailable()){
      let c = null;
      try{ c = await this.geocodeHere(address, getHereKey()); }catch(e){ c = null; }
      if(c) return c;
    }
    return this.geocodeNominatim(address);
  },

  async geocodeNominatim(address){
    if(!address) return null;
    const tryQuery = async (q)=>{
      try{
        const url = `${this.NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1${this._viewboxParam()}`;
        const r = await this._fetch(url, {headers:{'Accept-Language':this._geoLang()}});
        if(!r.ok){ console.warn(`Nominatim geocode failed for "${q}": HTTP ${r.status} ${r.statusText}`); return null; }
        let d = await r.json();
        if((!Array.isArray(d) || d.length===0) && this._viewboxParam()){
          const url2 = `${this.NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`;
          const r2 = await this._fetch(url2, {headers:{'Accept-Language':this._geoLang()}});
          if(!r2.ok){ console.warn(`Nominatim geocode (unbounded retry) failed for "${q}": HTTP ${r2.status} ${r2.statusText}`); return null; }
          d = await r2.json();
        }
        if(Array.isArray(d) && d.length>0) return {lat:parseFloat(d[0].lat), lon:parseFloat(d[0].lon)};
        return null;
      }catch(e){ console.warn(`Nominatim geocode threw for "${q}":`, e.message); return null; }
    };
    let c = await tryQuery(address);
    if(!c){
      const stripped = this._stripHouseNumber(address);
      if(stripped !== address) c = await tryQuery(stripped);
    }
    if(!c) console.warn(`Nominatim found no results for "${address}" (even without house number)`);
    return c;
  },

  // HERE Geocoding — used when a key is configured, since it doesn't need the
  // strict ~1-request/second throttling Nominatim's free public server
  // requires (see App.runAndNotify's bulk geocoding loop).
  // Google, through the Worker only (the key never reaches the page). Used
  // when HERE does not know a house number. Returns { lat, lon, placeId,
  // label, precise } or null; null also when Google is not set up, the
  // person's monthly allowance is spent, or nothing was found.
  async _google(params){
    const url = apiUrl('/google/geocode', { language: this._geoLang(), region: 'gr', ...params });
    if(!url) return null;
    try{
      const r = await this._fetch(url);
      if(!r.ok) return null;
      const d = await r.json();
      const it = d && d.status === 'OK' && Array.isArray(d.results) && d.results[0];
      if(!it || !it.geometry || !it.geometry.location) return null;
      const types = it.types || [];
      return { lat: Number(it.geometry.location.lat), lon: Number(it.geometry.location.lng), placeId: it.place_id || '',
        label: it.formatted_address || '', precise: types.some(x => ['street_address', 'premise', 'subpremise'].includes(x)) };
    }catch(e){ return null; }
  },
  // Typing "Ψαρών 11", deleting a letter and typing it again must not spend
  // two of the person's monthly Google lookups: the answer is remembered for
  // this session only (well inside Google's 30 days), never stored.
  geocodeGoogle(address){
    const key = normalizeSearchText(String(address || '')).trim();
    this._gcache = this._gcache || new Map();
    if(this._gcache.has(key)) return this._gcache.get(key);
    const p = this._google({ address });
    this._gcache.set(key, p);
    if(this._gcache.size > 100) this._gcache.delete(this._gcache.keys().next().value);
    return p;
  },
  googlePlace(placeId){ return placeId ? this._google({ place_id: placeId }) : Promise.resolve(null); },

  async geocodeHere(address, key){
    if(!address) return null;
    const tryQuery = async (q)=>{
      try{
        // With the user's own key, straight to HERE. Without one, through the
        // proxy, which holds the shared key and adds it upstream.
        const url = key
          ? `https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(q)}&limit=1&lang=${this._geoLang()}&apiKey=${key}`
          : apiUrl('/here/geocode', { q, limit: '1', lang: this._geoLang() });
        if(!url) return null;
        const r = await this._fetch(url);
        if(!r.ok) return null;
        const d = await r.json();
        const item = d.items && d.items[0];
        return (item && item.position) ? {lat:item.position.lat, lon:item.position.lng} : null;
      }catch(e){ return null; }
    };
    let c = await tryQuery(address);
    if(!c){
      const stripped = this._stripHouseNumber(address);
      if(stripped !== address) c = await tryQuery(stripped);
    }
    return c;
  },

  /** How much slower a real drive is than OSRM's free-flow figure. */
  timeFactor(){
    const v = Number((typeof state !== 'undefined' && state.settings || {}).osrmTimeFactor);
    return (Number.isFinite(v) && v >= 1 && v <= 4) ? v : 1.5;
  },

  // OSRM Table API: returns duration (seconds) and distance (meters) matrix
  async getMatrix(coords){
    if(coords.length < 2) return null;
    try{
      const pts = coords.map(c=>`${c.lon},${c.lat}`).join(';');
      const url = `${this.OSRM}/table/v1/driving/${pts}?annotations=duration,distance`;
      // Longer timeout than the default: an N×N matrix for a full client list
      // is a genuinely slow request, not a hung one.
      const r = await this._fetch(url, {}, 25000);
      if(!r.ok) return null;
      const d = await r.json();
      if(d.code !== 'Ok') return null;
      // Normalise to same shape used by old ORS matrix.
      //
      // Durations are scaled HERE, at the one place OSRM's times enter the app,
      // so the scheduler and the Route screen cannot disagree about a drive. A
      // 10-minute leg from Ρίο to the centre of Πάτρα was the free-flow figure;
      // nobody drives it in that. Distances are real and are left alone.
      const f = this.timeFactor();
      const durations = d.durations.map(row => row.map(v => (v == null ? v : v * f)));
      return { durations, distances: d.distances };
    }catch(e){ return null }
  },

  // OSRM Route API: returns actual road-following geometry (GeoJSON coords) for a stop sequence
  async getRouteGeometry(coords){
    if(coords.length < 2) return null;
    try{
      const pts = coords.map(c=>`${c.lon},${c.lat}`).join(';');
      const url = `${this.OSRM}/route/v1/driving/${pts}?overview=full&geometries=geojson`;
      const r = await this._fetch(url);
      if(!r.ok) return null;
      const d = await r.json();
      if(d.code !== 'Ok' || !d.routes?.[0]) return null;
      // GeoJSON is [lon,lat] — normalize it to RoutePal's [lat,lon] shape.
      return d.routes[0].geometry.coordinates.map(([lon,lat])=>[lat,lon]);
    }catch(e){ return null }
  },

  async getHereMatrix(coords, apiKey, departureTime){
    // HERE Matrix Routing API v8
    // coords: array of {lat, lon} objects (home first, then students)
    // departureTime: ISO string like "2024-01-15T17:00:00"
    const origins = coords.map(c=>({lat:c.lat,lng:c.lon}));
    const destinations = origins;
    const body = {
      origins, destinations,
      departureTime: departureTime || new Date().toISOString(),
      routingMode:'fast', transportMode:'car',
      matrixAttributes:['travelTimes','distances']
    };
    const url = apiKey
      ? `https://matrix.router.hereapi.com/v8/matrix?async=false&apiKey=${encodeURIComponent(apiKey)}`
      : apiUrl('/here/matrix');
    if(!url) throw new Error('no HERE route configured');
    const resp = await this._fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    }, 25000);
    if(!resp.ok) throw new Error(`HERE API ${resp.status}`);
    const data = await resp.json();
    // data.matrix.travelTimes/distances are flat arrays, numOrigins × numDestinations
    const n = coords.length;
    const durations = [];
    const distances = [];
    for(let i=0;i<n;i++){
      durations.push([]);
      distances.push([]);
      for(let j=0;j<n;j++){
        const idx = i*n+j;
        durations[i].push(data.matrix&&data.matrix.travelTimes?data.matrix.travelTimes[idx]:null);
        distances[i].push(data.matrix&&data.matrix.distances?data.matrix.distances[idx]:null);
      }
    }
    return {durations, distances, coords};
  },


  dist(a,b){
    if(!a||!b) return Infinity;
    return Scheduler.haversineKm(a,b);
  },

  // Real (haversine) distance in km — see Scheduler.haversineKm for why the
  // old Δlat/Δlon approximation was measurably wrong away from the equator.
  estimateKm(a,b){
    if(!a||!b) return 0;
    return Scheduler.haversineKm(a,b);
  },

};

// ============================================================
// LABELS (profession-aware)
// ============================================================
const PROFESSION_VALUES = ['tutor','physiotherapy','massage','beauty','personal_training','music','speech','psychologist','cleaning','pet','repair','freelancer','other'];
function getProfessions(){
  return PROFESSION_VALUES.map(value=>({
    value,
    label:t('profession_'+value+'_label'),
    client:t('profession_'+value+'_client'),
    clients:t('profession_'+value+'_clients'),
    session:t('profession_'+value+'_session'),
    sessions:t('profession_'+value+'_sessions'),
  }));
}
function getLabels(){
  const val=(typeof state!=='undefined'&&state.settings?.profession)||'other';
  const p=getProfessions().find(p=>p.value===val);
  return p ? {client:p.client,clients:p.clients,session:p.session,sessions:p.sessions} : getProfessions()[0];
}

// The progress bar is animated on requestAnimationFrame rather than by
// repeatedly setting a css-transitioned width from a timer. The old version
// wrote a new width every 150ms while css was still transitioning the previous
// one over 250ms, so each write interrupted the last — the bar visibly
// stepped instead of moving. Here JS owns the value and css owns nothing.
//
// Two eased values, both frame-rate independent (the 1-exp(-dt/tau) form means
// a dropped frame changes nothing, and a 120Hz screen looks the same as 60Hz):
//   goal  — creeps toward the ceiling so a long phase never looks frozen, and
//           decelerates as it goes, so it never implies more progress than
//           there is.
//   shown — chases goal quickly; this is what is painted.
let _schedRaf=null, _schedShown=0, _schedGoal=0, _schedLastTs=0, _schedPctText=-1, _schedCeil=99, _schedLastPct=0;

function _schedFrame(ts){
  _schedRaf=null;
  // Clamped at BOTH ends: the upper bound stops a backgrounded tab from
  // jumping the bar forward on return, and the lower bound stops a clock that
  // goes backwards from driving the easing in reverse.
  const dt=Math.max(0, Math.min(120, ts-(_schedLastTs||ts))); _schedLastTs=ts;
  // Creep toward a little past the last phase reported, not toward the end:
  // the bar keeps moving while a phase works, yet each new phase still moves it.
  const cap = Math.min(_schedCeil, Math.max(_schedGoal, _schedLastPct + 8));
  _schedGoal  += (cap-_schedGoal ) * (1-Math.exp(-dt/5000));
  // The finish is deliberately much faster than the working animation: the
  // overlay only stays up for a moment after 100%, and a full green bar the
  // user never actually sees is a wasted moment.
  _schedShown += (_schedGoal -_schedShown) * (1-Math.exp(-dt/(_schedCeil>=100?90:260)));
  // Easing only ever approaches its target. Snap the last fraction so a
  // finished run paints a genuinely full bar instead of leaving a hairline.
  if(_schedCeil-_schedShown<0.15) _schedShown=_schedCeil;

  const bar=document.getElementById('sched-bar');
  const pc=document.getElementById('sched-pct');
  const on=document.getElementById('sched-label-on');
  if(bar) bar.style.width=_schedShown.toFixed(2)+'%';
  if(on) on.style.clipPath='inset(0 '+(100-_schedShown).toFixed(2)+'% 0 0)';
  // Only ever show whole percent, and only touch the DOM when that whole
  // number actually changes — a percentage re-rendering 60 times a second with
  // decimals reads as noise, not as progress.
  const whole=Math.round(_schedShown);
  if(pc && whole!==_schedPctText){ pc.textContent=whole+'%'; _schedPctText=whole;
    const pc2=document.getElementById('sched-pct-on'); if(pc2) pc2.textContent=whole+'%';
    const tr=document.getElementById('sched-track'); if(tr && tr.setAttribute) tr.setAttribute('aria-valuenow', String(whole)); }

  // Settled on the target with nothing left to creep toward: stop burning
  // frames until the next phase update.
  // (the creep now stops a little past the last phase, so "settled" means
  // there, not at the end).
  if(Math.abs(cap-_schedShown)>0.15 || Math.abs(cap-_schedGoal)>0.01) _schedRaf=requestAnimationFrame(_schedFrame);
}

function _schedAnimate(){
  if(_schedRaf===null){ _schedLastTs=0; _schedRaf=requestAnimationFrame(_schedFrame); }
}

function _schedStopAnim(){
  if(_schedRaf!==null){ cancelAnimationFrame(_schedRaf); _schedRaf=null; }
}

