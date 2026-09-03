// Full-screen capture for the "what's on my screen" vision feature.
// screenshot-desktop shells out to the OS's own screenshot mechanism
// (a small bundled utility on Windows, `screencapture` on macOS, a
// system tool on Linux) rather than needing a native Node addon compiled
// for this machine — same "no node-gyp" preference as the rest of utils/.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let screenshot;
try {
  // eslint-disable-next-line global-require
  screenshot = require('screenshot-desktop');
} catch {
  screenshot = null;
}

async function captureScreen() {
  if (!screenshot) {
    return { ok: false, error: 'screenshot-desktop is not installed — run "npm install" after pulling this update.' };
  }
  const tmpFile = path.join(os.tmpdir(), `jarvis-screen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`);
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Screen capture timed out after 10s — is a display attached?')), 10000));
    await Promise.race([screenshot({ filename: tmpFile, format: 'png' }), timeout]);
    const buffer = fs.readFileSync(tmpFile);
    return { ok: true, buffer, mimeType: 'image/png' };
  } catch (err) {
    return { ok: false, error: `Screen capture failed: ${err.message}` };
  } finally {
    // Best-effort cleanup — never let a stray temp file block the response.
    fs.unlink(tmpFile, () => {});
  }
}

module.exports = { captureScreen };
