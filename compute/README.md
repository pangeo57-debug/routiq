# RoutePal compute server

Computes the week off the phone. A phone freezes the page the moment the
person leaves the app, and a week takes minutes; here it goes on regardless,
and a push notification says when it is ready. Coming back to the app (even
after it was closed) picks the result up.

## What it receives

Anonymous by construction — `Remote.build` in `routiq.html` makes the job:

- every client as a code (`§s1`, `§s2`, …); group names and subjects as codes
- availability, durations, lessons per week, the scheduling settings
- a travel matrix (minutes and metres) between the codes, and positions made
  up from that matrix

No names, addresses, phone numbers, notes, home address, API keys or real
coordinates. The server refuses a job that carries any of those fields, and
keeps jobs in memory only, for 24 hours after they finish. The codes are
turned back into people on the phone.

It runs the scheduler out of `routiq.html` itself (not a copy), in several
threads at once and in two rounds, exactly as the phone does.

## Run it

    docker build -f compute/Dockerfile -t routepal-compute .
    docker run -p 8790:8790 \
      -e ALLOWED_ORIGINS=https://pangeo57-debug.github.io \
      -e VAPID_PUBLIC=... -e VAPID_PRIVATE=... -e VAPID_SUBJECT=mailto:you@example.com \
      routepal-compute

Any small server works (2 vCPU, 2 GB is plenty for one person at a time;
about €5/month at Hetzner, or Fly.io). Put it behind HTTPS.

Push keys, once: `npx web-push generate-vapid-keys`. Without them the server
still computes; the person just is not notified.

Then in `routiq.html` set

    const COMPUTE_BASE = 'https://your-compute-server';
    const VAPID_PUBLIC = '<the public key>';

Empty `COMPUTE_BASE` keeps everything on the phone, as before. If the server
cannot be reached, the phone computes the week itself.

## Settings (environment)

| variable | default | |
|---|---|---|
| `PORT` | 8790 | |
| `ALLOWED_ORIGINS` | the app's site, localhost:8080 | comma-separated |
| `RUNS` | CPU count, at most 4 | runs at once per round |
| `CONCURRENT_JOBS` | 1 | jobs computed at the same time |
| `QUEUE_MAX` | 30 | jobs waiting before new ones are refused |
| `JOBS_PER_IP_HOUR` | 12 | |

## Endpoints

    POST   /jobs        { input, matrix, push?, notify? }  -> 202 { id }
    GET    /jobs/:id    -> { status: queued|running|done|failed|cancelled, progress, result? }
    DELETE /jobs/:id    -> stops it
    GET    /health

Tests: `npm test` at the repository root (compute/test).
