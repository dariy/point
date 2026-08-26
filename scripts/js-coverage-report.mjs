// Frontend coverage gate. Reads the lcov written by `node --test
// --experimental-test-coverage` and enforces two ratchets.
//
// Why two numbers instead of one:
//
// V8 only instruments modules that actually get imported, so a source file no
// test touches is not 0% in the report — it is absent from it entirely. Line
// coverage alone therefore cannot see a newly added, wholly untested file:
// adding one leaves the percentage untouched. UNREACHED_MAX closes that hole,
// and the list it prints is the prioritisation input for the remaining
// frontend-coverage work.
//
// Both are ratchets. Lower them as coverage improves; never raise one to make
// a red build green.
//
// Usage: node scripts/js-coverage-report.mjs <lcov-file>

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LINE_FLOOR = 65; // % of lines, across files the tests actually reach
const UNREACHED_MAX = 40; // src files no test imports at all

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "frontend", "src");

const lcovPath = process.argv[2];
if (!lcovPath) {
  console.error("usage: node scripts/js-coverage-report.mjs <lcov-file>");
  process.exit(2);
}

let lcov;
try {
  lcov = readFileSync(lcovPath, "utf8");
} catch {
  console.error(`js coverage: cannot read '${lcovPath}'`);
  process.exit(2);
}

let linesFound = 0;
let linesHit = 0;
const reached = new Set();

for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) {
    // lcov paths are relative to the cwd node ran in (the repo root).
    reached.add(line.slice(3).trim().split(sep).join("/"));
  } else if (line.startsWith("LF:")) {
    linesFound += Number(line.slice(3)) || 0;
  } else if (line.startsWith("LH:")) {
    linesHit += Number(line.slice(3)) || 0;
  }
}

if (linesFound === 0) {
  console.error(`js coverage: no line data in '${lcovPath}'`);
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// Paths excluded from the gate: build-time tooling that never reaches a
// production bundle, so counting it would inflate the untested-file ratchet
// with code the shipped app does not contain. Mirrors the Go side, where
// scripts/coverage-gate.sh excludes cmd/seed for the same reason.
//
// demo/mock/ is the static demo's fixture-backed API stand-in
// (demo/scripts/build.sh). It lives outside SRC_DIR, so it is already outside
// the walk below; nothing in a normal build reaches it.
const COVERAGE_EXCLUDE = [];

const allSrc = walk(SRC_DIR)
  .map((f) => relative(ROOT, f).split(sep).join("/"))
  .filter((f) => !COVERAGE_EXCLUDE.some((re) => re.test(f)))
  .sort();
const unreached = allSrc.filter((f) => !reached.has(f));

const pct = (100 * linesHit) / linesFound;
const pctStr = pct.toFixed(2);

console.log("");
console.log(
  `js coverage: ${pctStr}% of lines in ${reached.size} reached file(s) ` +
    `(floor ${LINE_FLOOR}%)`,
);
console.log(
  `js coverage: ${unreached.length} of ${allSrc.length} src file(s) reached by no test ` +
    `(max ${UNREACHED_MAX})`,
);

let failed = false;

if (pct < LINE_FLOOR) {
  console.error(
    `\njs coverage: FAIL — ${pctStr}% is below the ${LINE_FLOOR}% floor`,
  );
  failed = true;
}

if (unreached.length > UNREACHED_MAX) {
  console.error(
    `\njs coverage: FAIL — ${unreached.length} untouched src files exceeds the max of ${UNREACHED_MAX}`,
  );
  // Only the newly untouched ones are actionable, but the list is not stable
  // enough to diff here; show the largest, which are the ones worth testing.
  const bySize = unreached
    .map((f) => ({ f, size: statSync(join(ROOT, f)).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 10);
  console.error("Largest files no test imports:");
  for (const { f, size } of bySize) {
    console.error(`  ${String(Math.round(size / 1024)).padStart(4)}K  ${f}`);
  }
  failed = true;
}

if (failed) {
  console.error(
    "\nAdd tests, or justify moving a ratchet in scripts/js-coverage-report.mjs.",
  );
  process.exit(1);
}

process.exit(0);
