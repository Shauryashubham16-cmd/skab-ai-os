# Phase 3 — Intelligence (V8 → V10)

Backend + frontend edits, additive on top of Phase 1 (visual) and Phase 2
(real agent loop). No breaking changes, no new required env vars, no new
npm packages.

## What changed

### 1. Semantic memory
`utils/longTermMemory.js` — entries now get an embedding vector at write
time (`utils/llmProviders.js` gained `embedText()`, trying Gemini's or
OpenAI's `/embeddings` endpoint — whichever of `GEMINI_API_KEY` /
`OPENAI_API_KEY` you already have set, no separate key). `search()` ranks
by cosine similarity blended with the original keyword-overlap score and a
recency weight (a strong semantic match from a year ago still beats a weak
one from today; among comparable matches, recent wins).

This degrades transparently: no embedding-capable provider configured, or
an embedding call fails → entries save without a vector and search falls
straight back to the pre-Phase-3 keyword-overlap behavior. Nothing breaks
either way.

Also added:
- **Dedupe on write** — near-identical facts/notes (cosine ≥ 0.96, or exact
  text match) refresh the existing entry's timestamp instead of piling up
  duplicates. Matters most for task-outcome notes, which get written every
  `/task` run.
- **Cleanup** — `cleanup({ maxAgeDays, keepTypes })` drops old `note`
  entries (facts/preferences kept by default). Manual only, via
  `POST /api/knowledge/cleanup` — nothing runs automatically.

Because embedding is an async network call, `add()` and `search()` are now
`async` (they were synchronous before) — every call site
(`toolRegistry.js`, `taskEngine.js`, `routes/knowledge.js`, `routes/chat.js`)
was updated to `await` them.

### 2. Context awareness reaches the LLM
`utils/contextAwareness.js` already polled the focused window/app every 5s
(from an earlier build) but that data only ever reached `GET
/api/agent/context` for the UI to display — it never actually reached the
model's reasoning. Now:
- `routes/chat.js` injects a system message with the active window + a
  short recent-window trail into every chat turn (told to only use it if
  actually relevant — it's not forced into every reply).
- `utils/taskEngine.js`'s planner prompt gets the same active-window line,
  so a goal like *"close this"* or *"save what I'm working on"* can resolve
  against what's actually focused instead of failing to parse.

App/window-level only — no document contents, no tab URLs, no screen
pixels. That's `vision.screen`'s job, and stays opt-in per call.

### 3. Wake word
`public/index.html` — a second toggle next to the mic button
("Wake word: Off/On"). When on, a background `SpeechRecognition` instance
listens continuously for "Jarvis" / "Hey Jarvis". On a match it either:
- sends the rest of the sentence straight to chat if the wake phrase and
  command were said together ("hey jarvis, what time is it"), or
- opens the normal push-to-talk listening flow (same transcription,
  confidence meter, reactor states) if just the wake phrase was said alone.

It's a second `SpeechRecognition` instance, not a rewrite of the existing
push-to-talk one — the two hand off the mic to each other (wake pauses
itself when push-to-talk starts, resumes when it ends) rather than
competing. Same browser-support ceiling as the existing voice input
(Chrome/Edge; the toggle explains itself if unavailable).

## What this does NOT include yet (later phases)
- Plugin/extension system, background/scheduled tasks (both listed under
  Phase 3 in the original plan) — held back to keep this batch reviewable;
  say the word if you want them as a follow-up rather than folded into
  Phase 4.
- 3D imagination engine, text/image → scene generation — Phase 4.

## Setup note
Semantic memory needs `GEMINI_API_KEY` or `OPENAI_API_KEY` in `.env` (see
the new comment block there) — you very likely already have one of these
set for chat. No action needed if so; it just starts working. Wake word
needs no setup, just click the new toggle (and grant mic permission if
you haven't already for push-to-talk).

## Next
Phase 4 — 3D imagination engine (text/image → interactive scene), or the
Phase 3 leftovers (plugins, background tasks) if you'd rather close those
out first.
