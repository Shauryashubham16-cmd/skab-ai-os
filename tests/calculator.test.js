const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeEvaluate } = require('../utils/calculator');

test('basic arithmetic and precedence', () => {
  assert.equal(safeEvaluate('2+2').result, 4);
  assert.equal(safeEvaluate('2+3*4').result, 14);
  assert.equal(safeEvaluate('(2+3)*4').result, 20);
  assert.equal(safeEvaluate('2^3^2').result, 512); // right-associative: 2^(3^2)
});

test('unary minus and negative numbers', () => {
  assert.equal(safeEvaluate('-5+3').result, -2);
  assert.equal(safeEvaluate('3*-2').result, -6);
  assert.equal(safeEvaluate('-(2+3)').result, -5);
});

test('constants and functions', () => {
  assert.equal(safeEvaluate('sqrt(16)').result, 4);
  assert.equal(safeEvaluate('max(1,9,3)').result, 9);
  assert.ok(Math.abs(safeEvaluate('sin(0)+cos(0)').result - 1) < 1e-9);
  assert.ok(Math.abs(safeEvaluate('e').result - Math.E) < 1e-9);
});

test('division/modulo by zero are errors, not Infinity/NaN', () => {
  assert.equal(safeEvaluate('1/0').ok, false);
  assert.equal(safeEvaluate('5%0').ok, false);
});

test('unknown identifiers and malformed input are rejected, not silently coerced', () => {
  assert.equal(safeEvaluate('banana(1)').ok, false);
  assert.equal(safeEvaluate('2+').ok, false);
  assert.equal(safeEvaluate('2 3').ok, false); // trailing token with no operator
  assert.equal(safeEvaluate('').ok, false);
  assert.equal(safeEvaluate('   ').ok, false);
});

test('never executes arbitrary JS — this is a parser, not eval', () => {
  // If this ever silently used eval()/Function(), these would "succeed" and
  // return something; a real parser has no `require`/`process` grammar at all.
  assert.equal(safeEvaluate('require("fs")').ok, false);
  assert.equal(safeEvaluate('process.exit()').ok, false);
  assert.equal(safeEvaluate('(()=>1)()').ok, false);
});

test('rejects expressions over the length cap', () => {
  const huge = '1+'.repeat(150) + '1';
  assert.equal(safeEvaluate(huge).ok, false);
});

test('variable assignment: sets, is reported, and is usable afterward', () => {
  const first = safeEvaluate('x = 5 + 3', {});
  assert.equal(first.ok, true);
  assert.equal(first.result, 8);
  assert.equal(first.assignedName, 'x');

  const scope = { x: first.result };
  assert.equal(safeEvaluate('x * x', scope).result, 64);
  assert.equal(safeEvaluate('x + 2', scope).result, 10);
});

test('ans behaves like any other scope variable — caller wires it in, evaluator does not special-case it', () => {
  const r1 = safeEvaluate('10 / 4');
  assert.equal(r1.result, 2.5);
  const r2 = safeEvaluate('ans * 2', { ans: r1.result });
  assert.equal(r2.result, 5);
});

test('built-in constant/function/ans names cannot be reassigned', () => {
  assert.equal(safeEvaluate('pi = 5', {}).ok, false);
  assert.equal(safeEvaluate('sin = 1', {}).ok, false);
  assert.equal(safeEvaluate('ans = 1', {}).ok, false);
});

test('referencing an undefined variable is a clean error, not NaN/undefined leaking through', () => {
  const r = safeEvaluate('y + 1', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown constant or variable/);
});

test('a plain expression is unaffected by scope support — no assignedName leaks in', () => {
  // '5' isn't an identifier, so this can't parse as an assignment — it's
  // "5", then a stray "=" and "3" left over, which is a normal parse error.
  assert.equal(safeEvaluate('5 = 3').ok, false);
  assert.equal(safeEvaluate('sqrt(144) + 2^5').assignedName, undefined);
});
