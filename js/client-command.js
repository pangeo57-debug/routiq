// ============================================================
// CLIENT COMMANDS — "Γιώργος δεν μπορεί Τρίτη από 5 μέχρι 7", spoken or typed
// ============================================================
// Understood on the phone, by rules, in Greek and English: nothing said is
// sent anywhere. What is not understood is left to QuickNote as an errand.
//   <client> δεν μπορεί <day> [από H μέχρι H]   — a time they cannot do
//   <client> δεν μπορεί <day>                    — the whole day
//   <client> <N> φορές [την εβδομάδα]            — lessons a week
//   <client> μένει / διεύθυνση <address>         — a new address
// Hours: "5", "17", "5:30", "5 και μισή", "πέντε"; 1–6 with no other sign
// is the afternoon, as everywhere in the app.
const ClientCommand = {
  NUM_WORDS: { ενα:1, μια:1, μιαν:1, δυο:2, τρια:3, τρεις:3, τεσσερα:4, τεσσερις:4, πεντε:5, εξι:6, εφτα:7, επτα:7,
    οχτω:8, οκτω:8, εννια:9, εννεα:9, δεκα:10, εντεκα:11, δωδεκα:12,
    one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12 },
  CANNOT: [['δεν','μπορει','την'], ['δεν','μπορει','τη'], ['δεν','μπορει'], ['δε','μπορει'], ['δεν','μπορει','να'], ["can't"], ['cannot'], ['can','not'], ['not','available'], ['δεν','ειναι','διαθεσιμος'], ['δεν','ειναι','διαθεσιμη']],
  FROM: new Set(['απο','απ','from']), TO: new Set(['μεχρι','εως','ως','με','to','till','until','-','–']),
  AT: new Set(['τις','στις','της','at']),
  TIMES: new Set(['φορες','φορα','times','x']), LIVES: new Set(['μενει','διευθυνση','address','lives']),
  _n(w){ return normalizeSearchText(w).replace(/^[("']+|[.,;:!?)"']+$/g, ''); },
  ENDINGS: ['ους','ου','ος','ον','οι','ων','ας','ες','ης','ις','ια','ο','ε','α','η','ι','υ','s'],
  // Speech writes numbers as words: "πενήντα δύο", "τρίωρο". Turned into
  // digits before anything else reads the sentence.
  NW_UNIT: { μηδεν:0, ενα:1, ενας:1, μια:1, μιαν:1, δυο:2, τρια:3, τρεις:3, τεσσερα:4, τεσσερις:4, πεντε:5, εξι:6, εφτα:7, επτα:7,
    οχτω:8, οκτω:8, εννια:9, εννεα:9 },
  NW_TEEN: { δεκα:10, εντεκα:11, δωδεκα:12, δεκατρια:13, δεκατρεις:13, δεκατεσσερα:14, δεκατεσσερις:14, δεκαπεντε:15, δεκαεξι:16,
    δεκαεφτα:17, δεκαεπτα:17, δεκαοχτω:18, δεκαοκτω:18, δεκαεννια:19, δεκαεννεα:19 },
  NW_TENS: { εικοσι:20, τριαντα:30, σαραντα:40, πενηντα:50, εξηντα:60, εβδομηντα:70, ογδοντα:80, ενενηντα:90 },
  NW_HUND: { εκατο:100, εκατον:100, διακοσια:200, τριακοσια:300, τετρακοσια:400, πεντακοσια:500, εξακοσια:600, εφτακοσια:700, επτακοσια:700, οχτακοσια:800, εννιακοσια:900 },
  HOURS_WORD: { μονοωρο:1, μονωρο:1, ωρακι:1, ωριτσα:1, ωρουλα:1, διωρο:2, διωρα:2, διωρακι:2, τριωρο:3, τριωρα:3, τετραωρο:4, πεντωρο:5,
    μισαωρο:0.5, μισαωρακι:0.5 },
  // "μιάμιση", "ενάμιση", "δυόμισι": hours and a half, in one word
  HALF_W: { μιαμιση:1.5, μιαμισι:1.5, εναμιση:1.5, εναμισι:1.5, εναμισης:1.5, δυομισι:2.5, δυομιση:2.5, τρεισημισι:3.5, τρεισημιση:3.5, τριμισι:3.5 },
  _words(raw){
    // Written short: "1,5" is a number, "90'" "90λ" minutes, "2h" "1h30" "3ωρο" hours.
    const E = '(?=[\\s,.;!?]|$)';
    const src = String(raw || '').replace(/(\d),(\d)/g, '$1.$2')
      .replace(/(\d+)\s*h\s*(\d{1,2})(?=\D|$)/gi, '$1 ωρες $2 λεπτα').replace(new RegExp('(\\d+)\\s?h' + E, 'gi'), '$1 ωρες')
      .replace(new RegExp('(\\d+)\\s?(?:[\'′’]|λ|λεπτ[αά])' + E, 'g'), '$1 λεπτα').replace(new RegExp('(\\d+)\\s?[ωώ]ρ(?:ο|α|ες|ου)' + E, 'gi'), '$1 ωρες')
      .replace(/(\d)\s*[-–]\s*(\d)/g, '$1 - $2').replace(/[.!?;:]+(\s|$)/g, ' ')
      .split(/[\s,;]+/).map(w => w.replace(/[.,;:!?]+$/, '')).filter(Boolean);
    const words = [], norm = [];
    for(let i = 0; i < src.length; i++){
      const n = src[i] === '-' || src[i] === '–' ? src[i] : this._n(src[i]);
      if(this.HOURS_WORD[n] != null){ words.push(String(this.HOURS_WORD[n]), 'ώρες'); norm.push(String(this.HOURS_WORD[n]), 'ωρες'); continue; }
      // a run of number words: hundreds, tens, units
      let j = i, val = 0, any = false;
      const at = (k) => this._n(src[k] || '');
      if(this.NW_HUND[at(j)] != null){ val += this.NW_HUND[at(j)]; j++; any = true; }
      if(this.NW_TEEN[at(j)] != null){ val += this.NW_TEEN[at(j)]; j++; any = true; }
      else {
        if(this.NW_TENS[at(j)] != null){ val += this.NW_TENS[at(j)]; j++; any = true; }
        if(this.NW_UNIT[at(j)] != null && !(any && at(j) === 'μια')){ val += this.NW_UNIT[at(j)]; j++; any = true; }
      }
      if(any){ words.push(String(val)); norm.push(String(val)); i = j - 1; continue; }
      words.push(src[i]); norm.push(n);
    }
    return { words, norm };
  },
  _stem(w){ for(const e of this.ENDINGS) if(w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length); return w; },
  _num(w){ if(/^\d{1,2}$/.test(w)) return Number(w); return this.NUM_WORDS[w] ?? null; },
  // The client named at the start: full name, first name, or a Greek case of
  // it ("Γιώργο", "του Γιώργου") — matched on the stem, never on a guess.
  findClient(toks, students){
    const norm = (x) => normalizeSearchText(x).trim();
    let best = null;
    for(const st of students){
      const parts = norm(st.name).split(/\s+/).filter(Boolean);
      if(!parts.length) continue;
      for(let skip = 0; skip <= 1; skip++){                 // "του Γιώργου", "ο Γιώργος"
        if(skip && !['ο','η','του','της','τον','την','o'].includes(toks[0])) continue;
        let k = skip, ok = 0;
        for(const part of parts){
          const w = toks[k]; if(!w) break;
          // Greek cases change only the ending: Γιώργος / Γιώργο / Γιώργου.
          // The stems must then be equal — Μαρίνα is not Μαρία.
          if(w === part || (w.length >= 3 && this._stem(w) === this._stem(part))){ ok++; k++; } else break;
        }
        if(ok && (!best || ok > best.len || (ok === best.len && skip < best.skip))) best = { st, len: k, skip, full: ok === parts.length };
      }
    }
    if(!best) return null;
    // A first name shared by two clients is not a match: say so instead.
    const same = students.filter(x => normalizeSearchText(x.name).split(/\s+/)[0] === normalizeSearchText(best.st.name).split(/\s+/)[0]);
    if(same.length > 1 && !best.full) return { ambiguous: same };
    return best;
  },
  _clock(toks, i){
    let skip = 0;
    while(this.AT && this.AT.has(toks[i + skip])) skip++;
    const r = this._clock0(toks, i + skip);
    return r ? { min: r.min, used: r.used + skip, explicit: r.explicit } : null;
  },
  _clock0(toks, i){
    let w = toks[i]; if(w == null) return null;
    let h = null, m = 0, used = 1, explicit = false;
    const hm = w.match(/^(\d{1,2})[:.](\d{2})$/);
    if(hm){ h = Number(hm[1]); m = Number(hm[2]); explicit = h >= 13 || hm[1][0] === '0'; }
    else { h = this._num(w); if(h == null) return null; explicit = h >= 13; }
    if(toks[i + 1] === 'και' && toks[i + 2] === 'μιση'){ m = 30; used = 3; }
    else if(toks[i + 1] === 'μιση' || toks[i + 1] === 'half'){ m = 30; used = 2; }
    // "το πρωί / το απόγευμα" after a time says which half of the day
    const lead = toks[i + used] === 'το' && ['πρωι','απογευμα','βραδυ','μεσημερι'].includes(toks[i + used + 1]) ? 1 : 0;
    const mark = toks[i + used + lead];
    if(['πμ','am'].includes(mark)){ used += 1 + lead; if(h === 12) h = 0; explicit = true; }
    else if(mark === 'πρωι'){ used += 1 + lead; explicit = true; }                 // "12 το πρωί" is noon
    else if(['μμ','pm','απογευμα','βραδυ'].includes(mark)){ used += 1 + lead; if(h < 12) h += 12; explicit = true; }
    else if(mark === 'μεσημερι'){ used += 1 + lead; if(h < 5) h += 12; explicit = true; }
    if(!explicit && h >= 1 && h <= 6) h += 12;
    if(h > 23 || m > 59) return null;
    return { min: h * 60 + m, used, explicit };
  },
  NEW_WORDS: [['νεος','πελατης'],['νεα','πελατισσα'],['νεα','πελατης'],['νεος','μαθητης'],['νεα','μαθητρια'],['new','client'],['νεος'],['νεα'],['προσθεσε'],['add']],
  LEAD: new Set(['παμε','να','βαλουμε','βαλω','βαλε','βαλτε','προσθεσε','προσθεσουμε','προσθεσω','καταχωρησε','καταχωρησουμε','γραψε','σημειωσε','θελω','θελουμε',
    'εναν','ενα','μια','μιαν','καινουριο','καινουργιο','καινουρια','καινουργια','νεο','νεα','νεος','πελατη','πελατισσα','πελατης','μαθητη','μαθητρια','μαθητης',
    'τον','την','τη','το','ο','η','λοιπον','λεγεται','ονομα','ειναι','ok','οκ','add','new','client','a']),
  LEAD_VERB: new Set(['βαλουμε','βαλω','βαλε','βαλτε','προσθεσε','προσθεσουμε','προσθεσω','καταχωρησε','καταχωρησουμε','γραψε','σημειωσε','καινουριο','καινουργιο','καινουρια','καινουργια','νεο','νεα','νεος','add','new']),
  SEPARATE_W: new Set(['ξεχωριστες','ξεχωριστα','ξεχωριστη','ξεχωριστος','χωριστα','χωριστες','χωρια','ξεχωρα','separate','separately']),
  FILLER: new Set(['θελει','κανει','εχει','θα','κανουμε','wants']),
  HOUR_W: new Set(['ωρα','ωρες','ωρ','ωρων','ωριτσες','ωρακια','hour','hours','h']), MIN_W: new Set(['λεπτα','λεπτο','λεπτων','λεπτακια','λ','min','mins','minutes']),
  QUARTER_W: new Set(['τεταρτο','τεταρτα']), RANGE_W: new Set(['με','μεχρι','εως','ως','-','–','to','till','until']),
  FLEX_W: new Set(['σπαστα','σπαστη','σπαστες','split']),
  STOP: new Set(['θελει','κανει','εχει','θα','μενει','διευθυνση','address','στη','στην','στο','σε','δεν','δε','μαζι','η','ή','και','την','εβδομαδα','φορες','φορα','times','x','με','τις','στις','απο','μεχρι','εως','ως','οδος','οδο','οδου']),
  // "<name>, <street> <number> [<town>], <length>, <N> times / together or
  // split, <subject>, cannot <day> [from H to H]" — the parts in any order,
  // with or without commas. Returns a draft client, or null.
  parseNew(text, subjects){
    const raw = String(text || '').trim();
    if(!raw) return null;
    let { words, norm } = this._words(raw);
    // optional "νέος πελάτης"
    let explicit = false;
    for(const pat of this.NEW_WORDS) if(pat.every((w, k) => norm[k] === w)){ words = words.slice(pat.length); norm = norm.slice(pat.length); explicit = true; break; }
    // the way people start: "πάμε να βάλουμε (έναν καινούριο,) τον …",
    // "βάλε μια καινούρια, τη …", "θέλω να προσθέσω …" — a new client.
    let masculineAcc = false;
    { let k = 0, verb = false;
      while(k < norm.length && this.LEAD.has(norm[k])){ if(this.LEAD_VERB.has(norm[k])) verb = true; k++; }
      if(k && (verb || explicit)){ masculineAcc = norm[k - 1] === 'τον'; words = words.slice(k); norm = norm.slice(k); explicit = true; } }
    const used = new Array(words.length).fill(false);
    const d = { name: '', address: '', minutes: null, perWeek: null, flex: false, subject: null, cannot: [], explicit: false };
    // cannot … : one or more days, each with a time range, a part of the
    // day, or nothing (the whole day), joined by "και" or commas, as long
    // as the sentence goes on naming days and times:
    // "δεν μπορεί Τρίτη 5 με 7 και Πέμπτη 3 με 4, και Παρασκευή".
    const rangeAt = (k, timesOnly) => {
      let q = k; if(this.FROM.has(norm[q])) q++;
      const a = this._clock(norm, q);
      if(a){
        q += a.used;
        if(!this.TO.has(norm[q])) return null;
        q++;
        const b = this._clock(norm, q);
        if(!b) return null;
        let start = a.min, end = b.min <= a.min && b.min + 720 > a.min && b.min + 720 <= 24 * 60 ? b.min + 720 : b.min;
        if(end < start){ const x = start; start = end; end = x; }    // "3 με 2": two to three
        // "7 με 8" with no am/pm: morning or evening, whichever falls in the
        // working day. Someone who works 14:00–22:00 means 19:00–20:00.
        // "10 με 12 το πρωί": the half said once covers both ends.
        if(!a.explicit && b.explicit && b.min < 13 * 60 && start >= 13 * 60){ start -= 720; }
        if(!a.explicit && b.explicit && b.min >= 13 * 60 && start < 12 * 60 && start + 720 < end){ start += 720; }
        if(!a.explicit && !b.explicit && end <= 12 * 60 + 59){
          const hrs = Object.values(((typeof state !== 'undefined' && state.settings) || {}).dayHours || {});
          if(hrs.length){
            const lo = Math.min(...hrs.map(h => Scheduler.toMin(h.start))), hi = Math.max(...hrs.map(h => Scheduler.toMin(h.end)));
            const inside = (x, y) => Math.max(0, Math.min(y, hi) - Math.max(x, lo));
            if(inside(start + 720, end + 720) > inside(start, end)){ start += 720; end += 720; }
          }
        }
        return { start, end, next: q + b.used };
      }
      const pod = norm[k] === 'το' ? norm[k + 1] : norm[k];
      if(!timesOnly && ['απογευμα','πρωι','βραδυ'].includes(pod)){
        const [start, end] = pod === 'πρωι' ? [8 * 60, 13 * 60] : pod === 'απογευμα' ? [13 * 60, 20 * 60] : [19 * 60, 23 * 60];
        return { start, end, next: k + (norm[k] === 'το' ? 2 : 1) };
      }
      return null;
    };
    const daysAt = (k) => {
      const days = [];
      for(; k < norm.length; k++){
        const wd = QuickNote.WEEKDAYS[norm[k]];
        if(wd == null){
          if(['και','and','την','τη','τις','on'].includes(norm[k]) && QuickNote.WEEKDAYS[norm[k + 1]] != null) continue;
          break;
        }
        days.push(wd === 0 ? 7 : wd);
      }
      return { days, next: k };
    };
    for(let i = 0; i < norm.length; i++){
      const pat = this.CANNOT.find(p => p.every((w, k) => norm[i + k] === w));
      if(!pat) continue;
      let j = i + pat.length;
      let cur = daysAt(j);
      if(!cur.days.length) continue;
      j = cur.next;
      for(;;){
        const r = rangeAt(j);
        d.cannot.push({ days: cur.days, start: r ? r.start : null, end: r ? r.end : null });
        if(r) j = r.next;
        // goes on? "και" / "," then another range for the same days, or more days
        let k = j; while(['και','and'].includes(norm[k]) || (norm[k] && this.CANNOT.some(p => p.every((w, z) => norm[k + z] === w)) && false)) k++;
        // another range for the same days needs "και" before it: "3 με 4 και 6 με 8"
        const more = k > j ? rangeAt(k, true) : null;
        if(more && r){ d.cannot.push({ days: cur.days, start: more.start, end: more.end }); j = more.next; k = j;
          while(['και','and'].includes(norm[k])) k++; }
        const nextDays = daysAt(k);
        if(!nextDays.days.length) break;
        cur = nextDays; j = nextDays.next;
      }
      for(let q = i; q < j; q++) used[q] = true;
      i = j - 1;
    }
    // length: "2 ώρες", "90 λεπτά", "μιάμιση ώρα", "1,5 ώρα", "μισή ώρα", "τρία
    // τέταρτα", "ώρα και τέταρτο", "2 ώρες και 15 (λεπτά)", "δυόμισι ώρες"
    const length = (i) => {
      const w = (k) => norm[k], num = (k) => (/^\d+(\.\d+)?$/.test(w(k) || '') ? Number(w(k)) : this._num(w(k)));
      let h = null, j = i;
      if(this.HALF_W[w(i)] != null){ h = this.HALF_W[w(i)]; j = i + 1 + (this.HOUR_W.has(w(i + 1)) ? 1 : 0); }
      else if(w(i) === 'μιση' && this.HOUR_W.has(w(i + 1))) return { min: 30, next: i + 2 };
      else if(num(i) != null && w(i + 1) === 'και' && w(i + 2) === 'μιση' && this.HOUR_W.has(w(i + 3))){ h = num(i) + 0.5; j = i + 4; }
      // "5 ώρα" is not five hours: after 2 or more Greek says "ώρες". The 5 is a
      // house number ("Ερμού 5, ώρα και τέταρτο"), and "ώρα" stands alone.
      else if(num(i) != null && this.HOUR_W.has(w(i + 1)) && !(w(i + 1) === 'ωρα' && num(i) >= 2)){ h = num(i); j = i + 2; }
      else if(w(i) === 'ωρα' && w(i + 1) === 'και' && (w(i + 2) === 'μιση' || this.QUARTER_W.has(w(i + 2)) || this.QUARTER_W.has(w(i + 3)))){ h = 1; j = i + 1; }
      else if(num(i) != null && this.QUARTER_W.has(w(i + 1))) return { min: num(i) * 15, next: i + 2 };
      else if(w(i) === 'τεταρτο') return { min: 15, next: i + 1 + (w(i + 1) === 'της' && /^ωρα/.test(w(i + 2) || '') ? 2 : 0) };
      else if(num(i) != null && this.MIN_W.has(w(i + 1))) return { min: num(i), next: i + 2 };
      if(h == null) return null;
      let min = h * 60;
      if(w(j) === 'και'){
        if(w(j + 1) === 'μιση'){ min += 30; j += 2; }
        else if(this.QUARTER_W.has(w(j + 1))){ min += 15; j += 2; }
        else if(num(j + 1) != null && this.QUARTER_W.has(w(j + 2))){ min += num(j + 1) * 15; j += 3; }
        else if(/^\d{1,2}$/.test(w(j + 1) || '') && Number(w(j + 1)) < 60 && !this.RANGE_W.has(w(j + 2))){
          min += Number(w(j + 1)); j += 2; if(this.MIN_W.has(w(j))) j++;
        }
      }
      else if(/^\d{1,2}$/.test(w(j) || '') && this.MIN_W.has(w(j + 1))){ min += Number(w(j)); j += 2; }   // "1 ώρα 30 λεπτά", "1h30"
      return { min, next: j };
    };
    for(let i = 0; i < norm.length && d.minutes == null; i++){
      if(used[i]) continue;
      const L = length(i);
      if(L && L.min > 0){ d.minutes = Math.round(L.min); for(let q = i; q < L.next; q++) used[q] = true; }
    }
    // times a week
    for(let i = 0; i < norm.length; i++){
      if(used[i]) continue;
      const v = /^\d$/.test(norm[i]) ? Number(norm[i]) : this._num(norm[i]);
      if(v != null && v >= 1 && v <= 7 && (this.TIMES.has(norm[i + 1]) || norm[i + 1] === 'φορα')){
        d.perWeek = v; used[i] = used[i + 1] = true;
        for(const w of ['την','εβδομαδα','τη','βδομαδα','a','week']) if(norm[i + 2] === w || norm[i + 3] === w){ /* consumed below */ }
      }
      if(norm[i] === 'την' && ['εβδομαδα','βδομαδα'].includes(norm[i + 1])){ used[i] = used[i + 1] = true; }
    }
    // "2 ώρες ξεχωριστές": that many separate hours — lessons of an hour
    // (or of the length that divides them by the times given)
    for(let i = 0; i < norm.length; i++){
      if(used[i] || !this.SEPARATE_W.has(norm[i])) continue;
      used[i] = true;
      if(d.minutes){
        if(d.perWeek && d.perWeek > 1){ d.minutes = Math.round(d.minutes / d.perWeek / 15) * 15; }
        else { d.perWeek = Math.max(2, Math.round(d.minutes / 60)); d.minutes = Math.round(d.minutes / d.perWeek / 15) * 15; }
        d.separate = true;
      }
    }
    // together or split
    for(let i = 0; i < norm.length; i++){
      if(used[i]) continue;
      if(this.FLEX_W.has(norm[i])){ d.flex = true; used[i] = true;
        for(const k of [i - 1, i - 2, i - 3]) if(k >= 0 && ['μαζι','η','ή','or','together'].includes(norm[k])) used[k] = true; }
    }
    // subject: one of the profession's own
    for(const sub of (subjects || [])){
      const label = normalizeSearchText(subjectLabel(sub)), key = normalizeSearchText(sub);
      for(let i = 0; i < norm.length; i++) if(!used[i] && (norm[i] === key || norm[i] === label || (norm[i].length >= 5 && this._stem(norm[i]) === this._stem(key)))){
        d.subject = sub; used[i] = true; break;
      }
      if(d.subject) break;
    }
    // address: the first "<word…> <number>" not taken, with the town after it
    let addrAt = -1, addrEnd = -1;
    for(let i = 1; i < norm.length; i++){
      if(used[i] || used[i - 1]) continue;
      if(/^\d{1,4}[α-ωa-z]?$/.test(norm[i]) && !this.STOP.has(norm[i - 1]) && /\p{L}/u.test(norm[i - 1]) && !this.HOUR_W.has(norm[i + 1]) && !this.MIN_W.has(norm[i + 1]) && !this.TIMES.has(norm[i + 1])){
        addrAt = i - 1; addrEnd = i + 1;
        // a two-word street ("Αγίου Νικολάου 12", "Νόρμαν 3"): take the word before if it is not the name's only word
        if(addrAt >= 2 && !used[addrAt - 1] && !this.STOP.has(norm[addrAt - 1]) && /^[\p{Lu}]/u.test(words[addrAt - 1])
           && ['αγιου','αγιας','αγιων','λεωφορος','λεωφ','οδος','πλατεια','βασιλεως','βασ','ναυαρχου','μητροπολεως','αγ'].includes(norm[addrAt - 1])) addrAt--;
        // the town: capitalised words after the number, up to a keyword;
        // "στην Πάτρα" / "στο Ρίο" is the town too.
        if(['στην','στη','στο'].includes(norm[addrEnd]) && /^[\p{Lu}]/u.test(words[addrEnd + 1] || '')){ used[addrEnd] = true; addrEnd += 2; }
        else while(addrEnd < words.length && !used[addrEnd] && !this.STOP.has(norm[addrEnd]) && /^[\p{Lu}]/u.test(words[addrEnd]) && addrEnd - i < 3) addrEnd++;
        if(addrAt > 0 && ['οδος','οδο','οδου','λεωφορος','λεωφ'].includes(norm[addrAt - 1])) addrAt--;
        break;
      }
    }
    // "μένει / στη" before the street are not part of it
    if(addrAt > 0) for(let q = addrAt - 1; q >= 0 && ['μενει','στη','στην','στο','διευθυνση','address'].includes(norm[q]); q--) used[q] = true;
    if(addrAt >= 0){ d.address = words.slice(addrAt, addrEnd).filter(w => !['στην','στη','στο'].includes(this._n(w))).join(' ').replace(/^[,\s]+|[,\s]+$/g, ''); for(let q = addrAt; q < addrEnd; q++) used[q] = true; }
    // name: the first words left, up to two
    const left = [];
    for(let i = 0; i < words.length && left.length < 3; i++){
      if(used[i]) { if(left.length) break; continue; }
      if(this.STOP.has(norm[i])){ if(left.length) break; continue; }
      if(/\d/.test(norm[i])) break;
      left.push(words[i].replace(/[,.;:]+$/, ''));
    }
    // "τον Γιώργο Κολυμπήτρα" is "Γιώργος Κολυμπήτρας": a man's name after
    // "τον" goes back to the nominative (-ο, -α, -η take a final ς; a
    // genitive surname such as Αντωνίου stays as it is).
    d.name = left.slice(0, 2).map(w => masculineAcc && /[οόαάηή]$/.test(w) ? w + 'ς' : w).join(' ');
    if(!d.name) return null;
    // Without "νέος πελάτης": a capitalised name, at least two of address /
    // length / times / cannot, and nothing that marks an errand — a date
    // ("αύριο") or a time of day ("στις 11"). "Οδοντίατρος Κορίνθου 12 στις
    // 11 για 30 λεπτά" is an errand, not a client.
    if(!explicit){
      const facts = [d.address, d.minutes, d.perWeek, d.cannot.length].filter(Boolean).length;
      if(facts < 2) return null;
      if(!/^[\p{Lu}]/u.test(d.name)) return null;
      if(norm.some((w, i) => !used[i] && (QuickNote.MARKERS.has(w) || Object.prototype.hasOwnProperty.call(QuickNote.DAY_OFFSETS, w)))) return null;
    }
    if(d.flex && !d.minutes) d.flex = false;
    if(norm.some((w, i) => w === 'μαζι' && !used[i])) d.together = true;
    d.explicit = explicit;
    return d;
  },

  parse(text, students){
    const raw = String(text || '').trim();
    // "17:00-19:30" is two times and a dash.
    const toks = this._words(raw).norm;
    if(toks.length < 2) return null;
    const who = this.findClient(toks, students || []);
    if(!who) return null;
    if(who.ambiguous) return { kind: 'ambiguous', names: who.ambiguous.map(x => x.name) };
    const rest = toks.slice(who.len);
    const st = who.st;
    // cannot …
    for(const pat of this.CANNOT){
      if(pat.every((w, k) => rest[k] === w)){
        const r = rest.slice(pat.length);
        const days = [];
        let i = 0;
        for(; i < r.length; i++){
          const d = QuickNote.WEEKDAYS[r[i]];
          if(d == null){ if(['και','and','την','τη','τις','on'].includes(r[i])) continue; break; }
          days.push(d === 0 ? 7 : d);
        }
        if(!days.length) return null;
        let start = null, end = null;
        if(this.FROM.has(r[i])) i++;
        const a = this._clock(r, i);
        if(a){
          i += a.used;
          if(this.TO.has(r[i])) i++;
          const b = this._clock(r, i);
          if(!b) return null;
          start = a.min; end = b.min <= a.min && b.min + 12 * 60 > a.min ? b.min + 12 * 60 : b.min;
          if(end <= start || end > 24 * 60) return null;
        }
        return { kind: 'unavailable', id: st.id, name: st.name, days, start, end };
      }
    }
    // N times a week
    const n = this._num(rest[0]);
    if(n != null && n >= 1 && n <= 7 && this.TIMES.has(rest[1])) return { kind: 'perweek', id: st.id, name: st.name, n };
    // address
    if(this.LIVES.has(rest[0])){
      const words = raw.split(/\s+/);
      const addr = words.slice(who.len + 1 + (['στην','στο','σε'].includes(rest[1]) ? 1 : 0)).join(' ').replace(/^[:,\s]+/, '').trim();
      if(addr.length >= 3) return { kind: 'address', id: st.id, name: st.name, address: addr };
    }
    return null;
  },
};

