// memory.* tool definitions. See coreTools.js for the split rationale.
const longTermMemory = require('../longTermMemory');
const { knowledgeAddRequest } = require('../../schemas');
const { z } = require('../../schemas');

const memoryRecallArgs = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() });

const memoryTools = {
  'memory.remember': {
    describe: 'Save a durable fact, learned preference, or note for future sessions. args: { type: "fact"|"preference"|"note", content: string, tags?: string[] }',
    permission: 'standard',
    requiresCapability: null,
    argsSchema: knowledgeAddRequest,
    execute: async (args, ctx) => ({ ok: true, entry: await longTermMemory.add(ctx.userId, args) }),
  },
  'memory.recall': {
    describe: 'Search long-term memory (semantic when available, keyword otherwise). args: { query: string, limit?: number }',
    permission: 'read',
    requiresCapability: null,
    argsSchema: memoryRecallArgs,
    execute: async (args, ctx) => ({ ok: true, results: await longTermMemory.search(ctx.userId, args.query, { limit: args.limit }) }),
  },
};

module.exports = { memoryTools };
