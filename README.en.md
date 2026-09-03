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
- Each route stop opens in Google Maps for turn-by-turn navigation
- Multilingual UI (Greek, English, French, German)
- Dark mode
- Works as a PWA — installs to the home screen like a native app

## Technical architecture

**Single-file application, no backend (for now).** The entire app — HTML, CSS, JavaScript — lives in one file: [`routiq.html`](./routiq.html). No build step, no `npm install`.

```
routiq.html                       → the entire application
sw.js                             → service worker (network-first: fresh online, works offline)
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
5. **LNS (Large Neighborhood Search)** — destroy-repair for hard cases, with a "persistent" search extending up to 7 minutes if needed. Guarded: its output is adopted only if it placed more lessons, or held the same number without adding kilometres
6. **`enforceConstraints()`** — final safety net: removes any placement that violates a student's availability and retries elsewhere
7. **`compactDays()`** — pulls every lesson as early as it legally can (without reordering), closing the holes the repair passes leave behind
8. **Ratchet** — the schedule already on screen is used as a warm start and as a floor: a rerun keeps the previous result unless it beats it (more lessons placed, or the same number in fewer km)

## Development

Nothing special needed — open `routiq.html` in a browser, or run a simple local server (e.g. `python3 -m http.server`) for the Service Worker/manifest to work correctly.

### Testing

```bash
npm test
```

88 tests, zero dependencies — just the built-in `node:test` runner (Node 18+).

Because the app is a single HTML file, the tests load its real `<script>` into
a Node `vm` sandbox with stubbed browser APIs (`test/harness.js`). They run
against the **actual code**, not a copy.

| File | Covers |
|---|---|
| `test/scheduler.test.js` | Scheduling rules: blocked times, availability, pairs/groups, merged blocks, travel time |
| `test/data.test.js` | Data loss: pairing, deletion, export/import, legacy saved data |
| `test/rendering.test.js` | XSS escaping, address search, network resilience |
| `test/i18n.test.js` | Translation completeness across all 4 languages |

`test/invariants.js` holds an **independent** rule checker — deliberately
separate from the app's own `verifySchedule()`, so it can catch the case where
the scheduler and its self-check are wrong in the *same* way (which is exactly
what happened with blocked times).

Every test maps to a bug that actually shipped — this is a regression suite,
not a specification exercise.

### Deployment

Push to `main` → automatic deploy via GitHub Pages, live within 30-60 seconds.

The service worker is network-first, so a device with connectivity always gets the latest deploy without a hard refresh. (Devices still running the old blob-based worker need one final hard refresh to pick up the new one.)

## Roadmap

- [ ] Backend (proxy for geocoding keys, user accounts, cross-device sync)
- [ ] Payments/subscriptions (Stripe)
- [ ] Legal text reviewed by a lawyer (`PRIVACY.md`/`TERMS.md` are drafts)
- [ ] A second app: [DropOff](https://github.com/pangeo57-debug/dropoff) — delivery route optimization, with Wolt/efood integration

## Security

Reviewed for XSS (all user-controlled content passes through `esc()` before being inserted into `innerHTML`). No server-side attack surface yet, since there's no backend.
