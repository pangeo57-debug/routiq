// ============================================================
// CALENDAR IMPORT — a week of appointments out of an .ics file
// ============================================================
// Google Calendar (Settings → Import & export → Export), Apple and Outlook
// all write .ics. One week is read out of it — the coming one if it has
// appointments, else the most recent that does — with weekly repeats
// expanded. Each title becomes a client: their appointments that week give
// how many times a week and how long; the location gives the address.
// All-day events are skipped. Read on the phone; nothing is sent anywhere.
const CalendarImport = {
  _unfold(text){ return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); },
  _unescape(v){ return String(v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); },
  // A DTSTART/DTEND value as a local Date. "Z" is UTC; TZID or nothing is
  // read as the phone's own time zone, which is where the appointments are.
  _date(prop){
    if(!prop) return null;
    const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if(!m) return null;
    if(!m[4]) return { allDay: true };
    const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
    return { date: m[7] ? new Date(Date.UTC(y, mo - 1, d, h, mi)) : new Date(y, mo - 1, d, h, mi) };
  },
  events(text){
    const out = [];
    for(const block of this._unfold(text).split('BEGIN:VEVENT').slice(1)){
      const body = block.split('END:VEVENT')[0];
      const props = {};
      for(const line of body.split('\n')){
        const i = line.indexOf(':'); if(i < 0) continue;
        const [name, ...params] = line.slice(0, i).split(';');
        props[name.toUpperCase()] = { value: line.slice(i + 1).trim(), params };
      }
      if(props.STATUS && /CANCELLED/i.test(props.STATUS.value)) continue;
      const st = this._date(props.DTSTART), en = this._date(props.DTEND);
      if(!st || st.allDay) continue;
      let end = en && en.date;
      if(!end && props.DURATION){
        const m = props.DURATION.value.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
        if(m) end = new Date(st.date.getTime() + ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60000);
      }
      if(!end || end <= st.date) continue;
      const rrule = props.RRULE ? Object.fromEntries(props.RRULE.value.split(';').map(x => x.split('='))) : null;
      // Dates taken out of a weekly series, and the one instance a series
      // moved (RECURRENCE-ID): Google writes both, and without them a moved
      // lesson is counted twice and a cancelled one still counted.
      const exdates = [];
      for(const line of body.split('\n')) if(/^EXDATE/i.test(line)){
        const v = line.slice(line.indexOf(':') + 1);
        for(const one of v.split(',')){ const d = this._date({ value: one.trim() }); if(d && d.date) exdates.push(d.date.getTime()); }
      }
      const rid = props['RECURRENCE-ID'] ? this._date(props['RECURRENCE-ID']) : null;
      const summary = this._unescape(props.SUMMARY && props.SUMMARY.value);
      const description = this._unescape(props.DESCRIPTION && props.DESCRIPTION.value);
      out.push({ title: summary, location: this._unescape(props.LOCATION && props.LOCATION.value), description,
        start: st.date, end, rrule, exdates, uid: props.UID && props.UID.value, recurrenceId: rid && rid.date ? rid.date.getTime() : null });
    }
    return out;
  },
  _monday(d){ const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; },
  // Every appointment that falls in the week starting `mon`.
  inWeek(events, mon){
    const end = new Date(mon); end.setDate(end.getDate() + 7);
    const BY = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
    const out = [];
    // Instances a series moved elsewhere, by series and original time.
    const moved = new Set(events.filter(e => e.recurrenceId != null && e.uid).map(e => e.uid + '|' + e.recurrenceId));
    for(const e of events){
      const len = e.end - e.start;
      const add = (s) => {
        if(!(s >= mon && s < end)) return;
        if(e.rrule && ((e.exdates || []).includes(s.getTime()) || moved.has(e.uid + '|' + s.getTime()))) return;
        out.push({ ...e, start: s, end: new Date(s.getTime() + len) });
      };
      const r = e.rrule;
      if(!r || r.FREQ !== 'WEEKLY'){ add(e.start); continue; }
      const until = r.UNTIL ? this._date({ value: r.UNTIL }) : null;
      if(until && until.date && until.date < mon) continue;
      if(e.start >= end) continue;
      const interval = Number(r.INTERVAL) || 1;
      const weeks = Math.round((this._monday(mon) - this._monday(e.start)) / (7 * 86400000));
      if(weeks % interval) continue;
      const days = r.BYDAY ? r.BYDAY.split(',').map(x => BY[x.slice(-2)]).filter(Boolean) : [((e.start.getDay() + 6) % 7) + 1];
      for(const wd of days){
        const s = new Date(mon); s.setDate(s.getDate() + wd - 1); s.setHours(e.start.getHours(), e.start.getMinutes(), 0, 0);
        if(s < e.start) continue;
        if(until && until.date && s > until.date) continue;
        add(s);
      }
    }
    return out.sort((a, b) => a.start - b.start);
  },
  // The week to read: the coming one if it has appointments, else the most
  // recent one that does (up to eight weeks back).
  pickWeek(events, today){
    const mon = this._monday(today || new Date());
    for(const k of [0, 1, -1, -2, -3, -4, -5, -6, -7, -8]){
      const m = new Date(mon); m.setDate(m.getDate() + 7 * k);
      const occ = this.inWeek(events, m);
      if(occ.length) return { monday: m, occ };
    }
    return { monday: mon, occ: [] };
  },
  // Clients and the week as it stands, from a week of appointments.
  // A phone number written anywhere in the appointment: Greek mobiles and
  // landlines, with or without +30, with spaces or dashes.
  phoneIn(text){
    const m = String(text || '').match(/(?:\+|00)?(?:30[\s-]?)?(?:69\d|2\d{2})[\s-]?\d{3}[\s-]?\d{4}|(?:\+|00)\d[\d\s-]{8,14}\d/);
    return m ? m[0].replace(/[\s-]/g, '') : '';
  },
  // The client's name out of a title: a number or "τηλ." in it is not the name.
  nameOf(title){
    return String(title || '').replace(/(?:τηλ\.?|tel\.?|κιν\.?)\s*:?/gi, ' ')
      .replace(/(?:\+|00)?(?:30[\s-]?)?(?:69\d|2\d{2})[\s-]?\d{3}[\s-]?\d{4}/g, ' ')
      .replace(/\s*[-–|·:]\s*$/, '').replace(/^\s*[-–|·:]\s*/, '').replace(/\s+/g, ' ').trim();
  },
  // The .ics files inside a .zip — what Google Calendar's export downloads,
  // one file per calendar. Read here with the browser's own decompression
  // (DecompressionStream); no library, nothing sent anywhere.
  async unzipIcs(buf){
    const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // The central directory has the real sizes even when the local headers do not.
    let eocd = -1;
    for(let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
    if(eocd < 0) throw new Error('not a zip');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for(let k = 0; k < count; k++){
      if(dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if(!/\.ics$/i.test(name)) continue;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = b.subarray(start, start + csize);
      let text;
      if(method === 0) text = new TextDecoder().decode(data);
      else if(method === 8 && typeof DecompressionStream !== 'undefined'){
        const stream = new Response(data.slice()).body.pipeThrough(new DecompressionStream('deflate-raw'));
        text = await new Response(stream).text();
      } else continue;
      out.push(text);
    }
    return out.join('\n');
  },

  toClients(occ){
    const groups = new Map();
    for(const o of occ){
      const name = this.nameOf(o.title);
      const key = normalizeSearchText(name).replace(/\s+/g, ' ').trim();
      if(!key) continue;
      if(!groups.has(key)) groups.set(key, { name, address: '', phone: '', slots: [] });
      const g = groups.get(key);
      if(!g.address && o.location) g.address = o.location;
      if(!g.phone) g.phone = this.phoneIn(o.title) || this.phoneIn(o.description) || this.phoneIn(o.location);
      const day = ((o.start.getDay() + 6) % 7) + 1;
      const s = o.start.getHours() * 60 + o.start.getMinutes();
      const e = s + Math.round((o.end - o.start) / 60000);
      g.slots.push({ day, start: s, end: e, len: e - s });
    }
    return [...groups.values()];
  },
};

