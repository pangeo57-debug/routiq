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
// Only weeks of plain clients are searched (no pairs, groups, merged blocks,
// flexible hours, locked lessons or lunch break), and nothing is trusted from
// here: every day of the result is laid out again by relayoutDay and the week
// is checked by verifySchedule. It is kept only if that passes and it is
// better by the app's own rule (more lessons, then km + waiting).
Object.assign(Scheduler, {
  // How long the search runs: the quick plan the app uses by default, and the
  // thorough one ("search deeper"). Tests set both to 0 unless they test it.
  GENETIC_MS: { quick: 15000, thorough: 45000 },
  async geneticWeek(schedule, students, settings, budgetMs, stopped, progress){
    const S = this, t0 = Date.now();
    const days = (settings.workDays || []).filter(d => settings.dayHours && settings.dayHours[d]);
    if(days.length < 2 || !(budgetMs > 200)) return false;
    if(settings.lunchBreak) return false;
    const byId = Object.fromEntries(students.map(s => [s.id, s]));
    const flat = days.flatMap(d => schedule[d] || []);
    if(flat.some(sl => sl.locked || !S._plainSlot(sl, byId))) return false;
    // The lessons to place: one per lesson of every plain client.
    const L = [{ id: 'home', addr: settings.homeAddress || '' }];
    for(const st of students){
      if(!S._plainStudent(st) || (S.isFlex && S.isFlex(st)) || (S.hasMixedDurations && S.hasMixedDurations(st))) {
        if(flat.some(sl => sl.studentId === st.id) || (st.lessonsPerWeek || 0) > 0) return false;
        continue;
      }
      for(let k = 0; k < (st.lessonsPerWeek || 1); k++) L.push({ id: st.id, addr: st.address || '', st, dur: Number(st.lessonDuration) || 60 });
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
        const clipped = S.availWindows(x.st, d).map(w => [Math.max(w[0], start), Math.min(w[1], end)]);
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
    let wTW = 1, wCap = 50;
    const evalDay = (k, route) => {
      const dd = D[k];
      let km = 0, warp = 0, idle = 0, prev = 0, t = dd.start, first = true;
      for(const j of route){
        km += dd.K[prev][j];
        const ws = dd.wins[j], dur = L[j].dur;
        let earliest = first ? Math.max(dd.start, ws.length ? ws[0][0] : dd.start) : t + dd.T[prev][j];
        let s = ws.length ? S.earliestLegal(ws, dd.breaks, earliest, dur) : null;
        if(s === null || s + dur > dd.end){
          // Late: start at the last moment that would have fitted, and pay the difference.
          let latest = -1;
          ws.forEach((w, i) => { latest = Math.max(latest, Math.min(w[1] + S.windowFlex(ws, i), dd.end) - dur); });
          if(latest < 0) latest = dd.end - dur;
          warp += Math.max(1, earliest - latest);
          s = latest;
        } else if(!first) idle += s - earliest;
        t = s + dur; prev = j; first = false;
      }
      if(route.length) km += dd.K[prev][0];
      const over = cap ? Math.max(0, route.length - cap) : 0;
      return { km, warp, idle, over, cost: km + idle * IDLE + wTW * warp + wCap * over };
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
    const clash = (route, j) => route.some(x => L[x].id === L[j].id);

    // Best place for lesson j in day k: [delta, position].
    const bestIn = (ind, k, j) => {
      const route = ind.r[k];
      if(!canGo[j][k] || clash(route, j)) return [Infinity, -1];
      const base = ind.c[k].cost;
      let best = Infinity, at = -1;
      for(let p = 0; p <= route.length; p++){
        const trial = route.slice(0, p).concat(j, route.slice(p));
        const c = evalDay(k, trial).cost - base;
        if(c < best){ best = c; at = p; }
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
          const opts = D.map((_, k) => [...bestIn(ind, k, j), k]).filter(o => o[0] < Infinity).sort((a, b) => a[0] - b[0]);
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

    // ---- education: relocations and swaps until nothing improves -----------
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
            // Outside: in, at its best place anywhere, if that beats waiting outside.
            let best = OUT, bk = -1, bp = -1;
            for(let k = 0; k < D.length; k++){ const [delta, p] = bestIn(ind, k, j); if(delta < best - 1e-9){ best = delta; bk = k; bp = p; } }
            if(bk >= 0){ ind.r[bk].splice(bp, 0, j); ind.c[bk] = evalDay(bk, ind.r[bk]); ind.u = ind.u.filter(x => x !== j); improved = true; }
            continue;
          }
          const without = ind.r[k0].filter(x => x !== j);
          const gain = ind.c[k0].cost - evalDay(k0, without).cost;
          // Taking it out pays OUT and saves `gain` (its km and any penalty it caused).
          if(OUT - gain < -1e-9){
            ind.r[k0] = without; ind.c[k0] = evalDay(k0, without); ind.u.push(j); improved = true;
            continue;
          }
          let best = 0, bk = -1, bp = -1;
          for(let k = 0; k < D.length; k++){
            if(k === k0){
              for(let p = 0; p <= without.length; p++){
                const trial = without.slice(0, p).concat(j, without.slice(p));
                const delta = evalDay(k, trial).cost - ind.c[k].cost;
                if(delta < best - 1e-9){ best = delta; bk = k; bp = p; }
              }
              continue;
            }
            const [delta, p] = bestIn(ind, k, j);
            if(delta - gain < best - 1e-9){ best = delta - gain; bk = k; bp = p; }
          }
          if(bk >= 0){
            ind.r[k0] = without; ind.c[k0] = evalDay(k0, without);
            ind.r[bk].splice(bp, 0, j); ind.c[bk] = evalDay(bk, ind.r[bk]);
            improved = true;
          }
        }
        // Swaps of two lessons between two days, each into the other's place.
        for(let a = 0; a < D.length; a++) for(let b = a + 1; b < D.length; b++){
          for(let p = 0; p < ind.r[a].length; p++) for(let q = 0; q < ind.r[b].length; q++){
            const ja = ind.r[a][p], jb = ind.r[b][q];
            if(!canGo[ja][b] || !canGo[jb][a]) continue;
            const ra = ind.r[a].slice(), rb = ind.r[b].slice();
            ra[p] = jb; rb[q] = ja;
            if(ra.filter(x => L[x].id === L[jb].id).length > 1 || rb.filter(x => L[x].id === L[ja].id).length > 1) continue;
            const ca = evalDay(a, ra), cb = evalDay(b, rb);
            if(ca.cost + cb.cost < ind.c[a].cost + ind.c[b].cost - 1e-9){
              ind.r[a] = ra; ind.r[b] = rb; ind.c[a] = ca; ind.c[b] = cb; improved = true;
            }
          }
        }
      }
      return evalWeek(ind);
    };

    // ---- the population ------------------------------------------------------
    const fromSchedule = (sch) => {
      const used = new Set(), ind = { r: D.map(() => []) };
      D.forEach((dd, k) => {
        for(const sl of (sch[dd.d] || []).slice().sort((a, b) => S.toMin(a.start) - S.toMin(b.start))){
          const j = L.findIndex((x, i) => i && !used.has(i) && x.id === sl.studentId);
          if(j > 0){ used.add(j); ind.r[k].push(j); }
        }
      });
      ind.u = []; for(let j = 1; j <= n; j++) if(!used.has(j)) ind.u.push(j);
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
    const MU = 20, LAMBDA = 30, CLOSE = 4, ELITE = 4;
    const pop = [];
    let bestFeas = null;
    const consider = (ind) => {
      if(!ind.feas) return;
      const out = (ind.u || []).length;
      if(!bestFeas || out < bestFeas.out || (out === bestFeas.out && ind.real < bestFeas.real - 1e-9))
        bestFeas = { r: ind.r.map(x => x.slice()), real: ind.real, out };
    };
    const seed = fromSchedule(schedule);
    if(!seed) return false;
    educate(seed); consider(seed); pop.push(seed);
    // The screen keeps answering, and the bar moves, while this runs.
    const breathe = () => { if(progress) try{ progress(Math.min(1, (Date.now() - t0) / budgetMs)); }catch(e){} return new Promise(r => setTimeout(r, 0)); };
    while(pop.length < MU && Date.now() - t0 < budgetMs * 0.3 && !(stopped && stopped())){
      const ind = randomOne(); if(!ind) break;
      educate(ind); consider(ind); pop.push(ind);
      await breathe();
    }
    const survivors = () => {
      while(pop.length > MU){
        // Biased fitness: rank by cost plus rank by distance to the closest few.
        const nd = pop.map((a, i) => { const ds = pop.map((b, k) => k === i ? Infinity : dist(a, b)).sort((x, y) => x - y); return ds.slice(0, CLOSE).reduce((s, v) => s + v, 0) / CLOSE; });
        const byCost = pop.map((_, i) => i).sort((a, b) => pop[a].cost - pop[b].cost);
        const byDiv = pop.map((_, i) => i).sort((a, b) => nd[b] - nd[a]);
        const rc = new Array(pop.length), rd = new Array(pop.length);
        byCost.forEach((i, r) => { rc[i] = r; }); byDiv.forEach((i, r) => { rd[i] = r; });
        const fit = pop.map((_, i) => rc[i] + (1 - ELITE / pop.length) * rd[i] + (nd[i] < 1e-9 ? 1e6 : 0));
        let worst = 0; for(let i = 1; i < pop.length; i++) if(fit[i] > fit[worst]) worst = i;
        pop.splice(worst, 1);
      }
    };
    const tournament = () => { const a = pop[Math.floor(Math.random() * pop.length)], b = pop[Math.floor(Math.random() * pop.length)]; return a.cost <= b.cost ? a : b; };
    let made = 0, feasMade = 0, iter = 0;
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
      consider(child);
      if(!pop.some(p => dist(p, child) < 1e-9)) pop.push(child);
      if(pop.length >= MU + LAMBDA) survivors();
      // Keep about a fifth of the children legal by adjusting the prices.
      if(++iter % 20 === 0){
        const share = feasMade / Math.max(1, made);
        if(share < 0.15) wTW = Math.min(1000, wTW * 1.5); else if(share > 0.25) wTW = Math.max(0.05, wTW / 1.3);
        made = feasMade = 0;
        pop.forEach(evalWeek);
      }
      await breathe();
    }
    if(!bestFeas) return false;
    // ---- back into a real week: laid out by the app's own rules ----------------
    const out = {};
    for(const d of Object.keys(schedule)) out[d] = schedule[d];
    for(let k = 0; k < D.length; k++){
      const slots = bestFeas.r[k].map(j => { const sl = S._lessonSlot(L[j].st, L[j].dur); return sl; });
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
