// Text extraction from images via tesseract.js (pure JS/WASM — no native
// build step). The English trained-data file (a few MB) is fetched once on
// first use and cached under ~/.jarvis/tesseract-cache, so the very first OCR
// call needs internet access; every call after that works fully offline.
const path = require('path');
const os = require('os');

let Tesseract;
try {
  // eslint-disable-next-line global-require
  Tesseract = require('tesseract.js');
} catch {
  Tesseract = null;
}

const CACHE_PATH = path.join(os.homedir(), '.jarvis', 'tesseract-cache');

async function recognizeText(buffer, { lang = 'eng' } = {}) {
  if (!Tesseract) {
    return { ok: false, error: 'tesseract.js is not installed — run "npm install" after pulling this update.' };
  }
  let worker;
  try {
    worker = await Tesseract.createWorker(lang, undefined, { cachePath: CACHE_PATH });
    const { data } = await worker.recognize(buffer);
    return { ok: true, text: (data.text || '').trim(), confidence: data.confidence ?? null };
  } catch (err) {
    return { ok: false, error: `OCR failed: ${err.message}` };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

// Same OCR pass as recognizeText, but keeps the word/line bounding boxes
// Tesseract already computes internally — this is what makes
// visionService.findElement() possible (locate a UI element by its visible
// text and get real screen coordinates back), rather than only ever
// returning a flat transcript.
async function recognizeDetailed(buffer, { lang = 'eng' } = {}) {
  if (!Tesseract) {
    return { ok: false, error: 'tesseract.js is not installed — run "npm install" after pulling this update.' };
  }
  let worker;
  try {
    worker = await Tesseract.createWorker(lang, undefined, { cachePath: CACHE_PATH });
    const { data } = await worker.recognize(buffer);
    const words = (data.words || []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }));
    const lines = (data.lines || []).map((l) => ({ text: l.text.trim(), confidence: l.confidence, bbox: l.bbox }));
    return { ok: true, text: (data.text || '').trim(), words, lines };
  } catch (err) {
    return { ok: false, error: `OCR failed: ${err.message}` };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

module.exports = { recognizeText, recognizeDetailed };
