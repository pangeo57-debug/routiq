# RoutePal — project memory

Read this first in every new session. It replaces re-reading old conversations.
Longer background lives in `LESSONS.md`, `LAUNCH.md`, `LEGAL_BRIEF.md`,
`PRIVACY.md` (draft), and `test/bench-pvrp.js`.

## What it is
A PWA that plans the week (and the day) of a professional who goes to their
clients: tutors, therapists, trainers, cleaners, technicians. First everyone
fits (availability windows, pairs/groups, merged blocks, locked lessons, fixed
hours at another place), then fewest km + waiting, on real roads.
Greek first; also English, French, German.

## How we work (the owner's rules)
- Two repos, kept **identical**: private `pangeo57-debug/routepal` (remote
  `origin`) and public `pangeo57-debug/routiq` (remote `open`), which serves
  the GitHub Pages link people use.
- Work in the private repo. Then: `npm test` must end with `# fail 0`; check in a
  browser (phone size) when the change is visible; commit; push `origin main`;
  check `open/main` is an ancestor (`git merge-base --is-ancestor open/main HEAD`);
  push `open HEAD:main` and force-push `open HEAD:claude/festive-rubin-zuyfr8`.
- Replies to the owner: Greek, short, with numbers, and say plainly what was and
  was not verified.
- Do not rewrite the algorithm without being asked; measure before changing it.
- Commit trailer as the session instructs. No model names in repo files.

## Never
- Keys (HERE, Google, AI) anywhere but the Worker's secrets. Never in the repo, never in chat.
- The owner's exported data (real clients, addresses) in the repo. It lives only
  in the session's scratchpad, with `hereApiKey` removed.
- An automatic replan that moves times clients were already told. Edits mark the
  week "needs a new plan" only when it no longer holds; the person presses the button.
- Sending messages for the person: WhatsApp/SMS open ready, they tap send.
- Subscriptions/payments before everything else is done (they come last).
- Data about minors beyond what is needed; coded names in any study.

## Code map
- `routiq.html` loads `css/app.css` and `js/*.js`; `tools/assemble.js` rebuilds
  one page for tests and workers (`App._workerSource`).
- `js/scheduler.js` week planner, day solver, measurement (`dayKm`, `measureWeek`),
  `verifySchedule`, `fixedSplit` (fixed hours at another place), `lockSplit` (locks).
- `js/genetic.js` hybrid genetic search after Vidal (HGS): time-warp, two
  populations, PIX + regret-2, relocate/swap/2-opt/2-opt*, concatenation pricing,
  traffic band per departure, home-in-long-gaps.
- `js/dayfill.js` a cancelled lesson for one date and who can take its place.
- `js/notify.js` who must hear new times; parent's phone; send to the next one.
- `js/client-command.js` sentences about clients, and `VoiceCommand` (on-device intents).
- `js/payments.js`, `js/feedback.js` (+ `ErrorLog`), `js/professions.js`, `js/i18n.js` (4 languages;
  keys must exist in all; no "student/lesson" words in el/en messages — use neutral words).
- `worker/` Cloudflare Worker: geocoding proxy, sync (encrypted), optional AI. Not deployed yet.

## The week, in order (optimizeWeek)
backtracking placement → ALNS* → SA repair → LNS → ejection chains (if someone is
missing) → clean-ups → refineWeek* → genetic (15 s) → polish days (exact for ≤12
stops) → final fill. The best week so far is kept after every step (more lessons,
then km + 0.5·waiting min, never a new rule broken).
*Weeks under 40 lessons skip ALNS and refineWeek unless someone is missing after
the first placement (measured: same km, about a third less time).

## Measured (keep these in mind before "improving")
- Cordeau PVRP: p09 +1.15/+1.28/+1.15% at 60 s genetic; p03 +0.87%; p06 +4.95% (1 run, unexplained).
- Athens weeks (31–32 lessons, OSRM): 277.2 / 180.2 / 294.2 km, everyone placed.
- Owner's real week: ~118–120 km after a mistyped address was fixed (a wrong address
  cost ~32 km — the address warnings exist because of that).
- Tried and removed: SISR operator (worse), genetic early stop on small weeks (no gain),
  "thorough" mode (same km, 3.5× time), more initial placements (same km, slower).

## Next: moving to Cloudflare (agreed plan, in this order)
1. Deploy `worker/` (keys as Worker secrets; the Cloudflare API token is in the
   environment's network secrets for `api.cloudflare.com`). The HERE key that once
   shipped in `routiq.html` is public in git history: use a new one, delete the old.
2. Cloudflare Pages from the **private** repo, on a test `*.pages.dev` link first;
   the owner checks it on the phone before anything changes on the live link.
3. Before the GitHub Pages link goes away: a notice there — save a copy → open the
   new link → load the copy. Data is stored per site address and does not move by
   itself; installed apps must be added to the home screen again.
4. Then GitHub Pages off and `routiq` private. Code already public stays copied;
   HTML/JS sent to a browser is always readable — minify/obfuscate only slows copying.
   Real protection of the algorithm = running it on the server (`compute/`), at the
   cost of needing internet. Not decided yet.
- Google Maps JS key is visible by design: restrict it to the site's domain(s) and to
  Maps JavaScript + Places (New).

## Business decisions so far (proposals, not built)
- Plans: Free up to 10 clients; Basic €8.99/month (with VAT) up to 30 clients;
  Pro €14.99/month unlimited; yearly = 2 months free. Limit by clients, not by runs
  (a run costs us ~nothing; clients drive HERE cost and value). Stripe, no app stores.
- Per paying user per month after VAT, Stripe and services: ~€6–7 (Basic), ~€10–11 (Pro).
- Accountant: sole trader / freelancer at first; IKE once profit passes ~€50,000/year.
- Simulations (3 years, many runs; inputs are guesses until the Beta measures them):
  word of mouth + partnerships + content ≈ 30 paying in year 1, ~65–100 in year 3;
  paid ads at the assumed costs buy users at about what they bring (no profit).
  Ads pay only if one paying user costs < ~€50. ~1,000 paying needs ~1,000 sign-ups/month.
- Marketing order: associations/tutoring centres and own content first, referrals later.
  Claims must be honest: demo example −57% is a built example; real weeks measured
  −12.5% against a hand-made plan and −25–35% against the first placement.
- Beta goal: 20–50 real professionals; measure sign-ups, % who pay, monthly churn, and
  which channel brought them; then re-run the simulation with those numbers.

## Open (needs the owner)
- Cloudflare account + HERE/Google keys for the Worker. Before HERE goes live:
  cache road matrices and fetch only new rows, and use OSRM for km with HERE only for
  a traffic factor — otherwise HERE matrix billing (origins × destinations, two
  matrices per plan) costs more per user than the subscription.
- Feedback email (`FEEDBACK_TO`), data-controller name for `PRIVACY.md` and `LICENSE`,
  a lawyer's review of the privacy draft, domain, first Beta users.
