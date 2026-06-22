// Reads an esbuild metafile and writes frontend/js/plugin-manifest.json:
// a flat { "<plugin-id>": "<chunk-filename>" } map the Go server consumes
// (plugins.LoadChunkMap). The plugin id is the directory name of each entry
// point (frontend/src/plugins/<id>/index.js); the chunk filename is the
// basename of that entry's output (e.g. "<id>-ABC123.js"). Shared chunks
// (entries without an entryPoint) are intentionally omitted — only entry
// chunks are addressable plugin URLs.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const [metaPath, outPath] = process.argv.slice(2);
if (!metaPath || !outPath) {
  console.error("usage: build-plugin-manifest.mjs <meta.json> <out.json>");
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const manifest = {};

for (const [outFile, info] of Object.entries(meta.outputs || {})) {
  const entry = info.entryPoint;
  if (!entry) continue; // shared chunk, not an addressable plugin entry
  // entry: frontend/src/plugins/<id>/index.js  →  id = <id>
  const id = basename(dirname(entry));
  manifest[id] = basename(outFile);
}

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${outPath} (${Object.keys(manifest).length} plugin(s))`);
