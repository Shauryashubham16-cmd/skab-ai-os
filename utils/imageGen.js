// Real image generation. Tries OpenAI's Images API, then Gemini's image
// model, whichever has a key configured in .env — both env vars
// (OPENAI_API_KEY, GEMINI_API_KEY) already exist in this project for chat/
// vision/embeddings, so if either is already filled in, this works with no
// further setup. Every branch below makes a real HTTP call; there is no
// stub path. The only thing between "not wired" and "fully working" is a
// key in .env — no code changes needed on either side of that.
//
// Deliberately not adding a new SDK dependency for this: both calls are a
// single POST, so plain axios (already a dependency) covers it without
// pulling in provider-specific client libraries for a feature that's off
// until a key exists anyway.
const axios = require('axios');

const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const TIMEOUT_MS = 60000;

function configuredProviders() {
  const list = [];
  if (process.env.OPENAI_API_KEY) list.push('openai');
  if (process.env.GEMINI_API_KEY) list.push('gemini');
  return list;
}

async function viaOpenAI(prompt, { size = '1024x1024' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await axios.post(
    'https://api.openai.com/v1/images/generations',
    { model: OPENAI_IMAGE_MODEL, prompt, size, n: 1 },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS },
  );
  const item = res.data?.data?.[0];
  if (item?.b64_json) return { imageBase64: item.b64_json, mimeType: 'image/png', provider: 'openai', model: OPENAI_IMAGE_MODEL };
  if (item?.url) return { imageUrl: item.url, provider: 'openai', model: OPENAI_IMAGE_MODEL };
  throw new Error('OpenAI image response did not include any image data.');
}

async function viaGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } },
    { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS },
  );
  const parts = res.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) {
    const textPart = parts.find((p) => p.text)?.text;
    throw new Error(textPart ? `Gemini declined to generate an image: ${textPart.slice(0, 200)}` : 'Gemini response did not include any image data.');
  }
  return { imageBase64: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType || 'image/png', provider: 'gemini', model: GEMINI_IMAGE_MODEL };
}

const PROVIDERS = { openai: viaOpenAI, gemini: viaGemini };

// Tries every configured provider in order (OpenAI first — the most
// standard image API — then Gemini), returning the first success. Collects
// each attempt's error so a total failure explains what was actually tried,
// rather than just "it didn't work".
async function generateImage(prompt, opts = {}) {
  const available = configuredProviders();
  if (!available.length) {
    return {
      ok: false,
      error: 'No image-generation key configured. Set OPENAI_API_KEY or GEMINI_API_KEY in .env (both are already used for chat/vision, so you may already have one) — nothing else needs to change once a key is present.',
    };
  }
  const attempts = [];
  for (const name of available) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await PROVIDERS[name](prompt, opts);
      return { ok: true, prompt, ...result };
    } catch (err) {
      attempts.push(`${name}: ${err.response?.data?.error?.message || err.message}`);
    }
  }
  return { ok: false, error: `Every configured image provider failed. ${attempts.join(' | ')}` };
}

module.exports = { generateImage, configuredProviders };
