#!/usr/bin/env node
/**
 * Restructures an already-generated demo instance onto the tag tree in
 * demo/world.mjs, without regenerating any prose.
 *
 * The first demo generation let the model invent its own keywords per photo.
 * That produced ~100 topical tags of which roughly 80 named a single post — a
 * flat list that demonstrates the tag *page*, but not the hierarchy, the
 * breadcrumbs or the ancestor flyout, which are the features worth showing.
 * This walks the existing posts, folds their keywords onto the controlled
 * vocabulary, rebuilds the tree around them, and deletes what is left over.
 *
 * It also moves each post's prose from the body into `excerpt`. The body keeps
 * only its photograph, which is what makes the Sheet immersive viewer worth
 * enabling: the sheet renders `excerpt`, so the writing surfaces there instead
 * of sitting below the fold of a page nobody scrolls.
 *
 * A fresh `demo/scripts/make-content.sh` run produces this shape directly —
 * generate-content.mjs shares the same module. This script exists so the
 * existing bundle can be restructured without a Gemini key or new photographs.
 *
 * Usage:
 *   node demo/scripts/retag-content.mjs --base=http://127.0.0.1:8002 \
 *     --session=<token> --db=/path/to/scratch/point.db
 */

import { DatabaseSync } from "node:sqlite";

import {
  LOCATIONS,
  YEARS,
  buildTagScaffold,
  countryOf,
  postTags,
  toTopic,
} from "../world.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://127.0.0.1:8002";
const SESSION = args.session || "";
const DB_PATH = args.db || "";

for (const [name, value] of [
  ["--session", SESSION],
  ["--db", DB_PATH],
]) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

/**
 * Plugins the demo should present, applied in order.
 *
 * The tag cloud and the atlas answer the same question — "what is in this
 * archive?" — and the cloud answers it as a flat weighted list, which is
 * exactly what a hierarchy replaces.
 *
 * Standard and Sheet are the two members of the exclusive `immersive` area and
 * at least one must stay enabled (api/internal/plugins/registry.go), so Sheet
 * is turned on before Standard is turned off. The order is load-bearing.
 */
const PLUGIN_STATE = [
  ["tag-cloud", false],
  ["tags-atlas", true],
  ["immersive-sheet", true],
  ["immersive", false],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const init = {
    method,
    headers: { Cookie: `session=${SESSION}`, Accept: "application/json" },
  };
  if (body !== undefined) {
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

/**
 * Fetches every page of a paginated collection.
 *
 * The page size parameter is `per_page`; an unrecognised one is ignored rather
 * than rejected, so getting it wrong silently returns the first default-sized
 * page and every later step quietly operates on a fraction of the data.
 */
async function listAll(path, key) {
  const PER_PAGE = 100;
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const data = await api("GET", `${path}?page=${page}&per_page=${PER_PAGE}`);
    const batch = data?.[key] || [];
    const fresh = batch.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));
    out.push(...fresh);

    if (!fresh.length) break;
    if (data.pages && page >= data.pages) break;
    if (!data.pages && batch.length < PER_PAGE) break;
  }
  return out;
}

// ── Prose ─────────────────────────────────────────────────────────────────

/**
 * Splits a generated body into its photograph and its prose.
 *
 * Generated bodies are `path` followed by paragraphs. Anything that
 * does not match that shape is left alone — a hand-edited post should not be
 * silently rewritten.
 */
function splitBody(content) {
  const lines = content.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first === -1 || !/^\/.+$/.test(lines[first].trim())) return null;

  const prose = lines
    .slice(first + 1)
    .join("\n")
    .trim();
  if (!prose) return null;
  return { image: lines[first].trim(), prose };
}

/** Collapses Markdown paragraphs into one plain-text run for the excerpt field. */
function toExcerpt(prose) {
  return prose
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

// ── Main ──────────────────────────────────────────────────────────────────

const CITY_NAMES = new Set(LOCATIONS.map((l) => l.name));
const YEAR_NAMES = new Set(YEARS.map(String));

/**
 * Deals each of a city's posts a year from that city's own window (see
 * LOCATIONS in demo/world.mjs), cycling so the posts spread evenly across it.
 *
 * The first generation dealt location and year from two round-robins whose
 * lengths happen to be coprime (4 and 7), so 28 posts landed on all 28
 * combinations: every place had a post in every year. That reads fine on the
 * archive, but it makes the Atlas's timeline filter look broken — narrowing the
 * range can never drop a place from the map when every place is in every range.
 */
function yearScheduler() {
  const seen = new Map();
  return (cityName) => {
    const loc = LOCATIONS.find((l) => l.name === cityName);
    if (!loc) return null;
    const n = seen.get(cityName) || 0;
    seen.set(cityName, n + 1);
    return loc.years[n % loc.years.length];
  };
}

/**
 * Move a recorded timestamp onto `year`, keeping its month, day and time.
 *
 * The archive's dates and its year tags have to agree — the timeline reads the
 * tags, the post cards print the date — so rescheduling a post's year without
 * this would leave a "2026" post dated 2020.
 */
function restamp(stamp, year) {
  if (typeof stamp !== "string" || !/^\d{4}-/.test(stamp)) return stamp;
  const moved = `${year}${stamp.slice(4)}`;
  // Same clamp generate-content.mjs applies: the current year is only partly
  // elapsed, and a post dated in the future sorts above everything and reads
  // as a bug.
  const ceiling = new Date(Date.now() - 3600_000);
  return new Date(moved.replace(" ", "T") + "Z") > ceiling
    ? ceiling.toISOString().slice(0, 19).replace("T", " ")
    : moved;
}

async function main() {
  console.log(`Restructuring ${BASE}`);

  const posts = await listAll("/api/posts", "posts");
  console.log(`· ${posts.length} post(s)`);
  // Deal the years in a stable order, so a re-run reproduces the same archive.
  posts.sort((a, b) => a.id - b.id);

  // Timestamps are captured before any write and restored after: the archive
  // spans 2020–2026 only because generate-content.mjs backdated it
  // directly in SQLite, and a PUT through the API has no way to preserve that.
  const db = new DatabaseSync(DB_PATH);
  const stamps = new Map(
    db
      .prepare("SELECT id, published_at, created_at FROM posts")
      .all()
      .map((r) => [r.id, r]),
  );

  const dropped = new Set();
  const used = new Set();
  const nextYear = yearScheduler();
  let moved = 0;

  for (const summary of posts) {
    const post = await api("GET", `/api/posts/${summary.id}`);
    const names = (post.tags || []).map((t) => (typeof t === "string" ? t : t.name));

    const city = names.find((n) => CITY_NAMES.has(n));
    if (!city || !names.some((n) => YEAR_NAMES.has(n))) {
      console.warn(`  ! post ${post.id} has no city/year tag — leaving it alone`);
      continue;
    }
    // The post keeps its place and its prose; only its year is redealt, onto
    // that place's window. Its timestamp moves with it (see restamp).
    const year = String(nextYear(city));
    const stamp = stamps.get(post.id);
    if (stamp) {
      stamp.published_at = restamp(stamp.published_at, year);
      stamp.created_at = restamp(stamp.created_at, year);
    }

    const topics = [];
    for (const name of names) {
      if (CITY_NAMES.has(name) || YEAR_NAMES.has(name)) continue;
      if (name === countryOf(city)) continue;
      const topic = toTopic(name);
      if (!topic) {
        dropped.add(name);
        continue;
      }
      if (!topics.includes(topic)) topics.push(topic);
    }
    topics.forEach((t) => used.add(t));

    const body = { tags: postTags(city, year, topics) };

    const split = splitBody(post.content || "");
    if (split) {
      body.content = split.image;
      body.excerpt = toExcerpt(split.prose);
      moved++;
    }

    await api("PUT", `/api/posts/${post.id}`, body);
    console.log(
      `  ${String(post.id).padStart(2)} ${city.padEnd(11)} ${year}  ${topics.join(", ") || "(no topics)"}`,
    );
  }

  console.log(`· moved prose into excerpt for ${moved} post(s)`);
  if (dropped.size) {
    console.log(`· dropped ${dropped.size} uninformative keyword(s): ${[...dropped].sort().join(", ")}`);
  }

  // After the posts, not before: tagging auto-creates each name as an unfiled
  // root tag, and the scaffold adopts those and files them under the tree.
  console.log("· tag scaffold");
  await buildTagScaffold(api, { topics: [...used] });

  // ── Verify, before anything irreversible ────────────────────────────────
  //
  // A topic on a single post is a label, not a facet: clicking it lands on an
  // archive page holding only the post you came from — precisely the failure
  // this restructure exists to remove. Checked here rather than at the end
  // because the sweep below deletes tags, and a run that stops half way should
  // stop with the old vocabulary still intact.

  await api("POST", "/api/tags/recalculate-counts").catch(() => {});

  const counts = new Map(
    ((await api("GET", "/api/tags"))?.tags || []).map((t) => [t.name, t.post_count || 0]),
  );
  const thin = [...used].filter((t) => counts.get(t) < 2);
  if (thin.length) {
    console.error(`\nFAIL — topic(s) on fewer than 2 posts: ${thin.join(", ")}`);
    console.error("Nothing was deleted. Widen TOPIC_ALIASES in demo/world.mjs.");
    process.exit(1);
  }

  // ── Sweep ───────────────────────────────────────────────────────────────
  //
  // Every tag the old flat vocabulary left behind. Deleting by "not in the
  // tree" rather than "post_count is 0" also removes the previous `location`
  // root, which still has children and would otherwise survive as a second,
  // half-empty geography.

  const keep = new Set([
    "country", "city", "date", "subject",
    ...LOCATIONS.map((l) => l.name),
    ...LOCATIONS.map((l) => l.country),
    ...YEARS.map(String),
    ...used,
  ]);
  const groups = await api("GET", "/api/tags");
  for (const tag of groups.tags || []) {
    // Subject groups (terrain, water, …) are keyed off their parent rather
    // than listed twice; anything else outside the tree goes.
    const parents = (tag.parents || []).map((p) => p.name);
    if (keep.has(tag.name) || parents.includes("subject")) continue;
    await api("DELETE", `/api/tags/${tag.id}`);
  }

  // ── Plugins ─────────────────────────────────────────────────────────────

  console.log("· plugins");
  for (const [id, enabled] of PLUGIN_STATE) {
    await api("PATCH", `/api/plugins/${id}`, { enabled });
    console.log(`  ${enabled ? "on " : "off"} ${id}`);
  }

  // ── Restore the archive's dates ─────────────────────────────────────────

  const restore = db.prepare(
    "UPDATE posts SET published_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
  );
  for (const [id, row] of stamps) {
    restore.run(row.published_at, row.created_at, row.published_at, id);
  }
  db.close();

  await api("POST", "/api/system/cache/clear").catch(() => {});
  await api("POST", "/api/system/media/recalculate-visibility").catch(() => {});
  await api("POST", "/api/tags/recalculate-counts").catch(() => {});

  const final = await api("GET", "/api/tags");
  console.log(`\n${final.tags.length} tag(s), ${used.size} topic(s), all on 2+ posts.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
