# V16 — Consistent error handling, LLM resilience, task-cancellation fix, reduced coupling

## What this is
A maintainability/reliability pass targeting seven specific pain points
called out for this codebase: rising complexity, agent/tool/task coupling,
inconsistent error handling, non-standard API responses, weak task
recovery/cancellation, fragile LLM provider failure handling, and
dead/duplicate code. Nothing about existing route paths, request/response
field names, or tool behavior changed for a caller relying on today's
contract — every change here is either purely internal (dedup, module
split) or additive (new optional fields, new resilience behavior on top of
existing fallback logic).

## 1. Consistent error handling — `utils/apiError.js`
Every one of the 12 route files with async handlers previously repeated
the same three-line block by hand:
```js
async (req, res, next) => {
  try { ... } catch (err) { next(err); }
}
```
~65 occurrences of this across `routes/*.js`, each a candidate to drift
slightly (a couple already had) or simply be forgotten on a new route.

`utils/apiError.js` now provides:
- `asyncHandler(fn)` — wraps a handler so any thrown/rejected error reaches
  `next()` automatically. Every route file now reads as just its actual
  behavior, no boilerplate.
- `ApiError` — a status-carrying error class (`ApiError.badRequest(...)`,
  `.forbidden(...)`, `.notFound(...)`, `.conflict(...)`, or the constructor
  directly for any status) with optional `code`/`details`.

`server.js`'s central error handler now reads `.status`/`.code`/`.details`
off any thrown error. The wire shape for existing callers is **unchanged**
— `{ error: string }` — `code`/`details` are additive fields only present
when a handler opts in, so nothing on the frontend (`public/state/*`,
`public/components/**`, all of which read `data.error` as a plain string)
needed to change.

All 12 route files (`agent`, `browser`, `calendar`, `chat`, `imagination`,
`input`, `knowledge`, `memory`, `sessions`, `system`, `tasks`, `vision`)
converted. Verified with a full `npm test` pass plus a live server boot
smoke test after conversion.

## 2. LLM provider failure handling — `utils/llmProviders.js`
Previously, a provider failing meant one immediate attempt, then straight
to the next provider in the fallback chain — no distinction between "this
provider is having a transient blip" and "this provider is fundamentally
broken right now" (bad key, outage). A fully-down provider still cost a
full network round trip on every single request that tried it.

Two additions, both in-memory/per-process, no new dependency:
- **Retry-once-if-transient.** A failure is classified retryable unless
  its status is 400/401/403/404 (bad request / bad key / forbidden /
  not-found — retrying these fails identically). Retryable failures get
  exactly one retry with a short jittered backoff before moving to the
  next provider.
- **Per-provider circuit breaker.** After 3 consecutive failures, a
  provider is skipped entirely (no network call at all) for 30 seconds.
  A single success immediately closes the circuit. Applied to chat,
  streaming chat, vision, and embedding calls alike.

`circuitStatus()` is exported and now surfaced in
`GET /api/system/health/providers` (`utils/providerHealth.js`) alongside
each provider's existing configured/reachable report, so "configured but
currently circuit-open due to recent failures" is visible without waiting
on the next health ping.

## 3. Reduced agent/tool/task coupling — `utils/taskPlanner.js`
`utils/taskEngine.js` (previously 552 lines) owned two different concerns:
orchestration (the runs map, persistence, cancellation, retry/correction
control flow, the `/agent` socket) and the LLM-facing planning contract
(prompt text for planning/correction/verification, JSON parsing, which
provider order to prefer). Neither needs to change when the other does,
and testing the parsing contract in isolation meant either mocking the
entire engine or not testing it at all.

Planning/correction/verification (`proposePlan`, `correctStep`,
`verifyGoal`, plus the tool-catalog and active-window prompt text) moved
into a new `utils/taskPlanner.js`. `taskEngine.js` now depends on it as
three functions and a step-count constant — not five inlined prompt
strings. `taskEngine.js`'s own `verifyGoal` is now a thin wrapper that adds
the `'verifying'` socket-state emission (a run-lifecycle concern) around
`taskPlanner.verifyGoal` (an LLM-parsing concern).

## 4. Task recovery/cancellation strengthened — `utils/taskEngine.js`
Found and fixed a real bug in the course of writing tests for this: a run
was only registered in the in-memory `runs` map (and taskStore) **after**
`proposePlan()` resolved — except when started via `runInBackground`,
which pre-persists a `'queued'` record itself. Any *foreground*
`autonomousRun()` call (e.g. a blocking `POST /api/tasks/auto` with
`execute:true`) had no run record to cancel until planning finished, so
`cancelRun()` on it 404'd for the entire duration of the planning LLM
call — often the single slowest part of a run.

Fixed by registering a `'planning'`-status run record before `proposePlan`
is even called, for every caller. `'planning'` was also added to
`taskStore.js`'s `IN_FLIGHT_STATUSES` set (crash-recovery sweep).

Two additional races closed on top of that:
- A cancel requested while `proposePlan`'s LLM call is in flight is now
  observed the moment it resolves, instead of only at the first step of
  execution.
- A cancel requested after the last step finishes but before
  `verifyGoal` starts is now honored — the run is reported `'cancelled'`
  instead of spending an LLM call on verification and reporting
  `'completed'`.

A `finally` block now unconditionally clears any stray `cancelledRuns`
entry for a run, closing a (minor, unbounded-over-process-lifetime)
memory leak that existed if planning threw before either checkpoint above
observed the flag.

## 5. Dead/duplicate code
The ~65 duplicated `try/catch{next(err)}` blocks (see §1) were the main
target here — removed via a reviewed, syntax- and test-verified codemod
across all 12 route files. Confirmed no unused imports were left behind in
`taskEngine.js` after the `taskPlanner.js` extraction, and swept for
TODO/FIXME markers and unreferenced modules (none found beyond the
intentional `schemas/index.js` re-export entry point).

## 6. Test coverage
28 new tests, all passing alongside the existing 136 (171/171 total):
- `tests/apiError.test.js` — `asyncHandler`/`ApiError` contract (sync and
  async throws, status/code propagation).
- `tests/llmProviderResilience.test.js` — retry-once-if-transient,
  non-retryable-skips-retry, circuit-opens-after-threshold,
  circuit-closes-on-success (OpenAI SDK client mocked, no real network).
- `tests/taskPlanner.test.js` — plan parsing/step-capping/malformed-entry
  handling, correction parsing, verification parsing, and the
  never-throws-on-bad-LLM-output contract for all three.
- `tests/taskEngineCancellation.test.js` — the two cancellation races in
  §4, including the foreground-run registration bug this pass found and
  fixed.
- `tests/taskStore.test.js` — persistence round-trip, `deleteRun`/
  `loadAllRuns`, `IN_FLIGHT_STATUSES` (including the new `'planning'`
  entry), `recoverInterruptedRuns`, and `pruneOlderThan`. This module's
  own header comment claimed this test file already existed — it didn't;
  this closes that gap (filesystem is mocked, so the suite never touches
  the real `data/task-runs.json`).

## Follow-up cleanup pass
After the above, a second sweep specifically looking for leftover issues:
syntax-checked every server-side `.js` file, scanned for unused
`require()` destructures across `utils/`/`routes/`, checked for stray
secrets/credentials in the tree (none — `.env.example` is placeholders
only), and confirmed no lint config exists to run automatically. Found and
fixed one real leftover: an unused `beforeEach` import in
`tests/taskPlanner.test.js`. That scan is also what surfaced the
`taskStore.test.js` gap described above.

## 7. Scheduling granularity — `utils/scheduler.js`
Previously a fixed `setInterval(tick, TICK_MS)` polled every 15 seconds, so
any scheduled or recurring job could fire up to 15s after its nominal due
time regardless of how precisely it was scheduled. Replaced with a single
self-adjusting `setTimeout`, armed for exactly when the soonest due job is
due (clamped to `[0, TICK_MS]`), re-armed after every fire, and nudged
immediately (`maybeWakeSooner`) whenever a newly-created job is due sooner
than the currently-armed wake-up. `TICK_MS` (still 15s) is now only a
ceiling for the idle case — a bound on how long an idle scheduler waits
before checking again, not the granularity jobs actually fire at. Verified
with `node:test`'s MockTimers (`tests/scheduler.test.js`) that a job
scheduled ~500ms out fires within that window, not on a 15s poll boundary,
and that a sooner job added after a farther-out one still fires on its own
earlier schedule.

## 8. Task parallelism — `utils/taskEngine.js`
`PARALLEL_SAFE_TOOLS` (the allowlist of tools `runSequence` will batch and
run concurrently when adjacent in a plan) previously covered 7 tools.
Audited every tool in `utils/toolRegistry.js` against its own `execute()`
implementation (not just its `permission` tag) for hidden mutation, and
added 10 more genuinely side-effect-free tools that were missing:
`windows.active`, `files.searchContent`, `vision.screen`,
`vision.findElement`, `vision.snapshot`, `vision.compareToSnapshot`,
`browser.read`, `browser.tabs.list`, `browser.verify`,
`input.clipboardRead`. Each was individually checked, not just tagged
`permission:'read'` and assumed safe — e.g. confirmed `vision.snapshot`
only ever *adds* a fresh, independently-keyed entry to its snapshot store
(no collision risk between concurrent calls), and confirmed
`browser.read`/`browser.tabs.list`/`browser.verify` all read through
`browserAutomation`'s `activePage()` without ever touching its
`pages`/`activeIndex` state (checked `utils/browserAutomation.js`
directly).

**Deliberately not done: a full dependency-aware DAG executor.** This
system executes LLM-generated plans against real device/browser/filesystem
state — the cost of getting parallelism wrong (two steps that turn out to
have a real ordering dependency a dependency-inference heuristic
misjudged) is a genuine correctness/safety incident, not just a slow
response. A conservative, individually-reviewed allowlist that a human can
verify "every one of these is a pure read with no way to interfere with
its neighbors" is the right trade-off for a system with this blast radius,
even though it means some genuinely-independent `standard`/`dangerous`
steps stay sequential. If a full DAG executor (inferring step dependencies
from args/outputs rather than a hand-reviewed tool allowlist) is something
you actually want despite that risk profile, it's a substantial enough
architecture change — and safety trade-off — that it's worth discussing
scope before building rather than assuming it as a drop-in replacement.

New tests (`tests/taskEngineParallelism.test.js`, 7 tests) cover: every
allowlist entry is a real registered tool, none carry `permission:
'dangerous'`, the newly-added tools are present, known-mutating tools are
confirmed absent, and — using a mocked `toolRegistry.runTool` with a real
delay so concurrency is observable via timing, not just call order — that
adjacent safe steps genuinely run concurrently, that a batch correctly
stops at the first non-safe step, and that a lone safe step with no safe
neighbor isn't wastefully treated as a batch of one.

## Test coverage total
28 + 6 (`tests/scheduler.test.js`) + 7 (`tests/taskEngineParallelism.test.js`)
= 41 new tests. **184/184 passing**, verified from a completely fresh
unzip + `npm install` + `npm test`.

## Not done in this pass
Standardizing *success*-response shapes across routes was deliberately
left out — several existing shapes are load-bearing for specific frontend
call sites (`public/state/*`, `public/components/**`), and rewriting them
without a full frontend audit risked breaking working behavior for a
cosmetic consistency gain. The error-response path (the one that was
actually inconsistent) was standardized instead; success shapes are
untouched.
