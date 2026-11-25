'use strict';
// Spoken commands, understood on the phone by rules.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadApp, student, settings } = require('./harness');

test('each kind of sentence maps to its intent; a new client is never made; errands are left alone', () => {
  const app = loadApp();
  const sts = [student('k', { name: 'Κώστας Παπαδόπουλος' }), student('d', { name: 'Δέσποινα' })];
  app.setState({ students: sts, settings: settings() });
  const V = app.VoiceCommand;
  const p = (s) => V.parse(s, sts);
  assert.equal(p('Πού πάω μετά;').intent, 'NEXT_STOP');
  assert.equal(p('Τι έχω αύριο;').intent, 'SCHEDULE_OVERVIEW');
  assert.equal(p('Τι έχω αύριο;').entities.date, 'tomorrow');
  assert.equal(p('Πόσα ραντεβού μου μένουν;').intent, 'SCHEDULE_OVERVIEW');
  const c = p('Ακύρωσε ο Κώστας στις 6');
  assert.equal(c.intent, 'MARK_STATUS'); assert.equal(c.entities.status, 'cancelled'); assert.equal(c.entities.target_id, 'k');
  assert.equal(c.entities.time, '18:00'); assert.equal(c.requires_confirmation, true);
  const d = p('Ολοκληρώθηκε της Δέσποινας');
  assert.equal(d.intent, 'MARK_STATUS'); assert.equal(d.entities.status, 'completed'); assert.equal(d.entities.target_id, 'd');
  assert.equal(p('Βρες ποιος μπορεί να μπει στη θέση του σήμερα').intent, 'RESCHEDULE_OR_FILL');
  const m = p('Δείξε μου όσους έχω κοντά στην Αγία Σοφία');
  assert.equal(m.intent, 'MAP_SEARCH'); assert.match(m.entities.map_query, /Αγία Σοφία/);
  assert.equal(p('Ποιοι είναι κοντά μου').entities.map_query, '@me');
  assert.equal(p('Καφές με Γιάννη στις 5'), null, 'an errand stays an errand');
  assert.equal(p('Κώστας δεν μπορεί Τρίτη από 5 μέχρι 7'), null, 'a client command stays a client command');
  assert.equal(p('Ακύρωσε το ραντεβού με τον οδοντίατρο'), null, 'no client named: not ours');
});
