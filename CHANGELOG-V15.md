# V15 — Privileged-action layer, standardized tool contract, provider health, hardening

## What this is
A security/reliability hardening pass, built in ordered phases on top of
V14.5. Nothing about the HUD, chat, or existing tool behavior changed for a
user with every capability left at its default (off) — this pass is about
*how* every privileged action is authorized and *what* proves it's still
safe, not new user-facing features.

## 1. Centralized privileged-action layer — `utils/permissions.js`
Before this pass, "is this allowed right now" was answered in five
different places with five different shapes: `automationGuard`'s on/off
switches (input/browser), `pluginLoader`'s dangerous-permission gate,
`systemControl`'s own confirmation flow, `terminal.js`'s `ENABLE_TERMINAL`
check, and `toolRegistry.js`'s built-in `TOOLS` map, which had no
permission concept at all — every built-in tool was implicitly trusted.

`utils/permissions.js` is now the single source of truth. Three
permission tiers (`read` / `standard` / `dangerous`), four capability
flags (`terminal`, `input`, `browser`, `pluginDangerous`), each toggleable
at runtime (not just via `.env`) and kept in sync with `process.env` so
existing log lines and docs stay honest. One function, `authorize(name,
meta)`, decides whether a call is allowed — every tool routes through it.

`utils/automationGuard.js` is kept as a thin backward-compatible wrapper
over the two capabilities it already covered (`input`, `browser`), so
`POST /api/input/enable` / `POST /api/browser/enable` and every existing
caller keep working unchanged.

`utils/terminal.js` now calls `permissions.authorize('terminal.run', ...)`
instead of checking `process.env.ENABLE_TERMINAL` directly, and logs
blocked/successful commands to the audit trail (`utils/audit.js`).

## 2. Standardized tool schema & execution contract — `utils/toolRegistry.js`
Every one of the 37 built-in tools (plus any plugin tool registered via
`registerTool`) now declares the same shape:
```
{ describe, permission, requiresCapability, argsSchema, execute(args, ctx) }
```
`runTool()` — the single entry point the task-engine planner uses, and the
shape any future caller should use — now always does, in this order:
1. look the tool up
2. **authorize** it (`utils/permissions.js`)
3. **validate** its args against `argsSchema` (zod)
4. only then call `execute()`, catching any thrown error into `{ ok:
   false, error }` rather than letting it propagate

This closes a real gap: a REST route already validated its own request
body via its own zod schema, but a step in an LLM-planned task
(`utils/taskEngine.js` → `runTool(step.tool, step.args, ctx)`) had its
args go straight from the LLM's JSON into `execute()`, completely
unvalidated. Both entry points now get identical guarantees.

Plugin tools get a permissive default schema (`z.object({}).passthrough()`)
unless a plugin opts into a stricter one, and a plugin dangerous permission
now also declares `requiresCapability: 'pluginDangerous'`, making it
visible to `permissions.authorize()` the same way a built-in dangerous
tool is — belt-and-suspenders with `pluginLoader.js`'s own existing env
check in `wrapExecute`.

New: `GET /api/agent/tools` lists every tool (built-in and plugin) with its
declared permission and the current capability status — the tool catalog
is now inspectable, not just enforced.

## 3-5. Tests
65 new tests, all passing alongside the pre-existing 71 (136 total via
`npm test`):
- `tests/permissions.test.js` — capability toggles, `authorize()` for
  every permission/capability combination, the dangerous-with-no-gate
  note.
- `tests/toolRegistry.test.js` — every built-in tool's permission is
  valid; `runTool()` authorizes before it validates args, and validates
  before executing; a plugin can't shadow a built-in name; a thrown error
  is caught, never propagates.
- `tests/terminal.test.js` — the block-list pattern by pattern (fork
  bombs, `dd`, `mkfs`, `rm -rf /`, Windows `format`/`reg delete`, false-
  positive check on "shut the door"), plus the capability gate.
- `tests/automation.test.js` — input/browser off by default, every mouse/
  keyboard action rejected while disabled, request schemas reject
  malformed coordinates/selectors/URLs.
- `tests/pluginLoader.test.js` — manifest validation (name pattern,
  permission enum), the built-in-name collision guard, and proof that a
  plugin marked `dangerous` loads but genuinely cannot execute until
  *both* `ENABLE_PLUGINS` and `ENABLE_PLUGIN_DANGEROUS_ACTIONS` are armed.
  Uses small fixture plugins under `tests/fixtures/plugins/` — `loadPlugins`
  and `reloadPlugins` in `pluginLoader.js` now accept an optional
  directory override for this, defaulting to the real `plugins/` dir.
- `tests/providerHealth.test.js` — configured-vs-reachable reporting,
  response caching, proof that Tavily/Exa are never live-pinged. All
  network calls mocked via `node:test`'s built-in `mock` — no real
  internet access or API keys needed to run the suite.

## 6. Health/readiness checks for external providers — `utils/providerHealth.js`
New `GET /api/system/health/providers` (protected — makes real network
calls, unlike the public `/health`). Two questions per provider, kept
separate:
- **configured** — is a key present in `.env`? Free, synchronous.
- **reachable** — did a live call just now succeed? Costs a round trip,
  so it's cached for 30s and never attempted for an unconfigured provider.

Covers every configured LLM provider (a free `GET /models` ping — every
provider in `PROVIDER_DEFS` is OpenAI-compatible, so this is one code
path for all of them), ElevenLabs (`GET /v1/user`), Supabase (any HTTP
response from `/rest/v1/` counts as reachable, even a 401), and Open-Meteo
(keyless, public, safe to call every time modulo the cache). Tavily/Exa
report configured-only — a real check would spend a paid search credit,
so it's deliberately skipped (`NO_LIVE_PING`).

## 7. Electron hardening — `electron/main.js`
Baseline was already solid (`contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`). Added:
- `webviewTag: false`, `nodeIntegrationInSubFrames: false`,
  `allowRunningInsecureContent: false` on `webPreferences`.
- `will-navigate` blocked for anything outside `APP_URL`, applied to every
  `webContents` the app creates (not just the main window), so a future
  child surface can't skip it by forgetting to wire it up.
- `setWindowOpenHandler` only ever hands `http`/`https` targets to the OS
  browser via `shell.openExternal`; `file://`, `javascript:`, and custom
  schemes are dropped outright rather than passed through.
- `setPermissionRequestHandler` denies every browser permission prompt
  (camera, mic, geolocation, notifications) by default.
- DevTools blocked in **packaged** builds only (`F12`/`Ctrl+Shift+I`
  swallowed, `devtools-opened` immediately closes it) — still works
  normally in `npm run electron` dev mode.

## 8. Dependency scanning + CI — `.github/workflows/ci.yml`
- Test job across Node 18.x/20.x on every push/PR to `main`.
- `npm audit --audit-level=high` (blocking) plus a non-blocking full
  report for visibility into moderate/low findings.
- GitHub's `dependency-review-action` on PRs — flags a newly-introduced
  vulnerable or incompatibly-licensed dependency before merge.
- A weekly CodeQL scan (`javascript`) on top of the dependency scan —
  looks at JARVIS's own code, not just third-party packages, for the bug
  classes that matter most here (command injection, path traversal, SSRF)
  given what `utils/terminal.js`, `utils/fileSearch.js`, and
  `utils/browserAutomation.js` already do.
- Fixed a pre-existing bug found along the way: `npm test` itself
  (`node --test tests/`) silently failed to discover any test file on
  this Node version — passing a bare directory to `node --test` doesn't
  reliably auto-discover; `package.json`'s `test` script now uses an
  explicit glob (`node --test "tests/**/*.test.js"`).

## Verified
- Full suite (136 tests) green via `npm test`.
- `npm audit` — 0 known vulnerabilities in current dependencies.
- Booted the server for real (`node server.js`) and hit both new
  endpoints (`GET /api/agent/tools`, `GET /api/system/health/providers`)
  with a real passcode-issued token — both returned correct, well-shaped
  JSON end to end.

## Not done in this pass
- No git remote is set up for this repo yet — CI workflow is in place but
  won't actually run until the repo is pushed to GitHub.
- `public/index.html`'s `'unsafe-inline'` CSP allowance (noted in an
  earlier changelog) is still open — unrelated to this pass, real effort.
