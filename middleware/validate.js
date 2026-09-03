// Zod validation middleware. Every request body / query / param that reaches a
// route handler has already been parsed and replaced by its validated value,
// so handlers never see raw untrusted input.
function validate({ body, query, params }) {
  return (req, res, next) => {
    for (const [part, schema] of [['body', body], ['query', query], ['params', params]]) {
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        return res.status(400).json({
          error: `Invalid request ${part}`,
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      req[part] = result.data;
    }
    return next();
  };
}

module.exports = { validate };
