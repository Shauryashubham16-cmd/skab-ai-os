// A real, safe arithmetic expression evaluator — no `eval`, no `Function`
// constructor, no new dependency (same "prefer pure JS over a native/3rd
// party dependency" choice already made for tesseract.js/screenshot-desktop
// elsewhere in utils/). This is a small hand-written recursive-descent
// parser: tokenize -> parse to an AST -> evaluate the AST. Nothing here ever
// hands a string to the JS engine to execute, so there's no injection
// surface regardless of what a user (or the LLM planner, via the
// `calc.evaluate` tool) types in.
//
// Grammar (standard precedence, lowest to highest):
//   stmt    := IDENT '=' expr | expr        // assignment or a plain expression
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/' | '%') unary)*
//   unary   := '-' unary | '+' unary | power
//   power   := atom ('^' unary)?              // right-associative
//   atom    := NUMBER | IDENT | FUNC '(' expr (',' expr)* ')' | '(' expr ')'
//
// `scope` (variables + the implicit `ans`) is passed in by the caller and
// never touched here — this stays a pure function, the caller (routes/calc.js)
// owns the actual per-user variable state, same as it already owns history.

const CONSTANTS = { pi: Math.PI, e: Math.E };

const FUNCTIONS = {
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, ln: Math.log,
  log10: Math.log10, log2: Math.log2, exp: Math.exp,
  // multi-arg
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  pow: (a, b) => Math.pow(a, b),
  log: (a, b) => (b === undefined ? Math.log10(a) : Math.log(a) / Math.log(b)),
};

// Names a variable assignment can never use — built-ins stay predictable
// regardless of what's been assigned this session (`pi = 5` would otherwise
// silently break every later expression that uses pi).
const RESERVED_NAMES = new Set([...Object.keys(CONSTANTS), ...Object.keys(FUNCTIONS), 'ans']);

const MAX_EXPRESSION_LENGTH = 200;

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      const raw = input.slice(i, j);
      if ((raw.match(/\./g) || []).length > 1) throw new Error(`Malformed number "${raw}"`);
      tokens.push({ type: 'num', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[a-zA-Z_0-9]/.test(input[j])) j++;
      tokens.push({ type: 'ident', value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/%^(),='.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}" at position ${i}`);
  }
  return tokens;
}

// Top-level only: `<ident> = <expr>` with nothing else. Returns
// { assignTo, exprTokens } or null if this isn't an assignment (a plain
// expression, or `=` appearing anywhere but as the second token — e.g.
// inside a call's arguments — is left for parseExpr to reject normally).
function splitAssignment(tokens) {
  if (tokens.length < 3) return null;
  if (tokens[0].type !== 'ident' || tokens[1].type !== 'op' || tokens[1].value !== '=') return null;
  return { assignTo: tokens[0].value, exprTokens: tokens.slice(2) };
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expectOp = (v) => {
    const t = next();
    if (!t || t.type !== 'op' || t.value !== v) throw new Error(`Expected "${v}"`);
  };

  function parseExpr() {
    let node = parseTerm();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      node = { type: 'binary', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseUnary();
    while (peek() && peek().type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = next().value;
      node = { type: 'binary', op, left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = next().value;
      return { type: 'unary', op, arg: parseUnary() };
    }
    return parsePower();
  }

  function parsePower() {
    const base = parseAtom();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      next();
      return { type: 'binary', op: '^', left: base, right: parseUnary() }; // right-associative
    }
    return base;
  }

  function parseAtom() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') { next(); return { type: 'num', value: t.value }; }
    if (t.type === 'op' && t.value === '(') {
      next();
      const node = parseExpr();
      expectOp(')');
      return node;
    }
    if (t.type === 'ident') {
      next();
      if (peek() && peek().type === 'op' && peek().value === '(') {
        next();
        const args = [];
        if (!(peek() && peek().type === 'op' && peek().value === ')')) {
          args.push(parseExpr());
          while (peek() && peek().type === 'op' && peek().value === ',') { next(); args.push(parseExpr()); }
        }
        expectOp(')');
        return { type: 'call', name: t.value, args };
      }
      return { type: 'const', name: t.value };
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }

  const node = parseExpr();
  if (pos !== tokens.length) throw new Error(`Unexpected trailing input near "${tokens[pos].value}"`);
  return node;
}

function evaluate(node, scope) {
  switch (node.type) {
    case 'num': return node.value;
    case 'const': {
      if (scope && Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
      if (!(node.name in CONSTANTS)) throw new Error(`Unknown constant or variable "${node.name}"`);
      return CONSTANTS[node.name];
    }
    case 'unary': {
      const v = evaluate(node.arg, scope);
      return node.op === '-' ? -v : v;
    }
    case 'binary': {
      const l = evaluate(node.left, scope);
      const r = evaluate(node.right, scope);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new Error('Division by zero');
          return l / r;
        case '%':
          if (r === 0) throw new Error('Division by zero');
          return l % r;
        case '^': return Math.pow(l, r);
        default: throw new Error(`Unknown operator "${node.op}"`);
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`Unknown function "${node.name}(...)"`);
      const args = node.args.map((a) => evaluate(a, scope));
      const result = fn(...args);
      if (typeof result !== 'number') throw new Error(`"${node.name}(...)" did not return a number`);
      return result;
    }
    default:
      throw new Error(`Unknown node type "${node.type}"`);
  }
}

// Public entry point. Always returns { ok, result, expression, assignedName? }
// or { ok:false, error, expression } — never throws, so callers (the REST
// route and the `calc.evaluate` tool) don't each need their own try/catch.
//
// `scope` is a plain object of variable name -> number, e.g. { ans: 12,
// x: 5 } — the caller's job to build (routes/calc.js keeps one per user,
// same pattern as its existing history Map) and to persist `assignedName`
// back into if this call returns one.
function safeEvaluate(expression, scope = {}) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return { ok: false, error: 'Empty expression', expression };
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: `Expression too long (max ${MAX_EXPRESSION_LENGTH} characters)`, expression };
  }
  try {
    const tokens = tokenize(expression);
    if (!tokens.length) return { ok: false, error: 'Empty expression', expression };

    const assignment = splitAssignment(tokens);
    const assignTo = assignment ? assignment.assignTo : null;
    if (assignTo && RESERVED_NAMES.has(assignTo)) {
      return { ok: false, error: `"${assignTo}" is a built-in name and can't be reassigned`, expression };
    }
    const exprTokens = assignment ? assignment.exprTokens : tokens;
    if (!exprTokens.length) return { ok: false, error: 'Missing expression after "="', expression };

    const ast = parse(exprTokens);
    const result = evaluate(ast, scope);
    if (!Number.isFinite(result)) return { ok: false, error: 'Result is not a finite number', expression };
    return assignTo ? { ok: true, result, expression, assignedName: assignTo } : { ok: true, result, expression };
  } catch (err) {
    return { ok: false, error: err.message, expression };
  }
}

module.exports = { safeEvaluate, CONSTANTS, FUNCTIONS: Object.keys(FUNCTIONS) };
