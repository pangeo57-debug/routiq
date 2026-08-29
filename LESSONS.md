# Engineering rules learned from RoutePal

Every rule below is here because the opposite happened in this project and cost
real debugging time. None of it is generic advice — each one has a scar.

Written to be dropped into another codebase as instructions (e.g. as
`CLAUDE.md`, or the "rules" section of a project brief).

---

## 1. Constraints

### Every phase must enforce every constraint
The worst bug class in this project: the initial placement respected blocked
times, then a later optimizer re-laid out the day and put lessons straight
through them. A schedule went in valid and came out invalid, silently. Four
separate functions rebuilt a day, and only one of them checked blocks.

**Rule**: extract a single `isFeasible(x)` and call it from *every* phase. Never
reimplement a constraint check per phase. If you find yourself writing a second
version of a rule, that is the bug.

### The self-check must not share the algorithm's blind spots
`verifySchedule()` missed blocked times for exactly the same reason the
scheduler did — same assumptions, same author, same gap. Three bug classes
passed the self-check silently.

**Rule**: derive the validator from the *requirements*, independently. In the
tests, check again with a validator written separately a third time. Two
implementations that agree are evidence; one implementation checking itself is
not.

### The repair pass must cover the same rules as the checker
When the repair function checked fewer rules than the reporter, the app warned
about problems that nothing tried to fix, and each repair pass reintroduced
violations the previous pass had just removed. They fought each other.

**Rule**: checker and repairer read from the same rule list, or they will drift.

### Never let the algorithm silently decide something the user cares about
When a hard case had no clean solution, the natural instinct was to pick a
compromise (cap a block at 90 minutes, keep only the largest availability
window). Users experience that as the app being wrong, not as it being clever —
they cannot see what was traded away.

**Rule**: when the algorithm has to give something up, surface it. Name the
thing that was dropped. Offer the choice if there is one.

---

## 2. Data

### Round-trip everything you persist
Export omitted the geocoded coordinates and import overwrote them with nothing,
so a single export→import destroyed every address lookup in the app. Neither
side was individually obviously wrong.

**Rule**: for every serialization format, write one test that does
`import(export(state))` and asserts deep equality. It catches both halves at
once.

### Deleting an entity must delete everything that points at it
Deleting a student left their lessons in the schedule (ghost entries rendering
`undefined`) and left the *other* student's `pairedWith` pointing at a
non-existent id.

**Rule**: for every foreign-key-ish reference, know where the cleanup lives.
Write the deletion test before the deletion code.

### Read the old record before you overwrite it
`state.students[idx] = st` ran *before* the code looked up the previous record
to unlink its old partner. The lookup then found the new record and unlinked
nothing.

**Rule**: capture `prev` first, mutate second. Ordering bugs like this survive
review because both lines look correct in isolation.

### Assume saved data is from an older version of your code
Users had settings objects saved before new fields existed; the app crashed on
`settings.dayHours[d].start`. Storage is a permanent compatibility boundary.

**Rule**: every load path merges over defaults and backfills missing fields.
Test with a deliberately old, partial payload.

---

## 3. Async and cancellation

### `fetch` has no timeout
A hung request on mobile froze the entire calculation past the point where the
cancel button could work. The user saw a frozen app, not a slow network.

**Rule**: every network call goes through one wrapper with an
`AbortController` timeout. No raw `fetch` anywhere in the codebase.

### Long synchronous work makes the UI structurally unresponsive
The backtracking phase ran 50–70 seconds with no yield points. The browser
could not repaint or process a click, so the cancel button was not slow — it
was *unable* to run. Adding a "make it more responsive" tweak cannot fix this;
it is an event-loop fact.

**Rule**: either yield (`await new Promise(r => setTimeout(r, 0))`) at
checkpoints and test the cancel flag there, or put the work in a Web Worker.
For anything heavy, choose the Worker on day one — it is the same effort and it
removes the whole problem class.

### Concurrent runs corrupt each other
Several entry points could start a calculation. The second run reset the
first's cancel flag, so both stayed alive and both wrote results into the same
state.

**Rule**: give each run a generation token. On every write, a run checks it is
still the current generation and returns without writing if it is not. A
boolean `isRunning` flag is not enough.

---

## 4. Resources

### Anything you attach to a DOM node leaks when the node is replaced
Screens were rebuilt with `innerHTML`, which orphans the container but not the
map/chart/observer attached to it. Each navigation leaked a whole map with its
listeners and timers — invisible on desktop, fatal on iOS after a few minutes.

**Rule**: for every `create`, know where the matching `destroy` runs. If the
render path replaces markup wholesale, tear down before re-rendering.

### Don't ship libraries the user may never use
PDF export libraries were loaded eagerly in `<head>` and roughly doubled the
cold-start payload for everyone, including the majority who never export.

**Rule**: lazy-load on first use, with a cached in-flight promise so a
double-click doesn't fetch twice.

### A Blob-URL service worker is not a service worker
`createObjectURL` returns a new URL on every page load, so the browser treats
each visit as a *different* worker and re-registers it forever. This one also
cached nothing (`addAll([])`) — it sat in the request path providing neither
offline support nor speed.

**Rule**: the service worker is a real file at a stable path. Network-first for
your own assets, bypass third-party requests, and never cache a non-`ok`
response — a cached error page is served offline forever.

---

## 5. Security

### String interpolation into `innerHTML` is stored XSS
Names and addresses typed by the user were rendered unescaped in nine places,
including two that went through a translation helper's parameters — those were
the ones that survived the first review pass, because they didn't *look* like
interpolation.

**Rule**: route every interpolation through an escape helper, and grep for the
template-parameter paths too. Better: use a framework with automatic escaping
and never make the decision per call site.

---

## 6. Correctness of the maths

### Approximations that look fine are often not
The Δlat/Δlon "flat earth" distance is about 15% wrong at Greek latitudes. It
looked plausible in every manual spot-check and quietly produced worse routes.

**Rule**: use the correct formula (haversine) unless you have measured that the
approximation is acceptable *at your latitudes and distances*. Compare against
an external ground truth (Google Maps, a routing API), not against intuition.

### Straight-line distance is not travel time
Users compare against their satnav, not against your model. "0 minutes" between
two stops is a bug report waiting to happen.

**Rule**: real road distances from a routing API, with a matrix call rather than
N² individual calls, and a documented fallback when the API is unavailable.

---

## 7. Testing

### Verify that a test can actually fail
The first version of the test suite did **not** catch the blocked-times
regression — a later repair pass masked it, so the end-to-end assertion still
passed. Only re-introducing the bug on purpose revealed the gap.

**Rule**: after writing a test, break the code deliberately and confirm the test
goes red. A test never seen failing is not known to work. Where a repair pass
can mask a defect, test the phase in isolation as well as end-to-end.

### Test the real code, not a copy
Single-file app? Extract its `<script>` and run it in a `vm` sandbox with
stubbed browser APIs. Copying logic into the test file means testing the copy.

Two gotchas that cost time:
- Top-level `const` in a vm script is **not** reachable as a context property.
  Export explicitly: `this.__exports = {...}`.
- Arrays crossing the vm boundary carry the sandbox's `Array` prototype, so
  `deepStrictEqual(sandboxArray, [])` fails on identity even when both are
  empty. Copy with `Array.from()` first.

### Write regression tests, not specification exercises
Every test in this suite maps to a bug that actually shipped. That is what
makes the suite worth its runtime. Tests written from imagination cover the
cases you already thought about — which are, by definition, not the ones that
bite you.

---

## 8. Process

### Fix the cause, not the symptom
Twice the instinct was to add a warning ("distance unavailable", "no exact
match") instead of fixing the lookup. Both times the user rejected it, and both
times the underlying fix (retry geocoding without the house number) was
straightforward once actually attempted.

**Rule**: a message explaining a failure is a last resort, not a fix.

### Audit with fresh eyes, in parallel, then verify
The most productive session ran several independent audits (scheduler, data,
UI/security) against the same code. Each found things the others missed, because
each was looking for a different failure mode. Every finding was then reproduced
in a test *before* being reported — several plausible-sounding findings turned
out not to be real.

**Rule**: claims about bugs are hypotheses until reproduced. Never report a
finding you have not seen fail.

### Don't build infrastructure for users who don't exist
The strong pull throughout was to build a backend, accounts and payments. None
of that was the bottleneck; usage was. Ten strangers given a link tells you more
than a month of backend work.
