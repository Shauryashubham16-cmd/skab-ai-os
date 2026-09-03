// browser.* tool definitions — all gated on the 'browser' capability.
// See coreTools.js for the split rationale.
const browserAutomation = require('../browserAutomation');
const {
  browserNavigateRequest, browserSelectorRequest, browserTypeRequest,
  browserGetTextRequest, browserScrollRequest, browserTabIndexRequest,
  browserNewTabRequest, browserDownloadRequest, browserVerifyRequest,
} = require('../../schemas');
const { noArgs } = require('./coreTools');

const browserTools = {
  'browser.navigate': {
    describe: 'Navigate the automated browser to a URL (http/https only). args: { url: string }. Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserNavigateRequest,
    execute: async (args) => browserAutomation.navigate(args.url),
  },
  'browser.click': {
    describe: 'Click an element in the automated browser. args: { selector: string (CSS) }. Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserSelectorRequest,
    execute: async (args) => browserAutomation.click(args.selector),
  },
  'browser.type': {
    describe: 'Fill a field in the automated browser. args: { selector: string, text: string }. Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserTypeRequest,
    execute: async (args) => browserAutomation.typeInto(args.selector, args.text),
  },
  'browser.read': {
    describe: 'Read visible text from the automated browser page. args: { selector?: string }. Requires browser automation armed.',
    permission: 'read',
    requiresCapability: 'browser',
    argsSchema: browserGetTextRequest,
    execute: async (args) => browserAutomation.getText(args.selector),
  },
  'browser.scroll': {
    describe: 'Scroll the automated browser page, or scroll a specific element into view. args: { selector?: string, direction?: "up"|"down" (default "down"), amount?: number (px, default 600) }. Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserScrollRequest,
    execute: async (args) => browserAutomation.scroll(args),
  },
  'browser.tabs.list': {
    describe: 'List open tabs in the automated browser. args: {}. Requires browser automation armed.',
    permission: 'read',
    requiresCapability: 'browser',
    argsSchema: noArgs,
    execute: async () => browserAutomation.listTabs(),
  },
  'browser.tabs.new': {
    describe: 'Open a new tab, optionally navigating it to a URL. args: { url?: string }. Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserNewTabRequest,
    execute: async (args) => browserAutomation.newTab(args.url),
  },
  'browser.tabs.switch': {
    describe: 'Switch which tab subsequent browser.* calls act on. args: { index: number } (see browser.tabs.list). Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserTabIndexRequest,
    execute: async (args) => browserAutomation.switchTab(args.index),
  },
  'browser.tabs.close': {
    describe: 'Close a tab. args: { index: number } (see browser.tabs.list). Requires browser automation armed.',
    permission: 'standard',
    requiresCapability: 'browser',
    argsSchema: browserTabIndexRequest,
    execute: async (args) => browserAutomation.closeTab(args.index),
  },
  'browser.download': {
    describe: 'Trigger a file download by clicking a selector or navigating to a URL, and save it into the Downloads folder. args: { selector?: string, url?: string } (provide one). Requires browser automation armed.',
    // Writes a real file to disk from arbitrary/untrusted page content —
    // higher blast radius than the read/click/type tools around it.
    permission: 'dangerous',
    requiresCapability: 'browser',
    argsSchema: browserDownloadRequest,
    execute: async (args) => browserAutomation.download(args),
  },
  'browser.verify': {
    describe: 'Check whether the current browser page actually matches an expected outcome — the real "before/after verify" step. args: { textContains?: string, urlContains?: string, selectorExists?: string } (provide at least one). Requires browser automation armed.',
    permission: 'read',
    requiresCapability: 'browser',
    argsSchema: browserVerifyRequest,
    execute: async (args) => browserAutomation.verify(args),
  },
};

module.exports = { browserTools };
