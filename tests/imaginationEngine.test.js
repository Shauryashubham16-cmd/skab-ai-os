// Covers sanitizeScene() — the one function in utils/imaginationEngine.js
// that's pure and load-bearing for safety: it's the only thing standing
// between whatever the LLM returns (or a client posts to POST
// /api/imagination/edit, which accepts an arbitrary object) and the
// Three.js renderer. No network/LLM calls happen in this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeScene, OBJECT_TYPES } = require('../utils/imaginationEngine');

test('sanitizeScene: fills in sane defaults for a completely empty input', () => {
  const scene = sanitizeScene({});
  assert.equal(scene.sky, 'day');
  assert.equal(scene.ground.type, 'grass');
  assert.match(scene.ground.color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(scene.objects, []);
});

test('sanitizeScene: rejects an unknown sky/ground type instead of passing it through', () => {
  const scene = sanitizeScene({ sky: 'purple-haze', ground: { type: 'lava', color: '#ff0000' } });
  assert.equal(scene.sky, 'day');
  assert.equal(scene.ground.type, 'grass'); // invalid type falls back...
  assert.equal(scene.ground.color, '#ff0000'); // ...but a valid color on the same object is kept
});

test('sanitizeScene: drops objects with an invalid/missing type', () => {
  const scene = sanitizeScene({ objects: [{ type: 'spaceship', x: 0 }, { type: 'drone', x: 1, y: 2, z: 3 }] });
  assert.equal(scene.objects.length, 1);
  assert.equal(scene.objects[0].type, 'drone');
});

test('sanitizeScene: caps object count at 24 even if the LLM returns more', () => {
  const objects = Array.from({ length: 60 }, (_, i) => ({ type: 'box', x: i }));
  const scene = sanitizeScene({ objects });
  assert.equal(scene.objects.length, 24);
});

test('sanitizeScene: clamps out-of-range coordinates/scale rather than rejecting the object', () => {
  const scene = sanitizeScene({ objects: [{ type: 'building', x: 9999, y: -50, z: -9999, scale: 500 }] });
  const obj = scene.objects[0];
  assert.ok(obj.x <= 25 && obj.x >= -25);
  assert.ok(obj.y >= 0 && obj.y <= 20);
  assert.ok(obj.z <= 25 && obj.z >= -25);
  assert.ok(obj.scale <= 6);
});

test('sanitizeScene: falls back to a default color for a malformed hex value', () => {
  const scene = sanitizeScene({ objects: [{ type: 'car', color: 'not-a-color' }] });
  assert.match(scene.objects[0].color, /^#[0-9a-f]{6}$/i);
});

test('sanitizeScene: every OBJECT_TYPES entry survives sanitization', () => {
  const scene = sanitizeScene({ objects: OBJECT_TYPES.map((type, i) => ({ type, x: i })) });
  assert.equal(scene.objects.length, OBJECT_TYPES.length);
});

test('sanitizeScene: truncates an overly long label/notes instead of erroring', () => {
  const longLabel = 'x'.repeat(200);
  const scene = sanitizeScene({ objects: [{ type: 'box', label: longLabel }], notes: longLabel });
  assert.ok(scene.objects[0].label.length <= 40);
  assert.ok(scene.notes.length <= 200);
});
