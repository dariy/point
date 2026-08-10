#!/usr/bin/env node
/**
 * Writes a one-to-two paragraph excerpt onto every post in the recorded
 * fixtures.
 *
 * The demo's posts carry an image and nothing else: `generate-content.mjs`
 * puts Gemini's prose in `excerpt` (the body is only the photograph), but the
 * recorded bundle has `excerpt: null` on all 28 — a `PUT /api/posts/:id` that
 * omits `excerpt` clears it, because the handler's partial-PUT merge covers
 * title/content/slug/formatter/status/type and not excerpt, so
 * `retag-content.mjs` blanked the field on the pass that restructured the tags.
 * Without it the post cards preview nothing and the Sheet viewer — the reason
 * the body holds only a photograph — opens on a title and a tag row.
 *
 * The prose here is synthetic filler, not a description of the photograph: it
 * is assembled from the post's own city, country, year and topic tags so it
 * reads as plausible caption text and matches the archive it sits in, but no
 * one looked at the image. Restoring writing that is *about* the photographs
 * means a fresh `make-content.sh` run with a Gemini key.
 *
 * Deterministic: the text for a post is seeded from its id, so re-running
 * produces byte-identical output and every copy of a post across the fixture
 * blobs (`posts`, `postDetail`, the prerendered `pages`) gets the same text.
 *
 * Usage:
 *   node demo/scripts/fill-excerpts.mjs                  # fill empty excerpts
 *   node demo/scripts/fill-excerpts.mjs --force          # rewrite all of them
 *   node demo/scripts/fill-excerpts.mjs --dry-run        # print, write nothing
 *
 * Run it after record-fixtures.mjs and before build.sh.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { LOCATIONS, TOPICS, YEARS, countryOf } from "../world.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const FIXTURES = resolve(args.fixtures || "demo/mock/fixtures/fixtures.json");
const FORCE = Boolean(args.force);
const DRY_RUN = Boolean(args["dry-run"]);
const SEED = Number(args.seed || 0);

// ── Deterministic randomness ──────────────────────────────────────────────

/** mulberry32 — small, seedable, and stable across Node versions. */
function rng(seed) {
  let a = (seed + SEED) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/** Picks `n` distinct entries, or as many as the list holds. */
function sample(rand, list, n) {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) {
    out.push(...pool.splice(Math.floor(rand() * pool.length), 1));
  }
  return out;
}

// ── Vocabulary ────────────────────────────────────────────────────────────

/**
 * One clause per topic in `world.mjs`'s controlled vocabulary, so a post's
 * prose talks about the things its tags claim it is about. Two variants each:
 * with 28 posts drawing 2–4 topics, a single variant repeats often enough to
 * read as a template.
 */
const TOPIC_CLAUSES = {
  mountains: ["the ridgeline held its edge until the last of the light left it", "the range stacked itself into flat grey planes, each one paler than the last"],
  forest: ["the path gave out under a canopy that swallowed the sound of it", "moss had taken the north side of everything, patient about it"],
  coastline: ["the shoreline kept rewriting itself an inch at a time", "the cliffs dropped away without ceremony, the way they always do here"],
  valley: ["the valley floor stayed in shadow long after the tops had warmed", "everything funnelled down to one seam of green"],
  flora: ["something had flowered against all reasonable advice", "leaves caught the light and held it a beat longer than the air did"],

  ocean: ["open water all the way out, no seam where it met the sky", "the sea worked at the same stretch of rock it has always worked at"],
  waves: ["a set came through, broke, and left the sand briefly mirrored", "the swell arrived on a rhythm slower than breathing"],
  "still-water": ["the surface held the sky so exactly it felt like a trick", "not a ripple, and every reflection twice as saturated for it"],
  droplets: ["water beaded on everything and refused to fall", "each drop carried a bent copy of the whole scene"],

  architecture: ["the facade wore its repairs openly, which is the better half of its character", "windows in a rhythm somebody chose, a long time ago, for reasons nobody records"],
  "street-life": ["the street ran its usual errands and paid the camera no attention", "somebody was late for something, the way somebody always is"],
  cityscape: ["rooftops ran to the edge of sight, all of them slightly out of step", "the city sat in its bowl and let the weather come to it"],
  "winding-road": ["the road doubled back on itself twice before it committed", "asphalt drawn on the land like handwriting"],

  "morning-light": ["the first light came in low and made a case for getting up early", "morning arrived sideways and edged everything in warm"],
  mist: ["mist took the middle distance and gave nothing back", "the far side of things dissolved politely"],
  sky: ["the sky did most of the work in this frame", "cloud moved through fast enough to change the light between exposures"],
  twilight: ["the blue hour ran long, as it does at this latitude", "colour drained out of the land and gathered overhead"],

  winter: ["cold enough that the air had a taste to it", "winter had flattened the palette down to four or five honest colours"],
  summer: ["heat sat on everything and slowed the day down", "the light lasted so late it stopped feeling like evening"],

  solitude: ["nobody else came past the whole time it took to set up", "an hour of quiet, and no obligation to fill it"],
  companionship: ["two of us, mostly not talking, which was the point", "the good kind of company — the kind that waits while you frame a shot"],
  everyday: ["nothing here is remarkable, which is the reason to photograph it", "an ordinary afternoon, kept because ordinary afternoons don't keep themselves"],

  analog: ["shot on film, so the exposure was a guess with consequences", "thirty-six frames total, which changes how long you stand there first"],
  "close-up": ["close enough that the rest of the scene stopped mattering", "a detail worth more attention than the view it belonged to"],
  texture: ["surface, grain and wear doing all the description", "every mark on it put there by weather and time, in that order"],
};

/**
 * Openers, as templates over the post's own place and date tags.
 *
 * Two pools rather than one with fallback substitutions: not every post is
 * fully tagged (the featured one carries only its year), and a template filled
 * with stand-ins for the place it is built around reads worse than a template
 * that never mentions one.
 */
const OPENERS = [
  "{city}, {year}.",
  "{year}, somewhere above {city}.",
  "A day out of {city}, in {year}.",
  "{country}, {year} — the {city} end of it.",
  "Late in the {year} trip through {country}.",
  "Back in {city} again, {year}.",
];

/** Used when the post has no city or country tag to name. */
const OPENERS_PLACELESS = [
  "{year}, and no note of where.",
  "Somewhere off the route, {year}.",
  "Unfiled, {year}.",
  "{year}. The location went unrecorded, which happens.",
];

/** Second-paragraph closers — reflective, and about the act of photographing. */
const CLOSERS = [
  "I kept this one over four near-identical frames, and I could not now tell you why.",
  "It looked better in person, which is true of most things and worth saying anyway.",
  "The frame either side of this one is sharper. This is the one I go back to.",
  "Filed it, forgot it, found it two years later and liked it more.",
  "Nothing happened here. That is more or less the appeal.",
  "Whatever I was trying to do at the time, this is what came back.",
  "Stood there long after the shot, which is usually the sign of a good one.",
  "Half the reason to carry a camera is to have an excuse to stop walking.",
];

/** Neutral connective sentences, used when a post has thin topic tags. */
const FILLERS = [
  "The weather made its own decisions all morning.",
  "There was more of it than the frame could reasonably hold.",
  "It stayed like this for perhaps ten minutes.",
  "Worth the walk, on balance.",
  "The light shifted twice while I stood there.",
  "Nothing about it announced itself.",
];

const CITY_NAMES = new Set(LOCATIONS.map((l) => l.name));
const COUNTRY_NAMES = new Set(LOCATIONS.map((l) => l.country));
const YEAR_NAMES = new Set(YEARS.map(String));
const TOPIC_NAMES = new Set(TOPICS);

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lowercases only the leading letter — `toLowerCase()` would eat a mid-sentence "I". */
const decapitalize = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Splits a post's tag names into the four facets `world.mjs` assigns. */
function facets(post) {
  const names = (post.tags || []).map((t) => (typeof t === "string" ? t : t.name));
  const city = names.find((n) => CITY_NAMES.has(n));
  return {
    city,
    country: names.find((n) => COUNTRY_NAMES.has(n)) || (city ? countryOf(city) : ""),
    year: names.find((n) => YEAR_NAMES.has(n)),
    topics: names.filter((n) => TOPIC_NAMES.has(n)),
  };
}

/**
 * One or two paragraphs for a post.
 *
 * Paragraphs are joined with a blank line even though every current consumer
 * renders the field as a single run (`PostCard` escapes it into one `<p>`, the
 * Sheet linkifies it into another): the break is the honest shape of the text,
 * and it costs nothing where it collapses.
 */
function excerptFor(post) {
  const rand = rng(Number(post.id) || 0);
  const { city, country, year, topics } = facets(post);

  const placed = Boolean(city || country);
  const opener = pick(rand, placed ? OPENERS : OPENERS_PLACELESS)
    .replace("{city}", city || country)
    .replace("{country}", country || city)
    .replace("{year}", year || "undated");

  // Three topic clauses at most, each from a different tag, then padded with
  // distinct neutral sentences — a post tagged with one topic still needs two
  // clauses, and repeating the same sentence twice in a paragraph is worse
  // than a generic one.
  const clauses = sample(rand, topics, 3)
    .map((t) => pick(rand, TOPIC_CLAUSES[t] || []))
    .filter(Boolean);
  const spare = sample(rand, FILLERS, FILLERS.length);
  const next = () => clauses.shift() || decapitalize(spare.shift().replace(/\.$/, ""));

  const first = [
    opener,
    `${capitalize(next())}, and ${next()}.`,
    capitalize(spare.shift()),
  ].join(" ");

  // Two paragraphs on roughly half the posts: a uniform length across 28 cards
  // reads as generated, which is exactly what it must not look like.
  if (rand() < 0.5) return first;

  const second = [`${capitalize(next())}.`, pick(rand, CLOSERS)].join(" ");
  return `${first}\n\n${second}`;
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * A post appears in several fixture blobs — the list, its detail, and the
 * prerendered page payloads — so the text is generated once per id and then
 * stamped onto every copy, or the same post previews differently per page.
 */
function walk(node, visit) {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
  } else if (node && typeof node === "object") {
    if ("excerpt" in node && "id" in node && "title" in node) visit(node);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

async function main() {
  const fx = JSON.parse(await readFile(FIXTURES, "utf8"));

  const texts = new Map();
  let copies = 0;
  let skipped = 0;

  walk(fx, (post) => {
    if (!FORCE && post.excerpt) {
      skipped++;
      return;
    }
    const key = String(post.id);
    if (!texts.has(key)) texts.set(key, excerptFor(post));
    post.excerpt = texts.get(key);
    copies++;
  });

  const order = [...texts.keys()].sort((a, b) => Number(a) - Number(b));
  for (const id of order) {
    const text = texts.get(id);
    console.log(`  ${id.padStart(2)} ${text.split("\n\n").length}¶ ${text.split(/\s+/).length}w  ${text.slice(0, 68)}…`);
  }
  console.log(
    `· ${texts.size} post(s), ${copies} copy/copies written${skipped ? `, ${skipped} left alone (use --force)` : ""}`,
  );

  if (DRY_RUN) {
    console.log("· --dry-run: fixtures untouched");
    return;
  }

  // Compact, matching record-fixtures.mjs — the file is a build input, not a
  // file anyone reads.
  await writeFile(FIXTURES, JSON.stringify(fx));
  console.log(`· wrote ${FIXTURES}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
