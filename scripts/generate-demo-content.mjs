#!/usr/bin/env node
/**
 * Generates demo blog content into a running Point instance.
 *
 * Photos come from picsum.photos (Unsplash-sourced, freely usable); the text is
 * written by Gemini from the image itself, so titles, excerpts and tags actually
 * describe the picture instead of reading as filler. Each post is assigned a
 * year in [2020, 2026] and one of four locations, giving the timeline, the map
 * and the tag hierarchy real data to render.
 *
 * Everything is created through the REST API rather than written to SQLite, so
 * slugs, tag counts, media linking and visibility all go through the same code
 * paths as a real edit. The one exception is `published_at`: the API sets it
 * server-side at publish time and a past `scheduled_at` publishes immediately,
 * so backdating is applied directly to the database at the end.
 *
 * Usage:
 *   node scripts/generate-demo-content.mjs \
 *     --base=http://localhost:8002 --session=<token> \
 *     --db=/path/to/scratch/point.db --gemini-key=<key> [--count=28]
 *
 * Intended to run against a SCRATCH instance — see scripts/make-demo-content.sh.
 */

import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://localhost:8002";
const SESSION = args.session || "";
const DB_PATH = args.db || "";
const GEMINI_KEY = args["gemini-key"] || process.env.GEMINI_API_KEY || "";
const COUNT = Number(args.count) || 28;
const MODEL = args.model || "gemini-2.5-flash";
const CONCURRENCY = Number(args.concurrency) || 4;

for (const [name, value] of [
  ["--session", SESSION],
  ["--db", DB_PATH],
  ["--gemini-key", GEMINI_KEY],
]) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

// ── Demo world ────────────────────────────────────────────────────────────
//
// Four locations with real coordinates so the map and atlas plot something
// meaningful, chosen to be visually distinct enough that Gemini can plausibly
// match most photographs to one of them.

const LOCATIONS = [
  { name: "Lisbon", country: "Portugal", latitude: 38.7223, longitude: -9.1393 },
  { name: "Reykjavík", country: "Iceland", latitude: 64.1466, longitude: -21.9426 },
  { name: "Kyoto", country: "Japan", latitude: 35.0116, longitude: 135.7681 },
  { name: "El Chaltén", country: "Argentina", latitude: -49.3315, longitude: -72.8863 },
];

const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

/**
 * Deterministic PRNG (mulberry32) so a re-run reproduces the same year and
 * location assignment. A demo that reshuffles itself on every rebuild makes
 * screenshots and bug reports impossible to compare.
 */
function makeRandom(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeRandom(20260803);

// ── HTTP ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, { raw = false } = {}) {
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
    if (raw) return text;
    return text ? JSON.parse(text) : null;
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    excerpt: { type: "string" },
    body: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "excerpt", "body", "tags"],
};

function promptFor(photo, location, year) {
  return `You are writing a short entry for a personal photography blog.

Look at the attached photograph and write about it as if you took it yourself,
in ${location.name}, ${location.country}, in ${year}.

Return JSON with:
- "title": 2-5 words, evocative, no quotes, no trailing punctuation. Do not put
  the place name in the title.
- "excerpt": one sentence, max 140 characters, describing the scene.
- "body": 2-3 short paragraphs of plain Markdown (no headings, no images, no
  links). Write about what is in the frame, the light, and the moment. Weave in
  a sense of being in ${location.name}, but only as far as the image supports —
  if the subject is a close-up or an interior, keep the place incidental rather
  than inventing scenery that is not visible. Keep it under 130 words. Do not
  mention cameras, settings, or the word "photo".
- "tags": 3-5 lowercase single-word or hyphenated topical keywords describing
  the subject matter (e.g. "architecture", "coastline", "street-life"). No
  place names, no years.

The photograph is credited to ${photo.author}.`;
}

async function generateText(photo, imageBase64, location, year) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${GEMINI_KEY}`;

  const payload = {
    contents: [
      {
        parts: [
          { text: promptFor(photo, location, year) },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 1.0,
    },
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("gemini returned no text");
    return JSON.parse(text);
  }
  throw new Error("gemini: retries exhausted");
}

// ── Picsum ────────────────────────────────────────────────────────────────

async function fetchPhotoList(count) {
  const candidates = [];
  for (let page = 1; page <= 6; page++) {
    const res = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=100`);
    if (!res.ok) throw new Error(`picsum list ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    // Landscape only: the grid and immersive viewer are built around wide
    // images, and portrait originals make the demo look inconsistent.
    candidates.push(...batch.filter((p) => p.width / p.height >= 1.3));
  }

  // Sample across the whole catalogue rather than taking the first N. Picsum's
  // opening run is a single photographer's desk-and-laptop series, so the head
  // of the list yields a demo where every post looks the same.
  const shuffled = candidates
    .map((photo) => ({ photo, sort: random() }))
    .sort((a, b) => a.sort - b.sort)
    .map((entry) => entry.photo);

  // One photo per author where possible — the catalogue repeats contributors,
  // and near-duplicate scenes read as padding.
  const seenAuthors = new Set();
  const varied = shuffled.filter((p) => {
    if (seenAuthors.has(p.author)) return false;
    seenAuthors.add(p.author);
    return true;
  });

  return (varied.length >= count ? varied : shuffled).slice(0, count);
}

async function download(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`download failed: ${url}`);
}

// ── Tag scaffold ──────────────────────────────────────────────────────────

/**
 * Create the tag hierarchy the navigation and visualisations read.
 *
 * `location` and `year` are roots; cities hang under `location` carrying real
 * coordinates, and each year is a `kind: "year"` tag, which is what the
 * timeline pills are built from.
 */
async function buildTagScaffold() {
  const created = {};

  // Idempotent: creating a tag that exists is a 409, and the script should be
  // safe to re-run against a partially-built instance.
  const existing = new Map(
    ((await api("GET", "/api/tags"))?.tags || []).map((t) => [t.name.toLowerCase(), t]),
  );

  const makeTag = async (body) => {
    const hit = existing.get(body.name.toLowerCase());
    if (hit) {
      created[hit.name] = hit;
      return hit;
    }
    const tag = await api("POST", "/api/tags", {
      in_breadcrumbs: true,
      in_ancestor_flyout: true,
      ...body,
    });
    created[tag.name] = tag;
    existing.set(tag.name.toLowerCase(), tag);
    return tag;
  };

  const locationRoot = await makeTag({
    name: "location",
    kind: "tag",
    description: "Where these were taken.",
  });

  for (const loc of LOCATIONS) {
    await makeTag({
      name: loc.name,
      kind: "tag",
      description: `${loc.name}, ${loc.country}`,
      latitude: loc.latitude,
      longitude: loc.longitude,
      parent_ids: [locationRoot.id],
    });
  }

  for (const year of YEARS) {
    await makeTag({ name: String(year), kind: "year" });
  }

  console.log(`  tag scaffold: ${Object.keys(created).length} tags`);
  return created;
}

// ── Post creation ─────────────────────────────────────────────────────────

async function createOne(photo, index) {
  // Two sizes: a wide one for the blog, and a small one for Gemini — sending a
  // 1600px image would cost tokens and latency for no gain in description
  // quality.
  const blogHeight = Math.round((1600 * photo.height) / photo.width);
  const [full, small] = await Promise.all([
    download(`https://picsum.photos/id/${photo.id}/1600/${blogHeight}`),
    download(`https://picsum.photos/id/${photo.id}/640/${Math.round((640 * photo.height) / photo.width)}`),
  ]);

  // Location and year are assigned round-robin rather than chosen by the model.
  // Letting Gemini pick clustered almost everything onto one city, which leaves
  // the map with a single pin and the timeline lopsided — the two features the
  // spread exists to demonstrate.
  const location = LOCATIONS[index % LOCATIONS.length];
  const year = YEARS[index % YEARS.length];

  const text = await generateText(photo, small.toString("base64"), location, year);

  // Upload the image, then embed its returned path in the post body so the
  // server links the media record to the post the same way the editor does.
  const form = new FormData();
  form.append("file", new Blob([full], { type: "image/jpeg" }), `demo-${photo.id}.jpg`);
  const uploaded = await api("POST", "/api/media/upload", form);
  const mediaPath = uploaded.path || uploaded.url || uploaded.media?.path;
  if (!mediaPath) {
    throw new Error(`upload returned no path: ${JSON.stringify(uploaded).slice(0, 200)}`);
  }

  const body = [
    `![${text.title}](${mediaPath})`,
    "",
    text.body.trim(),
  ].join("\n");

  const topical = (text.tags || [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-"))
    .filter(Boolean)
    .slice(0, 5);

  const post = await api("POST", "/api/posts", {
    title: text.title,
    content: body,
    excerpt: text.excerpt,
    status: "published",
    formatter: "markdown",
    thumbnail_path: mediaPath,
    // Location and year are tags, which is how Point models both — the timeline
    // reads `kind: "year"` tags and the map reads coordinates off place tags.
    tags: [location.name, String(year), ...topical],
    is_featured: index === 0,
  });

  return { post, year, location, title: text.title };
}

/** Run `worker` over `items` with a bounded number in flight. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// ── Backdating ────────────────────────────────────────────────────────────

/**
 * Spread posts across their assigned years.
 *
 * Done in SQL because the API deliberately owns `published_at`: it is set at
 * publish time, and a past `scheduled_at` publishes immediately rather than
 * backdating. Writing it directly is the only way to build a multi-year archive.
 */
function backdate(assignments) {
  const db = new DatabaseSync(DB_PATH);
  const update = db.prepare(
    "UPDATE posts SET published_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
  );

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  // Ceiling of an hour ago: the current year is only partly elapsed, so an
  // unbounded date publishes posts in the future, where they sort above
  // everything else and read as a bug. Clamping the whole timestamp (rather
  // than just the month) also covers "today, but later this afternoon".
  const ceiling = new Date(now.getTime() - 3600_000);

  for (const { postId, year } of assignments) {
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    const hour = 7 + Math.floor(random() * 12);
    const minute = Math.floor(random() * 60);

    let when = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (when > ceiling) when = ceiling;

    const stamp =
      `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} ` +
      `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:00`;
    update.run(stamp, stamp, stamp, postId);
  }

  db.close();
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating ${COUNT} demo posts into ${BASE}`);

  console.log("· tag scaffold");
  await buildTagScaffold();

  console.log("· fetching picsum catalogue");
  const photos = await fetchPhotoList(COUNT);
  console.log(`  ${photos.length} landscape photo(s)`);

  console.log(`· generating posts (Gemini ${MODEL}, ${CONCURRENCY} at a time)`);
  const results = await pool(photos, CONCURRENCY, async (photo, i) => {
    const out = await createOne(photo, i);
    console.log(`  [${String(i + 1).padStart(2)}/${photos.length}] ${out.year} ${out.location.name.padEnd(11)} ${out.title}`);
    return out;
  });

  const ok = results.filter((r) => r && !r.error);
  const failed = results.filter((r) => r && r.error);
  for (const f of failed) console.warn(`  ! ${f.error.message}`);

  console.log(`· backdating ${ok.length} post(s) across ${YEARS[0]}–${YEARS.at(-1)}`);
  backdate(ok.map((r) => ({ postId: r.post.id, year: r.year })));

  // Recompute what the backdating invalidated: cached page payloads hold the
  // old ordering, and media visibility is derived from post state.
  console.log("· clearing caches");
  await api("POST", "/api/system/cache/clear").catch(() => {});
  await api("POST", "/api/system/media/recalculate-visibility").catch(() => {});
  await api("POST", "/api/tags/recalculate-counts").catch(() => {});

  console.log(`\nDone: ${ok.length} post(s), ${failed.length} failure(s)`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
