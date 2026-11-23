// ============================================================
// CADENCE — clients seen every week, every 2 weeks or every 4
// ============================================================
// A client on a 2- or 4-week rhythm keeps a place in the week plan, and is
// shown (Home, reminders, done/payments) only on their weeks, counted from
// the week the rhythm was set. The off weeks are not given to anyone else.
const Cadence = {
  of(st){ const n = Number(st && st.cadence); return n === 2 || n === 4 ? n : 1; },
  monday(iso){
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  },
  // Is `date` one of this client's weeks?
  onWeek(st, date){
    const n = this.of(st);
    if(n === 1) return true;
    const from = st.cadenceFrom || date;
    const weeks = Math.round((this.monday(date) - this.monday(from)) / (7 * 86400000));
    return ((weeks % n) + n) % n === 0;
  },
  label(st){ const n = this.of(st); return n === 1 ? '' : tf('cad_every', { n }); },
};
