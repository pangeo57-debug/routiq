# RoutePal

*[🇬🇷 Ελληνικά](./README.md) | 🇬🇧 English*

A scheduling and route-optimization app for private tutors and other mobile professionals (physiotherapists, personal trainers, etc.) who visit clients at home.

**Live**: https://pangeo57-debug.github.io/routiq/routiq.html

## What it does

- Automatically builds a weekly lesson schedule, respecting each student's availability and the tutor's working hours
- Optimizes visit order to minimize travel distance/time (real road data via OSRM/HERE, not straight-line distance)
- Supports group lessons, student pairs, and combined time blocks
- Exports the schedule to PDF
- Map view with student locations and the suggested route
- Multilingual UI (Greek, English, French, German)
- Dark mode
- Works as a PWA — installs to the home screen like a native app

## Technical architecture

**Single-file application, no backend (for now).** The entire app — HTML, CSS, JavaScript — lives in one file: [`routiq.html`](./routiq.html). No build step, no `npm install`.

```
routiq.html                       → the entire application
manifest.json                     → PWA manifest (icon, name, colors)
icon-*.png, apple-touch-icon.png  → app icons
PRIVACY.md, TERMS.md              → draft legal text (NEEDS LAWYER REVIEW before real use)
```

### Data storage

All data (students, schedule, settings) is stored **locally on the user's device** (`localStorage`) — there is no central server/database yet. Each user only sees their own data, on their own device.

### External services

| Service | Purpose | Cost |
|---|---|---|
| [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) | Address geocoding (default) | Free |
| [OSRM](https://router.project-osrm.org) | Real road distances/durations | Free |
| [HERE Technologies](https://developer.here.com) (optional) | Better search accuracy + live traffic — requires a personal API key set by the user in Settings | Free tier is enough for individual use |
| Leaflet.js | Map rendering | Free, open source |
| jsPDF + html2canvas | PDF export | Free, open source |

No Google API is used — deliberately avoided due to cost at scale.

### Scheduling algorithm

A multi-phase algorithm (the `Scheduler` object inside `routiq.html`):

1. **Backtracking CSP** (multiple randomized attempts) — initial placement, maximizes the number of students placed
2. **Geographic optimization** — nearest-neighbor + cross-day moves/swaps to reduce total distance
3. **Simulated Annealing** — refines visit order further
4. **Repair passes** — attempts to place any students still unscheduled
5. **LNS (Large Neighborhood Search)** — destroy-repair for hard cases, with a "persistent" search extending up to 7 minutes if needed
6. **`enforceConstraints()`** — final safety net: removes any placement that violates a student's availability and retries elsewhere

## Development

Nothing special needed — open `routiq.html` in a browser, or run a simple local server (e.g. `python3 -m http.server`) for the Service Worker/manifest to work correctly.

### Testing

There's no test framework — the algorithm is tested by extracting the `<script>` contents and running them in a Node.js `vm` context with stub browser globals:

```bash
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' routiq.html > /tmp/scheduler_test.js
node /tmp/scheduler_test.js
```

### Deployment

Push to `main` → automatic deploy via GitHub Pages, live within 30-60 seconds. Because of Service Worker caching, a hard refresh (⌘⇧R) may be needed on-device to see changes immediately.

## Roadmap

- [ ] Backend (proxy for geocoding keys, user accounts, cross-device sync)
- [ ] Payments/subscriptions (Stripe)
- [ ] Legal text reviewed by a lawyer (`PRIVACY.md`/`TERMS.md` are drafts)
- [ ] A second app: [DropOff](https://github.com/pangeo57-debug/dropoff) — delivery route optimization, with Wolt/efood integration

## Security

Reviewed for XSS (all user-controlled content passes through `esc()` before being inserted into `innerHTML`). No server-side attack surface yet, since there's no backend.
