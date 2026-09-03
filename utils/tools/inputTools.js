// input.* tool definitions — mouse/keyboard/clipboard automation, all
// gated on the 'input' capability. See coreTools.js for the split rationale.
const inputControl = require('../inputControl');
const {
  inputMoveRequest, inputClickRequest, inputScrollRequest, inputTypeRequest,
  inputKeyRequest, inputDragDropRequest, inputClipboardWriteRequest,
} = require('../../schemas');
const { noArgs } = require('./coreTools');

const inputTools = {
  'input.move': {
    describe: 'Move the mouse cursor. args: { x: number, y: number }. Requires input automation armed (POST /api/input/enable).',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: inputMoveRequest,
    execute: async (args) => inputControl.moveMouse(args.x, args.y),
  },
  'input.click': {
    describe: 'Click the mouse. args: { x?: number, y?: number, button?: "left"|"right"|"middle", double?: boolean }. Requires input automation armed.',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: inputClickRequest,
    execute: async (args) => inputControl.click(args),
  },
  'input.scroll': {
    describe: 'Scroll the mouse wheel. args: { delta: number, x?: number, y?: number }. Requires input automation armed.',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: inputScrollRequest,
    execute: async (args) => inputControl.scroll(args),
  },
  'input.type': {
    describe: 'Type text into whatever has focus. args: { text: string }. Requires input automation armed.',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: inputTypeRequest,
    execute: async (args) => inputControl.typeText(args.text),
  },
  'input.key': {
    describe: 'Send a raw key combo (SendKeys notation, e.g. "^c", "%{F4}"). args: { keys: string }. Requires input automation armed.',
    // Raw, unescaped SendKeys syntax can do more than a single click (e.g.
    // alt+F4, ctrl+alt combos) — classified dangerous even though, like
    // every other input.* tool, its actual gate is the shared "input"
    // capability flag rather than its own confirmation step.
    permission: 'dangerous',
    requiresCapability: 'input',
    argsSchema: inputKeyRequest,
    execute: async (args) => inputControl.pressKeys(args.keys),
  },
  'input.dragDrop': {
    describe: 'Press at one point, drag through to another, and release — for drag-and-drop UI (reordering, drag targets, sliders). args: { fromX: number, fromY: number, toX: number, toY: number }. Requires input automation armed.',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: inputDragDropRequest,
    execute: async (args) => inputControl.dragDrop(args),
  },
  'input.clipboardRead': {
    describe: 'Read the current clipboard text. args: {}. Requires input automation armed. Use before overwriting the clipboard if the previous contents matter.',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: noArgs,
    execute: async () => inputControl.clipboardRead(),
  },
  'input.clipboardWrite': {
    describe: 'Set the clipboard to the given text (e.g. to paste it elsewhere with input.key {"keys":"^v"}). args: { text: string }. Requires input automation armed.',
    permission: 'standard',
    requiresCapability: 'input',
    argsSchema: inputClipboardWriteRequest,
    execute: async (args) => inputControl.clipboardWrite(args.text),
  },
};

module.exports = { inputTools };
