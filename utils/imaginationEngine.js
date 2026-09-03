// Phase 4 — Imagination Engine. Converts a text description (or a real
// screen description, via visionService) into a structured 3D scene graph:
// a small JSON list of primitive objects (boxes, cylinders, cones, spheres)
// with position/scale/color, that public/index.html's Three.js viewer
// builds an actual interactive scene from — rotate, zoom, pan, not a flat
// generated image. "Add drones" / "make it nighttime" / "add flying cars"
// are handled by editScene(), which takes the CURRENT graph plus the new
// instruction and returns the updated graph, so a conversation can build a
// scene up incrementally exactly like the plan describes.
//
// This 3D scene graph is the key-free, always-available mode. A second,
// separate mode — an actual generated image — lives in utils/imageGen.js
// and routes/imagination.js's POST /image, for when a flat picture is what
// the user actually wants instead of an interactive scene; that one needs
// OPENAI_API_KEY or GEMINI_API_KEY. This file doesn't call it directly, to
// keep the scene-graph path usable with zero image-gen key configured.
const { chatCompletion } = require('./llmProviders');
const { extractJson } = require('./agents');
const { analyzeScreen } = require('./visionService');

const OBJECT_TYPES = ['building', 'tower', 'tree', 'drone', 'car', 'flyingCar', 'road', 'panel', 'person', 'water', 'sphere', 'box'];
const SKY_TYPES = ['day', 'night', 'dusk'];
const GROUND_TYPES = ['grass', 'concrete', 'water', 'sand'];
const MAX_OBJECTS = 24;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
}

// Shared by proposeScene/editScene so a scene coming back from either path
// (or a client-supplied one on the edit endpoint) always has the same safe,
// renderer-friendly shape — bad/missing fields get sane defaults rather than
// rejecting the whole scene, since a partially-honored request is far more
// useful here than an error.
function sanitizeScene(raw) {
  const sky = SKY_TYPES.includes(raw?.sky) ? raw.sky : 'day';
  const ground = {
    color: typeof raw?.ground?.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.ground.color) ? raw.ground.color : '#3a6b4a',
    type: GROUND_TYPES.includes(raw?.ground?.type) ? raw.ground.type : 'grass',
  };
  const objects = (Array.isArray(raw?.objects) ? raw.objects : [])
    .filter((o) => o && OBJECT_TYPES.includes(o.type))
    .slice(0, MAX_OBJECTS)
    .map((o, i) => ({
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 40) : `obj-${i}`,
      type: o.type,
      x: clamp(Number(o.x), -25, 25),
      y: clamp(Number(o.y), 0, 20),
      z: clamp(Number(o.z), -25, 25),
      scale: clamp(Number(o.scale) || 1, 0.2, 6),
      color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#8899aa',
      rotationY: Number.isFinite(Number(o.rotationY)) ? Number(o.rotationY) : 0,
      label: typeof o.label === 'string' ? o.label.slice(0, 40) : '',
    }));
  return { sky, ground, objects, notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 200) : '' };
}

const SCENE_SHAPE = `{"sky":"day"|"night"|"dusk","ground":{"color":"#hex","type":"grass"|"concrete"|"water"|"sand"},"objects":[{"id":"short-slug","type":"building"|"tower"|"tree"|"drone"|"car"|"flyingCar"|"road"|"panel"|"person"|"water"|"sphere"|"box","x":number,"y":number,"z":number,"scale":number,"color":"#hex","rotationY":number,"label":"<=3 words"}],"notes":"<=20 words"}`;

const CREATE_PROMPT = `You are the imagination engine of a desktop AI assistant. Convert the user's
description into a JSON 3D scene graph that a renderer builds from simple primitive shapes (boxes,
cylinders, cones, spheres) — think clean low-poly/blocky diorama, not photorealistic detail, since
detail has to come through color and arrangement, not texture.

Object types available (the renderer has ONLY these — pick the closest match):
- building: a box tower, good default for structures
- tower: a taller, thinner box/cylinder
- tree: cone-on-cylinder
- drone: small sphere-ish shape that hovers (use y > 2)
- car: small box at ground level (y = 0)
- flyingCar: like car but hovering (use y > 1)
- road: flat wide box at y = 0
- panel: flat tilted box (solar panel, screen, sign)
- person: small simple humanoid box stack
- water: flat plane-like box, usually blended with ground.type "water" instead for large bodies
- sphere: generic sphere (planet, ball, dome)
- box: generic fallback box for anything else

Reply with ONLY a JSON object, no prose, no code fence, matching exactly this shape:
${SCENE_SHAPE}

Rules:
- x and z roughly within -20..20, y is height above ground (0 for ground-level objects).
- Use at most ${MAX_OBJECTS} objects — prefer a few well-placed ones over clutter.
- Vary color per object to read clearly (do not make everything the same color).`;

const EDIT_PROMPT = `You are editing an existing 3D scene graph (same shape as before) based on a new
instruction. Return the FULL updated scene graph — not a diff — with the requested change applied
and everything else preserved exactly as-is unless the instruction implies otherwise (e.g. "make it
nighttime" changes "sky" and may darken colors, but should not remove existing objects).

Reply with ONLY the updated JSON object, no prose, no code fence, matching exactly this shape:
${SCENE_SHAPE}`;

async function proposeScene(prompt) {
  const { reply } = await chatCompletion(
    [
      { role: 'system', content: CREATE_PROMPT },
      { role: 'user', content: String(prompt).slice(0, 1000) },
    ],
    { maxTokens: 1400, temperature: 0.6, order: ['gemini', 'groq', 'openrouter', 'xai'] },
  );
  const parsed = extractJson(reply);
  if (!parsed) throw new Error('The imagination engine returned something that was not valid JSON.');
  return sanitizeScene(parsed);
}

async function editScene(currentScene, instruction) {
  const safeCurrent = sanitizeScene(currentScene || {});
  const { reply } = await chatCompletion(
    [
      { role: 'system', content: EDIT_PROMPT },
      { role: 'user', content: `Current scene:\n${JSON.stringify(safeCurrent)}\n\nInstruction: ${String(instruction).slice(0, 300)}` },
    ],
    { maxTokens: 1400, temperature: 0.5, order: ['gemini', 'groq', 'openrouter', 'xai'] },
  );
  const parsed = extractJson(reply);
  if (!parsed) throw new Error('The imagination engine returned something that was not valid JSON.');
  return sanitizeScene(parsed);
}

// "Jarvis sees your real screen -> understands it -> creates a visualization"
// — reuses the existing screen-capture + vision-description pipeline
// (utils/visionService.js), then hands that real description to
// proposeScene() as the prompt. No pixels are passed to the scene
// generator itself — only the vision model's text description of what it
// actually saw, same as everywhere else vision output is used downstream.
async function sceneFromScreen(instruction = '') {
  const seen = await analyzeScreen({
    mode: 'describe',
    question: 'Describe the layout, main elements, and colors of what is on screen in a few sentences, as if briefing someone who will recreate it as a simple 3D diorama. Do not invent anything you cannot actually see.',
  });
  if (seen.ok === false) throw new Error(seen.error || 'Could not capture the screen.');
  if (seen.descriptionError) throw new Error(seen.descriptionError);
  const prompt = instruction
    ? `Base a 3D scene on this real screenshot description: "${seen.description}". Apply this instruction too: ${instruction}`
    : `Base a 3D scene on this real screenshot description: "${seen.description}"`;
  const scene = await proposeScene(prompt);
  return { scene, sourceDescription: seen.description };
}

// Per-user "what scene are we looking at right now" — lets a bare follow-up
// like "add drones" or "make it nighttime" (routes/chat.js's /imagine
// command) edit the same scene across turns without the client having to
// resend the whole graph every time. In-memory only, same lifetime as the
// rest of this process's in-memory state (taskEngine's runs Map, etc.);
// swept on a TTL like taskEngine's own runs Map so a long-running server
// with many distinct users doesn't accumulate one entry per user forever.
const lastSceneByUser = new Map(); // userId -> { scene, updatedAt }
const SCENE_TTL_MS = 30 * 60 * 1000;

function sweepExpiredScenes() {
  const cutoff = Date.now() - SCENE_TTL_MS;
  for (const [userId, entry] of lastSceneByUser) {
    if (entry.updatedAt < cutoff) lastSceneByUser.delete(userId);
  }
}

function getLastScene(userId) {
  sweepExpiredScenes();
  return lastSceneByUser.get(userId)?.scene || null;
}

function setLastScene(userId, scene) {
  if (userId) lastSceneByUser.set(userId, { scene, updatedAt: Date.now() });
}

module.exports = {
  proposeScene, editScene, sceneFromScreen, sanitizeScene, OBJECT_TYPES, getLastScene, setLastScene,
};
