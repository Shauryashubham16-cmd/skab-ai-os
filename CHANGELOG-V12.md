# V12 — CSP hardening, Calculator, Proactive Insights agent

Three real, working additions on top of jarvis-v11-calendar-vector-memory,
picked from the README's own "still genuinely open" list plus one new
capability. Nothing here is a stub — everything is wired end-to-end and
covered by tests where the logic is pure enough to test without a live LLM
key.

## 1. CSP hardening (closes a README-flagged gap)
- Converted the last 13 inline `style=""` attributes in `public/index.html`
  into real CSS utility classes (`public/styles/main.css`).
- Confirmed no frontend JS uses `cssText` or `setAttribute('style', ...)` —
  only direct `.style.prop =` assignment, which CSP doesn't restrict.
- Removed `'unsafe-inline'` from both `scriptSrc` and `styleSrc` in the
  Content-Security-Policy (`server.js`). The frontend split from an earlier
  phase had already removed every inline `<script>`/`onclick=""`; this was
  the last piece.

## 2. Calculator panel (closes the other README-flagged gap)
- `utils/calculator.js` — a real hand-written recursive-descent expression
  parser/evaluator (tokenize → AST → evaluate). No `eval`, no `Function`
  constructor, no new dependency. Supports `+ - * / % ^`, parentheses,
  constants (`pi`, `e`), and functions (`sqrt abs floor ceil round sin cos
  tan asin acos atan ln log10 log2 log(x,base?) exp min max pow`).
- `routes/calc.js` — `POST /api/calc/evaluate`, `GET /api/calc/history`,
  `DELETE /api/calc/history`, `GET /api/calc/reference`.
- Registered as a `calc.evaluate` tool in `utils/toolRegistry.js`, so the
  autonomous agent/planner can also do arithmetic without hallucinating it.
- Frontend: new `Calculator` nav item, a dashboard card matching the
  Calendar card's styling, live debounced evaluation, and a clickable
  recent-calculations history (`public/components/Core/calculator.js`).
- Tests: `tests/calculator.test.js` (precedence, associativity, div/mod by
  zero, unknown identifiers, and an explicit check that arbitrary JS like
  `require("fs")` or `process.exit()` is rejected, not executed).

## 3. Proactive Insights agent (new capability)
- `utils/proactiveAgent.js` — an opt-in background timer
  (`ENABLE_PROACTIVE_AGENT=true`, default interval 15 min, floor 5 min) that
  gathers a small snapshot (upcoming calendar items, the active window, a
  few learned preferences) and asks the LLM one narrow question: is there
  something worth proactively telling the user right now? A strict-JSON
  contract (`{"shouldNotify": bool, "message": string}`) plus a 20-minute
  cooldown and dedupe keeps it from turning into unsolicited chatter.
- Reuses existing infrastructure end-to-end: `calendarStore`,
  `contextAwareness`, `longTermMemory`, `chatCompletion`, and the same
  `eventBus` → `agentSocket` → `/agent` socket pipeline calendar reminders
  already use.
- `GET /api/agent/insights/status` — enabled/interval/last-run/last-error.
- Frontend: `agent:insight` toast, same visual idiom as the existing
  calendar-reminder toast (`public/components/Core/calculator.js`).
- Off by default and documented in `.env.example` — this is the one addition
  that costs real API usage on a timer regardless of whether you're using
  the app, so (same convention as terminal/input/browser/plugins in this
  codebase) it needs an explicit opt-in, not just a sensible default.
- Tests: `tests/proactiveAgent.test.js` covers the strict-JSON decision
  parser — clean JSON, a ` ```json ` fence, stray prose around the object,
  garbage input, a truthy-but-not-`true` value failing closed, and message
  truncation. (`tick()`/`start()` touch a live LLM + scheduler, so — same
  convention as `computeRemindAt` vs `calendarStore`'s file I/O — those stay
  integration-only, not unit-tested here.)

## Verified
`node --test tests/*.test.js` → 56/56 passing (43 pre-existing + 13 new).
All touched/new files pass `node --check`.

## Still genuinely open
- Real image-generation as an Imagination second mode (env-var wiring exists
  in `.env.example`, but no route/UI calls it yet)
- A file-manager panel (Calculator is now done; file-manager is the other
  half of the original README item)
- Everything the v11 README already listed as open beyond those two
