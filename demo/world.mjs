/**
 * The demo's tag universe — shared by generate-content.mjs (fresh content)
 * and retag-content.mjs (restructuring an instance that already has some).
 *
 * It lives in one module because the two scripts have to agree exactly: a
 * vocabulary that drifts between them produces a hierarchy where half the posts
 * hang off tags the other half never uses.
 *
 * Shape of the tree:
 *
 *   country ─┬ Portugal ── Lisbon        cities are children of their country
 *            ├ Iceland ─── Reykjavík     *and* of the `city` root, so the tree
 *            ├ Japan ───── Kyoto         reads as geography while `city` stays
 *            └ Argentina ─ El Chaltén    a flat index of every place
 *   city ────┬ Lisbon, Reykjavík, Kyoto, El Chaltén
 *   date ────┬ 2020 … 2026               kind: "year" — what the timeline reads
 *   subject ─┬ terrain ─┬ mountains, forest, coastline, valley, flora
 *            ├ water ───┬ ocean, waves, still-water, droplets
 *            ├ built ───┬ architecture, street-life, cityscape, winding-road
 *            ├ light ───┬ morning-light, mist, sky, twilight
 *            ├ season ──┬ winter, summer
 *            ├ people ──┬ solitude, companionship, everyday
 *            └ objects ─┬ analog, close-up, texture
 *
 * Every post carries its country, its city, its year, and 2–4 subject topics,
 * so no branch of the tree is decorative.
 */

/**
 * Four places, spread far enough apart that the map has something to plot.
 *
 * `years` is the window each place was visited in, and the windows deliberately
 * do not all cover the whole archive. An archive where every place appears in
 * every year makes the timeline filter invisible on the map: narrowing the range
 * would rescale the markers and never drop one, so the Atlas would look broken
 * (nothing happens) when it was in fact working. Overlapping-but-distinct
 * windows give the demo something to show — 2020 is Lisbon alone, 2026 is Kyoto
 * and El Chaltén — while still leaving every year with at least one place, so
 * the timeline's own histogram has no empty column.
 */
export const LOCATIONS = [
  { name: "Lisbon", country: "Portugal", latitude: 38.7223, longitude: -9.1393, years: [2020, 2021, 2022, 2023] },
  { name: "Reykjavík", country: "Iceland", latitude: 64.1466, longitude: -21.9426, years: [2021, 2022, 2023] },
  { name: "Kyoto", country: "Japan", latitude: 35.0116, longitude: 135.7681, years: [2023, 2024, 2025, 2026] },
  { name: "El Chaltén", country: "Argentina", latitude: -49.3315, longitude: -72.8863, years: [2025, 2026] },
];

/**
 * A coordinate for each country, so the Atlas draws it as a filled shape.
 *
 * The Atlas plots only geo-tags — tags carrying a latitude/longitude — and then
 * matches each one's *name* against countries.geojson: a match becomes a
 * polygon, everything else a circle marker. A country tag without coordinates
 * clears neither bar and simply never appears, which left the demo's map
 * showing four city pins over an empty world.
 *
 * The point is a rough interior point rather than a strict centroid. It is not
 * where the shape is drawn — the boundary file decides that — only the anchor
 * the tag's cloud opens from when it is selected with no click point (returning
 * from a post), so "somewhere sensibly inside the country" is the whole
 * requirement.
 */
export const COUNTRY_COORDS = {
  Portugal: { latitude: 39.5, longitude: -8.0 },
  Iceland: { latitude: 64.9631, longitude: -19.0208 },
  Japan: { latitude: 36.2048, longitude: 138.2529 },
  Argentina: { latitude: -38.4161, longitude: -63.6167 },
};

export const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

/**
 * The controlled topical vocabulary, grouped.
 *
 * Closed rather than free-form: 28 posts each inventing their own keywords
 * produced ~100 tags of which 80 named exactly one post, which is a tag list,
 * not a hierarchy. Twenty-five terms over 28 posts guarantees every term is a
 * real facet that narrows the archive to more than one entry.
 */
export const SUBJECT_GROUPS = {
  terrain: ["mountains", "forest", "coastline", "valley", "flora"],
  water: ["ocean", "waves", "still-water", "droplets"],
  built: ["architecture", "street-life", "cityscape", "winding-road"],
  light: ["morning-light", "mist", "sky", "twilight"],
  season: ["winter", "summer"],
  people: ["solitude", "companionship", "everyday"],
  objects: ["analog", "close-up", "texture"],
};

export const TOPICS = Object.values(SUBJECT_GROUPS).flat();

/**
 * Folds a free-form keyword onto the controlled vocabulary.
 *
 * Covers the terms an unconstrained model actually produced for these photos,
 * so an instance generated before the vocabulary existed can be restructured
 * without regenerating its prose. A handful map to `null` — "nature",
 * "landscape", "light" and friends applied to nearly every post and so
 * separated nothing.
 */
export const TOPIC_ALIASES = {
  forest: "forest", woodland: "forest", path: "forest", moss: "forest",
  mountains: "mountains", "mountain-landscape": "mountains", alpine: "mountains",
  wilderness: "mountains", peak: "mountains",
  coastline: "coastline", seascape: "coastline", beach: "coastline", cliffs: "coastline",
  rocks: "coastline", "clifftop-housing": "coastline", shoreline: "coastline",
  valley: "valley",
  flora: "flora", foliage: "flora", flowers: "flora", blossoms: "flora",
  floral: "flora", growth: "flora", leaves: "flora",

  ocean: "ocean", sea: "ocean",
  waves: "waves", "water-splash": "waves", surf: "waves",
  "still-water": "still-water", water: "still-water", ripples: "still-water",
  calm: "still-water", "liquid-surface": "still-water", underwater: "still-water",
  immersion: "still-water", blue: "still-water", reflection: "still-water",
  droplets: "droplets", raindrops: "droplets", "water-drop": "droplets", dew: "droplets",

  architecture: "architecture", domes: "architecture", classical: "architecture",
  "historic-building": "architecture", "colorful-buildings": "architecture",
  village: "architecture", facade: "architecture",
  "street-life": "street-life", "urban-decay": "street-life", streetscape: "street-life",
  "city-life": "street-life", traffic: "street-life", movement: "street-life",
  cityscape: "cityscape", "urban-landscape": "cityscape", "observation-deck": "cityscape",
  skyline: "cityscape", "urban-view": "cityscape",
  "winding-road": "winding-road", "road-trip": "winding-road", road: "winding-road",

  "morning-light": "morning-light", sunrise: "morning-light", morning: "morning-light",
  "golden-hour": "morning-light",
  mist: "mist", misty: "mist", "misty-light": "mist", "misty-landscape": "mist",
  haze: "mist", fog: "mist",
  sky: "sky", "dramatic-sky": "sky", clouds: "sky", overcast: "sky",
  twilight: "twilight", silhouette: "twilight", dusk: "twilight", sunset: "twilight",

  winter: "winter", snow: "winter", snowscape: "winter", "winter-landscape": "winter",
  "winter-light": "winter", frost: "winter",
  summer: "summer", swimming: "summer", "outdoor-activity": "summer",

  solitude: "solitude", contemplation: "solitude", minimalism: "solitude",
  "human-form": "solitude", "distant-figures": "solitude", tranquil: "solitude",
  companionship: "companionship", "human-connection": "companionship", friendship: "companionship",
  everyday: "everyday", "cafe-life": "everyday", productivity: "everyday",
  "daily-routine": "everyday", preparation: "everyday",

  analog: "analog", vintage: "analog", "analog-tools": "analog", "vintage-gear": "analog",
  hands: "analog", exploration: "analog",
  "close-up": "close-up", macro: "close-up", details: "close-up", collection: "close-up",
  texture: "texture", monochrome: "texture", craftsmanship: "texture",

  // Applied to almost everything, so they carried no information.
  nature: null, landscape: null, light: null, hope: null, resilience: null,
  bench: null, scenery: null, outdoors: null, beautiful: null,
};

/** Canonicalises a keyword, or returns null if it has no place in the tree. */
export function toTopic(raw) {
  const key = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (Object.hasOwn(TOPIC_ALIASES, key)) return TOPIC_ALIASES[key];
  return TOPICS.includes(key) ? key : null;
}

/** The country that owns a place name. */
export function countryOf(cityName) {
  return LOCATIONS.find((l) => l.name === cityName)?.country || null;
}

/**
 * Creates (or adopts) every tag in the tree and wires up the parent links.
 *
 * Idempotent, so it is safe to run against an instance that is already half
 * built: an existing tag is reused and only its parents are rewritten. That is
 * what lets it run *after* posts have been tagged — the post API auto-creates
 * an unknown tag as an unfiled root, and this adopts it into the tree.
 *
 * `topics` is the subset of the vocabulary actually in use. Only those get
 * tags, and only groups with a surviving member get created: a topic tag on
 * zero posts is a dead end in the navigation, which is worse than the flat
 * list this replaces.
 *
 * `api` is `(method, path, body) => Promise<json>`.
 */
export async function buildTagScaffold(api, { topics = TOPICS } = {}) {
  const existing = new Map(
    ((await api("GET", "/api/tags"))?.tags || []).map((t) => [t.name.toLowerCase(), t]),
  );
  const created = {};

  const makeTag = async (body) => {
    const hit = existing.get(body.name.toLowerCase());
    let tag = hit;
    if (!tag) {
      tag = await api("POST", "/api/tags", {
        in_breadcrumbs: true,
        in_ancestor_flyout: true,
        ...body,
        parent_ids: undefined,
      });
      existing.set(tag.name.toLowerCase(), tag);
    } else {
      // An adopted tag keeps whatever it was created with, so anything the tree
      // depends on has to be reconciled explicitly — otherwise a --retag run
      // over an instance built before a field existed silently keeps the old
      // shape. nav_order is the header menu; coordinates are whether the Atlas
      // can place the tag at all, and country tags are always adopted (the post
      // API auto-creates them when the first post is tagged), so without this
      // they would never gain any. PUT is partial-update, so it touches nothing
      // else.
      const patch = {};
      if (body.nav_order != null && tag.nav_order !== body.nav_order) {
        patch.nav_order = body.nav_order;
      }
      const at = tag.locations?.[0];
      if (
        body.latitude != null &&
        (at?.latitude !== body.latitude || at?.longitude !== body.longitude)
      ) {
        patch.latitude = body.latitude;
        patch.longitude = body.longitude;
      }
      if (Object.keys(patch).length) {
        tag = await api("PUT", `/api/tags/${tag.id}`, patch);
        existing.set(tag.name.toLowerCase(), tag);
      }
    }
    // Parents are set separately in both branches: PUT is the only call that
    // *replaces* them, so a re-run cannot accumulate stale links.
    if (body.parent_ids) {
      await api("PUT", `/api/tags/${tag.id}/parents`, { ids: body.parent_ids });
    }
    created[tag.name] = tag;
    return tag;
  };

  // The four roots carry nav_order because that flag — not "has no parent" — is
  // what puts a tag in the header menu and the site-title dropdown
  // (TagGraph.NavTree is built from tags with nav_order set). Without it the
  // tree still exists, but the header has nothing to show.
  const countryRoot = await makeTag({
    name: "country",
    kind: "tag",
    description: "Where in the world.",
    nav_order: 1,
  });
  const cityRoot = await makeTag({
    name: "city",
    kind: "tag",
    description: "Every place, flat.",
    nav_order: 2,
  });
  const dateRoot = await makeTag({
    name: "date",
    kind: "tag",
    description: "When these were taken.",
    nav_order: 3,
  });

  for (const country of [...new Set(LOCATIONS.map((l) => l.country))]) {
    await makeTag({
      name: country,
      kind: "tag",
      description: country,
      ...COUNTRY_COORDS[country],
      parent_ids: [countryRoot.id],
    });
  }

  for (const loc of LOCATIONS) {
    // Two parents: its country (the geographic path) and the `city` index.
    // Point's tag graph is a DAG, so this is a supported shape rather than a
    // trick — breadcrumbs pick the first path and the flyout offers the other.
    await makeTag({
      name: loc.name,
      kind: "tag",
      description: `${loc.name}, ${loc.country}`,
      latitude: loc.latitude,
      longitude: loc.longitude,
      parent_ids: [created[loc.country].id, cityRoot.id],
    });
  }

  for (const year of YEARS) {
    await makeTag({ name: String(year), kind: "year", parent_ids: [dateRoot.id] });
  }

  const wanted = new Set(topics);
  if (wanted.size) {
    const subjectRoot = await makeTag({
      name: "subject",
      kind: "tag",
      description: "What is in the frame.",
      nav_order: 4,
    });
    for (const [group, members] of Object.entries(SUBJECT_GROUPS)) {
      const live = members.filter((t) => wanted.has(t));
      if (!live.length) continue;
      const groupTag = await makeTag({
        name: group,
        kind: "tag",
        parent_ids: [subjectRoot.id],
      });
      for (const topic of live) {
        await makeTag({ name: topic, kind: "tag", parent_ids: [groupTag.id] });
      }
    }
  }

  return created;
}

/** The tags a post carries: its country, its city, its year, then its topics. */
export function postTags(cityName, year, topics) {
  return [countryOf(cityName), cityName, String(year), ...topics].filter(Boolean);
}

/**
 * The place and year for the nth generated post.
 *
 * Round-robin over the locations rather than letting the model choose: asked to
 * pick, Gemini clustered nearly everything onto one city, leaving the map with a
 * single pin. The year then cycles that location's own window (see LOCATIONS),
 * so the archive is a spread rather than a full location × year grid — which is
 * what lets the timeline actually empty part of the map.
 */
export function placementFor(index) {
  const location = LOCATIONS[index % LOCATIONS.length];
  const round = Math.floor(index / LOCATIONS.length);
  return { location, year: location.years[round % location.years.length] };
}
