// Smart file search — filename match and (bounded) content match, both
// confined to an allowlist of root directories. This never searches the
// whole disk: FILE_SEARCH_ROOTS in .env sets the allowed roots explicitly,
// and without it, only the user's own Desktop/Documents/Downloads are used.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROOTS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
].filter((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

function allowedRoots() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const configured = (process.env.FILE_SEARCH_ROOTS || '')
    .split(sep).map((s) => s.trim()).filter(Boolean);
  const roots = configured.length ? configured : DEFAULT_ROOTS;
  return roots
    .map((r) => path.resolve(r))
    .filter((r) => {
      try { return fs.statSync(r).isDirectory(); } catch { return false; }
    });
}

function rootsContaining(target) {
  if (!target) return allowedRoots();
  const resolved = path.resolve(target);
  return allowedRoots().filter((r) => resolved === r || resolved.startsWith(r + path.sep));
}

function isUnderAllowedRoot(target) {
  const resolved = path.resolve(target);
  return allowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

const SKIP_DIRS = new Set(['node_modules', '.git', '$Recycle.Bin', 'System Volume Information', '.jarvis']);
const MAX_RESULTS = 200;
const MAX_ENTRIES_SCANNED = 20000;
const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024; // skip anything bigger for content search
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.csv', '.log', '.py',
  '.java', '.c', '.cpp', '.h', '.html', '.css', '.yml', '.yaml', '.xml', '.ini', '.conf',
]);

function* walk(root, maxDepth = 8) {
  const stack = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (scanned++ > MAX_ENTRIES_SCANNED) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

function searchByName(query, { root } = {}) {
  const roots = rootsContaining(root);
  if (!roots.length) {
    return { ok: false, error: root ? `"${root}" is not inside an allowed search root.` : 'No allowed search roots exist on this machine — set FILE_SEARCH_ROOTS in .env.' };
  }
  const needle = query.toLowerCase();
  const results = [];
  const deadline = Date.now() + 8000;
  outer:
  for (const r of roots) {
    for (const file of walk(r)) {
      if (Date.now() > deadline) break outer;
      if (path.basename(file).toLowerCase().includes(needle)) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        results.push({ path: file, name: path.basename(file), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
        if (results.length >= MAX_RESULTS) break outer;
      }
    }
  }
  return { ok: true, count: results.length, results, roots };
}

function searchByContent(query, { root, extensions } = {}) {
  const roots = rootsContaining(root);
  if (!roots.length) {
    return { ok: false, error: root ? `"${root}" is not inside an allowed search root.` : 'No allowed search roots exist on this machine — set FILE_SEARCH_ROOTS in .env.' };
  }
  const needle = query.toLowerCase();
  const allowedExt = extensions?.length ? new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())) : TEXT_EXTENSIONS;
  const results = [];
  const deadline = Date.now() + 10000;
  outer:
  for (const r of roots) {
    for (const file of walk(r)) {
      if (Date.now() > deadline) break outer;
      if (!allowedExt.has(path.extname(file).toLowerCase())) continue;
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.size > MAX_CONTENT_FILE_BYTES) continue;
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const idx = content.toLowerCase().indexOf(needle);
      if (idx !== -1) {
        const start = Math.max(0, idx - 60);
        const snippet = content.slice(start, idx + needle.length + 60).replace(/\s+/g, ' ').trim();
        results.push({ path: file, name: path.basename(file), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), snippet });
        if (results.length >= MAX_RESULTS) break outer;
      }
    }
  }
  return { ok: true, count: results.length, results, roots };
}

// Opens a file (or reveals it in the file manager). Caller must have already
// checked isUnderAllowedRoot(target) — this function trusts that check has
// happened, since both the HTTP route and the tool registry enforce it
// themselves before calling this.
function openPath(target, { reveal = false } = {}) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      if (reveal) spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
      else spawn('cmd.exe', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', reveal ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, path: target, state: 'open-requested' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { allowedRoots, isUnderAllowedRoot, searchByName, searchByContent, openPath };
