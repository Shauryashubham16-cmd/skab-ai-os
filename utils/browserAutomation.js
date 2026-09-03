// Browser automation — navigate, click, type, read, scroll, tabs, downloads,
// and a real verify step. Uses playwright-core (not the full `playwright`
// package) against the system's already-installed Chrome or Edge via
// Playwright's "channel" mode, so there is no ~300MB Chromium download on
// npm install.
//
// Gated behind automationGuard's "browser" switch (off by default), same as
// inputControl.js, and every call goes through the shared audit trail. Runs
// headed (a visible window) by default — set BROWSER_HEADLESS=true in .env
// to hide it, but a visible window is the honest default for something
// acting on your behalf.
let chromium;
try {
  // eslint-disable-next-line global-require
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

const path = require('path');
const os = require('os');
const audit = require('./audit');
const automationGuard = require('./automationGuard');

const NAV_TIMEOUT_MS = 20000;
const ACTION_TIMEOUT_MS = 8000;
const MAX_TEXT_CHARS = 8000;
const DOWNLOAD_TIMEOUT_MS = 30000;

let browser = null;
let context = null;
// Multiple tabs, tracked as an ordered list + which one is "active" (the
// one every other function in this file acts on unless a tab tool says
// otherwise). A closed tab is spliced out; the active index is clamped back
// onto whatever's left.
let pages = [];
let activeIndex = 0;

const DISABLED = { ok: false, error: 'Browser automation is disabled. Enable it with POST /api/browser/enable ({"enabled":true}) or ENABLE_BROWSER_AUTOMATION=true in .env.' };
const NOT_INSTALLED = { ok: false, error: 'playwright-core is not installed — run "npm install" after pulling this update.' };

function guardOrThrow() {
  if (!chromium) return NOT_INSTALLED;
  if (!automationGuard.isEnabled('browser')) return DISABLED;
  return null;
}

function log(action, args, result) {
  audit.record({
    type: 'browser',
    action,
    args,
    ok: result.ok !== false,
    summary: result.ok === false ? `Browser ${action} failed: ${result.error}` : `Browser: ${action}${args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}`,
  });
}

// Downloads save into the same Downloads folder utils/fileSearch.js already
// treats as an allowed root by default — so anything the browser downloads
// is immediately findable/openable via files.search / files.open too,
// rather than landing in some separate app-private folder.
function downloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

async function ensureContext() {
  if (context && browser && browser.isConnected()) return context;
  const headless = process.env.BROWSER_HEADLESS === 'true';
  let lastErr;
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!browser) {
    throw new Error(`Could not launch a system browser (tried Chrome, Edge): ${lastErr?.message}. Install Chrome or Edge, or set PLAYWRIGHT_CHANNEL in .env.`);
  }
  context = await browser.newContext({ acceptDownloads: true });
  pages = [];
  activeIndex = 0;
  return context;
}

// The tab every function below acts on. Creates a first tab on first use;
// if the previously-active tab was closed some other way, falls back to
// whichever tab is still open, or opens a fresh one if none are.
async function activePage() {
  await ensureContext();
  if (pages[activeIndex] && !pages[activeIndex].isClosed()) return pages[activeIndex];
  const openIndex = pages.findIndex((p) => p && !p.isClosed());
  if (openIndex !== -1) {
    activeIndex = openIndex;
    return pages[activeIndex];
  }
  const p = await context.newPage();
  pages = [p];
  activeIndex = 0;
  return p;
}

// Backward-compatible alias — every pre-existing call site in this file
// used `ensurePage()`; keep the name working while the rest gains tabs.
async function ensurePage() {
  return activePage();
}

// http/https only — file:// would let a compromised or misdirected agent
// read arbitrary local files through the DOM, which is a real exfiltration
// path this assistant has no business opening.
function assertSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Only http/https URLs are allowed (got "${parsed.protocol}").`);
  }
  return parsed;
}

async function navigate(url) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    assertSafeUrl(url);
    const p = await ensurePage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const result = { ok: true, url: p.url(), title: await p.title() };
    log('navigate', { url }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('navigate', { url }, result);
    return result;
  }
}

async function click(selector) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await ensurePage();
    await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
    const result = { ok: true, url: p.url() };
    log('click', { selector }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('click', { selector }, result);
    return result;
  }
}

async function typeInto(selector, text) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await ensurePage();
    await p.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    const result = { ok: true, url: p.url() };
    log('type', { selector, length: text.length }, result); // never log the typed text itself
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('type', { selector, length: text.length }, result);
    return result;
  }
}

async function getText(selector) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await ensurePage();
    const text = selector ? await p.innerText(selector, { timeout: ACTION_TIMEOUT_MS }) : await p.innerText('body', { timeout: ACTION_TIMEOUT_MS });
    const truncated = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…[truncated]` : text;
    const result = { ok: true, text: truncated, url: p.url() };
    log('getText', { selector }, { ok: true });
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('getText', { selector }, result);
    return result;
  }
}

async function screenshot() {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await ensurePage();
    const buffer = await p.screenshot({ type: 'png' });
    log('screenshot', {}, { ok: true });
    return { ok: true, buffer, mimeType: 'image/png' };
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('screenshot', {}, result);
    return result;
  }
}

async function status() {
  const p = pages[activeIndex];
  const running = Boolean(p && !p.isClosed());
  return { ok: true, running, url: running ? p.url() : null, tabCount: pages.filter((pg) => pg && !pg.isClosed()).length };
}

async function close() {
  try {
    if (browser) await browser.close();
  } finally {
    browser = null; context = null; pages = []; activeIndex = 0;
  }
  log('close', {}, { ok: true });
  return { ok: true, closed: true };
}

// ---------------- Scroll ----------------
async function scroll({ selector, direction = 'down', amount = 600 } = {}) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await activePage();
    if (selector) {
      await p.locator(selector).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    } else {
      const dy = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
      await p.mouse.wheel(0, dy);
    }
    const result = { ok: true, url: p.url() };
    log('scroll', { selector, direction, amount }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('scroll', { selector, direction, amount }, result);
    return result;
  }
}

// ---------------- Tabs ----------------
async function listTabs() {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  await ensureContext();
  const open = pages.map((p, i) => ({ p, i })).filter(({ p }) => p && !p.isClosed());
  const tabs = await Promise.all(open.map(async ({ p, i }) => ({
    index: i, url: p.url(), title: await p.title().catch(() => ''), active: i === activeIndex,
  })));
  return { ok: true, tabs };
}

async function newTab(url) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    await ensureContext();
    if (url) assertSafeUrl(url);
    const p = await context.newPage();
    pages.push(p);
    activeIndex = pages.length - 1;
    if (url) await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const result = { ok: true, index: activeIndex, url: p.url() };
    log('newTab', { url }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('newTab', { url }, result);
    return result;
  }
}

async function switchTab(index) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  if (!pages[index] || pages[index].isClosed()) {
    const result = { ok: false, error: `No open tab at index ${index}.` };
    log('switchTab', { index }, result);
    return result;
  }
  activeIndex = index;
  const result = { ok: true, index, url: pages[index].url() };
  log('switchTab', { index }, result);
  return result;
}

async function closeTab(index) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  if (!pages[index]) {
    const result = { ok: false, error: `No tab at index ${index}.` };
    log('closeTab', { index }, result);
    return result;
  }
  try {
    if (!pages[index].isClosed()) await pages[index].close();
    pages.splice(index, 1);
    if (activeIndex >= pages.length) activeIndex = Math.max(0, pages.length - 1);
    const result = { ok: true, remaining: pages.length };
    log('closeTab', { index }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('closeTab', { index }, result);
    return result;
  }
}

// ---------------- Download ----------------
// Triggers a download either by clicking a selector (a "Download" button/
// link) or by navigating directly to a file URL, waits for Playwright's
// download event, and saves it into the real Downloads folder under its
// suggested filename — so it shows up exactly where a human-initiated
// download would, and is immediately reachable via files.search/files.open.
async function download({ selector, url } = {}) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await activePage();
    const [dl] = await Promise.all([
      p.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
      selector ? p.click(selector, { timeout: ACTION_TIMEOUT_MS }) : (() => { assertSafeUrl(url); return p.goto(url, { timeout: NAV_TIMEOUT_MS }).catch(() => {}); })(),
    ]);
    const filename = dl.suggestedFilename();
    const dest = path.join(downloadsDir(), filename);
    await dl.saveAs(dest);
    const result = { ok: true, filename, path: dest };
    log('download', { selector, url }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('download', { selector, url }, result);
    return result;
  }
}

// ---------------- Verify ----------------
// A real "did that actually work" check, rather than assuming a click/type/
// navigate that didn't throw means success. Checks whatever combination of
// URL/selector/text conditions is given and reports which ones matched.
async function verify({ textContains, urlContains, selectorExists } = {}) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const p = await activePage();
    const url = p.url();
    const checks = [];
    let matched = true;

    if (urlContains) {
      const ok = url.includes(urlContains);
      matched = matched && ok;
      checks.push({ check: 'urlContains', expected: urlContains, ok });
    }
    if (selectorExists) {
      const count = await p.locator(selectorExists).count();
      const ok = count > 0;
      matched = matched && ok;
      checks.push({ check: 'selectorExists', expected: selectorExists, ok, count });
    }
    if (textContains) {
      const body = await p.innerText('body', { timeout: ACTION_TIMEOUT_MS });
      const ok = body.includes(textContains);
      matched = matched && ok;
      checks.push({ check: 'textContains', expected: textContains, ok });
    }

    const result = { ok: true, matched, checks, url };
    log('verify', { textContains, urlContains, selectorExists }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    log('verify', { textContains, urlContains, selectorExists }, result);
    return result;
  }
}

module.exports = {
  navigate, click, typeInto, getText, screenshot, status, close,
  scroll, listTabs, newTab, switchTab, closeTab, download, verify,
};
