# V13 — JARVIS Cinematic Boot System

## What this is
A real cinematic boot sequence (black screen → core power-up → holographic
rings → live system diagnostics → scan → J.A.R.V.I.S. activation → HUD),
built entirely on top of V12 without touching any existing feature's
behavior, and driven by real backend status — not a scripted animation.

## The key architectural decision
The real HUD reactor (`#reactorWrap`) was already in the DOM and already
animating on page load — its ring-spin CSS keyframes are unconditional, not
gated behind any "booted" state. So instead of building a second, fake
reactor for the boot screen, the boot overlay is a dark veil with a growing
circular hole (`.boot-veil-hole`, a box-shadow iris-reveal — GPU-cheap,
no custom-property gradient interpolation hacks) that progressively exposes
the real, unmodified HUD underneath. "Smooth transition into the current
HUD" is therefore literal: there is only ever one HUD, and boot reveals it.
Nothing about the existing HUD, its layout, or its components changed.

## Backend: `GET /api/boot-status`
New, public (same reasoning as the existing `/health` — booleans and
enable-flags only, no user data), and deliberately synchronous/cheap so the
boot screen never hangs. Aggregates real state for exactly the 9 systems
asked for, reusing existing modules rather than re-implementing checks:
- `core` — this endpoint responding at all
- `memory` — `local` vs `supabase`, from the existing `supabaseStatus`
- `vision` — `hasVisionProvider()`; OCR is always available (bundled,
  no key needed) so vision degrades rather than going fully offline
- `browser` / `automation` — `automationGuard.status()`
- `plugins` — `ENABLE_PLUGINS` + `pluginLoader.loadErrors()`
- `scheduler` — always online (it starts unconditionally at server boot)
- `security` — `active`/`degraded` based on whether `JARVIS_PASSCODE` was
  ever changed from the `'Namo'` default — a real, honest signal, not a
  decorative one
- `aiAgent` — `ready`/`offline` based on `listProviders().order.length`

If a check fails or a subsystem is disabled, it is reported as
`degraded`/`offline` — never silently shown as `online`. Verified directly
(see Testing below).

## Frontend
- `public/index.html` — replaced the old placeholder boot markup
  (`.boot-core` mini-SVG + plain text log) with the veil/hole + stage label
  + diagnostics grid + J.A.R.V.I.S. title card structure. `#authScreen` and
  everything else below it is untouched.
- `public/styles/main.css` — all new boot-sequence and settings-panel CSS is
  additive; the `.imagination-overlay` rules were extended (not duplicated)
  to also apply to the new `.settings-overlay`, since it's the same generic
  panel chrome.
- `public/components/Core/bootScreen.css` — trimmed to just `#authScreen`
  and the auth-card/history rules it already had; the boot visuals moved
  into `main.css` so they load before it and can share the HUD's CSS custom
  properties.
- `public/state/jarvisState.js` — `runBoot()` rewritten into
  `playCinematicSequence()` (the 7-stage flow) and `playPlainSequence()`
  (Cinematic Boot OFF). The security-critical parts — token storage, the
  `fetch`/`socket.io` auth-gating wrappers, `markSignedIn`/`showAuth` — are
  byte-for-byte the same logic as before, just called from the new
  choreography instead of the old text-log loop. `JARVIS.replayBoot()` is
  newly exposed for Settings' "Replay" button — it skips the identity
  re-check, since it's only reachable from an already-signed-in session.
- `public/components/Core/settingsPanel.js` (new) — fills in the "Settings"
  nav item, which existed in `services/nav.js` but had no panel behind it
  before this. Cinematic Boot and Fast Boot toggles, persisted to
  `localStorage` under `jarvis_boot_settings`.
- `public/services/nav.js` — one added line wiring the Settings nav click.

## Settings
- **Cinematic Boot** (default ON) — off gives a plain, near-instant
  sign-in screen with the same real checks, none of the choreography.
- **Fast Boot** (default OFF) — keeps the cinematic sequence but quarters
  every stage's timing (~10s → ~2s). Verified this is a real effect, not
  cosmetic (see Testing).
- **Replay** — re-runs the cinematic sequence live against the real
  backend, from inside the HUD, for previewing without restarting the app.

## Testing
`node --test tests/*.test.js` → 56/56 passing (unchanged from V12; nothing
regressed). One pre-existing, unrelated flaky test
(`recencyWeight: a fact from right now scores at the maximum, 1` in
`tests/longTermMemory.test.js`) — reproduced on a clean V12 checkout too, a
timing-sensitive floating point comparison unrelated to this work.

Also started the real server and curled every new/changed static asset and
both status endpoints directly — `200` on all of them, `/api/boot-status`
and `/health` both returned real, correctly-shaped JSON.

Then wrote `scripts/manual-boot-check.js` — a headless integration test
(needs `jsdom`, installed with `npm install --no-save jsdom` to run it, not
added to `package.json` since it's a one-off manual check, not part of the
shipped suite) that loads the REAL `jarvisState.js` against DOM extracted
directly from `index.html` (can't drift from what ships) and a fake
backend, and drives four real scenarios:
- **A** — cold boot, no session → lands on the auth screen, boot veil ends
  hidden, Fast Boot measurably compresses timing (~1.7s vs ~10s)
- **B** — Replay preview with one degraded + one offline subsystem in the
  fake response → diagnostics grid renders `DEGRADED`/`OFFLINE` correctly
  (not `ONLINE`), and never calls `/api/auth/me`
- **C** — backend unreachable → "Backend unreachable" is shown, and
  critically, **no subsystem is ever rendered as `ONLINE`** when the
  backend can't be reached
- **D** — valid stored session → `markSignedIn` fires with the real
  `/api/auth/me` user, auth card never appears, straight into the HUD

All four pass. `node --check` on every touched/new JS file, and a
brace-balance check on both touched CSS files, are also clean.
