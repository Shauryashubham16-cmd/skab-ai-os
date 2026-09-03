# V14 — App-Launch Cinematic

## What this is
A ~1.6s cinematic animation over the reactor — pulse, expanding holographic
rings, a fast scan sweep, then a cyan glass card materializing with the
app's name — that plays whenever JARVIS actually launches a desktop app.
Built entirely additive on top of V13; nothing about the existing HUD,
reactor, or its states was changed or removed.

## Why it's tied to two real trigger points, not one
An app launch can currently happen two ways in this codebase:
1. A plain "open spotify" / "launch vscode" chat message — handled by
   `routes/chat.js`'s `tryOpenAppIntent`, bypassing the LLM entirely.
2. A `/task` run whose plan includes an `apps.open` step — handled by
   `utils/taskEngine.js`'s step runner, driven live over the `/agent`
   socket.

Both now surface the same real facts to the frontend (which app key, and
whether the launch actually succeeded) so the cinematic never fires on a
guess:
- `routes/chat.js` — `tryOpenAppIntent`'s reply payload gained two additive
  fields, `appKey` and `launched`.
- `utils/taskEngine.js` — the `agent:log` event for a step already reports
  `tool`; it now also echoes `args`, so the frontend can read `args.app` for
  an `apps.open` step.

Neither change alters any existing field, response shape, or behavior —
both are new keys older/other clients simply ignore.

## Frontend
- `public/index.html` — new `#appLaunchCinematic` overlay added inside the
  existing `#reactorWrap` (rings, scan-sweep, glass card). It's a plain flex
  child with no manual positioning, the same free-centering trick
  `.energy-pulse` already relies on.
- `public/styles/main.css` — new "APP LAUNCH CINEMATIC" section, additive.
  Every animated property is `transform`/`opacity`/`filter` only, so the
  whole sequence stays compositor-only (no layout/paint thrash) — same
  performance discipline as the existing ring/comet animations.
- `public/components/HUD/appLaunchCinematic.js` (new) — exposes
  `window.JARVIS.playAppLaunchCinematic(appKey, ok)`. Reuses the reactor's
  own existing `reactorBurst()` for the "reactor should pulse" part instead
  of inventing a second, competing pulse.
- `public/components/Core/chat.js` — one added call, gated on
  `data.provider === 'app-launcher'`.
- `public/components/Terminal/terminal.js` — one added call inside the
  existing `agent:log` handler, gated on `payload.tool === 'apps.open'`.

## Testing
`node --check` clean on every touched/new JS file. CSS brace-balance check
clean on `main.css`. `index.html` parses cleanly. Could not run the full
`node --test` suite in this environment (this sandbox has no installed
`node_modules` and no reachable npm registry) — nothing touched here adds
or changes a dependency, and no existing test asserts on the `agent:log`
payload shape, so this is an environment limitation, not a regression risk
from this change. Recommend running `node --test tests/*.test.js` once
back in the real dev environment to confirm the 56/56 baseline still holds.

---

# V14.1 — Real process verification (launch → verify → report)

## The gap this closes
V14's cinematic played immediately off `appLauncher.js`'s honest-but-shallow
`launch-requested` state — a successful `spawn()` only proves the OS
*accepted* the request, not that the app is actually running. The card and
reply both said "Launching…" and stopped there.

## What changed
New `utils/launchVerifier.js`: after a successful spawn, polls the live
process list (via `systeminformation`, already a dependency — see
`utils/systemControl.js`'s `listProcesses`) for a process name matching the
launched app, resolving the instant it finds one (usually well under a
second) or reporting `verified:false` after a bounded 6s timeout. It only
ever confirms what it actually observes — a timeout is reported honestly as
"couldn't confirm," never silently upgraded to success. Cross-platform by
construction (darwin/win32/linux), unlike `windowManager.js`'s
Windows-only window enumeration, which is why process listing was used as
the verification signal instead.

Wired into both places an app gets launched:
- `routes/chat.js`'s `tryOpenAppIntent` — now awaits `verifyLaunch()` before
  replying, so "Spotify is open." is only ever said once a matching process
  was actually found. Unconfirmed launches get an equally honest "requested
  but couldn't confirm it's running yet." Additive response fields:
  `verified`, `pid`.
- `utils/toolRegistry.js`'s `apps.open` tool (used by `/task` runs) — same
  verification, returned as `verified`/`state: 'online'|'unconfirmed'`
  alongside the existing launch result. `utils/taskEngine.js`'s `agent:log`
  event now echoes `verified` too.

Frontend (`appLaunchCinematic.js`, `chat.js`, `terminal.js`, `main.css`):
the cinematic card now shows one of three real, distinct outcomes instead
of always "Launching…":
- **Online** (cyan, existing style) — process confirmed running
- **Not confirmed** (new amber `.warn` variant, reusing the design system's
  existing `--warning` token) — spawn succeeded, process not found in time
- **Launch failed** (existing red `.fail` variant) — spawn itself failed

## Testing
`verifyLaunch()` checked in isolation against a mocked `systeminformation`:
confirms a match as soon as it appears (not the full timeout) and correctly
returns `verified:false` after timing out against a process list with no
match — never a false positive. Same `node --check` / brace-balance /
HTML-parse sweep as V14, all clean. Full `node --test` suite still
unrunnable in this sandbox for the same pre-existing environment reason
(no `node_modules`, no reachable registry) — recommend running it in the
real dev environment before merging.

---

# V14.2 — Epic pass

## What changed
Purely a visual/polish upgrade to the V14.1 cinematic — no new backend
logic, no new trigger points. The three honest outcomes (Online / Not
confirmed / Launch failed) are unchanged; they just read more dramatically
now, and the whole thing got a robustness pass.

**New layers**, all added to the existing `#appLaunchCinematic` overlay,
all `transform`/`opacity`/`filter`-only so the sequence stays
compositor-only despite the extra elements:
- Instant radial flash + a fast, thick "shockwave" ring, distinct from the
  three softer rings — lands right as `reactorBurst()` fires, so the
  reactor's own pulse and the cinematic's first hit read as one impact.
- A snapping crosshair reticle (two thin lines) that locks onto center
  before the card resolves — a targeting-HUD beat.
- Eight radiating spark particles (pure CSS `rotate()`+`translateY()`, no
  trig functions needed, so no browser-support risk).
- A holographic scan-line sweep across the card face, isolated in its own
  `overflow:hidden` child layer so it can't clip the card's own outer glow
  (a plain `overflow:hidden` on the card itself would clip that too).
- A small monospace detail line under the status (`PID 4242` when
  verified, `May still be starting` when unconfirmed, `See terminal log`
  on failure) — reuses the real `pid` `verifyLaunch()` already returns,
  now threaded through both trigger paths and the `agent:log` socket event.
- Failure gets its own short stutter/glitch keyframe on the card instead of
  the confident settle the other two states get.

**Refactor**: state color is now two CSS custom properties
(`--alc-c`/`--alc-c-soft`) set once per state at the container level
(default cyan; `.warn`/`.fail` override both), instead of every element
repeating its own color per state. Every layer — rings, shockwave, reticle,
scan, sparks, card — reads from those two variables.

**Robustness**:
- `prefers-reduced-motion: reduce` support — drops every decorative layer
  to a single ~0.6s opacity crossfade, keeping the same real
  icon/name/status/detail text. Nothing about the actual launch
  verification changes; only the motion does.
- The overlay is `aria-hidden="true"` — it's decorative, the chat reply
  text is the real, accessible status.
- Confirmed no duplicate DOM ids and that the 8 spark elements all render
  with distinct `--a` angles.

Total sequence length stayed within the original "1–2 seconds" ask
(~1.75s reduced-motion-off, ~0.6s reduced-motion-on).

## Testing
Same `node --check` / CSS brace-balance / HTML-parse sweep as V14/V14.1,
all clean after these changes. No dependency, schema, or trigger-path
changes, so the V14.1 `verifyLaunch()` isolation test still applies
unchanged. `node --test` still unrunnable in this sandbox for the same
pre-existing reason (no `node_modules`, no reachable registry).

---

# V14.1 — Real process verification (launch → detect → verify → report)

## The gap this closes
V14 played the cinematic on `'launch-requested'` — the OS accepted the
spawn call, nothing more. `utils/appLauncher.js` was already explicit that
this doesn't mean the app is actually running. This pass closes that gap:
the pipeline is now genuinely `launch -> detect process -> verify -> report`,
and every "is it open" claim anywhere (chat reply text, `/task` log line,
and the cinematic card) is grounded in that real detection.

## New: `utils/launchVerifier.js`
`verifyLaunch(key)` polls the live process list (`systeminformation`'s
`si.processes()` — already a dependency via `utils/systemControl.js`, no
new package added) for a process name matching the launched app, up to a
bounded timeout (default 6s, 400ms interval). Resolves the moment it finds
a match — most real launches confirm in well under a second — or times out
with `verified:false`. A failed process-list read is treated as just
another empty poll, never a crash. Cross-platform (darwin/win32/linux) via
`systeminformation`, unlike `utils/windowManager.js`'s window detection
which is Windows-only, so this didn't need a per-OS fallback branch.

Process-name matching uses a small `PROCESS_HINTS` map per app key (e.g.
`spotify` → `Spotify.exe` / `Spotify` / `spotify` depending on platform),
since the string that *launches* an app is often not the string the OS
*reports* as its running process name. Anything not listed falls back to
matching the app key itself — good enough for most single-word apps, and
simply times out (never falsely confirms) for anything it can't match.

## Both launch paths now report the real outcome
- **Plain chat** ("open spotify") — `routes/chat.js`'s `tryOpenAppIntent`
  now awaits `verifyLaunch()` before replying. Three honest outcomes, not
  two: `"Couldn't open X: …"` (spawn itself failed), `"X is open."` (process
  confirmed), or `"Launch requested for X — couldn't confirm it's running
  yet; it may still be starting."` (spawn succeeded, verification timed
  out). The reply text is always this real, computed string.
- **`/task` runs** — `utils/toolRegistry.js`'s `apps.open` tool now calls
  `launch()` then awaits `verifyLaunch()` in the same step, returning
  `state: 'online' | 'unconfirmed'` alongside the existing fields.
  `utils/taskEngine.js` echoes the new `verified` flag on the `agent:log`
  socket event (additive field, alongside the `args` it already echoes) so
  the frontend gets the same real signal live during a task run.

## Frontend: the cinematic now shows the real state, not a guess
- `playAppLaunchCinematic(appKey, launched, verified)` — new third
  parameter. Card status text is now one of **Online** / **Not confirmed** /
  **Launch failed**, each with its own tone: existing cyan-success styling
  for confirmed, the existing red `.fail` styling for a failed spawn, and a
  new amber `.warn` tone (reusing the same `rgba(255,190,90,…)` amber the
  reactor's own `executing`/`observing` states already use — see
  `main.css`) for "requested but unconfirmed." Amber rather than red here on
  purpose: an unconfirmed launch isn't a failure, just an honest "couldn't
  verify in time."
- `chat.js` — the generic guessed executing/observing/verifying replay is
  skipped for app-launcher turns (the real verification already happened
  server-side before the response even arrived, so replaying a second fake
  "Verifying…" beat on top of an already-final result would be theater).
  Instead there's one short, specifically-labeled `verifying` beat
  ("Confirming spotify…") right before the cinematic reveals the real
  outcome.
- `terminal.js` — the `/task` path's `agent:log` handler now passes the real
  `verified` flag through to the same cinematic, so a task-driven launch
  looks and feels identical to a chat-driven one.

## Testing
`node --check` clean on every touched/new JS file (`routes/chat.js`,
`utils/taskEngine.js`, `utils/toolRegistry.js`, new `utils/launchVerifier.js`,
`public/components/HUD/appLaunchCinematic.js`,
`public/components/Core/chat.js`, `public/components/Terminal/terminal.js`).
CSS brace-balance clean on `main.css` (579/579). No new dependency —
`systeminformation` was already in `package.json`. Same sandbox limitation
as V14: no `node_modules` installed here, so `node --test` couldn't be run
directly — recommend it in the real dev environment before shipping.

---

# V14.4 — Calculator ans/variables, memory truncation fix, real test verification

## Scope
Follow-up to the "make everything 10/10" ask: rather than touch all 13
scorecard categories shallowly, this pass picks two concrete, evidence-based
gaps identified earlier (Calculator's stateless-only evaluation; Vector
Memory's silent truncation on long content) and fixes both for real, plus
gets the actual test suite running in this sandbox to verify all of it —
not just `node --check`.

## Calculator: `ans` + named variables
`utils/calculator.js`'s grammar gained `stmt := IDENT '=' expr | expr`.
`evaluate()` now takes a `scope` object (variable name -> number) that
identifiers resolve against before falling back to `CONSTANTS` — the
evaluator itself stays a pure function; `routes/calc.js` owns the actual
per-user scope state (a new `scopes` Map, same lifetime/tradeoff as its
existing `history` Map), auto-injecting `ans` as the previous result and
storing any `assignedName` from an assignment expression. Built-in
constant/function names (`pi`, `sin`, etc.) and `ans` itself cannot be
reassigned. New `GET/DELETE /api/calc/vars` endpoints; frontend
(`components/Core/calculator.js`) shows clickable variable chips and labels
an assignment result as `x = 8` instead of `= 8`.

## Vector Memory: closed the silent-truncation gap
`utils/longTermMemory.js` and `utils/longTermMemoryPgvector.js` both gained
a `MAX_CONTENT_LENGTH` (2000, matching the REST route's existing Zod cap)
enforced directly in `add()` — this is the fix that actually matters,
because the `memory.remember` tool (`utils/toolRegistry.js`, reachable from
any `/task` run) calls `add()` directly and was never covered by that Zod
schema. Before this, an over-long note reaching that path would silently
truncate at `embedText`'s 8000-char input cap with no error anywhere — only
the first ~8000 characters would ever be searchable. Now it's a clear,
immediate rejection. `embedText` itself also gained a `console.warn` on any
truncation, as a backstop for future callers that don't have their own cap.

## Architecture: corrected a misleading comment
`longTermMemory.js`'s header claimed the app's auth/session layer had grown
multi-account support that justified its user-scoping. It hadn't (confirmed
by reading `routes/auth.js`/`utils/passcodeAuth.js` — one shared passcode,
one `LOCAL_USER_ID`, no signup flow). Per this session's direction, the app
is intentionally single-user; the comment now says so, and explains the
user-scoping is kept anyway as free defense-in-depth, not because a
multi-account feature exists.

## Testing — this is the significant part
Got the real `node --test` suite actually running in this sandbox, not just
syntax-checked:
- Installed `zod` and `jsonwebtoken` for real from the npm registry (both
  pure-JS, no native/network runtime dependency).
- Installed `axios`, `cors`, `express`, `express-rate-limit`, `helmet`,
  `socket.io`, `dotenv`, `pngjs`, `jsdom` for real too, to smoke-test
  `server.js` itself booting.
- Stubbed only `openai`, `systeminformation`, and `@supabase/supabase-js`
  (interface-only fakes) plus `playwright-core`/`tesseract.js`/
  `screenshot-desktop` (throw-on-call stubs) — packages that need a live
  external API key, OS process table, database, browser, or OCR/screenshot
  binary regardless of test environment.
- Result: **63/63 tests passing**, confirmed clean across 5 repeated runs
  (no flakiness).
- Found and fixed one genuinely flaky pre-existing test in the process:
  `tests/longTermMemory.test.js`'s `recencyWeight` "right now" case asserted
  strict equality to `1`, which fails under real elapsed milliseconds
  between building the timestamp and scoring it. Changed to a tolerance
  check — not a new gap, a real bug this pass happened to surface.
- Booted `server.js` itself for real (`JARVIS is online at
  http://localhost:...`) and hit real HTTP endpoints end-to-end: unlocked a
  session, ran `x = 5+3` -> `x * x` -> `ans + 1` through `/api/calc/evaluate`
  and got the correct chained results back, confirmed `pi = 5` is rejected,
  confirmed the pre-existing `/api/knowledge` REST cap still works, and
  confirmed the actual gap this pass fixes — `memory.remember` called
  directly via `runTool()`, bypassing the REST layer entirely — now
  correctly rejects 2001 characters of content instead of silently
  truncating it.

This is meaningfully more verification than any earlier changelog entry in
this file could honestly claim.
