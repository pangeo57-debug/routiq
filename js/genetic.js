// ============================================================
// GENETIC — which client on which day, the way HGS does it
// ============================================================
// A hybrid genetic search for the week, after Vidal, Crainic, Gendreau &
// Prins (HGSADC; CIRRELT-2010-34 and Comput. Oper. Res. 40, 2013), written
// for one person and RoutePal's rules:
//
//  · an individual is the week itself: for each day, its lessons in order;
//  · children are made by keeping some days of one parent and the rest of the
//    other (PIX-like), the lessons left over put back by regret-2 insertion;
//  · every child is "educated" by local search: each lesson tried in every
//    position of every day it may go to (relocation and swaps between days);
//  · broken rules are allowed during the search at a price (time warp: being
//    late for a window; going over the day's limit), the price adapting so
//    about a fifth of the children are legal; that lets the search walk
//    across infeasible weeks between two good legal ones;
//  · the population is ranked by cost AND by how different each week is from
//    its nearest others, so it does not collapse onto one week.
//
// What it moves is each appointment as the planner made it — one person, a
// pair, a group, a merged block — whole, to a day and a time where all its
// people can be; lessons still missing are added only for clients with plain
// ones. Locked lessons come as lockSplit hands them over and stay put.
// Nothing is trusted from here: every day of the result is laid out again by
// relayoutDay and the week is checked by verifySchedule. It is kept only if
// that passes and it is better by the app's own rule (more lessons, then km
// + waiting).
Object.assign(Scheduler, {
  // How long the search runs: the quick plan the app uses by default, and the
  // thorough one ("search deeper"). Tests set both to 0 unless they test it.
  GENETIC_MS: { quick: 15000, thorough: 45000 },
  async geneticWeek(schedule, students, settings, budgetMs, stopped, progress){
    const S = this, t0 = Date.now();
    const days = (settings.workDays || []).filter(d => settings.dayHours && settings.dayHours[d]);
    if(days.length < 2 || !(budgetMs > 200)) return false;
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const flat = days.flatMap(d => schedule[d] || []);
    // A locked lesson arrives here as lockSplit made it: a stand-in client
    // (id ending in §L…) who can only come that day at that time, so the
    // search cannot move it. A locked lesson in any other shape is not ours.
    if(flat.some(sl => sl.locked && !/§L\d+$/.test(sl.studentId))) return false;
    // What is moved: every appointment of the week as it stands, whole —
    // one person, a pair, a group or a merged block alike (its people, its
    // length) — plus the lessons still missing for clients with plain ones.
    // A pair or a group can only go where ALL its people can (commonWindows),
    // and nobody is on a day twice.
    const L = [{ id: 'home', addr: settings.homeAddress || '' }];
    for(const d of days) for(const sl of (schedule[d] || [])){
      const people = S.occupantsOf(sl, byId);
      if(!people) return false;
      L.push({ id: sl.studentId, addr: sl.address || '', occ: S.occupantIds(sl), people,
        dur: S.toMin(sl.end) - S.toMin(sl.start), tpl: sl });
    }
    for(const st of students){
      if(!S._plainStudent(st) || (S.isFlex && S.isFlex(st)) || (S.hasMixedDurations && S.hasMixedDurations(st))) continue;
      const have = L.filter(x => x.tpl && x.occ.includes(st.id)).length;
      for(let k = have; k < (st.lessonsPerWeek || 1); k++)
        L.push({ id: st.id, addr: st.address || '', occ: [st.id], people: [st], dur: Number(st.lessonDuration) || 60, tpl: null, st });
    }
    const n = L.length - 1;
    if(n < 4) return false;
    const margin = settings.travelMargin ?? 2, cap = settings.maxPerDay | 0;
    const IDLE = S.IDLE_KM_PER_MIN || 0;
    // Per day: hours, breaks, each lesson's windows, and travel matrices.
    const D = days.map(d => {
      const dh = settings.dayHours[d];
      const start = S.toMin(dh.start), end = S.toMin(dh.end) + S.endFlex();
      const mid = Math.round((start + end) / 2);
      const T = [], K = [];
      for(let a = 0; a <= n; a++){
        const ta = new Float64Array(n + 1), ka = new Float64Array(n + 1);
        for(let b = 0; b <= n; b++){
          if(a === b || (a > 0 && b > 0 && L[a].id === L[b].id)){ ta[b] = 0; ka[b] = 0; continue; }
          ta[b] = a && b ? S.legMin(margin, L[a].id, L[a].addr, L[b].id, L[b].addr, d, mid) : 0;
          ka[b] = S.travelEstKm(L[a].id, L[a].addr, L[b].id, L[b].addr, d, mid);
        }
        T.push(ta); K.push(ka);
      }
      const wins = L.map((x, i) => {
        if(!i) return null;
        const clipped = S.commonWindows(x.people, d, settings).map(w => [Math.max(w[0], start), Math.min(w[1], end)]);
        // As relayoutDay has them: clipped to the day, long enough; the
        // end-of-day flex is added by earliestFit itself.
        return clipped.filter((w, j) => w[1] + S.windowFlex(clipped, j) - w[0] >= x.dur);
      });
      return { d, start, end, T, K, wins, breaks: S.breaksOn(d, settings) };
    });
    const canGo = L.map((x, i) => i ? D.map(dd => dd.wins[i].length > 0) : null);
    // A lesson the week has no room for waits outside (ind.u) at a price far
    // above any saving in km, so the search fits as many as it can first,
    // then makes the week short. Weeks where not everyone fits are common.
    const OUT = 10000;

    // ---- cost of one day, with the penalties ---------------------------------
    // One step of the day: lesson j after `prev`, the clock at `t`. Late for
    // every window: start at the last moment that would have fitted and pay
    // the difference as time warp (the clock goes back, so one late lesson
    // does not push the rest of the day). Early: wait, at the app's price.
    let wTW = 1, wCap = 50;
    const step = (dd, st, j) => {
      st.km += dd.K[st.prev][j];
      const ws = dd.wins[j], dur = L[j].dur;
      const earliest = st.first ? Math.max(dd.start, ws.length ? ws[0][0] : dd.start) : st.t + dd.T[st.prev][j];
      let s = ws.length ? S.earliestLegal(ws, dd.breaks, earliest, dur) : null;
      if(s === null || s + dur > dd.end){
        let latest = -1;
        ws.forEach((w, i) => { latest = Math.max(latest, Math.min(w[1] + S.windowFlex(ws, i), dd.end) - dur); });
        if(latest < 0) latest = dd.end - dur;
        st.warp += Math.max(1, earliest - latest);
        s = latest;
      } else if(!st.first) st.idle += s - earliest;
      st.t = s + dur; st.prev = j; st.first = false;
    };
    const price = (km, warp, idle, count) => {
      const over = cap ? Math.max(0, count - cap) : 0;
      return { km, warp, idle, over, cost: km + idle * IDLE + wTW * warp + wCap * over };
    };
    // A day's cost, with its profile: after each lesson, the clock and the
    // km, warp and waiting so far. A change is then priced from where it
    // happens, and stops as soon as the clock meets the old day again:
    // from there on everything is as it was (concatenation, as HGS does it,
    // kept exact for several windows a day and blocked times).
    const evalDay = (k, route) => {
      const dd = D[k], m = route.length;
      const st = { km: 0, warp: 0, idle: 0, prev: 0, t: dd.start, first: true };
      const te = new Float64Array(m), kp = new Float64Array(m), wp = new Float64Array(m), ip = new Float64Array(m);
      for(let q = 0; q < m; q++){ step(dd, st, route[q]); te[q] = st.t; kp[q] = st.km; wp[q] = st.warp; ip[q] = st.idle; }
      if(m) st.km += dd.K[st.prev][0];
      const c = price(st.km, st.warp, st.idle, m);
      c.te = te; c.kp = kp; c.wp = wp; c.ip = ip;
      return c;
    };
    // The cost of `route` with its first `pre` lessons kept, then `extra`
    // lessons, then the route again from index `from`.
    const splice = (k, c, route, pre, extra, from) => {
      const dd = D[k], m = route.length;
      const st = pre ? { km: c.kp[pre - 1], warp: c.wp[pre - 1], idle: c.ip[pre - 1], prev: route[pre - 1], t: c.te[pre - 1], first: false }
                     : { km: 0, warp: 0, idle: 0, prev: 0, t: dd.start, first: true };
      for(const j of extra) step(dd, st, j);
      const count = pre + extra.length + (m - from);
      for(let q = from; q < m; q++){
        step(dd, st, route[q]);
        // Met the old day again: the same lesson ends at the same moment, so
        // everything after it is as it was; add the old day's rest and stop.
        if(st.t === c.te[q]) return price(st.km + (c.km - c.kp[q]), st.warp + (c.warp - c.wp[q]), st.idle + (c.idle - c.ip[q]), count).cost;
      }
      if(count) st.km += dd.K[st.prev][0];
      return price(st.km, st.warp, st.idle, count).cost;
    };
    const evalWeek = (ind) => {
      let cost = 0, km = 0, feas = true;
      ind.u = ind.u || [];
      ind.c = ind.r.map((route, k) => evalDay(k, route));
      for(const c of ind.c){ cost += c.cost; km += c.km + c.idle * IDLE; if(c.warp > 0 || c.over > 0) feas = false; }
      ind.cost = cost + OUT * ind.u.length; ind.real = km; ind.feas = feas;
      return ind;
    };
    const daysOf = (ind) => { const m = new Int8Array(n + 1).fill(-1); ind.r.forEach((route, k) => route.forEach(j => { m[j] = k; })); return m; };
    // Same client twice on one day is never allowed (not even at a price).
    const clash = (route, j) => route.some(x => L[x].occ.some(o => L[j].occ.includes(o)));
    const twice = (route) => { const seen = new Set(); for(const x of route) for(const o of L[x].occ){ if(seen.has(o)) return true; seen.add(o); } return false; };

    // Best place for lessons `js` (one, or a run of two) in day k: [delta, position].
    const bestIn = (ind, k, js) => {
      const route = ind.r[k], c = ind.c[k];
      for(const j of js) if(!canGo[j][k] || clash(route, j)) return [Infinity, -1];
      let best = Infinity, at = -1;
      for(let p = 0; p <= route.length; p++){
        const d = splice(k, c, route, p, js, p) - c.cost;
        if(d < best){ best = d; at = p; }
      }
      return [best, at];
    };
    // Regret-2: the lesson whose best and second-best days differ most goes first.
    const insertAll = (ind, missing) => {
      ind.u = ind.u || [];
      evalWeek(ind);
      let left = missing.slice();
      while(left.length){
        let pick = -1, pickK = -1, pickP = -1, pickR = -Infinity;
        for(const j of left){
          const opts = D.map((_, k) => [...bestIn(ind, k, [j]), k]).filter(o => o[0] < Infinity).sort((a, b) => a[0] - b[0]);
          if(!opts.length) continue;
          const regret = (opts[1] ? opts[1][0] : opts[0][0] + 1e6) - opts[0][0];
          if(regret > pickR){ pickR = regret; pick = j; pickK = opts[0][2]; pickP = opts[0][1]; }
        }
        if(pick < 0){ ind.u = (ind.u || []).concat(left); break; }
        ind.r[pickK].splice(pickP, 0, pick);
        ind.c[pickK] = evalDay(pickK, ind.r[pickK]);
        left = left.filter(x => x !== pick);
      }
      evalWeek(ind);
      return true;
    };
    const setDay = (ind, k, route) => { ind.r[k] = route; ind.c[k] = evalDay(k, route); };

    // ---- education ---------------------------------------------------------
    // Until nothing improves: each lesson (and each run of two) moved to its
    // best place on any day; swaps between days; 2-opt within a day; tails
    // exchanged between two days (2-opt*); in or out of the week.
    const educate = (ind) => {
      evalWeek(ind);
      let improved = true, rounds = 0;
      const order = Array.from({ length: n }, (_, i) => i + 1);
      while(improved && rounds++ < 30){
        improved = false;
        for(let i = order.length - 1; i > 0; i--){ const r = Math.floor(Math.random() * (i + 1)); [order[i], order[r]] = [order[r], order[i]]; }
        for(const j of order){
          const k0 = ind.r.findIndex(route => route.includes(j));
          if(k0 < 0){
            let best = OUT, bk = -1, bp = -1;
            for(let k = 0; k < D.length; k++){ const [delta, p] = bestIn(ind, k, [j]); if(delta < best - 1e-9){ best = delta; bk = k; bp = p; } }
            if(bk >= 0){ const r = ind.r[bk].slice(); r.splice(bp, 0, j); setDay(ind, bk, r); ind.u = ind.u.filter(x => x !== j); improved = true; }
            continue;
          }
          const route0 = ind.r[k0], p0 = route0.indexOf(j);
          // Alone (1) or with the next lesson of its day (2): the run moves together.
          for(const len of [1, 2]){
            if(p0 + len > route0.length) continue;
            const run = route0.slice(p0, p0 + len);
            const gain = ind.c[k0].cost - splice(k0, ind.c[k0], route0, p0, [], p0 + len);
            if(len === 1 && OUT - gain < -1e-9){
              setDay(ind, k0, route0.filter(x => x !== j)); ind.u.push(j); improved = true; break;
            }
            const without = route0.slice(0, p0).concat(route0.slice(p0 + len));
            const cw = evalDay(k0, without);
            let best = 0, bk = -1, bp = -1;
            for(let k = 0; k < D.length; k++){
              if(k === k0){
                for(let p = 0; p <= without.length; p++){
                  const d = splice(k, cw, without, p, run, p) - ind.c[k].cost;
                  if(d < best - 1e-9){ best = d; bk = k; bp = p; }
                }
                continue;
              }
              const [delta, p] = bestIn(ind, k, run);
              if(delta - gain < best - 1e-9){ best = delta - gain; bk = k; bp = p; }
            }
            if(bk >= 0){
              if(bk === k0){ const r = without.slice(); r.splice(bp, 0, ...run); setDay(ind, k0, r); }
              else { setDay(ind, k0, without); const r = ind.r[bk].slice(); r.splice(bp, 0, ...run); setDay(ind, bk, r); }
              improved = true; break;
            }
          }
        }
        // Swaps of two lessons between two days, each into the other's place.
        for(let a = 0; a < D.length; a++) for(let b = a + 1; b < D.length; b++){
          for(let p = 0; p < ind.r[a].length; p++) for(let q = 0; q < ind.r[b].length; q++){
            const ja = ind.r[a][p], jb = ind.r[b][q];
            if(!canGo[ja][b] || !canGo[jb][a]) continue;
            const ra = ind.r[a].slice(), rb = ind.r[b].slice();
            ra[p] = jb; rb[q] = ja;
            if(twice(ra) || twice(rb)) continue;
            const ca = evalDay(a, ra), cb = evalDay(b, rb);
            if(ca.cost + cb.cost < ind.c[a].cost + ind.c[b].cost - 1e-9){
              ind.r[a] = ra; ind.r[b] = rb; ind.c[a] = ca; ind.c[b] = cb; improved = true;
            }
          }
        }
        // 2-opt within a day: a stretch of the day in reverse order.
        for(let k = 0; k < D.length; k++){
          const r = ind.r[k];
          for(let x = 0; x < r.length - 1; x++) for(let y = x + 1; y < r.length; y++){
            const t = r.slice(0, x).concat(r.slice(x, y + 1).reverse(), r.slice(y + 1));
            const ct = evalDay(k, t);
            if(ct.cost < ind.c[k].cost - 1e-9){ ind.r[k] = t; ind.c[k] = ct; improved = true; break; }
          }
        }
        // 2-opt*: the ends of two days exchanged.
        for(let a = 0; a < D.length; a++) for(let b = a + 1; b < D.length; b++){
          const ra = ind.r[a], rb = ind.r[b];
          let done = false;
          for(let x = 0; x <= ra.length && !done; x++) for(let y = 0; y <= rb.length && !done; y++){
            if(x === ra.length && y === rb.length) continue;
            const na = ra.slice(0, x).concat(rb.slice(y)), nb = rb.slice(0, y).concat(ra.slice(x));
            if(na.some(j => !canGo[j][a]) || nb.some(j => !canGo[j][b]) || twice(na) || twice(nb)) continue;
            const ca = evalDay(a, na), cb = evalDay(b, nb);
            if(ca.cost + cb.cost < ind.c[a].cost + ind.c[b].cost - 1e-9){
              ind.r[a] = na; ind.r[b] = nb; ind.c[a] = ca; ind.c[b] = cb; improved = true; done = true;
            }
          }
        }
      }
      return evalWeek(ind);
    };

    // ---- the population: legal weeks and weeks that break a rule, apart ------
    const fromSchedule = (sch) => {
      const ind = { r: D.map(() => []), u: [] };
      D.forEach((dd, k) => {
        const mine = (sch[dd.d] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
        for(const sl of mine){ const j = L.findIndex(x => x.tpl === sl); if(j > 0) ind.r[k].push(j); }
      });
      for(let j = 1; j <= n; j++) if(!L[j].tpl) ind.u.push(j);
      return evalWeek(ind);
    };
    const randomOne = () => {
      const ind = { r: D.map(() => []) };
      const order = Array.from({ length: n }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
      for(const j of order){
        const ks = D.map((_, k) => k).filter(k => canGo[j][k] && !clash(ind.r[k], j));
        if(!ks.length){ (ind.u = ind.u || []).push(j); continue; }
        ind.r[ks[Math.floor(Math.random() * ks.length)]].push(j);
      }
      for(const route of ind.r) route.sort(() => Math.random() - 0.5);
      return evalWeek(ind);
    };
    const dist = (a, b) => { const x = daysOf(a), y = daysOf(b); let s = 0; for(let j = 1; j <= n; j++) if(x[j] !== y[j]) s++; return s / n; };
    const MU = 15, LAMBDA = 25, CLOSE = 4, ELITE = 4, STUCK = 150;
    const popF = [], popI = [];
    let bestFeas = null, lastBetter = 0, iter = 0;
    const consider = (ind) => {
      if(!ind.feas) return;
      const out = (ind.u || []).length;
      if(!bestFeas || out < bestFeas.out || (out === bestFeas.out && ind.real < bestFeas.real - 1e-9)){
        bestFeas = { r: ind.r.map(x => x.slice()), real: ind.real, out }; lastBetter = iter;
      }
    };
    const addTo = (ind) => { const pop = ind.feas ? popF : popI; if(!pop.some(p => dist(p, ind) < 1e-9)) pop.push(ind); if(pop.length >= MU + LAMBDA) survivors(pop); };
    // A child that breaks a rule is, half the time, educated again at ten
    // times the price: often it becomes a legal week (Vidal's repair).
    const repair = (ind) => {
      const w0 = wTW, c0 = wCap; wTW *= 10; wCap *= 10;
      educate(ind); wTW = w0; wCap = c0; evalWeek(ind);
    };
    const seed = fromSchedule(schedule);
    if(!seed) return false;
    educate(seed); consider(seed); (seed.feas ? popF : popI).push(seed);
    const breathe = () => { if(progress) try{ progress(Math.min(1, (Date.now() - t0) / budgetMs)); }catch(e){} return new Promise(r => setTimeout(r, 0)); };
    const fill = async (until) => {
      while(popF.length + popI.length < MU && Date.now() - t0 < until && !(stopped && stopped())){
        const ind = randomOne(); if(!ind) break;
        educate(ind); if(!ind.feas && Math.random() < 0.5) repair(ind);
        consider(ind); (ind.feas ? popF : popI).push(ind);
        await breathe();
      }
    };
    await fill(t0 + budgetMs * 0.3);
    function survivors(pop){
      while(pop.length > MU){
        // Biased fitness: rank by cost plus rank by distance to the closest few.
        const nd = pop.map((a, i) => { const ds = pop.map((b, k) => k === i ? Infinity : dist(a, b)).sort((x, y) => x - y); return ds.slice(0, CLOSE).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(CLOSE, pop.length - 1)); });
        const byCost = pop.map((_, i) => i).sort((a, b) => pop[a].cost - pop[b].cost);
        const byDiv = pop.map((_, i) => i).sort((a, b) => nd[b] - nd[a]);
        const rc = new Array(pop.length), rd = new Array(pop.length);
        byCost.forEach((i, r) => { rc[i] = r; }); byDiv.forEach((i, r) => { rd[i] = r; });
        const fit = pop.map((_, i) => rc[i] + (1 - ELITE / pop.length) * rd[i] + (nd[i] < 1e-9 ? 1e6 : 0));
        let worst = 0; for(let i = 1; i < pop.length; i++) if(fit[i] > fit[worst]) worst = i;
        pop.splice(worst, 1);
      }
    }
    const all = () => popF.concat(popI);
    const tournament = () => { const p = all(); const a = p[Math.floor(Math.random() * p.length)], b = p[Math.floor(Math.random() * p.length)]; return a.cost <= b.cost ? a : b; };
    let made = 0, feasMade = 0;
    while(Date.now() - t0 < budgetMs && !(stopped && stopped())){
      const A = tournament(), Bp = tournament();
      const keep = new Set(D.map((_, k) => k).filter(() => Math.random() < 0.5));
      const child = { r: D.map((_, k) => keep.has(k) ? A.r[k].slice() : []) };
      const placed = new Set(child.r.flat());
      D.forEach((_, k) => { if(!keep.has(k)) child.r[k] = Bp.r[k].filter(j => !placed.has(j) && !clash(child.r[k], j)); });
      child.r.flat().forEach(j => placed.add(j));
      const missing = []; for(let j = 1; j <= n; j++) if(!placed.has(j)) missing.push(j);
      child.u = [];
      insertAll(child, missing);
      educate(child);
      made++; if(child.feas) feasMade++;
      if(!child.feas && Math.random() < 0.5) repair(child);
      iter++;
      consider(child);
      addTo(child);
      // Keep about a fifth of the children legal by adjusting the prices.
      if(iter % 20 === 0){
        const share = feasMade / Math.max(1, made);
        if(share < 0.15) wTW = Math.min(1000, wTW * 1.5); else if(share > 0.25) wTW = Math.max(0.05, wTW / 1.3);
        made = feasMade = 0;
        all().forEach(evalWeek);
        // A legal week that the new prices call illegal, or the reverse, changes side.
        for(const x of popF.filter(x => !x.feas)){ popF.splice(popF.indexOf(x), 1); popI.push(x); }
        for(const x of popI.filter(x => x.feas)){ popI.splice(popI.indexOf(x), 1); popF.push(x); }
      }
      // Stuck for long: keep the best few, start the rest afresh.
      if(iter - lastBetter > STUCK){
        popF.sort((a, b) => a.cost - b.cost); popF.splice(ELITE); popI.length = 0;
        lastBetter = iter;
        await fill(Date.now() + Math.max(0, (t0 + budgetMs - Date.now()) * 0.3));
      }
      await breathe();
    }
    if(!bestFeas) return false;
    // ---- back into a real week: laid out by the app's own rules ----------------
    const out = {};
    for(const d of Object.keys(schedule)) out[d] = schedule[d];
    for(let k = 0; k < D.length; k++){
      // An appointment that was there keeps everything it had (its pair, its
      // group, its merged count); one newly placed is a plain lesson.
      const slots = bestFeas.r[k].map(j => L[j].tpl ? { ...L[j].tpl } : S._lessonSlot(L[j].st, L[j].dur));
      const laid = slots.length ? S.relayoutDay(slots, D[k].d, students, settings) : [];
      if(!laid) return false;
      out[D[k].d] = laid;
    }
    if(S.verifySchedule(out, students, settings).length > S.verifySchedule(schedule, students, settings).length) return false;
    if(!S.isBetterStart(out, schedule, settings)) return false;
    for(const d of Object.keys(schedule)) delete schedule[d];
    Object.assign(schedule, out);
    return true;
  },
});
