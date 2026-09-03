// The actual "look at this image" logic, shared by routes/vision.js and the
// task-engine tool registry so both call one implementation.
const crypto = require('crypto');
const { captureScreen } = require('./screenCapture');
const { recognizeText, recognizeDetailed } = require('./ocr');
const { visionCompletion } = require('./llmProviders');

let PNG;
try {
  // eslint-disable-next-line global-require
  ({ PNG } = require('pngjs'));
} catch {
  PNG = null;
}

const SNAPSHOT_TTL_MS = 10 * 60 * 1000; // stale snapshots (e.g. an abandoned
                                          // before/after check) are cleared
                                          // rather than held in memory forever
// snapshotId -> { buffer, mimeType, takenAt }
const snapshots = new Map();

function sweepSnapshots() {
  const now = Date.now();
  for (const [id, snap] of snapshots) {
    if (now - snap.takenAt > SNAPSHOT_TTL_MS) snapshots.delete(id);
  }
}

async function analyzeBuffer(buffer, mimeType, { mode = 'describe', question } = {}) {
  const result = { ok: true, mode };

  if (mode === 'ocr' || mode === 'both') {
    result.ocr = await recognizeText(buffer);
  }

  if (mode === 'describe' || mode === 'both') {
    const base64 = buffer.toString('base64');
    const prompt = question
      ? `Answer this question about the attached image: ${question}`
      : 'Describe what is visible in this image in a few clear sentences — focus on the active application, any visible text, errors, or notable UI state. Do not invent details you cannot actually see.';
    try {
      const vision = await visionCompletion(base64, mimeType, prompt);
      result.description = vision.reply;
      result.provider = vision.provider;
    } catch (err) {
      result.descriptionError = err.message;
    }
  }

  return result;
}

async function analyzeScreen(opts) {
  const capture = await captureScreen();
  if (!capture.ok) return capture;
  return analyzeBuffer(capture.buffer, capture.mimeType, opts);
}

// ---------------- UI-element / coordinate detection ----------------
// OCR-based, not a general object-detection model: this finds an element by
// matching its VISIBLE TEXT against what Tesseract read off the screen, and
// returns the real pixel coordinates of that text's bounding box. That
// covers the plan's actual example ("Click the Download button" — the word
// "Download" is visible text) honestly; it will not find a button that's an
// icon with no label. Pair the returned `center` with input.click/moveMouse.
function bestWordMatch(words, needle) {
  const exact = words.find((w) => w.text.trim().toLowerCase() === needle);
  if (exact) return exact;
  // Prefer the highest-confidence partial match rather than the first one —
  // OCR often produces several near-misses (e.g. "Downloa" cut off by an
  // icon) and confidence is the best signal for which one is real.
  const partial = words
    .filter((w) => w.text && (w.text.toLowerCase().includes(needle) || needle.includes(w.text.toLowerCase())))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return partial[0] || null;
}

async function findElement(text, { source } = {}) {
  if (!text || !text.trim()) return { ok: false, error: 'text is required.' };
  let buffer = source;
  let mimeType = 'image/png';
  if (!buffer) {
    const capture = await captureScreen();
    if (!capture.ok) return capture;
    ({ buffer } = capture);
    ({ mimeType } = capture);
  }
  const ocr = await recognizeDetailed(buffer);
  if (!ocr.ok) return ocr;

  const needle = text.trim().toLowerCase();
  let match = bestWordMatch(ocr.words, needle);
  let matchedText = match?.text;
  if (!match) {
    // multi-word phrases ("Save Changes") won't match a single OCR word —
    // fall back to whole-line text, which Tesseract groups on its own.
    const line = (ocr.lines || []).find((l) => l.text.toLowerCase().includes(needle));
    if (line) { match = line; matchedText = line.text; }
  }
  if (!match) {
    return {
      ok: true, matched: false, text,
      candidates: ocr.words.slice(0, 25).map((w) => w.text).filter(Boolean),
    };
  }
  const { x0, y0, x1, y1 } = match.bbox;
  return {
    ok: true, matched: true, text: matchedText,
    bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    center: { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) },
    confidence: match.confidence ?? null,
    mimeType,
  };
}

// ---------------- Before/after screenshot verification ----------------
// A real pixel-level diff (not an LLM guessing from a description) — takes
// a snapshot now, and later compares a fresh capture against it, reporting
// what fraction of pixels changed and the bounding box of the changed
// region. This is the "screenshot comparison / before-after verification"
// item from the plan: click something, then actually confirm the screen
// changed, rather than trusting that a click that didn't throw worked.
function takeSnapshot() {
  return captureScreen().then((capture) => {
    if (!capture.ok) return capture;
    sweepSnapshots();
    const snapshotId = crypto.randomUUID();
    snapshots.set(snapshotId, { buffer: capture.buffer, mimeType: capture.mimeType, takenAt: Date.now() });
    return { ok: true, snapshotId, takenAt: Date.now() };
  });
}

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

// Per-pixel RGB distance summed across the image; a pixel counts as
// "changed" once its combined channel delta passes `threshold`. Pure JS —
// a full 1080p frame is ~2M pixels, which is a few hundred ms, fine for an
// occasional verify step rather than something called every frame.
function diffPngBuffers(bufferA, bufferB, threshold) {
  const a = decodePng(bufferA);
  const b = decodePng(bufferB);
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, changedPercent: null, changedPixels: null, totalPixels: null, bbox: null, note: 'Screen resolution changed between snapshots — treated as changed.' };
  }
  const { width, height } = a;
  let changedPixels = 0;
  let minX = width; let minY = height; let maxX = 0; let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      const delta = Math.abs(a.data[idx] - b.data[idx]) + Math.abs(a.data[idx + 1] - b.data[idx + 1]) + Math.abs(a.data[idx + 2] - b.data[idx + 2]);
      if (delta > threshold) {
        changedPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const totalPixels = width * height;
  const changedPercent = Number(((changedPixels / totalPixels) * 100).toFixed(3));
  return {
    changed: changedPercent > 0.05, // >0.05% of pixels is "something visibly happened", not noise
    changedPixels, totalPixels, changedPercent,
    bbox: changedPixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

async function compareToSnapshot(snapshotId, { threshold = 20, keep = false } = {}) {
  if (!PNG) return { ok: false, error: 'pngjs is not installed — run "npm install" after pulling this update.' };
  sweepSnapshots();
  const before = snapshots.get(snapshotId);
  if (!before) return { ok: false, error: 'That snapshot no longer exists (it may have expired after 10 minutes, or already been used).' };
  const after = await captureScreen();
  if (!after.ok) return after;
  try {
    const diff = diffPngBuffers(before.buffer, after.buffer, threshold);
    if (!keep) snapshots.delete(snapshotId);
    return { ok: true, ...diff };
  } catch (err) {
    return { ok: false, error: `Screenshot comparison failed: ${err.message}` };
  }
}

module.exports = { analyzeBuffer, analyzeScreen, findElement, takeSnapshot, compareToSnapshot };
