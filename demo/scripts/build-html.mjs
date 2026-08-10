#!/usr/bin/env node
/**
 * Produces the demo's index.html.
 *
 * The shipped frontend/index.html is a template: the Go server rewrites it in
 * memory on every request and never touches the file on disk. A static build has
 * to do that work itself, and the plugin manifest in particular is not optional
 * — core/pluginHost.js is completely inert without window.__PLUGINS__, which
 * silently costs the demo its media viewer, timeline and tag visualisation.
 *
 * See api/cmd/api/main.go (setupEcho, the SPA fallback handler) for the
 * behaviour being reproduced.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);

const SRC = resolve(args.src);
const OUT = resolve(args.out);
const JS_DIR = resolve(args["js-dir"]);
const CSS_DIR = resolve(args["css-dir"]);
const VERSION = args.version || "demo";
const FIXTURES = resolve(
  args.fixtures || "demo/mock/fixtures/fixtures.json",
);

/**
 * Plugins deliberately withheld from the demo manifest.
 *
 * comments      — injects <script src="/comments/web/embed.mjs"> from a remark42
 *                 sidecar that does not exist here. Omitting it also keeps
 *                 CommentsAdminPage (which calls api.* directly, bypassing
 *                 frontend/src/api/) from ever mounting.
 * mcp           — server-side capability with no meaning without a server.
 * offline-sync  — registers /sw.js and enables the IndexedDB mutation queue.
 *                 In a demo the service worker only serves stale bundles, and
 *                 the queue would silently accumulate writes that never drain.
 *                 Note app.js falls back to importing this plugin statically
 *                 when the manifest is EMPTY, so the manifest must be present
 *                 and non-empty for the omission to take effect.
 */
const EXCLUDE = new Set(["comments", "mcp", "offline-sync"]);

async function main() {
  const html = await readFile(SRC, "utf8");
  const fx = JSON.parse(await readFile(FIXTURES, "utf8"));

  // Chunk map: plugin id -> built entry filename, written by build-js.sh.
  const chunkMapPath = join(JS_DIR, "plugin-manifest.json");
  const chunks = existsSync(chunkMapPath)
    ? JSON.parse(await readFile(chunkMapPath, "utf8"))
    : {};

  // CSS map: which plugins shipped a stylesheet chunk.
  const cssDir = join(CSS_DIR, "p");
  const cssFiles = existsSync(cssDir) ? await readdir(cssDir) : [];
  const cssIds = new Set(
    cssFiles.filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, "")),
  );

  // Mirrors plugins.BuildManifest: enabled-only, with the built entry URL and
  // optional CSS attached. The recorded /api/plugins response already carries
  // the enabled state from the source instance.
  const manifest = [];
  for (const p of fx.plugins || []) {
    if (!p.enabled || EXCLUDE.has(p.id)) continue;
    const entry = {
      id: p.id,
      type: p.type,
      ...(p.slot ? { slot: p.slot } : {}),
      ...(p.routes?.length ? { routes: p.routes } : {}),
    };
    // Stamped like the app.js and stylesheet URLs in the template: plugin
    // entries are unhashed too, and pluginHost.js import()s them at a fixed
    // path, so without this they outlive a redeploy in a visitor's cache and
    // reach for chunk names the new build no longer has. shim.js matches on
    // pathname, so the query is invisible to interception.
    if (chunks[p.id]) entry.entry = `/assets/js/p/${chunks[p.id]}?v=${VERSION}`;
    if (cssIds.has(p.id)) entry.css = `/assets/css/p/${p.id}.css?v=${VERSION}`;
    manifest.push(entry);
  }

  const withEntries = manifest.filter((e) => e.entry).length;
  if (manifest.length === 0) {
    console.error(
      "REFUSING: empty plugin manifest — the demo would lose the media viewer,\n" +
        "timeline and tag visualisation, and app.js would fall back to loading\n" +
        "the offline-sync plugin (registering a service worker).",
    );
    process.exit(1);
  }

  // JSON.stringify output is embedded in an inline <script>. `</script>` cannot
  // appear in the data (ids and slots are slugs), but escape the sequence
  // defensively so a future fixture can never break out of the element.
  const json = JSON.stringify(manifest).replace(/<\//g, "<\\/");
  const script = `  <script>window.__PLUGINS__=${json};</script>`;

  let out = html
    .replaceAll("__BUILD_VERSION__", VERSION)
    // The deployment head-markup slot stays empty: it exists for analytics and
    // verification tags, and the demo embeds no third-party origin.
    .replace("<!-- __HEAD_HTML__ -->", "")
    .replace("</head>", `${script}\n</head>`);

  // The shell ships <title>Loading…</title> because the server replaces it
  // per-post. Nothing does that here, so give the demo a real default; app.js
  // overwrites it from settings once booted.
  out = out.replace("<title>Loading…</title>", "<title>Point — live demo</title>");

  await writeFile(OUT, out);

  console.log(
    `    index.html: ${manifest.length} plugin(s) in manifest ` +
      `(${withEntries} with chunks), version=${VERSION}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
