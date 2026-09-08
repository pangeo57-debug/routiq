'use strict';
/**
 * Translation completeness. The app ships four languages; a key present in one
 * and missing from another shows up as a blank or a raw key string in the UI,
 * which is easy to introduce and hard to notice while working in Greek.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { loadApp, settings, APP_FILE } = require('./harness');

const LANGS = ['el', 'en', 'fr', 'de'];

describe('i18n', () => {
  test('all languages define exactly the same keys', () => {
    const app = loadApp();
    const dict = app.I18N;
    assert.ok(dict, 'I18N should be reachable from the harness');

    const keysOf = (lang) => Object.keys(dict[lang]).sort();
    const base = keysOf('el');

    for (const lang of LANGS.slice(1)) {
      const ks = keysOf(lang);
      const missing = base.filter(k => !ks.includes(k));
      const extra = ks.filter(k => !base.includes(k));
      assert.deepStrictEqual(missing, [], `${lang} is missing keys present in el`);
      assert.deepStrictEqual(extra, [], `${lang} has keys el does not`);
    }
  });

  test('every t()/tf() key used in the code actually exists', () => {
    const app = loadApp();
    const dict = app.I18N;
    const src = fs.readFileSync(APP_FILE, 'utf8');

    // Literal single-quoted keys only; dynamically composed ones
    // (t('profession_'+v+'_label')) are covered by the test below.
    const used = new Set();
    for (const m of src.matchAll(/\bt\('([a-z0-9_]+)'\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/\btf\('([a-z0-9_]+)'/g)) used.add(m[1]);

    const known = new Set(Object.keys(dict.el));
    const unknown = [...used].filter(k => !known.has(k)).sort();
    assert.deepStrictEqual(unknown, [], 'these keys are referenced but never defined');
  });

  test('every profession has a full set of labels in every language', () => {
    const app = loadApp();
    const dict = app.I18N;
    const values = app.PROFESSION_VALUES;
    assert.ok(Array.isArray(values) && values.length, 'PROFESSION_VALUES should be reachable');

    for (const lang of LANGS) {
      for (const v of values) {
        for (const suffix of ['label', 'client', 'clients', 'session', 'sessions']) {
          const key = `profession_${v}_${suffix}`;
          assert.ok(dict[lang][key], `${lang} is missing ${key}`);
        }
      }
    }
  });

  test('subject names are translated in every language', () => {
    const app = loadApp();
    const dict = app.I18N;
    const subjects = app.SUBJECTS;
    assert.ok(Array.isArray(subjects) && subjects.length, 'SUBJECTS should be reachable');

    for (const lang of LANGS) {
      assert.ok(dict[lang].subjects, `${lang} has no subjects map`);
      for (const s of subjects) {
        assert.ok(dict[lang].subjects[s], `${lang} is missing a translation for "${s}"`);
      }
    }
  });
});

describe('each trade gets its own list of services', () => {
  // A personal trainer choosing between Μαθηματικά, Φυσική and Χημεία was the
  // giveaway that this list was written for one profession only.
  test('every profession has its own list, and none is the school one', () => {
    const app = loadApp();
    const seen = new Map();
    for (const p of app.PROFESSION_VALUES) {
      app.setState({ settings: settings({ profession: p }) });
      const list = Array.from(app.ctx.getSubjects());
      assert.ok(list.length >= 4, `${p} has only ${list.length} services`);
      seen.set(p, list.join('|'));
    }
    for (const [p, list] of seen) {
      if (p === 'tutor') continue;
      assert.notEqual(list, seen.get('tutor'), `${p} still offers the school subjects`);
    }
  });

  test('every service reads properly in all four languages', () => {
    const app = loadApp();
    for (const lang of ['el', 'en', 'fr', 'de']) {
      for (const p of app.PROFESSION_VALUES) {
        app.setState({ settings: settings({ profession: p, language: lang }) });
        for (const key of app.ctx.getSubjects()) {
          // Membership, not difference: in Greek several keys ARE their own
          // translation, which is correct — the keys were written in Greek.
          assert.ok(Object.prototype.hasOwnProperty.call(app.I18N[lang].subjects, key),
            `${lang}/${p}: "${key}" is missing from the dictionary and would show its raw key`);
          assert.ok(app.subjectLabel(key), `${lang}/${p}: "${key}" renders blank`);
        }
      }
    }
  });

  test('keys are identifiers, so switching language cannot change stored data', () => {
    const app = loadApp();
    app.setState({ settings: settings({ profession: 'personal_training', language: 'el' }) });
    const el = Array.from(app.ctx.getSubjects());
    app.setState({ settings: settings({ profession: 'personal_training', language: 'de' }) });
    assert.deepStrictEqual(Array.from(app.ctx.getSubjects()), el,
      'the values stored on a student must not depend on the interface language');
  });

  test('a subject from another trade still displays after switching profession', () => {
    const app = loadApp();
    // Someone who starts as a tutor and later switches has students on file
    // with school subjects. Those records must stay readable.
    app.setState({ settings: settings({ profession: 'personal_training', language: 'el' }) });
    assert.equal(app.subjectLabel('Μαθηματικά'), 'Μαθηματικά');
    assert.equal(app.subjectLabel('unknown_key'), 'unknown_key', 'and nothing may render blank');
  });
});
