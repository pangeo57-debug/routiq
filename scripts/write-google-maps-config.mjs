import { writeFile } from 'node:fs/promises';

// Without the key the site still goes live; only the map stays off, and the
// app already copes with an empty key (see the onerror on the script tag).
const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
if (!key) {
  console.warn('GOOGLE_MAPS_API_KEY is not set: deploying without the map key');
}

await writeFile(
  'google-maps-config.js',
  `// Generated at deploy time. Do not commit.\nwindow.ROUTEPAL_GOOGLE_MAPS_API_KEY=${JSON.stringify(key)};\n`,
);
