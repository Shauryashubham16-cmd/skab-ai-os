#!/usr/bin/env node
// Runs automatically before `npm test` (see package.json "pretest").
//
// Root cause this exists for: running `npm test` in a checkout that never
// had `npm install` run (or has a stale node_modules) doesn't fail cleanly
// — each test file that requires a missing package throws at require()
// time, and Node's test runner logs that as ONE failing "test" per file,
// silently swallowing however many real subtests were inside it. That's
// how a real "184/184 passing" suite gets reported as "37/92 failing" —
// the other 92 subtests never even got registered.
//
// This script checks every dependency + devDependency in package.json is
// actually resolvable and exits with a clear instruction before the test
// runner ever starts, instead of letting it happen again silently.
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

const missing = names.filter((name) => {
  try { require.resolve(name); return false; }
  catch { return true; }
});

if (missing.length) {
  console.error('\n\x1b[31m✖ Missing dependencies — install before running tests:\x1b[0m');
  missing.forEach((m) => console.error('  - ' + m));
  console.error('\nRun: npm install\n');
  console.error('(Without this, test files that require a missing package fail at');
  console.error(' require() time — Node\'s test runner counts that as ONE failed test');
  console.error(' per file and never registers the real subtests, so the totals look');
  console.error(' like a small, confusing failure count instead of a missing-deps error.)\n');
  process.exit(1);
}

console.log(`✓ All ${names.length} declared dependencies resolved.`);
