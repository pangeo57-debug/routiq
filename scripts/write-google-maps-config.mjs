import { writeFile } from 'node:fs/promises';

const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
if (!key) {
  console.error('GOOGLE_MAPS_API_KEY is required');
  process.exit(1);
}

await writeFile(
  'google-maps-config.js',
  `// Generated locally/deployment-only. Do not commit.\nwindow.ROUTEPAL_GOOGLE_MAPS_API_KEY=${JSON.stringify(key)};\n`,
);
