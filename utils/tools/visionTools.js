// vision.* tool definitions. See coreTools.js for the split rationale.
const { analyzeScreen } = require('../visionService');
const visionService = require('../visionService');
const {
  visionRequest, visionFindElementRequest, visionCompareRequest,
} = require('../../schemas');
const { noArgs } = require('./coreTools');

const visionTools = {
  'vision.screen': {
    describe: 'Look at the current screen (OCR and/or an LLM description). args: { mode?: "ocr"|"describe"|"both", question?: string }',
    permission: 'read',
    requiresCapability: null,
    argsSchema: visionRequest,
    execute: async (args) => analyzeScreen(args),
  },
  'vision.findElement': {
    describe: 'Find a UI element on screen by its visible text and get its click coordinates. args: { text: string }. OCR-based — works for labeled buttons/links, not unlabeled icons. Use the returned "center" with input.click.',
    permission: 'read',
    requiresCapability: null,
    argsSchema: visionFindElementRequest,
    execute: async (args) => visionService.findElement(args.text),
  },
  'vision.snapshot': {
    describe: 'Capture the current screen and remember it as a snapshot for a later before/after comparison. args: {}. Returns a snapshotId — pass it to vision.compareToSnapshot after the action you want to verify.',
    permission: 'read',
    requiresCapability: null,
    argsSchema: noArgs,
    execute: async () => visionService.takeSnapshot(),
  },
  'vision.compareToSnapshot': {
    describe: 'Capture a fresh screenshot and compare it pixel-by-pixel against an earlier vision.snapshot — the real "did that actually change the screen" check. args: { snapshotId: string, threshold?: number (default 20) }.',
    permission: 'read',
    requiresCapability: null,
    argsSchema: visionCompareRequest,
    execute: async (args) => visionService.compareToSnapshot(args.snapshotId, { threshold: args.threshold }),
  },
};

module.exports = { visionTools };
