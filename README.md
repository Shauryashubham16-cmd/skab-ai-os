# JARVIS

Express + Socket.IO app for the JARVIS AI OS — backend and frontend served from one
process. Covers:

1. **Chat** — tries multiple LLM providers in order with automatic fallback
   (Gemini → Groq → OpenRouter → Grok, all configurable), with both a normal
   JSON endpoint and a streaming (SSE) endpoint for a live "typing" feel.
   Augmented with Exa/Tavily search and Supabase-backed persistent history
   (both optional).
2. **Weather** — current conditions, hourly forecast, UV index, and AQI via
   Open-Meteo (no API key needed).
3. **Voice** — text-to-speech via ElevenLabs, plus real in-browser mic capture
   and speech-to-text for Jarvis's voice input/output.
4. **Terminal** — a real-time shell over Socket.IO, for the live terminal panel.
5. **System stats** — live CPU/RAM/disk/network/battery via `systeminformation`.
6. **Frontend** — the whole HUD is `public/index.html`, served statically by
   this same Express app (`http://localhost:4000`), so there's nothing to run separately.
7. **Desktop app** — the same server + frontend also runs as a real Windows
   app via Electron (`electron/main.js`) — see section 6 below.

## 1. Setup

```bash
cd jarvis
npm install
cp .env.example .env
```

Open `.env` and fill in:

- `GEMINI_API_KEY` — from aistudio.google.com/apikey. **Get it from your own Google AI Studio
  account and paste it only into this local `.env` file — never into a chat with me or any
  other AI, and never commit it to git.** `.gitignore` already excludes `.env`. This is the
  recommended primary chat provider — see section 4 below for the full fallback chain
  (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY` are all optional extra fallbacks).
- `ELEVENLABS_API_KEY` — from your ElevenLabs account settings.
- `ELEVENLABS_VOICE_ID` — optional; once the server is running, call `GET /api/voice/voices`
  to list voices in your account and pick one.
- `EXA_API_KEY` / `TAVILY_API_KEY` / `SUPABASE_URL` + `SUPABASE_KEY` — all optional,
  see section 4 below.
- `CORS_ORIGIN` — only matters if you ever run the frontend from a separate dev
  server again; same-origin (the normal case) doesn't need it.

Then run it:

```bash
npm run dev     # with auto-restart (nodemon)
# or
npm start
```

Open `http://localhost:4000` — that's the whole app, UI and API together.
`GET /health` confirms the server's alive if you just want to check the backend.

## 2. API Reference

### Chat
| Method | Route | Body | Notes |
|---|---|---|---|
| POST | `/api/chat` | `{ message, sessionId? }` | Returns `{ reply, sessionId, provider, citations }` — `provider` is whichever configured LLM actually answered |
| POST | `/api/chat/stream` | `{ message, sessionId? }` | Server-Sent Events; each event is `{ delta }` until `{ done: true, provider }` |
| DELETE | `/api/chat/:sessionId` | — | Clears that session's history |
| GET | `/api/chat/providers` | — | Returns `{ order, providers }` — which LLM providers are configured right now, in fallback order |

Conversation history persists in Supabase if configured (see section 4), otherwise
it's in-memory per `sessionId` and clears on restart.

### Weather
| Method | Route | Query | Notes |
|---|---|---|---|
| GET | `/api/weather` | `lat, lon, units` | `units` is `metric` or `imperial`. Defaults to Kolkata, metric. Includes hourly forecast, UV index, AQI |
| GET | `/api/weather/forecast` | `lat, lon, units, days` | Up to 10 daily entries |

### System
| Method | Route | Notes |
|---|---|---|
| GET | `/api/system` | Live CPU/RAM/disk/network/GPU/battery via `systeminformation`. Any metric that's unavailable on your machine comes back `null` rather than fabricated |
| GET | `/api/system/apps` | Apps that Jarvis is permitted to launch |
| POST | `/api/system/open` | Requests a launch for an allowlisted app: `{ "app": "chrome" }`. A `launch-requested` result means the OS accepted the request; it does not pretend the GUI has finished starting. |
| GET | `/api/system/windows` | Lists currently open top-level windows: `{ handle, title, processName, pid, isMinimized, isMaximized, isForeground }`. Windows-only. |
| GET | `/api/system/windows/active` | The window currently focused by the user. Windows-only. |
| POST | `/api/system/windows/action` | `{ "action": "focus"|"minimize"|"maximize"|"restore"|"close", "target": "<title or handle>" }`. `target` is resolved against currently-open windows server-side — never passed to a shell. Windows-only. |
| GET | `/api/system/context` | Rolling context-awareness log: the currently focused app/window plus recent focus history, refreshed every 5s. Also included in `GET /api/agent/context`. Windows-only. |

Window management and context awareness are implemented via a fixed
PowerShell helper (`utils/scripts/window-manager.ps1`) that wraps the Win32
user32.dll APIs (`EnumWindows`, `GetForegroundWindow`, `ShowWindow`, etc.) —
no extra npm dependency or native module to compile. It only ever runs with
enum-validated arguments or a live window handle obtained by re-enumerating
open windows, the same "never hand user text to a shell" rule the rest of
`utils/` follows. On macOS/Linux these routes return
`{ ok: false, error: "...only supported on Windows." }` rather than failing
silently.

### Vision (screen + images)
| Method | Route | Body | Notes |
|---|---|---|---|
| POST | `/api/vision/screen` | `{ mode: "ocr"\|"describe"\|"both", question? }` | Captures the live screen and analyzes it. `describe`/`both` needs a vision-capable LLM key (`GEMINI_API_KEY`, `OPENAI_API_KEY`, or `XAI_API_KEY`) — `ocr` alone doesn't. |
| POST | `/api/vision/image` | `{ imageBase64, mimeType?, mode, question? }` | Same analysis, against an uploaded image instead of the live screen. |

This is "look, don't touch" — a screenshot handed to OCR (`tesseract.js`,
pure JS/WASM, downloads English trained-data once on first use and caches it
under `~/.jarvis/tesseract-cache`) and/or a vision-capable LLM. No keystrokes,
no clicks. Screen capture uses `screenshot-desktop`, which shells out to the
OS's own screenshot mechanism rather than a compiled native addon.

### Calendar & tasks
| Method | Route | Body/Query | Notes |
|---|---|---|---|
| GET | `/api/calendar` | `?from=&to=&includeCompleted=` | Full list, optionally windowed by ISO timestamps |
| GET | `/api/calendar/upcoming` | `?limit=` | Next N incomplete items from now — what the dashboard card shows |
| POST | `/api/calendar` | `{ title, start, notes?, end?, allDay?, priority?, remindMinutesBefore? }` | `end` omitted means a point-in-time task, not a spanned event |
| GET | `/api/calendar/:id` | — | |
| PATCH | `/api/calendar/:id` | any subset of the fields above, plus `{ completed }` | Also how a reminder gets rescheduled |
| DELETE | `/api/calendar/:id` | — | |

Local JSON storage (`data/calendar.json`), same pattern as chat history's
local fallback — zero setup, per-user scoped. Reminders are polled every 15s
(`utils/calendarReminders.js`) and pushed as a `calendar:reminder` event over
the same `/agent` Socket.IO namespace `utils/taskEngine.js` already streams
plan/execute state on, so the frontend needed no new socket connection — see
`public/components/Calendar/calendarPanel.js` for the toast + dashboard card.
Was previously a dead nav icon (`services/nav.js` listed "Calendar" but
nothing happened on click, and there was no backend route at all).

### Smart file search
| Method | Route | Body/Query | Notes |
|---|---|---|---|
| GET | `/api/files/roots` | — | The directories Jarvis is allowed to search |
| GET | `/api/files/search` | `?q=&root=` | Filename search |
| POST | `/api/files/search/content` | `{ query, root?, extensions? }` | Content search, text files only, 2MB/file cap |
| POST | `/api/files/open` | `{ path, reveal? }` | Opens a file, or reveals it in the file manager if `reveal: true` |

Search is confined to an allowlist — by default your Desktop, Documents, and
Downloads folders — never the whole disk. Set `FILE_SEARCH_ROOTS` in `.env`
(semicolon-separated on Windows) to change it. Every `path` passed to
`/open` is checked against that same allowlist server-side before anything
runs.

### Mouse & keyboard automation
| Method | Route | Body | Notes |
|---|---|---|---|
| GET | `/api/input/status` | — | Whether input automation is armed |
| POST | `/api/input/enable` | `{ enabled }` | Runtime kill switch — arm/disarm without a restart |
| GET | `/api/input/bounds` | — | Screen resolution, for choosing valid coordinates |
| POST | `/api/input/move` | `{ x, y }` | Move the cursor |
| POST | `/api/input/click` | `{ x?, y?, button?, double? }` | Click at a position, or the current cursor position if `x`/`y` omitted |
| POST | `/api/input/scroll` | `{ delta, x?, y? }` | Scroll wheel |
| POST | `/api/input/type` | `{ text }` | Types text into whatever currently has focus |
| POST | `/api/input/key` | `{ keys }` | Raw SendKeys combo, e.g. `"^c"` (ctrl+c), `"%{F4}"` (alt+F4) |

**Off by default** (`ENABLE_INPUT_AUTOMATION=false`). This is the one
capability in this codebase that can genuinely take hard-to-undo actions, so
on top of the `.env` flag there's a runtime toggle
(`POST /api/input/enable`) that flips instantly — no restart needed — so you
always have a fast way to stop it mid-task. Windows-only, built the same way
as window management: a fixed PowerShell script (`utils/scripts/input-control.ps1`)
wrapping `user32.dll` mouse events and `SendKeys` for the keyboard, invoked
with enum-validated arguments only. Coordinates are checked against the real
screen bounds before anything moves. Typed text is never written to the
audit log, only its length.

### Browser automation
| Method | Route | Body | Notes |
|---|---|---|---|
| GET | `/api/browser/status` | — | Whether it's armed, and the current page URL if a session is open |
| POST | `/api/browser/enable` | `{ enabled }` | Runtime kill switch |
| POST | `/api/browser/navigate` | `{ url }` | http/https only — `file://` is blocked |
| POST | `/api/browser/click` | `{ selector }` | CSS selector |
| POST | `/api/browser/type` | `{ selector, text }` | Fills a field |
| POST | `/api/browser/read` | `{ selector? }` | Visible text of a selector, or the whole page if omitted (capped at 8000 chars) |
| POST | `/api/browser/screenshot` | — | Returns a base64 PNG of the current page |
| POST | `/api/browser/close` | — | Closes the automated browser session |

**Off by default** (`ENABLE_BROWSER_AUTOMATION=false`), same runtime kill
switch as input automation. Built on `playwright-core` (not the full
`playwright` package) driving your already-installed Chrome or Edge via
Playwright's "channel" mode — no extra browser binary download. Runs headed
(a visible window) unless `BROWSER_HEADLESS=true`, so what it's doing is
never hidden from you. `file://` URLs are blocked outright — that's the one
scheme that would let a misdirected agent read local files through the DOM.

### Multi-step tasks & the autonomous agent
| Method | Route | Body | Notes |
|---|---|---|---|
| GET | `/api/tasks/tools` | — | The tool catalog — every capability above, wrapped uniformly |
| POST | `/api/tasks/run` | `{ steps: [{ tool, args }] }` | Runs an explicit, caller-supplied sequence of tool calls in order |
| POST | `/api/tasks/auto` | `{ goal, execute? }` | `execute:false` (default) asks the LLM to propose a plan from a goal and returns it **without running anything**. `execute:true` runs it and verifies the outcome. |
| POST | `/api/tasks/:runId/continue` | — | Resumes a run that paused on a confirm-required step |
| GET | `/api/tasks/:runId` | — | Inspect a run's state |

This is the plan → execute → verify loop: `autonomousRun` asks the LLM to break
a goal into steps drawn only from the real tool catalog, runs them through
the same `system.power`/`input.*`/`browser.*` code paths as everything else
in this doc (so all of *their* gates still apply — a plan step that needs
armed input automation still needs it armed; a destructive system step still
needs confirmation), then asks the LLM a second time whether the goal was
actually achieved based on what happened, not just whether the calls
returned `ok`. A run pauses — not auto-confirms — the instant any step comes
back `needsConfirmation`; nothing after it runs until the user confirms
through the normal chat flow and the run is resumed with `/continue`. A hard
cap of 8 steps and a 60-second wall-clock budget keep any single run bounded.

### Long-term memory & learned preferences
| Method | Route | Body/Query | Notes |
|---|---|---|---|
| GET | `/api/knowledge` | `?type=&limit=` | List stored facts/preferences/notes |
| GET | `/api/knowledge/search` | `?q=&limit=` | Keyword search |
| POST | `/api/knowledge` | `{ type, content, tags? }` | `type` is `fact`, `preference`, or `note` |
| DELETE | `/api/knowledge/:id` | — | Forget one entry |

File-backed (`data/longterm.json`), same zero-setup pattern as chat history —
distinct from that per-conversation history, this is durable across
sessions. Search is plain keyword overlap, not embeddings — no vector DB to
install for what's realistically a few hundred entries. Normal chat
(`POST /api/chat`) automatically pulls in anything relevant here before
replying, so a saved preference like "likes concise answers" actually
changes future answers, not just sits in a store. The autonomous agent also
writes a one-line outcome note here after every completed task.

### Add your desktop apps

Jarvis can open the built-in apps (`chrome`, `edge`, `vscode`, `calculator`,
`files`, and more) from chat: for example, **“open vscode”**. To add one of
your own apps, edit `config/apps.json` with a fixed executable path. The path
is trusted local configuration, not text supplied through chat:

```json
{
  "obs": { "win32": { "cmd": "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe", "args": [] } }
}
```

Restart Jarvis after saving, then say **“open obs”**. Jarvis only launches a
name found in its built-in or local list; it never passes a chat message to a
shell.

### Memory
| Method | Route | Query | Notes |
|---|---|---|---|
| GET | `/api/memory/recent` | `limit` | Recent user messages from Supabase, for the memory panel. Returns `{ connected: false, items: [] }` if Supabase isn't configured |

### Voice
| Method | Route | Body | Notes |
|---|---|---|---|
| POST | `/api/voice/speak` | `{ text, voiceId? }` | Returns raw `audio/mpeg` bytes — play directly in an `<audio>` tag or Web Audio API |
| GET | `/api/voice/voices` | — | Lists voices available in your ElevenLabs account |

Frontend snippet:
```js
const res = await fetch('http://localhost:4000/api/voice/speak', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'All systems online.' }),
});
const audioBlob = await res.blob();
new Audio(URL.createObjectURL(audioBlob)).play();
```

### Terminal (Socket.IO, namespace `/terminal`)
Connect a socket.io client to `http://localhost:4000/terminal`.

| Client emits | Payload | Server emits |
|---|---|---|
| `terminal:run` | `{ command }` | `terminal:stdout` / `terminal:stderr` (streamed chunks) |
| `terminal:kill` | — | `terminal:exit` `{ code }` when it finishes |

```js
import { io } from 'socket.io-client';
const term = io('http://localhost:4000/terminal');
term.on('terminal:stdout', ({ chunk }) => appendToPanel(chunk));
term.emit('terminal:run', { command: 'ls -la' });
```

## 3. Terminal security — read this

The terminal endpoint runs real shell commands on **your** machine with **your** user
permissions. That's the whole point for a personal Jarvis-style assistant, but it means:

- It's gated behind `ENABLE_TERMINAL=true` in `.env` — leave it `false` if you're not using
  the terminal panel yet. This check now runs through the same centralized
  authorization layer every other privileged tool uses — see `utils/permissions.js`
  and section 9 below.
- A small denylist blocks a few catastrophic patterns (`rm -rf /`, disk-level `dd`, fork
  bombs, drive formatting) — this is a seatbelt, not a sandbox.
- **Never bind this server to a public interface or expose it to the internet.** It's meant
  for `localhost` only. This build has no authentication — anyone who can reach the
  `/terminal` socket can run arbitrary commands on your computer.

## 4. Multi-provider LLM fallback

`/api/chat` and `/api/chat/stream` don't talk to one LLM — they try a list of
configured providers in order and automatically move to the next one if a
provider errors out, rate-limits, or returns an empty response:

| Order | Provider | Free tier? | Env key |
|---|---|---|---|
| 1 (default) | Gemini | Yes, generous, no card | `GEMINI_API_KEY` |
| 2 | Groq | Yes, fast, open-weight models only | `GROQ_API_KEY` |
| 3 | OpenRouter | Yes, 200 req/day (lineup rotates) | `OPENROUTER_API_KEY` |
| 4 | Grok (xAI) | No — paid credits required | `XAI_API_KEY` |

You only need one key filled in for chat to work at all — the fallback only
kicks in for providers you've actually configured. Change the order (or drop
a provider entirely) via `LLM_PROVIDER_ORDER` in `.env`, e.g.
`LLM_PROVIDER_ORDER=groq,gemini` to try Groq first. Each provider's model is
also overridable (`GEMINI_MODEL`, `GROQ_MODEL`, etc.) without touching code —
useful since free-tier model IDs (especially OpenRouter's) rotate over time.

Check what's actually configured at any time with `GET /api/chat/providers`,
or the `/model` slash command in the chat input. Every response also reports
which provider answered (shown in the UI as "JARVIS · via Groq", etc.), so
you can see the fallback working rather than just trusting it's there.

## 5. Search augmentation & persistent memory (optional)

`/api/chat` also uses two extra, independent, optional integrations:

- **Exa + Tavily** — every chat message runs a search on both (in parallel) and the
  results are folded into the prompt as extra context. This does the real work of
  giving JARVIS current information, since none of the providers above browse the
  web on their own through these basic endpoints. Leave either `EXA_API_KEY` or
  `TAVILY_API_KEY` blank and that source is just skipped — nothing breaks, but chat
  answers will lean on the model's training data for anything time-sensitive. Both
  have free tiers (1,000 searches/month each as of writing), and both run on every
  message, so watch usage if you're chatty.
- **Supabase** — chat history now persists in Postgres instead of living only in
  server memory, so conversations survive a restart. Create a free project at
  supabase.com, run `supabase-schema.sql` (in this folder) in its SQL editor once,
  then set `SUPABASE_URL` and `SUPABASE_KEY` (the **service_role** key — never the
  `anon` key, and never put it in frontend code). Leave both blank and chat falls
  back to the original in-memory behavior automatically.

## 6. Desktop app (Electron)

The exact same server + frontend now also runs as a real Windows desktop app,
via `electron/main.js`. This is a thin wrapper, not a rewrite — nothing about
the backend or the HUD changed. Electron just starts the same Express server
in its own process and opens a window pointed at `http://localhost:4000`
instead of you opening that URL in a browser tab.

**Run it as a desktop window (dev):**
```bash
npm install        # pulls in electron + electron-builder alongside everything else
npm run electron
```
This uses your existing project-root `.env`, same as `npm start`.

**Build a real installable .exe:**
```bash
npm run dist:win
```
Output lands in `release/` (git-ignored) — both an NSIS installer and a
portable `.exe`. Two things are different for a packaged build specifically:

- **Where `.env` lives.** A packaged installer can't ship your real `.env` —
  that would bake your API keys into a file anyone with the installer could
  extract. So on first launch, JARVIS copies the bundled `.env.example` into
  your Windows user-data folder (something like
  `%APPDATA%\jarvis\.env`) and shows a one-time dialog telling you the exact
  path — open it, fill in your keys, restart the app.
- **No app icon yet** — it'll use Electron's default icon until you drop a
  `.ico` file in and point `build.win.icon` at it in `package.json`.

The renderer (the page itself) still has zero Node.js or Electron access —
it's loaded as a normal web page and talks to the backend the same way it
does in a browser, via `fetch` and Socket.IO. That's deliberate: nothing
currently in the app needs deeper OS access, so it doesn't have any. If a
future feature genuinely needs it (native file dialogs, desktop control),
that belongs in `electron/preload.js` as an explicit, narrow API — not a
blanket `nodeIntegration: true`.

**Hardening applied in `electron/main.js`** (beyond the baseline
`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` above):

- `webviewTag: false`, `nodeIntegrationInSubFrames: false`,
  `allowRunningInsecureContent: false` — narrows `webPreferences` further;
  nothing in the app uses `<webview>` or subframes, so there's no reason to
  leave that surface open.
- Every `webContents` this app creates (not just the main window) gets:
  a `will-navigate` handler that blocks the loaded page from navigating
  itself anywhere except `APP_URL`; a `setWindowOpenHandler` that only ever
  hands `http`/`https` targets to the OS browser via `shell.openExternal`
  and drops everything else (`file://`, `javascript:`, custom schemes)
  outright; and a `setPermissionRequestHandler` that denies every browser
  permission prompt (camera, mic, geolocation, notifications) by default.
- In a **packaged** build only, DevTools is blocked — the `F12`/
  `Ctrl+Shift+I` shortcut is swallowed and `devtools-opened` immediately
  closes it again. DevTools still works normally in `npm run electron` dev
  mode.

## 7. Testing

`npm test` runs the automated test suite (`tests/`, using Node's built-in
test runner — no extra dependency to install). It covers the pure logic
that's cheapest to get wrong silently and most load-bearing for safety:

- `sanitizeScene()` — the one thing standing between whatever the LLM (or a
  client posting to `POST /api/imagination/edit`) returns and the Three.js
  renderer.
- `longTermMemory`'s cosine/keyword/recency scoring math behind semantic
  search.
- `taskEngine.isRecoverable()` — the retry-vs-terminal classification that
  decides whether a failed task step is worth an LLM correction attempt.
- The zod request-validation schemas for every write-ish endpoint.
- The centralized privileged-action layer (`utils/permissions.js`) —
  capability on/off toggles, the dangerous-tool confirmation note, and
  authorization failure messages.
- The standardized tool contract (`utils/toolRegistry.js`) — every
  built-in tool's declared permission is valid, `runTool()` authorizes
  before it validates args, and it validates args before `execute()` ever
  runs.
- Terminal safety (`utils/terminal.js`) — the hardcoded block-list pattern
  by pattern, and the capability gate.
- Browser/input automation guards (`utils/automationGuard.js`,
  `utils/inputControl.js`) — off by default, every action rejected while
  disabled, request schemas reject malformed coordinates/selectors.
- Plugin permissions (`utils/pluginLoader.js`) — manifest validation, the
  built-in-name collision guard, and proof that a `dangerous` plugin is
  loaded but genuinely cannot execute until both `ENABLE_PLUGINS` and
  `ENABLE_PLUGIN_DANGEROUS_ACTIONS` are armed.
- Provider health/readiness (`utils/providerHealth.js`) — configured vs.
  reachable reporting, response caching, and that providers which would
  burn a paid quota just to prove they're up (Tavily/Exa) are never
  live-pinged. Network calls are mocked, so this suite needs no internet
  access and no real API keys.

These are deliberately unit tests, not integration tests — nothing here
touches disk, a real LLM/embedding provider, or the network, so they run
fast and don't cost API credits. Route handlers, the actual multi-provider
LLM fallback, and anything requiring a live browser/desktop are not covered
yet; see "Suggested next steps" below.

CI (`.github/workflows/ci.yml`) runs this suite on every push/PR across two
Node versions, plus `npm audit`, GitHub's dependency-review action on PRs,
and a weekly CodeQL scan — see section 9.

## 8. Privileged-action layer, tool contract & provider health

A hardening pass added a single place every privileged action in the app
now goes through, rather than each tool/route re-implementing its own
on/off check:

- **`utils/permissions.js`** — the centralized authorization model. Every
  tool declares a `permission` (`read` | `standard` | `dangerous`) and an
  optional `requiresCapability` (`input` | `browser` | `terminal` |
  `pluginDangerous`). `authorize(name, meta)` is the one function that
  decides whether a call is allowed right now; `utils/automationGuard.js`
  is kept as a thin backward-compatible wrapper over it so existing
  `POST /api/input/enable` / `POST /api/browser/enable` runtime toggles
  keep working unchanged.
- **`utils/toolRegistry.js`** — the standardized tool schema & execution
  contract. Every built-in tool (and every plugin tool registered via
  `registerTool`) declares `{ describe, permission, requiresCapability,
  argsSchema, execute }`. `runTool()` — the single entry point the
  task-engine planner and any future caller use — now always: (1) looks the
  tool up, (2) authorizes it via `permissions.js`, (3) validates its args
  against `argsSchema` (zod), and only then calls `execute()`. Previously,
  args from an LLM-planned task step reached `execute()` completely
  unvalidated; REST-route calls were already validated by their own route
  schema, but the planner path was not. `GET /api/agent/tools` lists every
  tool with its declared permission.
- **`GET /api/system/health/providers`** (protected) — readiness for every
  external provider this app talks to: the configured LLM providers
  (a free `GET /models` ping against each one's OpenAI-compatible
  endpoint), ElevenLabs, Supabase, and Open-Meteo. Tavily/Exa report
  configured-only, since pinging them for real would spend a paid search
  credit. Results are cached for 30s so polling this endpoint doesn't
  hammer anyone's API quota; see `utils/providerHealth.js`.

## 9. Suggested next steps

Both items from the previous "still open" list are now built:

- **Real vector-based memory** — `supabase-schema-vector.sql` + `utils/longTermMemoryPgvector.js`
  add a genuine pgvector cosine-search backend, opt-in via `USE_PGVECTOR_MEMORY=true`
  (see `.env.example`). The default JSON/brute-force backend
  (`utils/longTermMemory.js`) is unchanged and still what runs out of the box —
  switch once a single user's memory is realistically headed for the thousands
  of entries, not before.
- **Calendar** — full CRUD + reminders, see the "Calendar & tasks" section above.
  Turns out the nav icon existed but nothing was behind it; now something is.

While fixing the memory backend's user-scoping to match the new pgvector
version's API, a real pre-existing gap surfaced: `utils/longTermMemory.js`'s
`add`/`list`/`remove`/`search`/`cleanup` took no `userId` at all, so every
signed-in account shared one `longterm.json` — a genuine cross-account leak
for anyone actually running this with more than one person signed in. Fixed
in the same pass; every call site (`routes/knowledge.js`, `routes/chat.js`,
`utils/taskEngine.js`, `utils/toolRegistry.js`'s `memory.remember`/`memory.recall`
tools) now threads the calling user's id through.

Still genuinely open:

- A calculator or file-manager panel, per the earlier "AI OS" feature list (calendar is now done).
- `public/index.html` is still one large file with inline scripts — splitting it out
  would let `'unsafe-inline'` come out of the CSP in `server.js`. Not touched in this
  pass; real effort, and everything above kept working without it.

See `PHASE-PLUGINS-SCHEDULER.md`, `PHASE-VISION-INPUT-IMAGEGEN.md`, and
`PHASE-FRONTEND-SPLIT.md` for what each of the earlier passes did.

---

## v3 upgrade — accounts, memory, multi-agent, hardening

### 1. Set up Supabase (now required)

JARVIS stores accounts and chat history in Supabase, and every API route is
locked behind a signed-in session.

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run **`supabase-schema.sql`** from this folder. It
   creates `chat_sessions` + `chat_messages`, grants Data API access, and turns on
   row-level security so a user can only ever read their own rows.
3. Copy three values from **Settings → API** into `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (public — used for login/signup)
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only — never put this in frontend code)
4. `npm install && npm start`, open the app, and click **Create one** to register.

By default Supabase emails a confirmation link before the first sign-in. To skip
that while testing, turn off email confirmation in **Authentication → Providers →
Email**.

### 2. What changed

**Security**
- Every `/api/*` route except `/api/auth/*` and `/health` requires a valid Supabase
  access token, verified against Supabase Auth on each request (not just decoded).
- The Socket.IO terminal namespace authenticates at handshake — an anonymous
  socket can never reach `spawn()`. It still also needs `ENABLE_TERMINAL=true`.
- `helmet` adds a content-security policy and the standard hardening headers.
- Login/signup is rate-limited to 20 attempts per 15 minutes; failures are
  deliberately generic so the API never reveals whether an email exists.
- The error handler no longer leaks internal messages on 5xx.

**Zod validation** — `schemas/index.js` defines every request shape; the
`validate()` middleware parses body/query/params before any handler runs, so
handlers never touch raw input. Terminal commands are validated too.

**Memory** — history lives in Postgres, scoped by `user_id` on every query, with
conversation threads, titles auto-derived from your first message, plus rename
and delete. The old anonymous in-memory fallback is gone.

**Multi-agent routing** — a cheap router agent classifies each message and hands
it to a specialist, each with its own system prompt, provider preference and
token budget:

| Agent | Handles |
| --- | --- |
| Generalist | everyday chat, quick questions, summaries |
| Researcher | anything current — always web-searches first |
| Engineer | code, debugging, shell, APIs |
| Analyst | multi-step reasoning, planning, tradeoffs |

The router's JSON output is Zod-validated; if it's unavailable or malformed a
keyword heuristic decides instead, so routing can never break chat itself. Force
an agent by passing `"agent": "coder"` to `/api/chat`, or leave it on `auto`.
`GET /api/chat/agents` lists the roster.

**Boot sequence** — a startup overlay runs real checks (backend reachable, memory
bank linked, terminal armed or locked, existing session) before revealing the HUD
or the sign-in screen.

### 3. New endpoints

```
POST /api/auth/signup | login | refresh | logout      GET /api/auth/me | status
GET  /api/sessions            POST /api/sessions
GET  /api/sessions/:id/messages
PATCH /api/sessions/:id       DELETE /api/sessions/:id | /api/sessions/:id/messages
GET  /api/chat/agents
```

### 4. Still worth doing

- The terminal allowlist is a safety net, not a sandbox — keep
  `ENABLE_TERMINAL=false` unless you need it.
- `public/index.html` is still one large file; splitting the JS out lets you drop
  `'unsafe-inline'` from the CSP in `server.js`.
- Semantic memory (embeddings + pgvector) would let JARVIS recall older
  conversations, not just the current thread.
