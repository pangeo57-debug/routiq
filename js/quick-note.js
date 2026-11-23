// ============================================================
// QUICK NOTE — "dentist tomorrow at 11" into a job, without a form
// ============================================================
// A plain reader, no AI: it finds the few things people actually write (a day,
// a time, a length) and leaves everything else as the title. Anything it does
// not recognise stays in the title rather than being guessed at, and the
// result is shown in the ordinary job form to be corrected, never saved
// silently.
//
// A bare number is NEVER a time ("Γούναρη 58" is a street): a time needs a
// marker word ("at", "στις", "à", "um"), a colon, or am/pm.
const QuickNote = {
  DAY_OFFSETS: {
    today:0, σημερα:0, "aujourd'hui":0, aujourdhui:0, heute:0,
    tomorrow:1, αυριο:1, demain:1, morgen:1,
    μεθαυριο:2, "apres-demain":2, apresdemain:2, uebermorgen:2, übermorgen:2,
  },
  WEEKDAYS: {
    sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6,
    κυριακη:0, δευτερα:1, τριτη:2, τεταρτη:3, πεμπτη:4, παρασκευη:5, σαββατο:6,
    dimanche:0, lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6,
    sonntag:0, montag:1, dienstag:2, mittwoch:3, donnerstag:4, freitag:5, samstag:6,
  },
  MARKERS: new Set(['at','στις','στην','στο','à','a','um','@','around']),
  FOR_WORDS: new Set(['for','για','pour','für','fur']),
  MIN_UNITS: new Set(['min','mins','minute','minutes','λεπτα','λεπτο','λ','mn','minuten']),
  HOUR_UNITS: new Set(['h','hr','hrs','hour','hours','ωρα','ωρες','ωρ','heure','heures','stunde','stunden']),

  _addDays(iso, n){
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  },
  STREET_WORDS: new Set(['οδος','οδου','οδο','λεωφ','λεωφορος','πλατεια','πλ','αριθμος','αρ','no','nr','number','street','st','road','rd','avenue','ave','blvd','boulevard','rue','strasse','straße','platz','via']),
  // "at 3" means three in the afternoon to nearly everyone; "at 11" means 11 in
  // the morning. With no am/pm and no 24-hour form (leading zero), 1–6 is
  // read as the afternoon.
  _hour(h, raw, suffix){
    if(!suffix && h >= 1 && h <= 6 && raw[0] !== '0') return h + 12;
    return h;
  },
  _clock(h, m){
    if(!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  },

  parse(text, todayISO, opts){
    const original = String(text || '').trim();
    const out = { title: original, date: null, start: null, durationMin: null };
    if(!original) return out;
    const toks = original.split(/\s+/);
    const norm = toks.map(x => normalizeSearchText(x).replace(/^[("']+|[.,;:!?)"']+$/g, ''));
    const used = new Array(toks.length).fill(false);
    const num = (x) => /^\d{1,3}$/.test(x) ? Number(x) : null;

    for(let i = 0; i < toks.length; i++){
      if(used[i]) continue;
      const w = norm[i];

      // "day after tomorrow"
      if(w === 'day' && norm[i+1] === 'after' && norm[i+2] === 'tomorrow' && out.date === null){
        out.date = this._addDays(todayISO, 2); used[i] = used[i+1] = used[i+2] = true; continue;
      }
      if(out.date === null && Object.prototype.hasOwnProperty.call(this.DAY_OFFSETS, w)){
        out.date = this._addDays(todayISO, this.DAY_OFFSETS[w]); used[i] = true; continue;
      }
      if(out.date === null && Object.prototype.hasOwnProperty.call(this.WEEKDAYS, w)){
        // The next such day AFTER today: saying "Friday" on a Friday means next week's.
        const now = new Date(todayISO + 'T12:00:00').getDay();
        const ahead = ((this.WEEKDAYS[w] - now + 7) % 7) || 7;
        out.date = this._addDays(todayISO, ahead); used[i] = true; continue;
      }

      // a length: "for 30 min", "2 hours", "1.5 hours"
      const forWord = this.FOR_WORDS.has(w);
      const j = forWord ? i + 1 : i;
      if(out.durationMin === null && j < toks.length){
        const m = /^(\d{1,3}(?:[.,]\d)?)(?:(min|mins|λεπτα|λ|mn)|(hr|hrs|ωρ|h))?$/.exec(norm[j]);
        if(m){
          let val = parseFloat(m[1].replace(',', '.'));
          let unit = m[2] ? 'm' : (m[3] && (forWord || m[3] !== 'h') ? 'h' : null);
          let end = j;
          if(!unit && norm[j+1] !== undefined){
            if(this.MIN_UNITS.has(norm[j+1])){ unit = 'm'; end = j + 1; }
            else if(this.HOUR_UNITS.has(norm[j+1]) && !(norm[j+1] === 'h' && !forWord)){ unit = 'h'; end = j + 1; }
          }
          if(unit){
            const mins = Math.round(unit === 'h' ? val * 60 : val);
            if(mins >= 5 && mins <= 600){
              out.durationMin = mins;
              for(let k = i; k <= end; k++) used[k] = true;
              continue;
            }
          }
        }
      }

      // a time: needs a marker, a colon/"h" clock form, or am/pm
      if(out.start === null){
        const marked = this.MARKERS.has(w) && i + 1 < toks.length;
        const k = marked ? i + 1 : i;
        const tk = norm[k];
        const m = /^(\d{1,2})(?:[:.h](\d{2}))?(am|pm|uhr|h)?$/.exec(tk || '');
        if(m){
          const hasColon = /^\d{1,2}[:h]\d{2}/.test(tk);
          let suffix = m[3] || null;
          let extra = 0;
          if(!suffix && (norm[k+1] === 'am' || norm[k+1] === 'pm' || norm[k+1] === 'uhr' || norm[k+1] === 'h')){
            suffix = norm[k+1]; extra = 1;
          }
          const clockForm = hasColon || suffix === 'am' || suffix === 'pm' || suffix === 'uhr' || suffix === 'h';
          const dotOnly = /^\d{1,2}\.\d{2}$/.test(tk);
          if(marked || (clockForm && !dotOnly)){
            let h = this._hour(Number(m[1]), m[1], suffix); const min = m[2] ? Number(m[2]) : 0;
            if(suffix === 'pm' && h < 12) h += 12;
            if(suffix === 'am' && h === 12) h = 0;
            const clock = this._clock(h, min);
            if(clock){
              out.start = clock;
              for(let x = i; x <= k + extra; x++) used[x] = true;
              continue;
            }
          }
        }
      }
    }

    // "μαγνητική 11": a lone number at the very end, after a name, is the hour.
    // A number above 23 cannot be one ("Γούναρη 58"), and after a street word it
    // is a house number ("Ermou street 12"). What was understood is shown in
    // the job form, so a wrong guess is one tap to fix, never saved unseen.
    if(out.start === null && !(opts && opts.place)){
      const left = [];
      for(let i = 0; i < toks.length; i++) if(!used[i]) left.push(i);
      if(left.length >= 2){
        const k = left[left.length - 1], prev = left[left.length - 2];
        if(/^\d{1,2}$/.test(norm[k]) && Number(norm[k]) >= 1 && Number(norm[k]) <= 23
           && !this.STREET_WORDS.has(norm[prev])){
          const clock = this._clock(this._hour(Number(norm[k]), norm[k], null), 0);
          if(clock){ out.start = clock; used[k] = true; }
        }
      }
    }

    const rest = toks.filter((_, i) => !used[i]).join(' ')
      .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '');
    out.title = rest || original;
    return out;
  },

  // ---- several errands in one note ---------------------------------------
  // "αύριο φαρμακείο Κορίνθου γιατρός 12 Φιλοποίμενος και καφές κέντρο" is
  // three things to do tomorrow. A note is cut into items at the joining
  // words ("και", "μετά", "and", …) and commas, and before every word that
  // names an activity — from the list below or a name the person has used
  // before. In each item the activity is the title, a bare number right after
  // it is the hour ("γιατρός 12"), and what is left is the place (where a
  // number is a house number: "Κορίνθου 12"). A day word anywhere counts for
  // every item. Anything not understood stays in the title or the place, for
  // the person to see and fix: nothing is saved that was not shown.
  SEPARATORS: new Set(['και','μετα','επειτα','and','then','et','puis','und','dann','&','+']),
  ACTIVITIES: new Set([
    'φαρμακειο','γιατρος','γιατρο','οδοντιατρος','οδοντιατρο','καφες','καφε','τραπεζα','ταχυδρομειο',
    'σουπερμαρκετ','μαρκετ','φουρνος','φουρνο','κρεοπωλειο','μαναβικο','λαικη','γυμναστηριο','κομμωτηριο',
    'κουρειο','κεπ','εφορια','δημαρχειο','νοσοκομειο','κλινικη','μικροβιολογικο','φυσιοθεραπεια','σχολειο',
    'φροντιστηριο','πρατηριο','βενζινη','συνεργειο','καθαριστηριο','ψωνια','ραντεβου','μαθημα','φαγητο',
    'pharmacy','chemist','doctor','dentist','coffee','bank','post','supermarket','groceries','gym',
    'hairdresser','barber','school','hospital','lunch','dinner','meeting',
    'pharmacie','medecin','docteur','dentiste','cafe','banque','poste','supermarche','coiffeur','ecole',
    'apotheke','arzt','zahnarzt','kaffee','supermarkt','friseur','schule',
  ]),
  CENTRE_WORDS: new Set(['κεντρο','center','centre','downtown','zentrum','innenstadt']),

  parseMany(text, todayISO, knownNames){
    const original = String(text || '').trim();
    if(!original) return [];
    const known = new Set((knownNames || []).map(n => normalizeSearchText(n).trim()).filter(n => n && !n.includes(' ')));
    const isAct = (n) => this.ACTIVITIES.has(n) || known.has(n);
    const toks = original.split(/\s+/);
    // The day, once, for every item.
    let date = null;
    const keep = [];
    for(const tk of toks){
      const n = normalizeSearchText(tk).replace(/[.,;:!?]+$/, '');
      if(date === null){
        const d = this.parse(n, todayISO).date;
        if(d && (Object.prototype.hasOwnProperty.call(this.DAY_OFFSETS, n) || Object.prototype.hasOwnProperty.call(this.WEEKDAYS, n))){
          date = d; continue;
        }
      }
      keep.push(tk);
    }
    // Cut into items.
    const items = [[]];
    for(const tk of keep){
      const endsItem = /[,;.]$/.test(tk);
      const word = tk.replace(/[,;.]+$/, '');
      const n = normalizeSearchText(word);
      const cur = items[items.length - 1];
      if(this.SEPARATORS.has(n)){ if(cur.length) items.push([]); continue; }
      if(isAct(n) && cur.length) items.push([word]);
      else if(word) cur.push(word);
      if(endsItem && items[items.length - 1].length) items.push([]);
    }
    return items.filter(it => it.length).map(it => {
      const n0 = normalizeSearchText(it[0]);
      if(!isAct(n0)){
        // Not a known activity: read it the single-note way.
        const r = this.parse(it.join(' '), todayISO);
        return { title: r.title, place: '', start: r.start, durationMin: r.durationMin, date: r.date || date };
      }
      let i = 1, start = null;
      const num = it[1] && /^\d{1,2}$/.test(it[1]) ? Number(it[1]) : null;
      if(num !== null && num >= 1 && num <= 23){ start = this._clock(this._hour(num, it[1], null), 0); i = 2; }
      // What follows the activity is a place: a number in it is a house number.
      const restText = it.slice(i).join(' ');
      const r = this.parse(restText, todayISO, { place: true });
      const consumed = (r.start || r.durationMin || r.date) && r.title === restText.trim();
      return { title: it[0], place: consumed ? '' : (r.start || r.durationMin || r.date ? r.title : restText),
               start: start || r.start, durationMin: r.durationMin, date: r.date || date };
    }).map(x => ({ ...x, place: (x.place || '').trim() }));
  },
};

