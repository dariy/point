#!/usr/bin/env node
/**
 * Emits feed.xml and sitemap.xml for the static demo.
 *
 * In production these are rendered by the Go server (api/cmd/api/main.go
 * registers /feed.xml, /feed, /sitemap.xml, /robots.txt), so a static build has
 * to write them out — the shell's <link rel="alternate" href="/feed.xml">
 * otherwise points at the SPA fallback and serves HTML as RSS.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);

const FIXTURES = resolve(args.fixtures);
const OUT = resolve(args.out);
// Relative URLs are invalid in RSS, so the feed needs an absolute base. It is
// only cosmetic in a demo; override when the real hostname is known.
const BASE = (args.base || "https://demo.point.photos").replace(/\/$/, "");

const escapeXml = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

async function main() {
  const fx = JSON.parse(await readFile(FIXTURES, "utf8"));
  const settings = fx.publicSettings || {};

  const posts = (fx.posts || [])
    .filter((p) => p.status === "published" && !p.is_hidden && p.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  const title = settings.blog_title || "Point Demo";
  const subtitle = settings.blog_subtitle || "";

  const items = posts
    .slice(0, 50)
    .map((p) => {
      const url = `${BASE}/posts/${encodeURIComponent(p.slug)}`;
      return [
        "    <item>",
        `      <title>${escapeXml(p.title || p.slug)}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `      <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>`,
        `      <description>${escapeXml(p.excerpt || "")}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(BASE)}</link>
    <description>${escapeXml(subtitle)}</description>
    <atom:link href="${escapeXml(`${BASE}/feed.xml`)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;

  const urls = [
    `  <url><loc>${escapeXml(BASE)}/</loc></url>`,
    ...posts.map(
      (p) =>
        `  <url><loc>${escapeXml(`${BASE}/posts/${encodeURIComponent(p.slug)}`)}</loc>` +
        `<lastmod>${new Date(p.published_at).toISOString().slice(0, 10)}</lastmod></url>`,
    ),
  ].join("\n");

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  await writeFile(resolve(OUT, "feed.xml"), feed);
  await writeFile(resolve(OUT, "sitemap.xml"), sitemap);
  console.log(`    feed.xml + sitemap.xml: ${posts.length} post(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
