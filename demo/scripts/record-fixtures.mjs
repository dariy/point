#!/usr/bin/env node
/**
 * Records API responses from a running Point instance into the fixture bundle
 * that the static demo build (demo/scripts/build.sh) serves from.
 *
 * Fixtures are RECORDED rather than hand-written so their shapes are true by
 * construction. The mock only has to model behaviour, never guess payloads —
 * and when the API changes, re-running this is the whole update.
 *
 * Two kinds of data come out of here:
 *
 *   Entities (posts, tags, media, settings, …) seed the mutable in-browser
 *   store, so the demo's create/edit/delete actually do something.
 *
 *   Compound page payloads (/api/pages/*, timeline, graph, map) are recorded
 *   verbatim and served read-only. Recomputing a tag graph or a map clustering
 *   in the mock would be a second implementation of real backend work for no
 *   demo value.
 *
 * Usage:
 *   node demo/scripts/record-fixtures.mjs --base=http://localhost:8001 \
 *        --session=<token> [--out=demo/mock/fixtures]
 *
 * The session token is a raw (unhashed) value from the `sessions` table. Any
 * admin session works; nothing is written back to the source instance.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  REPLACE_SETTINGS,
  ADD_SETTINGS,
  SETTINGS_MARKER,
} from "../settings.mjs";

// ── Args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://localhost:8001";
const SESSION = args.session || process.env.POINT_SESSION || "";
const OUT = resolve(args.out || "demo/mock/fixtures");

if (!SESSION) {
  console.error("Missing --session=<token>. Admin-only endpoints need one.");
  process.exit(1);
}

// ── Scrubbing ─────────────────────────────────────────────────────────────
//
// The source instance is somebody's real blog. Anything that identifies the
// operator, or that is a live credential, must not reach a bundle that gets
// published to a CDN. Scrubbing happens here — at the recording boundary —
// rather than in the build, so a raw fixture file never exists on disk.

/** Settings keys dropped entirely. */
const DROP_SETTING_KEYS = [
  "google_analytics_id",
  "author_email",
  "smtp_host",
  "smtp_username",
  "smtp_password",
  "smtp_from",
  "instagram_access_token",
  "instagram_user_id",
  "remark_secret",
];

// REPLACE_SETTINGS / ADD_SETTINGS / SETTINGS_MARKER are what the demo *says*
// rather than what it hides, so they live in demo/settings.mjs — the build
// re-applies them from there, which is what makes editing a demo string a
// rebuild rather than a re-record.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Recursively scrub a recorded payload.
 *
 * Any settings key starting with `_` is internal server state — `_secret_key`
 * is literally the instance's signing key, and `_version_check_cached` leaks
 * the deployed version. Prefix-dropping is deliberately broader than an
 * explicit list so a newly-added internal key is excluded by default.
 *
 * ADD_SETTINGS is applied by shape rather than at the three call sites that
 * record a settings map today (`/api/settings`, `/api/settings/public` and the
 * copy embedded in `/api/pages/home`), so a page payload that starts embedding
 * settings later carries them too.
 */
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_")) continue;
      if (DROP_SETTING_KEYS.includes(k)) continue;
      out[k] = k in REPLACE_SETTINGS ? REPLACE_SETTINGS[k] : scrub(v);
    }
    return SETTINGS_MARKER in out ? { ...out, ...ADD_SETTINGS } : out;
  }
  if (typeof value === "string") return value.replace(EMAIL_RE, "demo@example.com");
  return value;
}

// ── Fetching ──────────────────────────────────────────────────────────────

let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server's publicLimiter allows ~10 req/s sustained (rate.Every(100ms),
// burst 200 — see api/cmd/api/main.go). Recording is a few hundred requests, so
// pace just under that rather than burning the burst and then 429-ing for the
// rest of the run.
const THROTTLE_MS = 120;

async function get(path, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await sleep(THROTTLE_MS);
    const res = await fetch(BASE + path, {
      headers: { Cookie: `session=${SESSION}`, Accept: "application/json" },
    });
    if (res.status === 429 && attempt < retries) {
      // Back off past the limiter's refill window and try again.
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      console.warn(`  ! ${res.status} ${path}`);
      failures++;
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? scrub(await res.json()) : null;
  }
}

/**
 * Fetch every page of a paginated collection and concatenate `key`.
 *
 * Not every collection endpoint paginates — /api/tags returns the full set and
 * ignores `page`, which without the `pages`/short-batch checks below is an
 * infinite loop. MAX_PAGES is the backstop for any future endpoint that does
 * the same.
 */
async function getAll(path, key, perPage = 100) {
  const MAX_PAGES = 50;
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await get(`${path}${sep}page=${page}&per_page=${perPage}`);
    const batch = data?.[key];
    if (!Array.isArray(batch) || batch.length === 0) break;

    // An unpaginated endpoint returns the same rows for every page; detecting
    // that by id is more reliable than trusting the response to say so.
    const fresh = batch.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));
    out.push(...fresh);
    if (fresh.length === 0) break;

    if (data.pages && page >= data.pages) break;
    if (!data.pages && batch.length < perPage) break;
  }
  return out;
}

// ── Record ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Recording from ${BASE}`);

  const fx = {
    recordedAt: new Date().toISOString(),
    source: "point-demo-recorder",
  };

  console.log("· settings, user, plugins, themes");
  fx.publicSettings = await get("/api/settings/public");
  fx.settings = await get("/api/settings");
  fx.user = await get("/api/auth/me");
  fx.plugins = await get("/api/plugins");
  fx.themes = await get("/api/themes");
  fx.activeTheme = await get("/api/themes/active");
  fx.customCss = await get("/api/themes/custom-css");

  console.log("· posts");
  fx.posts = await getAll("/api/posts", "posts");
  console.log(`  ${fx.posts.length} posts`);

  // Full single-post payloads: the list endpoint omits `content`, and both the
  // public PostPage and the admin editor need it.
  console.log("· post detail + navigation");
  fx.postDetail = {};
  fx.postNavigation = {};
  for (const p of fx.posts) {
    const detail = await get(`/api/posts/${p.id}`);
    if (detail) {
      fx.postDetail[String(p.id)] = detail;
      // `scheduled_at` back onto the list row, which the mock's post store is
      // seeded from. The admin list query does not select the column
      // (buildPostsQuery, api/internal/repository/queries_posts.go), so every
      // scheduled post records as `scheduled_at: null` — while the feed's own
      // queue read does select it, and the card is dated and the queue ordered
      // by it. Taking the value from the detail payload records what the feed
      // would have sent rather than what the admin list happened to omit.
      if (p.scheduled_at == null && detail.scheduled_at != null) {
        p.scheduled_at = detail.scheduled_at;
      }
    }
    const nav = await get(`/api/posts/${p.id}/navigation`);
    if (nav) fx.postNavigation[String(p.id)] = nav;
  }

  console.log("· tags");
  fx.tags = await getAll("/api/tags", "tags");
  fx.tagCloud = await get("/api/tags/cloud");
  console.log(`  ${fx.tags.length} tags`);

  console.log("· media");
  fx.media = await getAll("/api/media", "media");
  fx.mediaStats = await get("/api/media/stats");
  fx.mediaFolders = await get("/api/media/folders");
  console.log(`  ${fx.media.length} media`);

  console.log("· compound page payloads");
  fx.pages = {
    home: await get("/api/pages/home"),
    tags: await get("/api/pages/tags"),
    graph: await get("/api/pages/graph"),
    map: await get("/api/pages/map"),
    nav: await get("/api/pages/nav"),
  };

  // Tag pages are SYNTHESIZED by the mock (see mock/routes.js) rather than
  // recorded: the payload is just {tag, posts, pagination, breadcrumbs,
  // nav_children, menu}, all derivable from the tag and post stores. Recording
  // ~250 of them would multiply the bundle, and synthesis has the better
  // property that a tag created inside the demo gets a working page too.
  //
  // A few are still recorded as reference samples so the synthesis can be
  // diffed against real output when the API changes.
  fx.pages.tagSamples = {};
  const sampleTags = fx.tags
    .filter((t) => (t.post_count || 0) > 0)
    .sort((a, b) => (b.post_count || 0) - (a.post_count || 0))
    .slice(0, 3);
  for (const t of sampleTags) {
    const page = await get(`/api/pages/tags/${encodeURIComponent(t.slug)}`);
    if (page) fx.pages.tagSamples[t.slug] = page;
  }
  console.log(`  ${Object.keys(fx.pages.tagSamples).length} tag page samples`);

  console.log("· timeline, analytics, system");
  fx.timeline = await get("/api/timeline");

  // /api/timeline/locations is per-tag (it 400s without one), so record it for
  // each timeline pill — that is exactly the set the timeline UI can request.
  fx.timelineLocations = {};
  for (const pill of fx.timeline?.pills || []) {
    const locs = await get(
      `/api/timeline/locations?tag=${encodeURIComponent(pill.slug)}`,
    );
    if (locs && locs.length) fx.timelineLocations[pill.slug] = locs;
  }
  console.log(`  ${Object.keys(fx.timelineLocations).length} timeline location sets`);

  fx.analytics = await get("/api/posts/analytics");
  fx.system = {
    stats: await get("/api/system/stats"),
    health: await get("/api/system/health"),
    disk: await get("/api/system/disk"),
    migrations: await get("/api/system/migrations"),
  };

  // Every media path the demo must ship as a real file. build.sh reads
  // this to copy (and downscale) exactly the images that are referenced —
  // walking the source media directory would sweep in unpublished originals.
  const paths = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) return v.forEach(collect);
    if (v && typeof v === "object") return Object.values(v).forEach(collect);
    if (typeof v === "string" && /^\/\d{4}\/\d{2}\/[^?]+/.test(v)) {
      paths.add(v.split("?")[0]);
    }
  };
  collect(fx);
  fx.mediaFiles = [...paths].sort();
  console.log(`  ${fx.mediaFiles.length} media files referenced`);

  await mkdir(dirname(resolve(OUT, "fixtures.json")), { recursive: true });
  const target = resolve(OUT, "fixtures.json");
  const json = JSON.stringify(fx);
  await writeFile(target, json);

  console.log(`\nWrote ${target} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
  if (failures) console.log(`${failures} endpoint(s) failed — see warnings above`);

  // A recorded bundle that still carries a secret is worth failing loudly for.
  // Checked against KEYS and against literal value patterns — not raw substring
  // search, which false-positives on innocent content (a migration is actually
  // named `migrate_secret_key_to_secrets`).
  const leaks = [];
  // Anchored at the end so `<name>_is_set` keys survive: those are presence
  // booleans the settings UI renders to show whether a credential is
  // configured, and they carry no value.
  const BANNED_KEY = /^_|(password|secret|token|api_key)$/i;
  const BANNED_VALUE = [
    /\bG-[A-Z0-9]{8,}\b/, // Google Analytics measurement id
    /\bGTM-[A-Z0-9]+\b/,
    /\$argon2/, // password hash
  ];
  const audit = (v, path = "") => {
    if (Array.isArray(v)) return v.forEach((x, i) => audit(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (BANNED_KEY.test(k)) leaks.push(`key ${path}/${k}`);
        audit(val, `${path}/${k}`);
      }
      return;
    }
    if (typeof v === "string") {
      for (const re of BANNED_VALUE) {
        if (re.test(v)) leaks.push(`value ${path} matches ${re}`);
      }
    }
  };
  audit(fx);

  if (leaks.length) {
    console.error(`\nREFUSING — fixture carries sensitive data:`);
    leaks.slice(0, 20).forEach((l) => console.error(`  ${l}`));
    process.exit(1);
  }
  console.log("Scrub audit passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
