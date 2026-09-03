# Vision gaps + Clipboard/drag-drop + Image generation

Closes the last three items from the original audit that didn't need a
build-system change (the frontend split, the fourth, is covered separately
in `PHASE-FRONTEND-SPLIT.md`).

## 1. Vision gaps

New in `utils/visionService.js` (backed by two additions to `utils/ocr.js`):

- **`findElement(text)`** — OCR-based UI-element targeting. Runs Tesseract
  with word/line bounding boxes kept (via the new `recognizeDetailed()` in
  `utils/ocr.js`, alongside the existing plain-text `recognizeText()`),
  matches the requested text against the words/lines actually on screen, and
  returns real pixel coordinates (`bbox`, `center`) — pair `center` with
  `input.click`/`input.moveMouse`. This is OCR-based, not a general
  object-detection model: it finds an element by its *visible label*, which
  covers the plan's own example ("finds Download → clicks") honestly. It
  will not find an unlabeled icon — noted directly in the tool's
  description so the planner doesn't over-trust it.
- **`takeSnapshot()` / `compareToSnapshot()`** — real pixel-diff before/after
  verification, not an LLM guessing from a description. Take a snapshot,
  do something, compare a fresh capture against it; get back
  `changed`/`changedPercent`/`bbox` of the changed region. Added `pngjs` as
  a new (pure-JS, no native build) dependency to decode PNG buffers for the
  diff — the same "prefer pure JS over native bindings" choice already made
  for `tesseract.js`/`screenshot-desktop`.

New tools: `vision.findElement`, `vision.snapshot`, `vision.compareToSnapshot`.
New routes: `POST /api/vision/find`, `POST /api/vision/snapshot`,
`POST /api/vision/compare`.

## 2. Clipboard + drag-and-drop

`utils/scripts/input-control.ps1` gained three ops: `dragdrop` (press, move
through intermediate points, release — the step-by-step move matters, since
HTML5 and many custom drag handlers only start tracking a drag after seeing
mousemove events between down and up, not a single teleport), `clipget`, and
`clipset` (via PowerShell's built-in `Get-Clipboard`/`Set-Clipboard`, not
`System.Windows.Forms.Clipboard`, which needs an STA thread a
non-interactive PowerShell process isn't guaranteed to have).

New in `utils/inputControl.js`: `dragDrop()`, `clipboardRead()`,
`clipboardWrite()` — same `automationGuard` gate and audit trail as every
other input function in the file. Clipboard contents are never logged
(same reasoning as not logging typed text).

New tools: `input.dragDrop`, `input.clipboardRead`, `input.clipboardWrite`.
New routes: `POST /api/input/dragdrop`, `GET`/`POST /api/input/clipboard`.

## 3. Image generation

New `utils/imageGen.js` — a real (non-stub) integration: tries OpenAI's
Images API, then Gemini's image model, whichever has a key configured.
Deliberately reuses `OPENAI_API_KEY`/`GEMINI_API_KEY`, which already exist
in `.env.example` for chat/vision/embeddings — if either is already filled
in, this works with zero additional setup. No new SDK dependency; both
calls are a single POST via axios (already a dependency).

This is an *additional* mode alongside the Imagination panel's existing
key-free 3D scene graph (`utils/imaginationEngine.js`), not a replacement —
the scene graph stays the default, always-available path; image generation
is there for when the user wants an actual picture instead of an
interactive scene.

New route: `POST /api/imagination/image` (`{prompt, size?}` →
`{imageBase64 or imageUrl, provider, model}`, or a clear "no key configured"
error). `GET /api/imagination/image-providers` lets the UI check what's
available before offering the option.

## Verification

Every touched file passed `node --check`. `findElement`/`compareToSnapshot`
were traced end-to-end against the real OCR/screenshot pipeline already in
place (no new capture path introduced). `imageGen.js` makes real HTTP calls
to each provider's documented endpoint — there is no code path that returns
fabricated image data.
