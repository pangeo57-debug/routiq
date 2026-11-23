'use strict';
/**
 * The app as one text, the way it was before it was split into files.
 *
 * routiq.html loads css/app.css and js/*.js; the browser runs them in that
 * order, exactly as it ran the one big <script> they came from. Tests, the
 * compute server and anything else that reads the app as text read it through
 * here, so they see the same single page as before: the stylesheet link back
 * as a <style> block, the run of local scripts back as one <script> block.
 *
 *   node tools/assemble.js            prints the assembled page
 *   node tools/assemble.js --check F  exits 1 unless it equals file F byte for byte
 */
const fs = require('fs');
const path = require('path');

const SCRIPT = /^<script src="(js\/[^"]+\.js)"><\/script>$/;
const STYLE = /^<link rel="stylesheet" href="(css\/[^"]+\.css)">$/;

function assemble(htmlFile) {
  const dir = path.dirname(htmlFile);
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const lines = fs.readFileSync(htmlFile, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const css = lines[i].match(STYLE);
    if (css) { out.push('<style>', read(css[1]) + '</style>'); continue; }
    if (SCRIPT.test(lines[i])) {
      let body = '';
      while (i < lines.length && SCRIPT.test(lines[i])) body += read(lines[i++].match(SCRIPT)[1]);
      i--;
      out.push('<script>', body + '</script>');
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

module.exports = { assemble };

if (require.main === module) {
  const app = path.join(__dirname, '..', 'routiq.html');
  const text = assemble(app);
  const i = process.argv.indexOf('--check');
  if (i < 0) { process.stdout.write(text); return; }
  const want = fs.readFileSync(process.argv[i + 1], 'utf8');
  if (text === want) { console.log('identical: ' + text.length + ' characters, ' + text.split('\n').length + ' lines'); return; }
  const a = text.split('\n'), b = want.split('\n');
  const at = a.findIndex((l, k) => l !== b[k]);
  console.error(`differs at line ${at + 1}:\n  split:    ${JSON.stringify(a[at])}\n  original: ${JSON.stringify(b[at])}`);
  process.exit(1);
}
