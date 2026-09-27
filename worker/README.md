# RoutePal API proxy

A Cloudflare Worker that holds the HERE API key and keeps us honest with
OpenStreetMap. It stores **no user data** — the schedule, the clients and
their addresses never leave the device. This proxy sees an address string on
its way to a geocoder, and nothing else.

## Why it exists

1. **The key was public.** It sat in `routiq.html`, a file anyone can read, so
   anyone could copy it and spend the quota. It is now a Worker secret.
2. **We were breaking Nominatim's usage policy.** It requires an identifying
   `User-Agent`; `User-Agent` is a *forbidden header* in browsers, so the
   client's attempt to set one was silently dropped and every request went out
   anonymous. Only a server can send it. The Worker also caches for 30 days,
   which is the other half of being a good citizen.

## Running it locally

Two terminals, from the repository root:

    npm run dev        # the app          -> http://localhost:8080/routiq.html
    npm run dev:api    # the Worker       -> http://localhost:8787

For the second one, first put your key where `wrangler dev` will find it:

    cp worker/.dev.vars.example worker/.dev.vars
    # edit worker/.dev.vars and paste the key

Then point the app at it: set `API_BASE` in `routiq.html` to
`http://localhost:8787`. `http://localhost:8080` is already in
`ALLOWED_ORIGINS`, so the browser will not be refused.

Leaving `API_BASE` empty is a valid, working state: the app falls back to
Nominatim and OSRM, which need no key. Less accurate, not broken.

Checking it by hand:

    curl http://localhost:8787/health
    curl 'http://localhost:8787/osm/search?q=Πάτρα' -H 'Origin: http://localhost:8080'

Without the `Origin` header you get a 403. That is the point.

## Deploying

    cd worker
    npx wrangler login
    npx wrangler kv namespace create RATE
    npx wrangler kv namespace create CACHE
    # paste the two ids into wrangler.toml
    npx wrangler secret put HERE_API_KEY
    npx wrangler deploy

Then set `API_BASE` in `routiq.html` to the URL it prints, and add your
GitHub Pages origin to `ALLOWED_ORIGINS` in `wrangler.toml` if it is not
already there.

**Restrict the key at HERE as well.** The proxy stops it leaking; it does not
stop a key that leaked earlier. Lock it to this Worker's domain in the HERE
portal, and rotate it, since the old one was public for a while.

## Routes

| Route | Method | Upstream |
|---|---|---|
| `/health` | GET | — |
| `/here/geocode` | GET | HERE geocode |
| `/here/autosuggest` | GET | HERE autosuggest |
| `/here/revgeocode` | GET | HERE reverse geocode |
| `/here/matrix` | POST | HERE matrix routing |
| `/osm/search` | GET | Nominatim search |
| `/osm/reverse` | GET | Nominatim reverse |

Every route rebuilds its upstream URL from an allowlist of parameters. A proxy
that forwards whatever it is given is an open relay wearing a different hat.

## Limits

60 requests a minute and 2000 a day, per IP.

The counters live in KV, which is eventually consistent, and the update is a
read-modify-write — so a simultaneous burst can overshoot slightly. That is
acceptable for what this defends against (one person or script draining a
shared quota) and is written down rather than pretended away. If it ever needs
to be exact, the answer is a Durable Object, not a cleverer version of this.

With no KV binding the limiter is skipped rather than failing closed: a
misconfigured limiter must not take the whole proxy down with it.

## Tests

    npm run test:worker

25 tests, no network and no Cloudflare account needed — the Worker is plain ES
modules with a stubbed `env`. They are all about the two ways this can fail
badly: leaking the key, and being an open relay.
