#!/usr/bin/env node
/**
 * One-time setup for the RoutePal Worker.
 *
 * Creates the two KV namespaces and the D1 database, writes their ids into
 * wrangler.toml, applies the migration, deploys, and points the app at the
 * result.
 *
 * It exists because every one of those steps otherwise ends with "copy this
 * id into that file", and a mistyped id fails at runtime with an error that
 * says nothing useful.
 *
 * Safe to re-run: anything that already exists is reused rather than
 * recreated, and nothing is deleted.
 *
 *   node setup.mjs            do it
 *   node setup.mjs --check    only report what is and is not set up
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TOML = join(here, 'wrangler.toml');
const APP = join(here, '..', 'routiq.html');
const CHECK = process.argv.includes('--check');

const c = { dim:'\x1b[2m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', bold:'\x1b[1m', off:'\x1b[0m' };
const say = (m) => console.log(m);
const step = (n, m) => say(`\n${c.bold}${n}. ${m}${c.off}`);
const ok = (m) => say(`   ${c.green}✓${c.off} ${m}`);
const warn = (m) => say(`   ${c.yellow}!${c.off} ${m}`);

function wrangler(args, { quiet = false } = {}) {
  try {
    return execFileSync('npx', ['--yes', 'wrangler@latest', ...args],
      { cwd: here, encoding: 'utf8', stdio: quiet ? 'pipe' : ['inherit', 'pipe', 'pipe'] });
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    throw Object.assign(new Error(out.trim() || err.message), { output: out });
  }
}

/** Pull an id out of whatever shape wrangler prints it in this version. */
function findId(text) {
  const m = text.match(/id\s*=\s*"([0-9a-f]{32})"/i)
        || text.match(/"id":\s*"([0-9a-f-]{32,36})"/i)
        || text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
        || text.match(/\b([0-9a-f]{32})\b/i);
  return m ? m[1] : null;
}

function readToml() { return readFileSync(TOML, 'utf8'); }

/** Replace the id of one binding, by binding name, without touching the rest. */
function setKvId(toml, binding, id) {
  const re = new RegExp(`(binding\\s*=\\s*"${binding}"[\\s\\S]{0,200}?)id\\s*=\\s*"[^"]*"`, 'm');
  if (!re.test(toml)) throw new Error(`binding ${binding} not found in wrangler.toml`);
  return toml.replace(re, (all, head) => `${head}id = "${id}"`);
}
function setPreviewId(toml, binding, id) {
  const re = new RegExp(`(binding\\s*=\\s*"${binding}"[\\s\\S]{0,240}?)preview_id\\s*=\\s*"[^"]*"`, 'm');
  return re.test(toml) ? toml.replace(re, (all, head) => `${head}preview_id = "${id}"`) : toml;
}
function setD1Id(toml, id) {
  return toml.replace(/(database_name\s*=\s*"routepal-sync"\s*\n\s*database_id\s*=\s*)"[^"]*"/m, `$1"${id}"`);
}

const PLACEHOLDER = /PUT_YOUR_\w+_HERE/;

async function main() {
  say(`${c.bold}RoutePal Worker setup${c.off}`);
  let toml = readToml();

  if (CHECK) {
    const left = toml.match(/PUT_YOUR_\w+_HERE/g) || [];
    left.length ? warn(`still to fill in: ${[...new Set(left)].join(', ')}`) : ok('wrangler.toml has no placeholders left');
    const app = existsSync(APP) ? readFileSync(APP, 'utf8') : '';
    const base = app.match(/const API_BASE = '([^']*)'/);
    base && base[1] ? ok(`the app points at ${base[1]}`) : warn('API_BASE in routiq.html is still empty');
    existsSync(join(here, '.dev.vars')) ? ok('.dev.vars exists for local development') : warn('no .dev.vars — `npm run dev:api` will have no key');
    return;
  }

  step(1, 'Signing in to Cloudflare');
  try { wrangler(['whoami'], { quiet: true }); ok('already signed in'); }
  catch { say(`   ${c.dim}a browser window will open${c.off}`); wrangler(['login']); ok('signed in'); }

  step(2, 'KV namespaces (rate limits and the geocoding cache)');
  for (const binding of ['RATE', 'CACHE']) {
    const current = toml.match(new RegExp(`binding\\s*=\\s*"${binding}"[\\s\\S]{0,200}?id\\s*=\\s*"([^"]*)"`));
    if (current && !PLACEHOLDER.test(current[1])) { ok(`${binding} already set (${current[1].slice(0, 8)}…)`); continue; }
    const out = wrangler(['kv', 'namespace', 'create', binding], { quiet: true });
    const id = findId(out);
    if (!id) throw new Error(`could not read the id wrangler printed for ${binding}:\n${out}`);
    toml = setKvId(toml, binding, id);
    const prevOut = wrangler(['kv', 'namespace', 'create', binding, '--preview'], { quiet: true });
    const prevId = findId(prevOut);
    if (prevId) toml = setPreviewId(toml, binding, prevId);
    writeFileSync(TOML, toml);
    ok(`${binding} created`);
  }

  step(3, 'D1 database (the encrypted sync blobs)');
  const d1 = toml.match(/database_name\s*=\s*"routepal-sync"\s*\n\s*database_id\s*=\s*"([^"]*)"/);
  if (d1 && !PLACEHOLDER.test(d1[1])) ok(`already set (${d1[1].slice(0, 8)}…)`);
  else {
    let out;
    try { out = wrangler(['d1', 'create', 'routepal-sync'], { quiet: true }); }
    catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
      warn('it already exists — reading its id');
      out = wrangler(['d1', 'info', 'routepal-sync'], { quiet: true });
    }
    const id = findId(out);
    if (!id) throw new Error(`could not read the database id:\n${out}`);
    toml = setD1Id(toml, id);
    writeFileSync(TOML, toml);
    ok('database ready');
  }

  step(4, 'Creating the table');
  wrangler(['d1', 'migrations', 'apply', 'routepal-sync', '--remote']);
  ok('migration applied');

  step(5, 'The HERE API key');
  const devVars = join(here, '.dev.vars');
  let key = '';
  if (existsSync(devVars)) {
    const m = readFileSync(devVars, 'utf8').match(/HERE_API_KEY\s*=\s*(.+)/);
    if (m) key = m[1].trim();
  }
  if (key) {
    // Piped in, so the key never appears in the shell history or in a
    // process list where anything else could read it.
    execFileSync('npx', ['--yes', 'wrangler@latest', 'secret', 'put', 'HERE_API_KEY'],
      { cwd: here, input: key + '\n', encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
    ok('key uploaded from .dev.vars');
  } else {
    warn('no .dev.vars found — run `npx wrangler secret put HERE_API_KEY` yourself');
  }

  step(6, 'Deploying');
  const out = wrangler(['deploy'], { quiet: true });
  process.stdout.write(out);
  const url = (out.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
  if (!url) { warn('deployed, but could not read the URL from the output — copy it from above'); return; }
  ok(`live at ${url}`);

  step(7, 'Pointing the app at it');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`   Set API_BASE in routiq.html to ${url}? [Y/n] `)).trim().toLowerCase();
  rl.close();
  if (ans === 'n') { warn(`not changed — set it yourself: const API_BASE = '${url}';`); }
  else {
    const app = readFileSync(APP, 'utf8');
    if (!/const API_BASE = '[^']*';/.test(app)) throw new Error('could not find API_BASE in routiq.html');
    writeFileSync(APP, app.replace(/const API_BASE = '[^']*';/, `const API_BASE = '${url}';`));
    ok('routiq.html updated — commit and push it');
  }

  say(`\n${c.bold}Done.${c.off} Check it with:`);
  say(`   curl ${url}/health`);
  say(`   node setup.mjs --check`);
  say(`\n${c.yellow}One thing left, in the HERE portal:${c.off} restrict the key to this`);
  say(`Worker's domain. That is what makes a copied key useless to whoever copied it.`);
}

main().catch(err => {
  console.error(`\n${c.red}Setup stopped.${c.off} ${err.message}`);
  console.error(`\nNothing was deleted. Fix the problem and run it again —`);
  console.error(`anything that already exists will be reused.`);
  process.exit(1);
});
