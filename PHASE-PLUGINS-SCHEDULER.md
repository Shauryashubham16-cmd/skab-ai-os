# Plugins + Scheduler + Emergency Stop + Browser Gaps

Closes four items left open after Phase 3–5: the plugin/extension system,
background/scheduled tasks, an emergency stop for a running task, and the
browser-agent gaps (scroll/tabs/download/verify) called out in the original
plan but never built. Nothing here needs a new API key — every one of these
runs entirely on infrastructure already in the project.

## 1. Plugin/extension system

New: `utils/pluginLoader.js`, `routes/plugins.js`, `plugins/dice-roll/` (a
working example), `registerTool()`/`clearPluginTools()` in `toolRegistry.js`.

- Drop a folder in `plugins/` with a `plugin.json` manifest (`name`,
  `description`, `permission`, `entry`) and an entry file exporting
  `execute(args, ctx)`, and it becomes a real tool the planner can put in a
  plan — same as `apps.open` or `system.status`. No other code changes.
- **Off by default** (`ENABLE_PLUGINS=false`) — plugin code runs in-process
  with full server privileges, same honest tradeoff the terminal already
  makes. A manifest can mark a tool `"permission":"dangerous"`, which stays
  blocked even with plugins enabled until `ENABLE_PLUGIN_DANGEROUS_ACTIONS=true`
  too.
- A plugin can never register a name that collides with a built-in tool —
  `registerTool()` rejects it outright.
- `GET /api/plugins` (loaded + any that failed, with why) and
  `POST /api/plugins/reload` (hot-reload without restarting the server).

## 2. Background + scheduled tasks

New: `utils/scheduler.js`; `taskEngine.runInBackground()`;
`POST /api/tasks/auto {background:true}`; `POST /api/tasks/schedule`,
`GET /api/tasks/scheduled`, `DELETE /api/tasks/scheduled/:id`.

- `background:true` on the existing `/api/tasks/auto` starts a goal without
  blocking the request — returns `{status:'queued', runId}` immediately,
  progress streams over the `/agent` socket exactly like a blocking run's
  does.
- `POST /api/tasks/schedule` takes either `{goal, at}` (ISO timestamp,
  one-off) or `{goal, everyMinutes}` (recurring, floor of 1 minute). A
  15-second ticker checks for due jobs and fires them via
  `runInBackground()`.
- **In-memory only** — like `taskEngine`'s own runs map and `utils/audit.js`,
  a server restart clears the schedule. Real, stated limitation, not hidden.
- No queue/concurrency limiter — each background/scheduled run starts right
  away. A deliberate scope choice for a single-user desktop assistant, not
  an oversight.

## 3. Emergency stop

New: `taskEngine.cancelRun()`; `POST /api/tasks/:runId/cancel`.

- Flags a runId; `runSequence` checks the flag before every step *and*
  before every correction attempt, so a run unwinds at the next safe point
  — never mid-tool-call.
- Works on a run that's queued, planning, mid-step, or mid-correction.
  Returns a clear error (404/403/409) for a run that's already finished or
  belongs to someone else.
- A cancelled run reports `status:'cancelled'` from `GET /api/tasks/:runId`,
  same shape as `completed`/`failed`/`timeout`.

## 4. Browser agent gaps

`utils/browserAutomation.js` rewritten from a single-page model to real
multi-tab tracking, closing every gap from the original plan's "Advanced
Browser Agent" list that wasn't already covered (navigate/click/type/read
already existed):

- `scroll` — by pixel amount, or scroll a selector into view
- `listTabs` / `newTab` / `switchTab` / `closeTab` — real multi-tab support
- `download` — click a selector or hit a URL, waits for the actual download
  event, saves into your real Downloads folder (so it's immediately
  findable via `files.search`/`files.open`, not some separate app folder)
- `verify` — the real "did that actually work" step: checks
  `urlContains`/`selectorExists`/`textContains` against the live page and
  reports which matched, instead of assuming no-exception means success

All six are new `toolRegistry.js` entries (`browser.scroll`,
`browser.tabs.list/new/switch/close`, `browser.download`, `browser.verify`)
and new REST endpoints in `routes/browser.js`, gated behind the same
`ENABLE_BROWSER_AUTOMATION` switch as everything else in that file.

## What's still open

Vision gaps (element/coordinate detection, before/after screenshot
comparison), clipboard + drag-and-drop, real image generation (needs a key),
and the frontend component split — see the README's "Suggested next steps".
