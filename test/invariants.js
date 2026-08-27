'use strict';
/**
 * The rules a finished schedule must always obey, checked independently of the
 * app's own verifySchedule() — the point is to catch the case where BOTH the
 * scheduler and its self-check are wrong in the same way (which is exactly
 * what happened with blocked times).
 */

/**
 * @returns {string[]} human-readable violations; empty means valid.
 */
function auditSchedule(Scheduler, schedule, students, settings) {
  const S = Scheduler;
  const errs = [];
  const byId = Object.fromEntries(students.map(s => [s.id, s]));
  const margin = settings.travelMargin ?? 2;

  // Everyone a slot actually occupies — a group/paired block is filed under one
  // member's id but ties up every member.
  const occupants = (sl) => {
    const ids = (sl.groupMemberIds && sl.groupMemberIds.length)
      ? sl.groupMemberIds.slice()
      : [sl.studentId, sl.pairedStudentId].filter(Boolean);
    return ids.map(id => byId[id]).filter(Boolean);
  };

  for (const d of settings.workDays) {
    const slots = (schedule[d] || []).slice()
      .sort((a, b) => S.toMin(a.start) - S.toMin(b.start));
    const dh = settings.dayHours[d];
    const seen = {};

    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const s0 = S.toMin(sl.start), e0 = S.toMin(sl.end);
      const who = sl.studentName || sl.studentId;

      if (e0 <= s0) errs.push(`[${d}] ${who}: end <= start (${sl.start}-${sl.end})`);

      if (dh) {
        if (s0 < S.toMin(dh.start)) errs.push(`[${d}] ${who}: starts before working hours`);
        if (e0 > S.toMin(dh.end) + 15) errs.push(`[${d}] ${who}: ends after working hours`);
      }

      for (const st of occupants(sl)) {
        const av = st.availability && st.availability[d];
        if (!av || !av.on) { errs.push(`[${d}] ${st.name}: not available this day`); continue; }
        if (s0 < S.toMin(av.start) || e0 > S.toMin(av.end) + 15)
          errs.push(`[${d}] ${st.name}: outside own window (${sl.start}-${sl.end} vs ${av.start}-${av.end})`);
      }

      if (S.isBlocked(s0, e0, d, settings))
        errs.push(`[${d}] ${who}: inside a blocked time (${sl.start}-${sl.end})`);

      for (const st of occupants(sl)) {
        // A forceMerge student explicitly asked for their lessons on the SAME
        // day, so more than one slot is the requested outcome, not a fault —
        // whether they ended up as one collapsed block or as fragments.
        if (seen[st.id] && !sl.merged && !st.forceMerge)
          errs.push(`[${d}] ${st.name}: two lessons same day`);
        seen[st.id] = true;
      }

      if (i > 0) {
        const p = slots[i - 1];
        const pe = S.toMin(p.end);
        if (s0 < pe) {
          errs.push(`[${d}] overlap: ${p.studentName || p.studentId} & ${who}`);
        } else if (p.studentId !== sl.studentId) {
          const need = S.travelEstMin(p.studentId, p.address, sl.studentId, sl.address, d) + margin;
          if (s0 < pe + need)
            errs.push(`[${d}] impossible travel ${p.studentName || p.studentId}→${who}: ${s0 - pe}min available, ${need}min needed`);
        }
      }
    }
  }

  // Nobody scheduled more than they asked for.
  const placed = {};
  for (const d of settings.workDays)
    for (const sl of (schedule[d] || []))
      for (const st of occupants(sl))
        placed[st.id] = (placed[st.id] || 0) + (sl.mergedCount || 1);
  for (const st of students) {
    const n = placed[st.id] || 0;
    if (n > st.lessonsPerWeek)
      errs.push(`${st.name}: ${n} lessons scheduled, only ${st.lessonsPerWeek} requested`);
  }

  return [...new Set(errs)];
}

/** Total lessons placed, counting merged blocks by their session count. */
function totalPlaced(schedule, workDays) {
  let n = 0;
  for (const d of workDays) for (const sl of (schedule[d] || [])) n += (sl.mergedCount || 1);
  return n;
}

module.exports = { auditSchedule, totalPlaced };
