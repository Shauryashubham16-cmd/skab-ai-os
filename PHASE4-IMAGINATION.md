# Phase 4 — Imagination Engine (V8 → V10)

Backend + frontend edits, additive on top of Phases 1–3. No breaking
changes, one new required-if-you-want-it thing: an LLM key you almost
certainly already have configured (nothing new to sign up for).

## A framing note before the diff

The original plan describes this phase as "Text → Understanding → Scene
generation → 3D/image generation → Holographic viewer" and is explicit that
**"The visualization should be interactive, not just an image."**

There's no image-generation API key anywhere in this project (see
`.env.example` — chat/vision/embedding providers only), and wiring one in
would be a bigger, separate decision than a phase build should make for you
silently. So this phase builds the interactive half literally: the LLM
proposes a small structured **scene graph** (a JSON list of primitive
shapes — boxes, cylinders, cones, spheres — with position/scale/color), and
the frontend renders that as a real Three.js scene you can drag-rotate and
scroll-zoom. It's not a photorealistic render, but it is a genuinely
interactive, editable, real 3D object — which the plan itself says matters
more than photorealism here. If you'd rather have real image generation
bolted on top later (e.g. as a "render this angle" button using an image
API once you've picked and funded one), that's a clean, additive follow-up
on this same scene-graph foundation, not a rewrite.

## What changed

### Backend
- **`utils/imaginationEngine.js`** (new) — `proposeScene(prompt)` and
  `editScene(currentScene, instruction)` ask the LLM for a scene graph,
  sanitized and clamped (`sanitizeScene()`) so nothing malformed or
  runaway (bad object types, out-of-range coordinates, unbounded object
  counts — capped at 24) ever reaches the renderer. `sceneFromScreen()` is
  the "Vision/Imagination Connection" item from the plan: it reuses your
  existing screen-capture + vision-description pipeline
  (`utils/visionService.js`) and builds a scene from a real description of
  what's actually on screen — no pixels are invented, only described.
- **`routes/imagination.js`** (new) — `POST /api/imagination/scene`,
  `/edit`, `/from-screen`, auth-gated like everything else.
- **`routes/chat.js`** — new `/imagine <description>` command. First use
  creates a scene; bare follow-ups ("add drones", "make it nighttime")
  edit the same scene — mirrors the plan's own example dialogue as closely
  as an explicit, unambiguous command can (say `/imagine new <description>`
  to start fresh instead of editing). Emits live reactor states over the
  same `/agent` socket built in Phase 2, so the HUD reflects real backend
  progress here too, not a guessed timeline.
- **`schemas/index.js`**, **`server.js`** — request validation + route
  mount.
- Fixed a small CSS bug from Phase 3 along the way: the wake-word toggle
  referenced a `--border` variable that doesn't exist in your theme
  (should've been `--border-default`) — corrected.

### Frontend (`public/index.html`)
- New **Imagination** nav icon, opening a full-screen overlay (same fixed-
  inset expand pattern as the existing fullscreen terminal card).
- A real Three.js viewer (`ensureImaginationEngine()` / `renderSceneGraph()`
  / `buildObjectMesh()`): OrbitControls for rotate/zoom/pan, a directional +
  ambient light pair whose intensity and color shift with the scene's
  `sky` value (day/dusk/night), fog and background color to match, and a
  ground disc colored from the scene graph. Each object type in the graph
  (`building`, `tower`, `tree`, `drone`, `car`, `flyingCar`, `road`,
  `panel`, `person`, `water`, `sphere`, `box`) maps to a small primitive
  mesh or group — drones get spinning-rotor rings, flying cars get a glow
  ring, that kind of thing — built from Three.js's basic geometries only
  (`BoxGeometry`, `CylinderGeometry`, `ConeGeometry`, `SphereGeometry`,
  `TorusGeometry`), pinned to Three.js r128 for `OrbitControls` compatibility
  (loaded via CDN — `cdnjs` for the core lib, `jsdelivr` for the classic
  non-module `OrbitControls.js`, since current Three.js dropped both from
  its own site).
- Toolbar: a text input + **Imagine** (create/edit, same rule as the chat
  command), **From Screen** (calls `sceneFromScreen`), **New** (clears the
  loaded scene so the next prompt starts fresh).
- `sendChat()` opens the overlay automatically and renders whatever scene
  comes back if you trigger this from chat (`/imagine ...`) instead of the
  toolbar — one code path either way.

## Setup note
Uses whichever LLM provider you already have configured for chat — no new
key. `sceneFromScreen` additionally needs screen-capture to actually be
available on this machine (same requirement as your existing Vision tab).

## What this does NOT include yet
- Real image/photo generation as a second, optional rendering mode (see the
  framing note above — a deliberate scope decision, not an oversight).
- The Phase 3 leftovers: plugin/extension system, background/scheduled
  tasks.
- Phase 5 (polish): performance pass, security hardening beyond what's
  already in place, responsive layouts, testing, broader error handling.

## Next
Phase 5 (polish/hardening), or the Phase 3 leftovers (plugins, background
tasks) if you'd rather close those out first — your call.
