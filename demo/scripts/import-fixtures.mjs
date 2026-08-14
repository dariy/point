#!/usr/bin/env node
/**
 * Rebuilds a Point instance from a recorded fixture bundle.
 *
 * The inverse of record-fixtures.mjs, and the reason the scratch instance is
 * genuinely disposable: `demo/mock/fixtures/fixtures.json` plus the original
 * photographs is enough to stand the archive back up, so content that took a
 * Gemini run to write survives the loss of the database it was written into.
 *
 * That is what makes *adding* to the demo possible. Growing the archive used to
 * mean re-running generate-content.mjs from scratch — new photographs and new
 * prose for every post, including the ones that were already good. Importing
 * first and generating on top (`make-content.sh --add=N`) leaves every existing
 * post exactly as it was recorded.
 *
 * Everything goes in through the REST API, like the generator: slugs, tag
 * counts, media linking and visibility all follow the same code paths as a real
 * edit. The exceptions are the three timestamp columns and `view_count`, which
 * the API owns and would otherwise reset to "just now" — collapsing a 2020-2026
 * archive onto today. Those are restored directly in SQLite at the end, the
 * same way generate-content.mjs backdates.
 *
 * Usage:
 *   node demo/scripts/import-fixtures.mjs \
 *     --base=http://localhost:8002 --session=<token> \
 *     --db=/path/to/scratch/point.db [--media=/path/to/originals]
 *
 * Intended to run against an EMPTY scratch instance — see make-content.sh.
 */

import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(HERE, "..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://localhost:8002";
const SESSION = args.session || "";
const DB_PATH = args.db || "";
const FIXTURES = args.fixtures || path.join(DEMO_DIR, "mock/fixtures/fixtures.json");
const MEDIA_SRC = args.media || path.join(DEMO_DIR, ".scratch/media/originals");

for (const [name, value] of [
  ["--session", SESSION],
  ["--db", DB_PATH],
]) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const init = {
    method,
    headers: { Cookie: `session=${SESSION}`, Accept: "application/json" },
  };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, init);
    // The server's publicLimiter allows ~10 req/s; back off rather than fail.
    if (res.status === 429 && attempt < 4) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

// ── Tags ──────────────────────────────────────────────────────────────────

/**
 * Recreate every recorded tag, then wire the parent links.
 *
 * Two passes because a parent link is an id: the whole set has to exist before
 * any of it can be joined up, and the tag graph is a DAG in which a city hangs
 * off both its country and the flat `city` index, so there is no creation order
 * that would let one pass do it.
 *
 * Fields are copied verbatim rather than rebuilt from world.mjs. The recorded
 * tree already *is* that world, plus the texture a run through the API leaves
 * on it — `kind: ""` and `in_breadcrumbs: false` on the tags the post endpoint
 * auto-created, which is exactly what would be lost by regenerating them.
 *
 * Returns old tag id → new tag id.
 */
async function importTags(tags) {
  const idMap = new Map();

  for (const tag of [...tags].sort((a, b) => a.id - b.id)) {
    const at = (tag.locations || [])[0];
    const created = await api("POST", "/api/tags", {
      name: tag.name,
      slug: tag.slug,
      kind: tag.kind || "",
      description: tag.description || "",
      hidden: !!tag.hidden,
      hides_posts: !!tag.hides_posts,
      nav_order: tag.nav_order ?? null,
      in_breadcrumbs: !!tag.in_breadcrumbs,
      in_ancestor_flyout: !!tag.in_ancestor_flyout,
      show_related: !!tag.show_related,
      ...(at ? { latitude: at.latitude, longitude: at.longitude } : {}),
    });
    idMap.set(tag.id, created.id);
  }

  for (const tag of tags) {
    const parents = (tag.parents || []).map((p) => idMap.get(p.id)).filter(Boolean);
    if (!parents.length) continue;
    await api("PUT", `/api/tags/${idMap.get(tag.id)}/parents`, { ids: parents });
  }

  return idMap;
}

// ── Media ─────────────────────────────────────────────────────────────────

/**
 * Re-upload every recorded photograph from the originals on disk.
 *
 * The upload endpoint stamps its own `<timestamp>_` prefix onto the stored
 * name, so the recorded path is stripped back to the filename the generator
 * chose (`demo-374.jpg`) before sending — otherwise each import would layer
 * another timestamp on the last, and a bundle imported twice would carry names
 * no one can read.
 *
 * Paths therefore change, which is why the mapping is returned: post bodies
 * reference their photograph by path, and a body still pointing at the old one
 * is a post with a broken image.
 */
async function importMedia(media) {
  const pathMap = new Map();
  let missing = 0;

  for (const item of [...media].sort((a, b) => a.id - b.id)) {
    const file = path.join(MEDIA_SRC, item.path.replace(/^\//, ""));
    if (!existsSync(file)) {
      console.warn(`  ! missing original: ${item.path}`);
      missing++;
      continue;
    }

    const form = new FormData();
    const bytes = await readFile(file);
    form.append(
      "file",
      new Blob([bytes], { type: item.mime_type || "image/jpeg" }),
      item.filename || path.basename(file),
    );
    const uploaded = await api("POST", "/api/media/upload", form);
    const newPath = uploaded.path || uploaded.url || uploaded.media?.path;
    if (!newPath) {
      throw new Error(`upload returned no path: ${JSON.stringify(uploaded).slice(0, 200)}`);
    }
    pathMap.set(item.path, newPath);

    // Alt text and caption are separate columns the upload does not carry.
    if (item.alt_text || item.caption) {
      await api("PATCH", `/api/media/${uploaded.id}`, {
        alt_text: item.alt_text ?? "",
        caption: item.caption ?? "",
      });
    }
  }

  if (missing) {
    console.warn(`  ! ${missing} original(s) absent — their posts will import without an image`);
  }
  return pathMap;
}

// ── Posts ─────────────────────────────────────────────────────────────────

/** Rewrite every recorded media path in a body to the path it now lives at. */
function rewriteMediaPaths(text, pathMap) {
  let out = String(text ?? "");
  for (const [oldPath, newPath] of pathMap) {
    out = out.split(oldPath).join(newPath);
  }
  return out;
}

/**
 * Recreate the posts, newest id last so the archive rebuilds in the order it
 * was written.
 *
 * Tags are passed by name, the way the generator passes them: the endpoint
 * resolves an existing tag and auto-creates anything it does not know. By this
 * point it knows all of them, so nothing is created here — a post arriving with
 * a tag name absent from the recorded tree would be a bug in the recording, and
 * showing up as a new unfiled root is the right way to notice.
 *
 * Returns the rows the timestamp restore needs.
 */
async function importPosts(fixtures, pathMap) {
  const created = [];

  for (const listed of [...fixtures.posts].sort((a, b) => a.id - b.id)) {
    const detail = fixtures.postDetail[String(listed.id)] || {};
    const tags = (detail.tags || listed.tags || []).map((t) => t.name).filter(Boolean);

    const post = await api("POST", "/api/posts", {
      title: detail.title ?? listed.title ?? "",
      slug: listed.slug,
      content: rewriteMediaPaths(detail.content, pathMap),
      excerpt: detail.excerpt ?? listed.excerpt ?? "",
      formatter: listed.formatter || "markdown",
      // A scheduled post needs its date at creation or the API rejects it; the
      // other statuses take theirs from the timestamp restore below.
      status: listed.status || "published",
      type: listed.type || "post",
      is_featured: !!listed.is_featured,
      immersive_mode: listed.immersive_mode || "",
      meta_description: listed.meta_description || "",
      css: detail.css || "",
      thumbnail_path: rewriteMediaPaths(
        detail.thumbnail_path || detail.media?.[0]?.path || listed.media_url || "",
        pathMap,
      ),
      tags,
      ...(listed.scheduled_at ? { scheduled_at: listed.scheduled_at } : {}),
    });

    created.push({
      id: post.id,
      published_at: listed.published_at ?? null,
      created_at: listed.created_at ?? null,
      updated_at: listed.updated_at ?? listed.created_at ?? null,
      view_count: listed.view_count ?? 0,
      title: post.title,
    });
  }

  return created;
}

// ── Timestamps ────────────────────────────────────────────────────────────

/**
 * Put the recorded dates and view counts back.
 *
 * `published_at` is set server-side at publish time and cannot be sent, so
 * every imported post lands dated today — which would flatten the archive the
 * timeline, the Atlas's year scoping and the year tags are all built on. The
 * same write restores `view_count`, which the API only ever increments.
 *
 * SQLite stores these as `YYYY-MM-DD HH:MM:SS`; the fixture carries RFC3339.
 */
function restoreTimestamps(rows) {
  const db = new DatabaseSync(DB_PATH);
  const update = db.prepare(
    "UPDATE posts SET published_at = ?, created_at = ?, updated_at = ?, view_count = ? WHERE id = ?",
  );

  const sqlite = (iso) =>
    iso ? new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z?$/, "") : null;

  for (const row of rows) {
    update.run(
      sqlite(row.published_at),
      sqlite(row.created_at),
      sqlite(row.updated_at),
      row.view_count,
      row.id,
    );
  }

  db.close();
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const fixtures = JSON.parse(await readFile(FIXTURES, "utf8"));
  console.log(
    `Importing ${fixtures.posts?.length ?? 0} post(s), ${fixtures.tags?.length ?? 0} tag(s), ` +
      `${fixtures.media?.length ?? 0} media into ${BASE}`,
  );
  console.log(`  fixtures: ${FIXTURES}`);
  console.log(`  originals: ${MEDIA_SRC}`);

  // Importing into an instance that already holds posts would duplicate the
  // archive rather than restore it, and the duplicate is only visible once the
  // fixtures have been re-recorded over the good ones.
  const existing = await api("GET", "/api/posts?per_page=1");
  if (existing?.total > 0) {
    throw new Error(`${BASE} already holds ${existing.total} post(s) — import wants an empty instance`);
  }

  console.log("· tags");
  await importTags(fixtures.tags || []);

  console.log("· media");
  const pathMap = await importMedia(fixtures.media || []);
  console.log(`  ${pathMap.size} uploaded`);

  console.log("· posts");
  const rows = await importPosts(fixtures, pathMap);
  console.log(`  ${rows.length} created`);

  console.log("· restoring dates and view counts");
  restoreTimestamps(rows);

  // The same three the generator runs: the page cache holds the pre-backdate
  // ordering, media visibility is derived from post state, and tag counts were
  // written per-post as the archive went in.
  console.log("· clearing caches");
  await api("POST", "/api/system/cache/clear").catch(() => {});
  await api("POST", "/api/system/media/recalculate-visibility").catch(() => {});
  await api("POST", "/api/tags/recalculate-counts").catch(() => {});

  console.log(`\nDone: ${rows.length} post(s) restored`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
