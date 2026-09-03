# Phase 5 — Polish (V8 → V10)

The last phase of the original roadmap: performance, security, micro-
interactions, responsive layouts, testing, error handling. Rather than a
ground-up pass over the whole app (most of that was already solid — see
"What was already fine" below), this phase focused on real, specific gaps:
several introduced by Phases 2-4's own additions, plus the genuinely
missing pieces (an automated test suite chief among them).

## What changed

### Security
- **Fixed a real bug from Phase 4**: the CSP (`server.js`, via `helmet`)
  only allowed `scriptSrc: ["'self'", "'unsafe-inline'"]`, which silently
  blocks the Imagination viewer's `cdnjs.cloudflare.com` /
  `cdn.jsdelivr.net` `<script>` tags — Three.js and OrbitControls would
  fail to load in the browser with no obvious error beyond the console.
  Added both domains to `scriptSrc`.
- **`/api/tasks`, `/api/knowledge`, `/api/imagination`** were sitting on
  the generic 120/min `apiLimiter` meant for cheap reads, despite each
  making a real LLM or embedding call per request — the same cost profile
  as `/api/chat`. Moved to a new 20/min `heavyLimiter` shared with that
  tier.
- **`TRUST_PROXY`** (new, `.env`, defaults `false`) — only trusts
  `X-Forwarded-For` for rate-limit IP keying when explicitly turned on.
  Trusting it unconditionally with nothing actually in front of the server
  would let a client spoof its own IP and dodge rate limits entirely.

### Performance
- **Fixed a real bug from Phase 4**: the Imagination viewer's
  `requestAnimationFrame` render loop never stopped once started — closing
  the overlay left it rendering an invisible scene indefinitely. Now
  pauses on close (`imaginationVisible` flag checked each frame), resumes
  on reopen.
- **Fixed a real leak from Phase 4**: `imaginationEngine.js`'s per-user
  "current scene" map had no eviction — grew by one entry per distinct
  user for the life of the process. Now swept on a 30-minute TTL, matching
  the pattern `taskEngine.js`'s own runs map already used.

### Responsive layouts
The existing 980px tablet breakpoint (columns stack, sidebar goes
horizontal) was already solid — this added what was missing around it:
- A ≤480px phone breakpoint tightening the app's outer padding/gaps (20px
  was eating a disproportionate share of a 375-414px viewport).
- A dedicated ≤600px layout for the Imagination overlay: toolbar stacks
  (input on its own row, buttons below), the status line hides (no room
  for title + status + close all at once), buttons go full-width for
  touch targets.

### Micro-interactions
- Escape now closes the Imagination overlay (previously click-only).

### Testing
`tests/` (new) + `npm test`, using Node's built-in test runner — no new
dependency, which mattered given this sandbox's npm registry access issue
that's been a standing caveat since Phase 1. Covers:
- `imaginationEngine.sanitizeScene()` — default-filling, invalid-type
  rejection, coordinate/scale clamping, the 24-object cap, malformed-color
  fallback — the one function standing between arbitrary LLM/client input
  and the renderer.
- `longTermMemory`'s `cosineSimilarity`/`keywordScore`/`recencyWeight` — the
  scoring math behind semantic search, including edge cases (zero vectors,
  mismatched lengths, orthogonal/opposite vectors).
- `taskEngine.isRecoverable()` — the classification deciding whether a
  failed step gets an LLM correction attempt or is treated as terminal.
- The zod schemas gating every Phase 2-4 write endpoint.

These are unit tests only — no disk I/O, no live LLM/embedding calls, no
network. Fast, free to run, and don't need any API key configured. Route
handlers and anything requiring a live browser/LLM/desktop aren't covered;
noted as a next step in the README rather than silently left out.

`cosineSimilarity`, `keywordScore`, `recencyWeight` (from
`longTermMemory.js`) and `isRecoverable` (from `taskEngine.js`) are now
exported alongside each module's real public API, purely so these tests
can reach them directly — noted in-code as not a stable API for other
modules to depend on.

### Docs
- New "Testing" section in `README.md`.
- Fixed a stale README bullet claiming auth still needed adding — it's
  been required (Supabase-backed sessions) since the "v3 upgrade" section
  further down the same file.

## What was already fine (audited, not touched)
- Central error handler (`server.js`) already returns generic 500s for
  unexpected errors and never leaks internals; `err.status`-carrying errors
  keep their real message.
- `middleware/validate.js` already returns clean, non-leaky validation
  error shapes.
- `helmet`, CORS allowlist, JSON body-size limits, rate limiting on the
  cheap-endpoint tier, `unhandledRejection`/`uncaughtException` handlers,
  and graceful shutdown were all already in place from earlier work — this
  phase extended them to cover Phase 2-4's additions, not rebuilt them.
- The audit log (`utils/audit.js`) was already bounded (300 entries, FIFO).

## What this does NOT include
- Plugin/extension system, background/scheduled tasks — still the Phase 3
  leftovers, untouched across this whole project.
- Route-level/integration tests, load testing, a CI pipeline.
- A from-scratch mobile redesign — the existing breakpoint structure was
  judged sound; this filled specific gaps rather than replacing it.

## Where this leaves the V8 → V10 project
All 5 phases of the original plan have now been addressed in some form.
Two deliberately scoped-out items remain open across the whole project:
plugins/extensions and background/scheduled tasks (both nominally under
Phase 3), and real image-generation as an optional second Imagination mode
alongside the interactive 3D scene graph (Phase 4). Both are clean,
additive follow-ups on what's here now, not rewrites.
