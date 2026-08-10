#!/usr/bin/env node
/**
 * Theme catalogue for the static demo.
 *
 * `GET /api/themes` is served by the Go backend from whatever is in
 * frontend/themes/ — the list is derived from the files, never stored. The demo
 * recorded that response into its fixture instead, which froze the catalogue at
 * the set of themes that existed on recording day: a theme added afterwards
 * ships in the bundle (build.sh copies the whole directory) but never appears
 * on the Themes page, so it cannot be activated.
 *
 * This writes the same catalogue at build time by parsing the same metadata out
 * of the same files, so adding a theme to frontend/themes/ is all it takes for
 * the demo to offer it. The parsing mirrors ThemeService.ReadAndValidateTheme
 * (api/internal/services/theme_service.go) — the header comments, the :root
 * colour literals behind the admin swatch, and the presence of a dark block.
 *
 * Usage:
 *   node demo/scripts/build-themes.mjs --src=frontend/themes --out=<dist>/assets/themes/index.json
 */

import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  }),
);

const SRC = args.src;
const OUT = args.out;
if (!SRC || !OUT) {
  console.error("usage: build-themes.mjs --src=<themes dir> --out=<index.json>");
  process.exit(1);
}

// Same expressions as theme_service.go.
const TITLE_RE = /\/\*\s*theme-title:\s*"([^"]+)"\s*\*\//;
const DESC_RE = /\/\*\s*description:\s*"([^"]+)"\s*\*\//;
const COLOR_RE = /\/\*\s*preview-color:\s*"([^"]+)"\s*\*\//;
const ROOT_BLOCK_RE = /:root\s*\{([\s\S]*?)\}/;
const DECL_RE = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g;
const COLOR_LITERAL_RE =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/deg]+\))$/;

/** Plain colour literals from the light-mode :root block, keyed by property. */
function rootColorVars(content) {
  const block = ROOT_BLOCK_RE.exec(content);
  if (!block) return {};
  const vars = {};
  for (const [, prop, raw] of block[1].matchAll(DECL_RE)) {
    const value = raw.trim();
    if (COLOR_LITERAL_RE.test(value)) vars[prop] = value;
  }
  return vars;
}

const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".css"))
  .sort();

const themes = [];
for (const file of files) {
  const slug = file.replace(/\.css$/, "");
  const content = fs.readFileSync(path.join(SRC, file), "utf8");

  // The backend drops a file with no :root block rather than listing it; a demo
  // that offered it would activate a theme that styles nothing.
  if (!/:root\s*\{/.test(content)) {
    console.warn(`    ! ${file} has no :root block — skipped, as the server would`);
    continue;
  }

  const name = TITLE_RE.exec(content)?.[1] || slug;

  // shim.js resolves the active theme to /assets/themes/<name.toLowerCase()>.css,
  // the same lowercase mapping the backend uses to find the file. A title that
  // does not match its filename would fetch a 404 and fall back to the baked-in
  // theme.css — the page stays styled, so the failure is silent.
  if (name.toLowerCase() !== slug) {
    console.warn(
      `    ! ${file} declares theme-title "${name}" — the demo would look for ` +
        `${name.toLowerCase()}.css and fall back to the default theme`,
    );
  }

  const vars = rootColorVars(content);
  themes.push({
    name,
    description: DESC_RE.exec(content)?.[1] || "",
    preview_color: COLOR_RE.exec(content)?.[1] || vars["--color-primary"] || "",
    preview_bg: vars["--bg-primary"] || "",
    preview_surface: vars["--surface-card"] || "",
    preview_text: vars["--text-primary"] || "",
    preview_border: vars["--border-primary"] || "",
    has_dark_mode: content.includes('[data-theme="dark"]'),
  });
}

if (!themes.length) {
  console.error(`No themes found in ${SRC}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(themes, null, 2) + "\n");
console.log(`    ${themes.length} themes: ${themes.map((t) => t.name).join(", ")}`);
