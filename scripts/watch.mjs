// The file watcher behind `scripts/run.sh --watch`. It runs the server,
// rebuilds the frontend when its sources change, and rebuilds and restarts
// only the Go binary when Go code changes.
//
// A CSS or JS rebuild needs no restart: run.sh sets DEV_ASSET_RELOAD=1, so the
// server re-reads the build manifests on the next page load (liveAssets in
// api/cmd/api/assets.go). Reload the browser to see the change.
//
// Started by run.sh after the first build, with the server's environment
// already exported: FRONTEND_DEBUG picks the bundle set to rebuild (-d), and
// DEV_VERSION is the Go version stamp. Node's fs.watch only — no dependencies.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEBOUNCE_MS = 150;
const STOP_TIMEOUT_MS = 5000;

const cssOnly = (f) => (f.endsWith(".css") ? "css" : null);

// Each watched tree, and what a changed file in it rebuilds — null for a file
// no build reads (editor swap files, Go tests). classify gets the path relative
// to the tree. The build outputs (frontend/js*, the frontend/css/*.css bundles,
// frontend/css/p) sit outside these trees, so a rebuild never triggers itself.
const TREES = [
  // Plugin CSS partials live beside their JS under frontend/src/plugins/<id>/.
  {
    dir: "frontend/src",
    classify: (f) => cssOnly(f) ?? (/\.(m?js|json)$/.test(f) ? "js" : null),
  },
  // common/theme.css is not a partial: the server writes the active theme
  // there at startup and on every theme switch, and serves it unbundled.
  {
    dir: "frontend/css/common",
    classify: (f) => (f === "theme.css" ? null : cssOnly(f)),
  },
  { dir: "frontend/css/light", classify: cssOnly },
  { dir: "frontend/css/public", classify: cssOnly },
  {
    dir: "api",
    classify: (f) =>
      (f.endsWith(".go") && !f.endsWith("_test.go")) ||
      /^go\.(mod|sum)$/.test(basename(f))
        ? "go"
        : null,
  },
];

// Build order when several kinds are pending: frontend first, so a restarted
// server comes up on the new bundles.
const ORDER = ["css", "js", "go"];

const debug = process.env.FRONTEND_DEBUG === "1";
const BUILDS = {
  css: { label: "CSS", cmd: "./scripts/build-css.sh", args: [] },
  js: {
    label: debug ? "JS (debug)" : "JS (release)",
    cmd: "./scripts/build-js.sh",
    args: [],
    // Rebuild only the set being served, as run.sh does.
    env: debug ? { BUILD_RELEASE_FRONTEND: "0" } : { BUILD_DEBUG_FRONTEND: "0" },
  },
  go: {
    label: "Go",
    cmd: "go",
    args: [
      "build",
      `-ldflags=-s -w -X main.Version=${process.env.DEV_VERSION ?? "dev"}`,
      "-o",
      "../point",
      "./cmd/api",
    ],
    cwd: join(ROOT, "api"),
  },
};

const log = (msg) => console.log(`[watch] ${msg}`);

// runBuild runs one build with its output captured, printing the output only
// when the build fails — a successful save stays one line.
function runBuild({ cmd, args, env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: cwd ?? ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => out.push(b));
    child.on("error", (err) => resolve({ ok: false, output: String(err) }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, output: Buffer.concat(out).toString() }),
    );
  });
}

// ── Server ─────────────────────────────────────────────────────────────────

let server = null;
let stopping = false;

function startServer() {
  const s = spawn("./point", { cwd: ROOT, stdio: "inherit" });
  server = s;
  s.on("exit", (code, signal) => {
    if (server !== s) return; // stopped on purpose
    server = null;
    if (!stopping) {
      log(`point exited (${signal ?? `code ${code}`}); edit a .go file to rebuild and restart it`);
    }
  });
}

function stopServer() {
  const s = server;
  server = null;
  if (!s || s.exitCode !== null || s.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => s.kill("SIGKILL"), STOP_TIMEOUT_MS);
    s.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    s.kill("SIGTERM");
  });
}

// ── Rebuild queue ──────────────────────────────────────────────────────────

const pending = new Set();
let timer = null;
let building = false;

function schedule(kind) {
  pending.add(kind);
  clearTimeout(timer);
  timer = setTimeout(drain, DEBOUNCE_MS);
}

// drain runs the pending builds one at a time. Edits that land mid-build are
// picked up by the same loop once the current build finishes.
async function drain() {
  if (building) return;
  building = true;
  while (pending.size && !stopping) {
    const kinds = ORDER.filter((k) => pending.has(k));
    pending.clear();
    for (const kind of kinds) {
      if (stopping) break;
      const build = BUILDS[kind];
      const started = Date.now();
      const { ok, output } = await runBuild(build);
      const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      if (!ok) {
        process.stdout.write(output);
        log(`${build.label} build FAILED (${took})${kind === "go" ? "; the running server is unchanged" : ""}`);
        continue;
      }
      if (kind === "go") {
        await stopServer();
        if (!stopping) startServer();
        log(`Go rebuilt in ${took}; server restarted`);
      } else {
        log(`${build.label} rebuilt in ${took}; reload the page`);
      }
    }
  }
  building = false;
}

// ── Start ──────────────────────────────────────────────────────────────────

// watchTree watches every directory under root, one fs.watch per directory,
// and calls onChange with the changed path relative to root. Not
// { recursive: true }: on Linux that watches each file, and loses it the
// moment the file is replaced rather than rewritten — an atomic editor save,
// a git checkout — after which edits to it go unseen. A directory watch
// reports its entries by name, whatever inode they have.
const watchers = new Map();

function watchTree(root, onChange) {
  const add = (dir) => {
    if (watchers.has(dir)) return;
    let w;
    try {
      w = watch(dir, (_event, name) => {
        if (!name) return;
        const path = join(dir, name.toString());
        // A directory created (or moved in) after startup gets its own watch.
        if (!watchers.has(path) && isDir(path)) add(path);
        onChange(relative(root, path));
      });
    } catch {
      return; // removed before we got to it
    }
    // A watched directory that is deleted errors out; drop its watch.
    w.on("error", () => {
      w.close();
      watchers.delete(dir);
    });
    watchers.set(dir, w);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) add(join(dir, e.name));
    }
  };
  add(root);
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

for (const { dir, classify } of TREES) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  watchTree(abs, (rel) => {
    const kind = classify(rel);
    if (kind) schedule(kind);
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  for (const w of watchers.values()) w.close();
  await stopServer();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, shutdown);

startServer();
log(`watching ${TREES.map((t) => t.dir).join(", ")} — CSS/JS edits need only a page reload`);
