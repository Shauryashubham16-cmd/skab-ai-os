# Phase 1 — Visual Engine Upgrade (V8 → V10)

Drop-in replacement for `public/index.html`. No backend, dependency, or route
changes — this is purely the front-end HUD, so it's safe to swap in without
touching `server.js`, `routes/`, or `utils/`.

## What changed

### 1. Real AI state system (was 6 states → now 10 + error)
`idle → listening → understanding → planning → thinking → executing →
observing → verifying → speaking → complete`

- `PIPELINE_STATES` + `CORE_STATE_META` + `STATE_COLOR` extended to the full
  pipeline from your plan.
- New **AI Core States** panel (top of the right column) renders the pipeline
  as a live stepper — done/active/error styling driven by the same
  `setReactorState()` call everything else already used, so it can't drift
  out of sync with the reactor or the "Reasoning Core" bar.
- Added `stepReactorStates()`, a small sequencer that walks multiple states
  with short delays. Used in `sendChat()` so a single `/api/chat` round trip
  reads as understanding → planning → thinking → (executing → observing →
  verifying, only if the backend actually routed to a tool agent — checked
  via the real `data.agent` field, not invented) → speaking → complete.
- The Vision "Capture & Analyze Screen" flow now uses `observing` →
  `verifying` → `complete` instead of a generic `executing`, so it's an
  honest reflection of what that call is actually doing.

### 2. Extreme visual engine
- **New rings**: a fine data-tick ring (`.ring-tick`) added between the
  segmented ring and the orbit-dot ring for extra parallax depth, plus two
  **comet-style energy streams** (`.ring-comets`) — GPU-cheap conic-gradient
  masks, not canvas — that race around the outer band and speed up during
  executing/thinking/error states.
- **Holographic glass panels**: every `.card` now has a subtle scanline
  texture and a diagonal light-sheen that sweeps across on hover
  (`.card::before` / `.card::after`), giving the glass-panel read from your
  reference image without a rewrite of the card system.
- **Micro-interactions**: click-ripple on the mic button (`spawnClickRipple`),
  small lift/press transform on hover/active.
- All new animated layers use `transform`/`opacity` + `will-change` only —
  no layout-triggering properties — so they stay GPU-composited at 60fps
  alongside the existing particle canvas and reactor.

## What this does NOT include yet (later phases)
- Backend Plan→Execute→Observe→Verify→Correct→Retry loop (Phase 2) — the
  states above are wired to real signals available today (`data.agent`,
  actual fetch timing), but there's no retry/correction logic server-side
  yet.
- Semantic/vector memory, 3D imagination engine, wake-word voice, real
  desktop/browser automation upgrades — all separate, larger phases.

## How to apply
```bash
cp index.html /path/to/jarvis_v8/public/index.html
npm start
```
No new env vars, no new npm packages.

## Next
Say the word and I'll do the same kind of pass on **Phase 2 (agent brain)** —
a real `Plan → Execute → Observe → Verify → Correct → Retry` loop in
`utils/taskEngine.js` / `utils/agents.js`, wired to emit the same state names
this UI now understands, so the reactor and the stepper start reflecting
actual backend execution instead of a client-side sequencer.
