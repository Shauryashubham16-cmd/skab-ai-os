// Covers utils/apiError.js — the ApiError class + asyncHandler wrapper that
// replaced the ~65 duplicated `try { ... } catch (err) { next(err); }`
// blocks previously scattered across routes/*.js. The important guarantees:
// a thrown/rejected error inside a wrapped handler always reaches next()
// (never crashes the process or hangs the request), a sync throw is caught
// exactly like an async rejection, and ApiError's status/code/details ride
// along for the central error middleware in server.js to render.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApiError, asyncHandler } = require('../utils/apiError');

function fakeReqRes() {
  return { req: {}, res: {} };
}

test('asyncHandler: a resolved handler never calls next()', async () => {
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  const handler = asyncHandler(async () => { /* no-op success */ });
  await handler(req, res, () => { nextCalled = true; });
  // asyncHandler itself doesn't await the inner promise in a way the test can
  // block on directly, so give the microtask queue a tick.
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(nextCalled, false);
});

test('asyncHandler: a rejected async handler forwards the error to next(), not a throw', async () => {
  const { req, res } = fakeReqRes();
  const boom = new Error('boom');
  const handler = asyncHandler(async () => { throw boom; });
  const received = await new Promise((resolve) => {
    handler(req, res, resolve);
  });
  assert.equal(received, boom);
});

test('asyncHandler: a handler that throws synchronously (before any await) still reaches next()', async () => {
  const { req, res } = fakeReqRes();
  const boom = new Error('sync boom');
  // Promise.resolve(fn(...)) means even a fully synchronous throw inside an
  // async fn is caught the same way as a later rejection — this is the
  // specific behavior that made asyncHandler a safe drop-in replacement for
  // every existing try/catch, sync or async.
  const handler = asyncHandler(async () => { throw boom; });
  const received = await new Promise((resolve) => {
    handler(req, res, resolve);
  });
  assert.equal(received, boom);
});

test('ApiError: carries status, and optional code/details', () => {
  const err = new ApiError(409, 'conflict happened', { code: 'RUN_CONFLICT', details: { runId: 'abc' } });
  assert.equal(err.status, 409);
  assert.equal(err.message, 'conflict happened');
  assert.equal(err.code, 'RUN_CONFLICT');
  assert.deepEqual(err.details, { runId: 'abc' });
  assert.ok(err instanceof Error);
});

test('ApiError: code/details are omitted (not undefined-but-present) when not given', () => {
  const err = new ApiError(400, 'bad input');
  assert.equal('code' in err, false);
  assert.equal('details' in err, false);
});

test('ApiError static helpers set the expected status codes', () => {
  assert.equal(ApiError.badRequest('x').status, 400);
  assert.equal(ApiError.forbidden('x').status, 403);
  assert.equal(ApiError.notFound('x').status, 404);
  assert.equal(ApiError.conflict('x').status, 409);
});

test('asyncHandler: an ApiError thrown inside a handler is forwarded intact (status/code preserved)', async () => {
  const { req, res } = fakeReqRes();
  const handler = asyncHandler(async () => { throw ApiError.notFound('Run not found.', { code: 'RUN_NOT_FOUND' }); });
  const received = await new Promise((resolve) => {
    handler(req, res, resolve);
  });
  assert.equal(received.status, 404);
  assert.equal(received.code, 'RUN_NOT_FOUND');
});
