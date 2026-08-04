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

import {
  LOCATIONS,
  YEARS,
  TOPICS,
  buildTagScaffold,
  postTags,
  toTopic,
} from "./demo-world.mjs";

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
// Locations, years and the topical vocabulary live in scripts/demo-world.mjs,
// shared with retag-demo-content.mjs so the two cannot describe different
// worlds.

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
    // Constrained to the shared vocabulary. Left free-form, 28 posts invent
    // ~100 keywords of which 80 name exactly one post, and the tag tree becomes
    // a list of dead ends.
    tags: { type: "array", items: { type: "string", enum: TOPICS } },
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
- "tags": 3-4 terms chosen ONLY from this list, describing what is actually
  visible in the frame. Do not invent terms and do not include place names or
  years — those are added separately.
  ${TOPICS.join(", ")}

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

  // The body is the photograph and nothing else; the writing goes into
  // `excerpt`, which is what the Sheet immersive viewer renders and what the
  // post cards preview. A demo whose prose only appears below the fold of the
  // article page is prose nobody in the demo reads.
  const topics = [...new Set((text.tags || []).map(toTopic).filter(Boolean))].slice(0, 4);

  const post = await api("POST", "/api/posts", {
    title: text.title,
    content: `![${text.title}](${mediaPath})`,
    excerpt: [text.excerpt.trim(), text.body.trim().replace(/\s*\n+\s*/g, " ")]
      .filter(Boolean)
      .join(" "),
    status: "published",
    formatter: "markdown",
    thumbnail_path: mediaPath,
    // Country, city and year are tags, which is how Point models all three —
    // the timeline reads `kind: "year"` tags and the map reads coordinates off
    // the city tags.
    tags: postTags(location.name, year, topics),
    is_featured: index === 0,
  });

  return { post, year, location, topics, title: text.title };
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

// ── Topic balance ─────────────────────────────────────────────────────────

/**
 * Drops any topic the model only reached for once.
 *
 * A tag on a single post is a label, not a facet: clicking it lands on an
 * archive page holding the post you came from. The vocabulary is closed, so
 * this is rare, but a demo is judged on the click that goes nowhere.
 *
 * Removal rather than invention — padding an unrelated post to make the count
 * would put a tag on a photograph that does not show it. Mutates `results` so
 * the caller's topic set matches what the instance now holds.
 */
async function balanceTopics(results) {
  const holders = new Map();
  for (const r of results) {
    for (const topic of r.topics) {
      if (!holders.has(topic)) holders.set(topic, []);
      holders.get(topic).push(r);
    }
  }

  const singletons = [...holders].filter(([, rs]) => rs.length < 2).map(([t]) => t);
  if (!singletons.length) return;

  const touched = new Set(singletons.flatMap((t) => holders.get(t)));
  for (const r of touched) {
    r.topics = r.topics.filter((t) => !singletons.includes(t));
    await api("PATCH", `/api/posts/${r.post.id}/tags`, {
      tags: postTags(r.location.name, r.year, r.topics),
    });
    if (r.topics.length < 2) {
      console.warn(`  ! post ${r.post.id} is down to ${r.topics.length} topic(s)`);
    }
  }
  console.log(`· dropped ${singletons.length} single-use topic(s): ${singletons.join(", ")}`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating ${COUNT} demo posts into ${BASE}`);

  // Geography and dates first, so the city tags carry their coordinates before
  // any post references them. The subject tree is built afterwards, once the
  // surviving vocabulary is known.
  console.log("· tag scaffold (geography, dates)");
  await buildTagScaffold(api, { topics: [] });

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

  await balanceTopics(ok);

  console.log("· tag scaffold (subjects)");
  await buildTagScaffold(api, {
    topics: [...new Set(ok.flatMap((r) => r.topics))],
  });

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
