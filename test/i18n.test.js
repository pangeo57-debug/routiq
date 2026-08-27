'use strict';
/**
 * Translation completeness. The app ships four languages; a key present in one
 * and missing from another shows up as a blank or a raw key string in the UI,
 * which is easy to introduce and hard to notice while working in Greek.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { loadApp, APP_FILE } = require('./harness');

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
