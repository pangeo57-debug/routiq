# DropOff — handoff from RoutePal

Everything worth carrying over from building RoutePal, written so a fresh
conversation can start from here instead of rediscovering it.

**How to use this**: in a new session, point at this file — *"read
DROPOFF-HANDOFF.md, we're building DropOff"* — alongside `routiq.html`
(the RoutePal source) and `test/` (its test suite).

---

## 1. What DropOff is

Delivery/courier route optimization. Same underlying problem as RoutePal —
assign stops to containers, order them sensibly, respect time constraints —
but for parcels and drivers instead of lessons and weekdays.

**Target market (unvalidated)**: small local businesses doing their own
deliveries — pharmacies, florists, local supermarkets, small courier firms
with 3-10 vehicles. NOT Wolt/efood/Box, who have their own systems.

Two things make this commercially more promising than RoutePal:
- **Daily use**, not once-a-September (RoutePal's core weakness)
- **Businesses pay**, individuals resist — €50/month is easy for a pharmacy,
  €5/month is hard for a tutor

Validate before building: talk to 3 local businesses that deliver. Ask how
they plan routes today. "In our head" / "on paper" → market exists.

---

## 2. The structural insight: days ARE drivers

RoutePal's scheduler assigns stops to *containers*, where each container has
a time window, an ordered stop list, and travel times between stops. Those
containers are weekdays. In DropOff they're drivers. **The data structure is
the same.**

| RoutePal | DropOff |
|---|---|
| Day (Mon–Sat) | Driver / shift |
| `settings.dayHours[day]` | Driver's shift window |
| Student | Order |
| `student.availability[day]` | Delivery time window |
| `lessonDuration` | Stop dwell time (2–5 min) |
| `settings.blockedSlots` | Driver break |
| Paired/group students | Pickup+dropoff pair (see §4) |

This is a rename, not a rewrite. The ALNS optimizer, the day-rebuild logic,
the travel matrix layer, the constraint checker and the tests all work as-is.

**Roughly 50–60% of the routing core transfers unchanged.**

Not a coincidence: ALNS (Adaptive Large Neighborhood Search) is the standard
industry algorithm for Vehicle Routing Problems. RoutePal already has the
right engine — it was built for a VRP variant without being called one.

---

## 3. What to lift from `routiq.html`

Line numbers drift; find these by name in the `Scheduler` object.

**Take as-is:**
- `alnsOptimize` — the optimizer. Destroy/repair with adaptive operator
  weights (random/worst/Shaw removal, greedy/regret-2 insertion), 2-opt +
  Or-opt local search, restart-on-stagnation. This is the valuable part.
- `travelEstMin` / `travelEstKm` — real road time/distance with a matrix
  lookup and a haversine fallback. Provider-agnostic.
- `haversineKm` — correct great-circle distance (NOT the Δlat/Δlon
  approximation, which is ~15% wrong at Greek latitudes).
- `Router.getMatrix` / `getHereMatrix` / `_fetch` — routing providers with
  timeouts already wired.
- `isBlocked` — time-window overlap check.
- `test/harness.js` — the whole testing approach (see §6).

**Adapt:**
- `rebuildDay` (inside `alnsOptimize`) — lays out one container's stops with
  travel time between them. Becomes `rebuildRoute(driver)`.
- `verifySchedule` / `enforceConstraints` — the rule checker and the repair
  pass. Rules change; the structure doesn't.
- `findSlotFixed` — finds the earliest valid slot respecting travel, blocked
  times and windows.

**Drop:**
- Everything under `App` (the UI) — different product
- `collapseForceMergeFragments` — RoutePal-specific (δίωρο merging)
- `runMultiAttempt` / `scheduleAll` — the CSP backtracking phase. Delivery
  doesn't need multi-attempt weekly placement; insertion + ALNS is enough.

---

## 4. What genuinely has to be built

In order of difficulty.

### 4.1 Multiple vehicles — easy (1–2 days)
Replace `for (const day of settings.workDays)` with
`for (const driver of drivers)`. The optimizer doesn't notice.

### 4.2 Capacity — easy (1 day)
One more constraint in `dayFeasible`: sum of parcel sizes ≤ vehicle
capacity. Same shape as the existing working-hours check.

### 4.3 Pickup → delivery pairing — hard (1–2 weeks)
The real new work. Each order becomes **two** stops with constraints:
- Both on the **same** driver
- Pickup strictly **before** dropoff (precedence)
- Bounded time between them (food freshness / SLA)

ALNS must move **pairs**, not individual stops: removal takes both, insertion
places both while preserving order.

**You already have something close**: RoutePal's paired/group students, where
two people must be scheduled together and never split. Look at how
`groupMemberIds` / `pairedWith` are handled across every phase — the
"never split this" plumbing is done. Precedence is the addition.

### 4.4 Real time — architectural, not algorithmic
The actual blocker. RoutePal runs 30–60s for a weekly plan. Delivery needs an
answer in **under 1 second** when an order arrives.

Don't try to make ALNS fast. Use **two speeds**:

- **Instant (~50ms)**: `regret2Insertion` alone — find the best position for
  the new order in the existing routes. *This already exists inside
  `alnsOptimize`.* Extract it.
- **Background (continuous)**: full ALNS improving only the stops that
  haven't been started yet. Never touch a stop a driver is already driving to.

This is the standard pattern for live dispatch systems.

### 4.5 Backend — mandatory
A fleet means many devices sharing state. localStorage ends here. Also needed:
live driver positions, and re-planning when reality diverges (traffic, a
driver running late).

---

## 5. Lessons paid for the hard way

These cost real debugging time in RoutePal. Design DropOff to avoid them.

### Every phase must enforce every constraint
RoutePal's worst bug class: the initial placement respected blocked times,
then the optimizer re-laid out the day and put lessons straight through them.
A schedule went in valid and came out invalid, silently.

**Rule**: any function that rebuilds a route must check *all* constraints, not
just the ones its author was thinking about. Extract one `isFeasible(route)`
and call it from everywhere. Do not reimplement per phase.

### The self-check must not share the algorithm's blind spots
`verifySchedule` missed blocked times for exactly the same reason the
scheduler did — same assumptions, same author, same gap. Three bug classes
passed it silently.

**Rule**: derive the validator from the *requirements*, independently. In the
tests, check with a validator written separately again (`test/invariants.js`).

### The repair pass must cover the same rules as the checker
When `enforceConstraints` checked fewer rules than `verifySchedule` reported,
the app warned about problems nothing tried to fix, and repair passes
reintroduced violations the previous pass had removed.

### `fetch` has no timeout
A hung request on mobile froze the entire calculation past the point where
cancellation could work. Every network call needs an `AbortController`
timeout. See `Router._fetch`.

### Long synchronous work makes the UI structurally unresponsive
RoutePal's backtracking ran ~50-70s with no yield points — the browser
couldn't repaint or process a click, so the cancel button wasn't slow, it was
*unable* to run. Yield (`await new Promise(r => setTimeout(r, 0))`) at
checkpoints, and check a cancellation flag there.

For DropOff this matters more: put optimization in a **Web Worker** from day
one. It's the right answer and avoids the problem entirely.

### Concurrent runs corrupt each other
Multiple entry points started a calculation; the second reset the first's
cancel flag, leaving both alive and both writing results. Give each run a
generation token; a superseded run must return without writing anything.

### String interpolation into innerHTML is stored XSS
User-typed names/addresses rendered without escaping execute on every render.
If DropOff has any UI, use a framework with automatic escaping, or route
*every* interpolation through an escape helper with a lint rule.

### Verify that tests can actually fail
The first version of RoutePal's suite did **not** catch the blocked-times
regression — the repair pass masked it. Only re-introducing the bug on purpose
revealed the gap.

**Rule**: after writing a test, break the code deliberately and confirm the
test goes red. A test never seen failing is not known to work.

---

## 6. Testing approach (reuse this)

Zero dependencies, `node:test` only. See `test/harness.js`.

The app is one HTML file, so the harness extracts its `<script>` and runs it
in a `vm` sandbox with stubbed browser APIs — tests exercise the **real
code**, not a copy. Each load gets a fresh sandbox.

Two gotchas that cost time:
- Top-level `const` in a vm script is **not** reachable as a context property.
  Export explicitly: `this.__exports = {Scheduler, App, ...}`.
- Arrays crossing the vm boundary carry the sandbox's `Array` prototype, so
  `assert.deepStrictEqual(sandboxArray, [])` fails on identity even when both
  are empty. Copy with `Array.from()` first.

If DropOff gets a backend, this pattern still applies to the routing core —
keep it a pure module with no I/O, and it stays trivially testable.

---

## 7. Suggested build order

1. **Validate** — 3 conversations with local businesses. Do not skip.
2. **Extract the routing core** from `routiq.html` into a standalone module
   with no DOM/localStorage dependencies. Port its tests. This alone is worth
   doing even if DropOff stalls — it makes RoutePal's core reusable.
3. **Rename days → drivers**, add capacity. Prove multi-vehicle works.
4. **Add pickup/dropoff pairing.** The hard part; budget properly.
5. **Split fast insertion from background optimization.** Web Worker.
6. **Backend**, only once 2–5 has been proven with fake data.

Do not build the backend first. RoutePal's mistake was almost building
infrastructure for users who didn't exist yet.

---

## 8. Current RoutePal state (as of this handoff)

- ~7.000 lines, single file, no build step
- 41 tests passing (`npm test`)
- Deployed: https://pangeo57-debug.github.io/routiq/routiq.html
- Routing: HERE (traffic-aware) with a shared API key embedded in the client
  — a deliberate temporary trade-off, to be replaced by a backend proxy
- Known unfixed: Leaflet map instances leak on screen re-render;
  `computeAvailabilityFromExceptions` is lossy with multiple gaps per day;
  the demo-data button's confirm dialog says "Delete"
