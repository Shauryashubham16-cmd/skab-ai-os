const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const {
  imaginationSceneRequest, imaginationEditRequest, imaginationFromScreenRequest, imaginationImageRequest,
} = require('../schemas');
const imaginationEngine = require('../utils/imaginationEngine');
const imageGen = require('../utils/imageGen');

const router = express.Router();

// POST /api/imagination/scene — text -> new 3D scene graph.
router.post('/scene', validate({ body: imaginationSceneRequest }), asyncHandler(async (req, res) => {
  const scene = await imaginationEngine.proposeScene(req.body.prompt);
  imaginationEngine.setLastScene(req.user.id, scene);
  res.json({ ok: true, scene });
}));

// POST /api/imagination/edit — conversational edit of an existing scene
// ("add drones", "make it nighttime", "add flying cars").
router.post('/edit', validate({ body: imaginationEditRequest }), asyncHandler(async (req, res) => {
  const scene = await imaginationEngine.editScene(req.body.scene, req.body.instruction);
  imaginationEngine.setLastScene(req.user.id, scene);
  res.json({ ok: true, scene });
}));

// POST /api/imagination/from-screen — vision/imagination connection: looks
// at the real screen (utils/visionService.js) and builds a scene from what
// it actually sees, optionally with an extra instruction applied.
router.post('/from-screen', validate({ body: imaginationFromScreenRequest }), asyncHandler(async (req, res) => {
  const { scene, sourceDescription } = await imaginationEngine.sceneFromScreen(req.body.instruction);
  imaginationEngine.setLastScene(req.user.id, scene);
  res.json({ ok: true, scene, sourceDescription });
}));

// GET /api/imagination/image-providers — which image-gen provider(s), if
// any, are configured. Lets the UI show/hide the "generate an image"
// option instead of offering something that will just 500.
router.get('/image-providers', (req, res) => {
  res.json({ providers: imageGen.configuredProviders() });
});

// POST /api/imagination/image — a real generated image, as an alternative
// to the (key-free) 3D scene graph above, for when the user actually wants
// a picture rather than an interactive scene. Requires OPENAI_API_KEY or
// GEMINI_API_KEY in .env; see utils/imageGen.js.
router.post('/image', validate({ body: imaginationImageRequest }), asyncHandler(async (req, res) => {
  const result = await imageGen.generateImage(req.body.prompt, { size: req.body.size });
  if (result.ok === false) return res.status(409).json(result);
  res.json(result);
}));

module.exports = router;
