// ============================================================
// PROFESSIONS — what each kind of work usually looks like
// ============================================================
// A starting point, never a rule: the person sees what is set, and changes any
// of it in Settings (or per client). Nothing here is applied without them:
// at first run it fills an empty profile; later it only runs when they say so.
//
//   durations   the length buttons in the client form (minutes)
//   dur         the one picked for a new client
//   perWeek     times a week for a new client
//   days        working days (1 Monday … 7 Sunday)
//   hours       the working day, one or two stretches (split shift)
//   margin      minutes kept between two appointments, on top of the drive
//   maxPerDay   most appointments in a day (0 = no limit)
//   spacing     keep the same client off two days in a row
//   services    a service's own length, where the service decides it
const PROFESSION_PRESETS = {
  tutor:             { durations: [60, 90, 120], dur: 90, perWeek: 2, days: [1, 2, 3, 4, 5, 6], hours: [['14:00', '21:30']], margin: 5, maxPerDay: 0, spacing: true },
  physiotherapy:     { durations: [45, 60], dur: 45, perWeek: 2, days: [1, 2, 3, 4, 5], hours: [['08:00', '14:00'], ['17:00', '21:00']], margin: 10, maxPerDay: 0, spacing: true },
  speech:            { durations: [45, 60], dur: 45, perWeek: 2, days: [1, 2, 3, 4, 5], hours: [['14:00', '20:30']], margin: 5, maxPerDay: 0, spacing: true },
  psychologist:      { durations: [50, 60, 90], dur: 50, perWeek: 1, days: [1, 2, 3, 4, 5], hours: [['09:00', '21:00']], margin: 10, maxPerDay: 0, spacing: false },
  personal_training: { durations: [45, 60], dur: 60, perWeek: 2, days: [1, 2, 3, 4, 5, 6], hours: [['06:30', '10:00'], ['17:00', '21:30']], margin: 5, maxPerDay: 0, spacing: true },
  massage:           { durations: [60, 90], dur: 60, perWeek: 1, days: [1, 2, 3, 4, 5, 6], hours: [['10:00', '21:00']], margin: 15, maxPerDay: 5, spacing: false,
    services: { mass_relax: 60, mass_deep: 60, mass_sports: 60, mass_lymph: 60, mass_preg: 60, mass_reflex: 45 } },
  beauty:            { durations: [30, 45, 60, 90, 120], dur: 60, perWeek: 1, days: [1, 2, 3, 4, 5, 6], hours: [['10:00', '20:00']], margin: 10, maxPerDay: 0, spacing: false,
    services: { beauty_facial: 60, beauty_mani: 45, beauty_pedi: 60, beauty_wax: 30, beauty_lash: 90, beauty_makeup: 60, beauty_hair: 120 } },
  music:             { durations: [45, 60], dur: 60, perWeek: 1, days: [1, 2, 3, 4, 5, 6], hours: [['14:00', '21:00']], margin: 5, maxPerDay: 0, spacing: true },
  cleaning:          { durations: [180, 240, 300], dur: 240, perWeek: 1, days: [1, 2, 3, 4, 5, 6], hours: [['08:00', '16:00']], margin: 10, maxPerDay: 2, spacing: false },
  pet:               { durations: [30, 60], dur: 30, perWeek: 5, days: [1, 2, 3, 4, 5, 6, 7], hours: [['07:00', '09:30'], ['18:00', '21:00']], margin: 3, maxPerDay: 0, spacing: false },
  repair:            { durations: [30, 60, 90, 120, 180], dur: 60, perWeek: 1, days: [1, 2, 3, 4, 5, 6], hours: [['08:00', '17:00']], margin: 10, maxPerDay: 0, spacing: false },
  freelancer:        { durations: [30, 45, 60, 90], dur: 60, perWeek: 1, days: [1, 2, 3, 4, 5], hours: [['09:00', '17:00']], margin: 5, maxPerDay: 0, spacing: false },
  other:             { durations: [45, 60, 90, 120], dur: 60, perWeek: 1, days: [1, 2, 3, 4, 5], hours: [['09:00', '21:00']], margin: 5, maxPerDay: 0, spacing: false },
};

const Professions = {
  preset(p){ return PROFESSION_PRESETS[p] || PROFESSION_PRESETS.other; },

  // The length buttons: the person's own list if they set one, else the
  // profession's. Always sorted, no repeats, each 5-480 minutes.
  durations(settings){
    const own = Array.isArray(settings && settings.durationChoices) ? settings.durationChoices : null;
    const list = own && own.length ? own : this.preset(settings && settings.profession).durations;
    const ok = [...new Set(list.map(Number).filter(v => Number.isFinite(v) && v >= 5 && v <= 480).map(Math.round))].sort((a, b) => a - b);
    return ok.length ? ok : [45, 60, 90, 120];
  },
  // "45, 60 90" -> [45, 60, 90]; nothing usable -> null (back to the profession's).
  parseDurations(text){
    const v = String(text || '').split(/[^\d]+/).map(Number).filter(n => n >= 5 && n <= 480);
    return v.length ? [...new Set(v.map(Math.round))].sort((a, b) => a - b).slice(0, 8) : null;
  },
  defaultPerWeek(settings){
    const v = Number(settings && settings.defaultPerWeek);
    return v >= 1 && v <= 7 ? v : this.preset(settings && settings.profession).perWeek;
  },
  // A service's own length: the person's override, else the profession's.
  serviceDuration(settings, subject){
    if(!subject) return null;
    const own = settings && settings.serviceDurations && Number(settings.serviceDurations[subject]);
    if(own >= 5 && own <= 480) return Math.round(own);
    const p = this.preset(settings && settings.profession).services;
    return p && p[subject] ? p[subject] : null;
  },

  // The settings this profession suggests, as a patch on `settings`.
  // Working hours with a break are one day from first to last minute plus the
  // break as a blocked stretch, the same shape the hours editor writes.
  // keepHours: leave working days and hours as they are (they were set by
  // the person, or came with an import), and set only the rest.
  apply(settings, p, opts = {}){
    const pr = this.preset(p);
    settings.profession = p;
    if(!opts.keepHours) this._applyHours(settings, pr);
    settings.travelMargin = pr.margin;
    settings.maxPerDay = pr.maxPerDay;
    settings.avoidConsecutiveDays = !!pr.spacing;
    settings.defaultLessonDuration = pr.dur;
    settings.defaultPerWeek = pr.perWeek;
    delete settings.durationChoices;
    delete settings.serviceDurations;
    return settings;
  },
  _applyHours(settings, pr){
    settings.workDays = pr.days.slice();
    settings.dayHours = {};
    settings.blockedSlots = (settings.blockedSlots || []).filter(b => b.auto !== 'hours');
    for(const d of pr.days){
      const iv = pr.hours.map(([start, end]) => ({ start, end }));
      settings.dayHours[d] = { start: iv[0].start, end: iv[iv.length - 1].end };
      for(let i = 1; i < iv.length; i++)
        settings.blockedSlots.push({ day: d, start: iv[i - 1].end, end: iv[i].start,
          reason: typeof t === 'function' ? t('hours_gap_reason') : '', auto: 'hours' });
    }
  },

  // One line that says what apply() sets, for the person to read before and after.
  summary(p){
    const pr = this.preset(p);
    const D = typeof DAYS !== 'undefined' ? DAYS : [];
    const days = pr.days.length === 7 ? (typeof t === 'function' ? t('prof_every_day') : '') :
      `${D[pr.days[0]] || pr.days[0]}–${D[pr.days[pr.days.length - 1]] || pr.days[pr.days.length - 1]}`;
    const hours = pr.hours.map(([a, b]) => `${a}–${b}`).join(' & ');
    return typeof tf === 'function' ? tf('prof_summary', {
      days, hours, durs: pr.durations.map(v => v + '′').join(' · '), dur: pr.dur, per: pr.perWeek,
      margin: pr.margin, spacing: pr.spacing ? t('prof_spacing_on') : t('prof_spacing_off'),
    }) : '';
  },
};
