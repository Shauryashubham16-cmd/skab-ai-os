# Phase 2 — Real Agent Loop (V8 → V10)

Backend-plus-frontend upgrade. Adds real files, edits a few existing ones —
not a drop-in like Phase 1. No breaking changes to existing routes/behavior.

## What changed

### 1. Real Plan → Execute → Observe → Verify → Correct → Retry loop
`utils/taskEngine.js` — the plan/execute/verify loop from V8 now has two
phases it didn't before:
- **Observe**: after every tool call, a distinct `observing` phase reads and
  summarizes what the tool actually returned, before anything decides what
  happens next.
- **Correct → Retry**: a step that fails with a *recoverable* error (not a
  disarmed capability, not an out-of-scope path, not a confirmation gate —
  those are terminal by design) triggers a small LLM call that proposes one
  corrected replacement step. Up to `MAX_CORRECTIONS_PER_STEP` (2) attempts
  per step before the run gives up and reports failure honestly.

### 2. Real-Time Event Bus
- `utils/eventBus.js` — a plain Node `EventEmitter`, so `taskEngine.js`
  doesn't need to know Socket.IO exists.
- `utils/agentSocket.js` — a new `/agent` Socket.IO namespace, auth-gated
  exactly like the existing `/terminal` one (valid JARVIS session token
  required at handshake). Fans eventBus events out to the right user's room.
- `server.js` — wires `attachAgentEvents(io)` alongside the existing
  `attachTerminal(io)`.

Every phase transition — `understanding → planning → thinking → executing →
observing → verifying → correcting → retrying → speaking → complete`, plus
`error` — is pushed live as `agent:state` events with the exact
`PIPELINE_STATES` names the Phase 1 reactor/stepper already render. A
`agent:log` event carries a one-line per-step trail (✓/✗/↻) for a HUD log.

### 3. Chat wiring — `/task <goal>`
`routes/chat.js` — an explicit, opt-in chat command:
```
/task open notepad and type "hello"
/agent ...   (alias)
/do ...      (alias)
```
Kept as an explicit prefix rather than free-text intent detection on
purpose: this can drive mouse/keyboard/browser automation, so it should
only ever run on an unambiguous ask, never a guess.

Confirmation flow was also fixed: previously, confirming a destructive step
that happened to be step 3 of 5 in a task run would execute *only* that one
step and silently strand the rest. Now `taskEngine.getPendingRunId(userId)`
lets the existing chat "confirm"/"cancel" flow detect that and resume the
whole run via `continueRun()` instead.

### 4. Frontend — real events replace the guess
`public/index.html`:
- Connects to `io('/agent')` (same auto-auth wrapper as everything else) and
  drives `setReactorState()` directly from `agent:state`/`agent:log`.
- `/task` is special-cased in `sendChat()`: it's still sent to `/api/chat`
  like a normal message (not intercepted as a local UI command the way
  `/clear`/`/weather`/etc. are), and the canned client-side
  understanding→planning→...→complete sequence is skipped entirely for it —
  the socket already played the real one live.
- Added to the `/` autocomplete menu.

## What this does NOT include yet (later phases)
- Semantic/vector memory, active-app/context-aware planning inputs beyond
  what `contextAwareness` already exposes, wake-word voice, the 3D
  imagination engine — Phases 3 and 4.

## How to apply
Backend files are additive/small edits — same `npm start`, no new env vars,
no new npm packages (Socket.IO was already a dependency for `/terminal`).

## Next
Phase 3 — semantic memory, active-app/context-aware planning, wake word.
