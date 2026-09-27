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

For the second one, the key goes where `wrangler dev` will find it:

    cp worker/.dev.vars.example worker/.dev.vars
    # paste the key into worker/.dev.vars

`.dev.vars` is in `.gitignore` and must stay there — it is the one file in
this directory that holds a real secret.

The key currently in use is the one that used to ship inside `routiq.html`.
It was therefore public — on the deployed page, in the repository, and in the
git history, where it still is and cannot be taken back. Keeping it is a
deliberate choice, not an oversight: the proxy stops it leaking from here on,
and moving to a fresh key is one `wrangler secret put` whenever you want it.
If the HERE dashboard ever shows traffic you do not recognise, that is what it
means, and rotating is the answer.

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
    npx wrangler secret put HERE_API_KEY      # the same key as in .dev.vars
    npx wrangler deploy

Then set `API_BASE` in `routiq.html` to the URL it prints, and add your
GitHub Pages origin to `ALLOWED_ORIGINS` in `wrangler.toml` if it is not
already there.

**Restrict the key at HERE.** The proxy stops it leaking from here on; it
cannot un-leak what already left. Lock it to this Worker's domain in the HERE
portal — that is what makes a copied key useless to whoever copied it, and it
is worth doing even though the key itself is staying.

## Sync (phase two)

One person's data as a single encrypted blob, with one device allowed to
write it.

**The server cannot read any of it.** The blob is encrypted on the device with
a key derived from a 24-character code that never leaves it. What is stored
here is ciphertext, its size, and when it changed. Names, addresses and
schedules are unreadable to the server, to Cloudflare, and to anyone who ever
gets hold of the database.

The price, said out loud in the app before anything is sent: **lose the code
and the copy on the server is gone.** For a backup of data that also lives on
the device, that is an honest trade rather than a nasty surprise.

Three rules, each with tests that were watched failing:

- **A write must be based on the current version.** If it is not, somebody
  wrote in between, and this write would erase them — the server hands back
  the newer copy instead of taking the older one.
- **Only the primary device writes.** A second device reads. It can take over,
  but only by saying so, so a phone left in a drawer cannot quietly overwrite
  the laptop that has been doing the real work.
- **A wrong code and a missing space give the same answer,** or the endpoint
  tells you which space ids are real.

A pull may send its `knownVersion`. If it matches, the server answers
`unchanged` and sends no blob at all — opening the app five times a day should
not download the whole roster five times. The version only ever goes up, and
goes up on every write, so "same version" cannot mean "different data".

The stored credential is a hash of what the client sends, which is itself a
hash of the code — so the database is not a usable credential if it leaks.

    npx wrangler d1 create routepal-sync
    # paste the id into wrangler.toml
    npx wrangler d1 migrations apply routepal-sync --remote

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
| `/sync/create` | POST | D1 |
| `/sync/pull` | POST | D1 |
| `/sync/push` | POST | D1 |
| `/sync/rotate` | POST | D1 |
| `/sync/delete` | POST | D1 |

Every route rebuilds its upstream URL from an allowlist of parameters. A proxy
that forwards whatever it is given is an open relay wearing a different hat.

## Limits

60 requests a minute and 2000 a day, per IP — and separately **5 space
creations a day**. Creating is nothing like a lookup: it leaves a row behind,
so under the general allowance alone one address could create 2000 spaces a
day and fill the database with rows nobody will ever read. A person needs a
handful of these in a lifetime.

Running out of creations does not touch the allowance for ordinary lookups:
someone who has made their spaces can still use the app.

The counters live in KV, which is eventually consistent, and the update is a
read-modify-write — so a simultaneous burst can overshoot slightly. That is
acceptable for what this defends against (one person or script draining a
shared quota) and is written down rather than pretended away. If it ever needs
to be exact, the answer is a Durable Object, not a cleverer version of this.

With no KV binding the limiter is skipped rather than failing closed: a
misconfigured limiter must not take the whole proxy down with it.

## What this does not defend against

Said plainly, because a security section that lists only wins is a marketing
page.

- **The limits are per IP.** Anyone willing to rotate addresses gets a fresh
  allowance each time. This raises the cost of abuse; it does not make it
  impossible.
- **Whoever has the code has the data.** There is no second factor. The code
  is 24 characters from a 31-symbol alphabet — far past guessing — but it can
  be shared, screenshotted or shoulder-surfed like any password. What there
  IS, is a way to take access back: `/sync/rotate` changes the code and
  re-encrypts in one statement, and every other device is locked out the
  moment it lands. Changing the credential without the data would leave a blob
  nobody can read, so the two move together or not at all.
- **Timing is visible.** The server knows when a blob changed — roughly, when
  you last worked on the schedule. Nothing hides that from it.
- **Size is visible in bands.** Ciphertext is as long as what goes in, so the
  blob is padded to a 16KB step before encryption. Rosters from empty to
  twenty are byte-for-byte identical; a much larger one moves up a band. That
  is one step of resolution, not none.
- **A lost code is lost data.** By design, and the app says so before anything
  is sent.

## Tests

    npm run test:worker

65 tests, no network and no Cloudflare account needed — the Worker is plain ES
modules with a stubbed `env`. They are all about the two ways this can fail
badly: leaking the key, and being an open relay.
