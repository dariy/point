#!/usr/bin/env node
/**
 * Static file server for the demo build, driven by the build's own `_redirects`.
 *
 * The demo is deployed to Cloudflare Pages, which resolves a request against the
 * static files first and only consults `_redirects` when nothing matched. Every
 * admin route (`/light/...`) is a client-side route with no file behind it, so
 * without that fallback the entire admin UI — the thing the demo exists to show
 * — is a 404. `npx serve` does not read `_redirects`, and its `-s` flag rewrites
 * *everything* to index.html, which hands a 200 + HTML shell to missing images
 * and defeats dropBrokenImages() (frontend/src/utils/helpers.js).
 *
 * So the rules are read from the build itself rather than restated here: local
 * serving and the deployed site cannot drift apart.
 *
 * Usage: node scripts/serve-demo.mjs [--dir=dist-demo] [--host=127.0.0.1] [--port=8002]
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const ROOT = resolve(args.dir || "dist-demo");
const HOST = args.host || "127.0.0.1";
const PORT = Number(args.port || 8002);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Parses `_redirects`: `<source> <destination> [status]`, one rule per line,
 * first match wins. Only the trailing-`*` splat that build-demo.sh emits is
 * supported — an unrecognised source is reported rather than silently ignored,
 * since a rule that quietly does nothing is exactly how the admin UI 404s.
 */
async function loadRedirects(dir) {
  let text;
  try {
    text = await readFile(join(dir, "_redirects"), "utf8");
  } catch {
    console.warn(`! no _redirects in ${dir} — serving files only, no SPA fallback`);
    return [];
  }

  const rules = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [source, destination, status] = trimmed.split(/\s+/);
    if (!destination) {
      console.warn(`! ignoring malformed _redirects line: ${trimmed}`);
      continue;
    }
    if (source.slice(0, -1).includes("*") || source.includes(":")) {
      console.warn(`! unsupported _redirects source "${source}" — ignoring`);
      continue;
    }

    const pattern = source.endsWith("*")
      ? new RegExp(`^${escapeRe(source.slice(0, -1))}`)
      : new RegExp(`^${escapeRe(source)}$`);
    rules.push({ pattern, destination, status: Number(status) || 200 });
  }
  return rules;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolves a URL path to a file inside ROOT, or null. Refuses to escape ROOT. */
async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const rel = normalize(decoded.endsWith("/") ? `${decoded}index.html` : decoded);
  const abs = join(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;

  try {
    const stats = await stat(abs);
    if (stats.isDirectory()) return resolveFile(`${urlPath.replace(/\/$/, "")}/`);
    return { abs, size: stats.size };
  } catch {
    return null;
  }
}

function send(res, status, file, req) {
  const type = MIME[extname(file.abs).toLowerCase()] || "application/octet-stream";
  const headers = {
    "Content-Type": type,
    // The deployed build caches aggressively via `_headers`; locally that only
    // serves stale bundles after a rebuild.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  // Range support keeps video seeking working; without it the player has to
  // download a whole file before it can jump.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && status === 200 && file.size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
    if (start > end || start >= file.size) {
      res.writeHead(416, { "Content-Range": `bytes */${file.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${file.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    return createReadStream(file.abs, { start, end }).pipe(res);
  }

  res.writeHead(status, { ...headers, "Accept-Ranges": "bytes", "Content-Length": file.size });
  if (req.method === "HEAD") return res.end();
  return createReadStream(file.abs).pipe(res);
}

const rules = await loadRedirects(ROOT);

const server = createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0].split("#")[0];

  try {
    const direct = await resolveFile(urlPath);
    if (direct) return send(res, 200, direct, req);

    for (const rule of rules) {
      if (!rule.pattern.test(urlPath)) continue;
      if (rule.status >= 300 && rule.status < 400) {
        res.writeHead(rule.status, { Location: rule.destination });
        return res.end();
      }
      const target = await resolveFile(rule.destination);
      if (target) return send(res, rule.status, target, req);
      break;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  } catch (err) {
    console.error(`  500 ${urlPath}: ${err.message}`);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal error\n");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT} on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`${rules.length} rule(s) from _redirects — admin UI at /light`);
});
