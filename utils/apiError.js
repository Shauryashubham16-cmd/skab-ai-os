// Central place for the two things that were previously duplicated,
// slightly differently, in every route file:
//
//   1. "wrap this async handler so a thrown/rejected error reaches
//      Express's error middleware instead of hanging the request" —
//      previously every single async route handler in routes/*.js
//      repeated the same three lines:
//          try { ... } catch (err) { next(err); }
//      That's boilerplate, not logic — asyncHandler() below replaces it
//      with one wrapper, so a route file is just its actual behavior.
//
//   2. "throw an error that carries a specific HTTP status/code" — before
//      this, routes either threw a bare Error (which the central handler
//      in server.js could only ever turn into a generic 500), or
//      early-returned their own res.status(x).json({...}) by hand, so the
//      exact response shape for "bad request" vs "not found" vs
//      "forbidden" drifted slightly from file to file. ApiError gives
//      every route the same well-shaped way to say "this specific status,
//      this specific message" and let the central handler render it —
//      while keeping the wire shape ({ error: string, code?: string })
//      exactly what the frontend already expects (see public/state/
//      jarvisState.js, public/components/Core/chat.js, etc. — they all
//      read `data.error` as a plain string), so this is purely additive,
//      not a breaking response-shape change.
//
// Nothing about a route's SUCCESS response shape is touched by this file —
// only the error path. Standardizing every success shape too would mean
// rewriting what the frontend expects on ~20 endpoints for no functional
// gain; the error path was the one that was actually inconsistent.

class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (code) this.code = code;
    if (details !== undefined) this.details = details;
  }

  static badRequest(message, opts) { return new ApiError(400, message, opts); }
  static forbidden(message, opts) { return new ApiError(403, message, opts); }
  static notFound(message, opts) { return new ApiError(404, message, opts); }
  static conflict(message, opts) { return new ApiError(409, message, opts); }
}

// Wraps an async (or sync) Express handler so any thrown error or rejected
// promise is forwarded to next(err) automatically. Handlers no longer need
// their own try/catch purely to do that forwarding — they should still
// catch and handle errors they mean to recover from locally, this only
// covers the "let it propagate to the central handler" case.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { ApiError, asyncHandler };
