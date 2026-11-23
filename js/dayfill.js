// ============================================================
// DAYFILL — a lesson cancelled for one day, and who could take its place
// ============================================================
// Cancelling here touches ONE date only: the week plan stays as it is. The
// freed stretch can then be offered to another client, for that date only:
//
//  · someone due later this week, brought forward (their own day that week
//    is freed in turn, and that is said plainly), or
//  · someone with no lesson to move, as an extra one.
//
// Each option says what it costs and what it gains: kilometres today, the
// gap it leaves on the other day, two days in a row, whether the rest of the
// day stays exactly on time. Nothing changes without the person's tap.
//
//   rp_daychg = { 'YYYY-MM-DD': { cancel: [{ sid, start }], add: [{ sid, start, end, from }] } }
//   `from` on an added lesson: the 'YYYY-MM-DD|HH:MM' it was brought from.
const DayFill = {
  KEY: 'rp_daychg',
  load(){ try{ const v = JSON.parse(localStorage.getItem(this.KEY) || 'null'); return v && typeof v === 'object' ? v : {}; }catch(e){ return {}; } },
  save(v){ try{ localStorage.setItem(this.KEY, JSON.stringify(v)); }catch(e){} },
  of(date){ const v = this.load()[date] || {}; return { cancel: v.cancel || [], add: v.add || [] }; },
  _put(date, ch){ const v = this.load(); if(!ch.cancel.length && !ch.add.length) delete v[date]; else v[date] = ch; this.save(v); },

  isCancelled(date, sid, start){ return this.of(date).cancel.some(c => c.sid === sid && c.start === start); },
  cancel(date, sid, start){
    const ch = this.of(date);
    if(!ch.cancel.some(c => c.sid === sid && c.start === start)) ch.cancel.push({ sid, start });
    this._put(date, ch);
  },
  // Undo a cancellation (and whatever was put in its place from elsewhere).
  restore(date, sid, start){
    const ch = this.of(date);
    ch.cancel = ch.cancel.filter(c => !(c.sid === sid && c.start === start));
    this._put(date, ch);
  },

  // The day as it will really be: the week's lessons for that weekday, minus
  // the ones cancelled for this date, plus any brought in for it.
  lessonsOn(date){
    const day = Scheduler.weekdayOf(date), ch = this.of(date);
    const base = (state.schedule[day] || []).filter(sl => !ch.cancel.some(c => c.sid === sl.studentId && c.start === sl.start));
    const added = ch.add.map(a => {
      const st = (state.students || []).find(s => s.id === a.sid) || {};
      return { studentId: a.sid, studentName: st.name || '', subject: st.subject || '', address: st.address || '',
        start: a.start, end: a.end, duration: Scheduler.toMin(a.end) - Scheduler.toMin(a.start), oneOff: true, from: a.from };
    });
    return base.concat(added).sort((a, b) => Scheduler.toMin(a.start) - Scheduler.toMin(b.start));
  },

  _iso(d){ const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },
  // The other dates of the same week, after `date` (Monday-Sunday).
  _laterThisWeek(date){
    const out = [], d = new Date(date + 'T12:00:00'), wd = Scheduler.weekdayOf(date);
    for(let k = 1; wd + k <= 7; k++){ const x = new Date(d); x.setDate(x.getDate() + k); out.push(this._iso(x)); }
    return out;
  },
  _km(a, b, day, at){ return a && b ? Scheduler.travelEstKm(a.studentId || a.id, a.address || '', b.studentId || b.id, b.address || '', day, at) : 0; },
  _min(margin, a, b, day, at){ return a && b ? Scheduler.legMin(margin, a.studentId || a.id, a.address || '', b.studentId || b.id, b.address || '', day, at) : 0; },

  /**
   * Who could take the freed stretch on `date`. The stretch runs from the
   * lesson before it (or the start of the day) to the lesson after it (or the
   * end of the day); a candidate must get there from the one before, and on
   * to the one after, so the rest of the day stays on time.
   */
  options(date, cancelledStart){
    const day = Scheduler.weekdayOf(date), cfg = state.settings, margin = cfg.travelMargin ?? 2;
    const grid = Scheduler.timeGrid ? Scheduler.timeGrid(cfg) : 5;
    const home = { id: 'home', address: cfg.homeAddress || '' };
    const lessons = this.lessonsOn(date);
    const hrs = Scheduler.hoursForDay(cfg, day);
    const dayStart = Scheduler.toMin(hrs.start), dayEnd = Scheduler.toMin(hrs.end);
    const at = Scheduler.toMin(cancelledStart);
    const prev = lessons.filter(sl => Scheduler.toMin(sl.end) <= at).pop() || null;
    const next = lessons.find(sl => Scheduler.toMin(sl.start) >= at) || null;
    const g0 = prev ? Scheduler.toMin(prev.end) : dayStart, g1 = next ? Scheduler.toMin(next.start) : dayEnd;
    // What the day drives now through the gap: prev -> next directly.
    const kmNow = this._km(prev || home, next || home, day, at);
    // Not anyone already on that day, nor whoever just cancelled it.
    const busy = new Set(lessons.map(sl => sl.studentId).concat(this.of(date).cancel.map(c => c.sid)));
    const out = [];
    for(const st of state.students || []){
      if(busy.has(st.id) || !Cadence.onWeek(st, date)) continue;
      const dur = Number(st.lessonDuration) || 60;
      const lead = prev ? this._min(margin, prev, st, day, g0) : 0;
      const tail = next ? this._min(margin, st, next, day, g1) : 0;
      // The candidate's own hours that day, inside the working day and the gap.
      const starts = [];
      for(const [ws, we] of Scheduler.availWindows(st, day)){
        let s = Math.max(ws, g0 + lead, dayStart);
        s = Math.ceil(s / grid) * grid;
        const latest = Math.min(we, g1 - tail, dayEnd) - dur;
        if(s <= latest) starts.push([s, latest]);
      }
      if(!starts.length) continue;
      // The cancelled lesson's own time first, if it fits: back where the day expected you.
      let start = null;
      for(const [s, latest] of starts) if(at >= s && at <= latest){ start = at; break; }
      if(start == null) start = starts[0][0];
      const end = start + dur;
      if(Scheduler.isBlocked && Scheduler.isBlocked(start, end, day, cfg)) continue;
      const cand = { studentId: st.id, address: st.address };
      const kmToday = this._km(prev || home, cand, day, start) + this._km(cand, next || home, day, end) - kmNow;
      // Brought forward from later this week, or an extra lesson.
      let from = null;
      for(const d2 of this._laterThisWeek(date)){
        const l2 = this.lessonsOn(d2), mine = l2.find(sl => sl.studentId === st.id);
        if(!mine) continue;
        const wd2 = Scheduler.weekdayOf(d2), i = l2.indexOf(mine);
        const p2 = l2[i - 1] || home, n2 = l2[i + 1] || home;
        const kmThere = this._km(p2, n2, wd2) - this._km(p2, mine, wd2) - this._km(mine, n2, wd2);
        const edge = i === 0 || i === l2.length - 1;
        from = { date: d2, day: wd2, start: mine.start, end: mine.end, km: kmThere, edge, alone: l2.length === 1 };
        break;
      }
      // Two days in a row for this client, counting the moved lesson.
      const near = [-1, 1].some(k => { const x = new Date(date + 'T12:00:00'); x.setDate(x.getDate() + k);
        const xi = this._iso(x); return !(from && from.date === xi) && this.lessonsOn(xi).some(sl => sl.studentId === st.id); });
      out.push({ st, start: Scheduler.toTime(start), end: Scheduler.toTime(end), dur,
        onTime: start === at, kmToday, from, extra: !from, near,
        price: Payments ? Payments.price(st) : 0,
        score: (start === at ? 0 : 1) * 10 + Math.max(0, kmToday + (from ? from.km : 0)) + (near ? 5 : 0) + (from && !from.edge && !from.alone ? 3 : 0) });
    }
    out.sort((a, b) => a.score - b.score);
    return { gap: { start: Scheduler.toTime(g0), end: Scheduler.toTime(g1) }, options: out.slice(0, 6) };
  },

  // Put a client into the freed stretch, for this date only. Brought from
  // another day this week, that day's lesson is cancelled for that date.
  apply(date, opt){
    const ch = this.of(date);
    ch.add.push({ sid: opt.st.id, start: opt.start, end: opt.end, from: opt.from ? `${opt.from.date}|${opt.from.start}` : null });
    this._put(date, ch);
    if(opt.from) this.cancel(opt.from.date, opt.st.id, opt.from.start);
  },
  // Take a brought-in lesson back out (and give its own day back).
  unapply(date, sid){
    const ch = this.of(date), a = ch.add.find(x => x.sid === sid);
    ch.add = ch.add.filter(x => x.sid !== sid);
    this._put(date, ch);
    if(a && a.from){ const [d2, s2] = a.from.split('|'); this.restore(d2, sid, s2); }
  },

  // What each option means, in words.
  pros(o){
    const p = [];
    if(o.onTime) p.push(t('df_on_time'));
    if(o.kmToday < -0.2) p.push(tf('df_km_less_today', { km: (-o.kmToday).toFixed(1) }));
    if(o.from && o.from.km < -0.2) p.push(tf('df_km_less_there', { km: (-o.from.km).toFixed(1), day: DAYS_FULL[o.from.day] || '' }));
    if(o.from && o.from.edge) p.push(tf(o.from.alone ? 'df_day_free' : 'df_day_shorter', { day: DAYS_FULL[o.from.day] || '' }));
    if(o.extra) p.push(o.price ? tf('df_extra_paid', { eur: o.price }) : t('df_extra'));
    return p;
  },
  cons(o){
    const c = [];
    if(!o.onTime) c.push(tf('df_other_time', { time: o.start }));
    if(o.kmToday > 0.2) c.push(tf('df_km_more_today', { km: o.kmToday.toFixed(1) }));
    if(o.from && o.from.km > 0.2) c.push(tf('df_km_more_there', { km: o.from.km.toFixed(1), day: DAYS_FULL[o.from.day] || '' }));
    if(o.from && !o.from.edge) c.push(tf('df_gap_there', { day: DAYS_FULL[o.from.day] || '', time: o.from.start, min: o.dur }));
    if(o.near) c.push(t('df_two_days'));
    return c;
  },

  // ---- the screens -------------------------------------------------------
  askCancel(date, sid, start){
    const st = (state.students || []).find(s => s.id === sid) || {};
    App.confirm(tf('df_cancel_title', { name: st.name || '' }), tf('df_cancel_text', { date: App.prettyDate ? App.prettyDate(date) : date, time: start }), () => {
      this.cancel(date, sid, start);
      try{ App.renderHome(); }catch(e){}
      Toast.show(tf('df_cancelled', { name: st.name || '' }), 'info', 7000, { label: t('swipe_undo'), run: () => { this.restore(date, sid, start); try{ App.renderHome(); }catch(e){} } });
      this.openFill(date, start);
    }, t('df_cancel_ok'), true);
  },

  openFill(date, start){
    const r = this.options(date, start);
    document.getElementById('df-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay open'; ov.id = 'df-overlay';
    const li = (arr, cls) => arr.map(x => `<div style="font-size:13px;color:${cls}">${esc(x)}</div>`).join('');
    ov.innerHTML = `<div class="confirm-box" style="max-width:480px;max-height:85vh;overflow-y:auto">
      <div class="confirm-title">${esc(tf('df_fill_title', { from: r.gap.start, to: r.gap.end }))}</div>
      <div class="confirm-text" style="margin-bottom:10px">${esc(r.options.length ? t('df_fill_hint') : t('df_fill_none'))}</div>
      ${r.options.map((o, i) => `<div class="card-sm" style="margin:0 0 10px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <b>${esc(o.st.name || '')}</b><span style="font-weight:700">${esc(o.start)}–${esc(o.end)}</span></div>
        <div style="font-size:12px;color:var(--text3);margin:2px 0 6px">${esc(o.from ? tf('df_from', { day: DAYS_FULL[o.from.day] || '', time: o.from.start }) : t('df_extra_label'))}</div>
        ${li(this.pros(o).map(x => '✓ ' + x), 'var(--green)')}${li(this.cons(o).map(x => '⚠ ' + x), 'var(--orange,#c2410c)')}
        <button class="btn btn-primary btn-full" style="margin-top:8px" onclick="DayFill.choose('${esc(date)}',${i})">${esc(t('df_choose'))}</button>
      </div>`).join('')}
      <div class="confirm-actions"><button class="btn btn-secondary" style="flex:1" onclick="document.getElementById('df-overlay').remove()">${esc(t('df_leave_free'))}</button></div>
    </div>`;
    document.body.appendChild(ov);
    this._open = { date, options: r.options };
  },

  choose(date, i){
    const o = this._open && this._open.options[i];
    if(!o) return;
    this.apply(date, o);
    document.getElementById('df-overlay')?.remove();
    try{ App.renderHome(); }catch(e){}
    // The client has to say yes: the message opens ready.
    const first = String(o.st.name || '').trim().split(/\s+/)[0] || '';
    const text = o.from
      ? tf('df_msg_move', { name: first, date: App.prettyDate ? App.prettyDate(date) : date, time: o.start, day: DAYS_FULL[o.from.day] || '', was: o.from.start })
      : tf('df_msg_extra', { name: first, date: App.prettyDate ? App.prettyDate(date) : date, time: o.start, session: String(getLabels().session || '').toLowerCase() });
    const intl = App.normalizePhone(o.st.phone, state.settings.countryCode);
    state.sendTarget = { raw: o.st.phone || '', intl, sid: null };
    const ta = document.getElementById('send-text'); if(ta) ta.value = text;
    document.getElementById('send-title').textContent = tf('df_ask_title', { name: o.st.name || '' });
    document.getElementById('send-hint').textContent = intl ? t('df_ask_hint') : t('send_no_phone');
    for(const [btnId, on] of [['send-wa-btn', !!intl], ['send-sms-btn', !!o.st.phone]]){
      const b = document.getElementById(btnId); if(b){ b.disabled = !on; b.style.opacity = on ? '' : '.45'; }
    }
    document.getElementById('send-overlay')?.classList.add('open');
    Toast.show(tf('df_filled', { name: o.st.name || '', time: o.start }), 'success', 7000, { label: t('swipe_undo'), run: () => { this.unapply(date, o.st.id); try{ App.renderHome(); }catch(e){} } });
  },
};
