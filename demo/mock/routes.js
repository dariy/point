/**
 * Endpoint handlers for the static demo.
 *
 * Each entry is [method, pattern, handler]. Patterns use `:name` segments;
 * handlers receive `{ state, params, query, body }` and return either a plain
 * value (serialised as 200 JSON) or `{ status, body }` for anything else.
 *
 * Ordering matters — the first match wins, so literal-prefixed patterns must
 * precede parameterised siblings (`/api/posts/slug/:slug` before
 * `/api/posts/:id`).
 *
 * Coverage is deliberately partial. The full REST surface is ~110 endpoints;
 * this covers what the UI actually exercises. Everything else falls through to
 * the shim's soft default rather than erroring — see shim.js.
 */

import {
  applyNavMenu,
  byNewest,
  findTheme,
  nextId,
  paginate,
  setAuthenticated,
  storeThemeName,
  storePlugins,
  toListShape,
  withinYears,
} from "./store.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const ok = (body) => ({ status: 200, body });
const noContent = () => ({ status: 204, body: null });
const notFound = (msg = "not found") => ({ status: 404, body: { detail: msg } });

/** Settings rows hold JSON as text; a malformed row degrades to the default. */
function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Links shown inline before "More ▾" — out-of-range or unset means 4. */
function inlineMaxOrDefault(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 4;
}

// ── Visibility ────────────────────────────────────────────────────────────
//
// Point hides things two ways, and they compose: a post can be withheld by its
// own `status`, or by carrying a tag whose `hides_posts` is set — the tag's own
// or one inherited from an ancestor. A tag can itself be `hidden`, likewise
// inherited. docs/features/hidden-visibility.md is the model; this is that
// model over the demo's stores.
//
// Computed rather than read off the recorded rows. The fixture carries the
// `effective_*` flags the backend worked out at record time, which is fine
// until a visitor opens /light/tags and hides something — at which point the
// recording describes a tree that no longer exists. Recomputing means the
// demo's own edits propagate the way a real one's would, and the revelio switch
// has something true to show.

/**
 * The inherited visibility flags, by tag id.
 *
 * Both flags propagate to every descendant (TagGraph's BFS, api/internal/
 * services/tag_graph.go) — the graph is a DAG, so `seen` is what terminates a
 * walk that can reach the same tag by more than one path. `via` records which
 * ancestor set a tag hidden, which is what the admin tag list reports as
 * `hidden_via`.
 */
export function hiddenSets(state) {
  const byId = new Map(state.tags.map((t) => [t.id, t]));
  const hidden = new Set();
  const hidesPosts = new Set();
  const via = new Map();

  const spread = (rootId, into, mark) => {
    const queue = [rootId];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      into.add(id);
      if (mark && id !== rootId && !via.has(id)) via.set(id, rootId);
      for (const child of byId.get(id)?.children || []) queue.push(child.id);
    }
  };

  for (const tag of state.tags) {
    if (tag.hidden) spread(tag.id, hidden, true);
    if (tag.hides_posts) spread(tag.id, hidesPosts, false);
  }

  // Slugs as well as ids: a post carries its tags by slug, not by id.
  const hidesPostsSlugs = new Set(
    state.tags.filter((t) => hidesPosts.has(t.id)).map((t) => t.slug),
  );

  return { hidden, hidesPosts, hidesPostsSlugs, via };
}

/** Is this post withheld from the public by one of its tags? */
function hiddenByTag(post, sets) {
  return (post.tags || []).some((t) => sets.hidesPostsSlugs.has(t.slug));
}

/** The statuses a direct fetch will answer with for a guest — visibility.go. */
const PUBLIC_STATUS = new Set(["published", "page"]);

/**
 * Can a guest read this post at all?
 *
 * `draft`, `hidden` and `scheduled` are all withheld, and so is a published
 * post filed under a tag that hides its posts.
 */
function publiclyReadable(post, sets) {
  return PUBLIC_STATUS.has(post.status) && !hiddenByTag(post, sets);
}

/**
 * The posts a feed page is drawn from: published, plus the hidden ones for the
 * owner. Never drafts, never the scheduled queue — that lives left of page 1
 * and is read separately (see scheduledQueue).
 *
 * This is ListPosts with `IncludeDrafts: false, IncludeHidden: !publicOnly`,
 * which is what both the home feed and the tag pages ask for.
 */
export function feedPosts(state, sets = hiddenSets(state)) {
  return state.posts.filter((p) => {
    if (p.status === "draft" || p.status === "scheduled" || p.status === "trashed") {
      return false;
    }
    if (state.authenticated) return p.status === "published" || p.status === "hidden";
    return publiclyReadable(p, sets);
  });
}

/** The queue: posts waiting to be published, soonest first. Owner-only. */
export function scheduledQueue(state) {
  if (!state.authenticated) return [];
  return state.posts
    .filter((p) => p.status === "scheduled")
    .sort((a, b) => {
      // A scheduled post with no date sorts last rather than first, matching
      // the queue's own ORDER BY (`scheduled_at IS NULL` first in SQL).
      const at = Date.parse(a.scheduled_at || "") || Infinity;
      const bt = Date.parse(b.scheduled_at || "") || Infinity;
      return at - bt || Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });
}

/**
 * Posts a *list* endpoint returns — the admin post manager, which unlike a feed
 * shows drafts and the scheduled queue because managing them is what it is for.
 * A guest gets the public set.
 */
function readablePosts(state, sets = hiddenSets(state)) {
  return state.authenticated
    ? state.posts.slice()
    : state.posts.filter((p) => publiclyReadable(p, sets));
}

/**
 * Strip the owner-only visibility fields from a post on its way to a guest.
 *
 * The backend never puts them there in the first place (they are injected only
 * for an authenticated viewer), and the frontend keys the lock icon off their
 * mere presence — so leaving them in would mark a guest's own feed with locks
 * for posts that are not hidden from them at all.
 */
function projectPost(state, post, sets) {
  if (state.authenticated) {
    return { ...post, is_hidden: post.status === "hidden", is_hidden_by_tag: hiddenByTag(post, sets) };
  }
  // eslint-disable-next-line no-unused-vars
  const { is_hidden, is_hidden_by_tag, ...rest } = post;
  return rest;
}

/** The same, for a list of posts. */
function projectPosts(state, posts, sets) {
  return posts.map((p) => projectPost(state, p, sets));
}

/**
 * A tag as this viewer may see it: the owner gets the computed inheritance, a
 * guest gets neither the flags nor the tags they describe (filtered upstream).
 */
function projectTag(state, tag, sets) {
  if (!state.authenticated) {
    // eslint-disable-next-line no-unused-vars
    const { hidden, hides_posts, effective_hidden, effective_hides_posts, hidden_via, ...rest } = tag;
    return rest;
  }
  const out = {
    ...tag,
    effective_hidden: sets.hidden.has(tag.id),
    effective_hides_posts: sets.hidesPosts.has(tag.id),
  };
  if (sets.via.has(tag.id)) out.hidden_via = sets.via.get(tag.id);
  else delete out.hidden_via;
  return out;
}

/**
 * A recorded tag cloud, minus what this viewer may not follow.
 *
 * The cloud is a flat weighted list of `{id, name, slug, count, weight}`; the
 * real one is filtered at the source (TagGraph skips effectively-hidden tags
 * before building it), so this is the same cut applied to the recording.
 */
function visibleCloud(state, cloud, sets = hiddenSets(state)) {
  if (state.authenticated) return cloud;
  return (cloud || []).filter((t) => !sets.hidden.has(t.id));
}

/**
 * A recorded nav tree, minus what this viewer may not follow.
 *
 * Recursive because the menu is the tag hierarchy: hiding a country has to take
 * its cities with it, and the flags inherit the same way (hiddenSets has
 * already worked out which ids that leaves).
 */
function visibleNavTree(state, nodes, sets = hiddenSets(state)) {
  if (state.authenticated) return nodes;
  return (nodes || [])
    .filter((n) => !n.id || !sets.hidden.has(n.id))
    .map((n) => ({ ...n, children: visibleNavTree(state, n.children, sets) }));
}

/** Tags this viewer may see at all. */
function readableTags(state, sets = hiddenSets(state)) {
  const rows = state.authenticated
    ? state.tags
    : state.tags.filter((t) => !sets.hidden.has(t.id));
  return rows.map((t) => projectTag(state, t, sets));
}

// ── Feed pagination ───────────────────────────────────────────────────────

/**
 * One page of a feed, from either half of it.
 *
 * The owner's feed extends *left* of page 1 into the scheduled queue: page 0 is
 * the first future page, then -1, -2 … `min_page` reports how far left it goes
 * (1 for everyone else) and `scheduled` says which half the returned page came
 * from, which is what lets GridPager and the paginator treat page 0 as the
 * first page instead of hard-coding 1. See resolveScheduledPage
 * (api/internal/api/pages.go) and docs/features/publishing.md.
 *
 * `total` and `pages` keep describing the *published* half on both sides, so
 * the paginator spans the whole range and a swipe back right lands on page 1
 * knowing what follows it.
 *
 * A timeline scope turns the left half off: an unpublished post has no year to
 * be scoped by, and one that has not happened yet cannot be in range.
 */
export function feedPage(state, rows, queue, query, perPageDefault) {
  const perPage = Number(query.per_page) || perPageDefault;
  const scoped = withinYears(rows, query);
  const hasYearFilter = Number(query.year_from) > 0 && Number(query.year_to) > 0;

  const queued = hasYearFilter ? [] : queue;
  const minPage = queued.length ? 1 - Math.ceil(queued.length / perPage) : 1;

  const asked = query.page === undefined || query.page === "" ? 1 : Number(query.page);
  let page = Number.isFinite(asked) ? asked : 1;
  // A page past the end of the queue clamps to its last one rather than 404ing
  // — the same forgiveness the right-hand side of the feed gets.
  if (page < minPage) page = minPage;

  const total = scoped.length;
  const pages = Math.max(1, Math.ceil(total / perPage));

  let posts;
  if (page < 1) {
    // Page 0 is the queue's first page, -1 its second, and so on.
    const start = -page * perPage;
    posts = queued.slice(start, start + perPage);
  } else {
    const start = (page - 1) * perPage;
    posts = scoped.slice(start, start + perPage);
  }

  return {
    posts,
    pagination: {
      page,
      pages,
      per_page: perPage,
      total,
      min_page: minPage,
      scheduled: page < 1,
    },
  };
}

function findPost(state, idOrSlug) {
  const id = Number(idOrSlug);
  return state.posts.find((p) =>
    Number.isFinite(id) && id > 0 ? p.id === id : p.slug === idOrSlug,
  );
}

/** Detail payload for a post, synthesising one for posts created in-demo. */
function postDetail(state, post) {
  const recorded = state.postDetail[String(post.id)];
  if (recorded) return { ...recorded, ...post, content: recorded.content, content_html: recorded.content_html };
  return {
    ...post,
    title: post.title || "Untitled",
    content: post.content || "",
    content_html: post.content_html || `<p>${post.excerpt || ""}</p>`,
    css: post.css || "",
    media: post.media || [],
    tags: post.tags || [],
    view_count: 0,
    type: "post",
    updated_at: new Date().toISOString(),
  };
}

/**
 * A tag and every tag beneath it.
 *
 * The tree is a DAG — a city is a child of both its country and the flat `city`
 * index — so a tag is reachable by more than one path; `seen` terminates the
 * walk and keeps each tag visited once.
 */
function tagSubtree(state, tag) {
  const out = [];
  const seen = new Set();
  const walk = (t) => {
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const ref of t.children || []) {
      walk(state.tags.find((x) => x.id === ref.id));
    }
  };
  walk(tag);
  return out;
}

/**
 * A tag's own slug plus every descendant's.
 *
 * A parent tag page lists everything filed anywhere beneath it: /tags/light
 * shows the posts of morning-light, mist, sky and twilight, not only the posts
 * carrying `light` itself. TagService.GetPostsByTag does the same closure over
 * the real graph, so without this the demo's inner tags each work while every
 * grouping tag above them reads as empty.
 */
function tagSlugClosure(state, tag) {
  return new Set(tagSubtree(state, tag).map((t) => t.slug));
}

/**
 * The slug set a `?tag=` filter selects: the named tag and everything beneath
 * it, or nothing at all when no such tag exists — the recursive CTE in
 * buildPostsQuery (api/internal/repository/queries_posts.go) yields an empty id
 * list for an unknown slug, so an unrecognised filter matches no posts rather
 * than quietly matching all of them.
 */
function tagFilterSlugs(state, slug) {
  const tag = state.tags.find((t) => t.slug === slug);
  return tag ? tagSlugClosure(state, tag) : new Set();
}

/** Whether a post carries any of `slugs`, directly. */
function taggedWithAny(post, slugs) {
  return (post.tags || []).some((t) => slugs.has(t.slug));
}

/** Feed posts filed under a tag or any of its descendants, newest first. */
function postsForTag(state, slug, sets = hiddenSets(state)) {
  const slugs = tagFilterSlugs(state, slug);
  return feedPosts(state, sets)
    .filter((p) => taggedWithAny(p, slugs))
    .sort(byNewest);
}

/**
 * The queue for one tag page: the same tag-plus-descendants set the published
 * list is drawn from, so a parent tag shows its children's queue too
 * (TagService.GetScheduledPostsByTag).
 */
function queueForTag(state, slug) {
  const slugs = tagFilterSlugs(state, slug);
  return scheduledQueue(state).filter((p) => taggedWithAny(p, slugs));
}

/**
 * Does a post match a free-text query?
 *
 * The real search is one SQL predicate over the post's title, slug and content
 * plus the names and slugs of its tags (buildPostsQuery,
 * api/internal/repository/queries_posts.go) — which is why searching for a
 * place finds the photographs taken there, not just the posts that happen to
 * name it in their title.
 *
 * Content is the one column with no counterpart here: the recorded list shape
 * carries only the excerpt the cards render, and the bodies live in a separate
 * detail map the list never loads. The excerpt stands in for it, which narrows
 * the demo's matches rather than widening them — everything found is something
 * a visitor can see the reason for on the results grid.
 */
function postMatchesQuery(post, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;
  const has = (value) => String(value || "").toLowerCase().includes(needle);
  return (
    has(post.title) ||
    has(post.slug) ||
    has(post.excerpt) ||
    (post.tags || []).some((t) => has(t.name) || has(t.slug))
  );
}

/**
 * Rewrite a media URL the way atlasThumbURL (api/internal/api/pages.go) does,
 * so a cloud chip requests the same square thumbnail the recorded graph blob
 * already points at. A static host ignores the query and serves the (already
 * downscaled) original — the demo's documented `?thumb` limitation rather than
 * a new one.
 */
function atlasThumbUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return url.split("?")[0] + "?thumb=128";
}

/**
 * The Atlas cloud for one place: the most recent posts filed anywhere beneath
 * it, the tags those posts most often carry, and the edges wiring the two
 * together — PagesHandler.GetTagCloud (api/internal/api/pages.go).
 *
 * Derived rather than recorded, unlike the graph blob it sits beside. The
 * payload is per place *and* per timeline range, so recording it would mean one
 * fixture per combination — and a place would still answer with a stale cloud
 * after the visitor retagged a post inside the demo. Deriving it keeps every
 * marker on the map clickable, including tags created in the demo itself.
 *
 * Posts are year-scoped and the related tags are not, matching the backend:
 * narrowing the timeline changes which photographs a place offers, not what the
 * place is about.
 */
function atlasCloud(state, tag, query) {
  // atlasCloudLimit, which is also the atlas_post_limit default.
  const LIMIT = 10;
  const sets = hiddenSets(state);

  const inSubtree = new Set(tagSubtree(state, tag).map((t) => t.slug));
  const subtreePosts = feedPosts(state, sets).filter((p) =>
    (p.tags || []).some((t) => inSubtree.has(t.slug)),
  );

  const recent = withinYears(subtreePosts, query).sort(byNewest).slice(0, LIMIT);
  const posts = recent.map((p) => {
    const node = {
      id: p.id,
      slug: p.slug,
      title: p.title,
      media_url: atlasThumbUrl(p.media_url),
    };
    // The owner's marking for what a guest would not get: the Atlas draws a
    // node as concealed when it carries a non-public status or `is_hidden`
    // (isConcealed, frontend/src/plugins/tags-atlas/index.js), and the backend
    // only sends either to a viewer allowed to see hidden items.
    if (state.authenticated) {
      node.status = p.status;
      if (p.status === "published" && hiddenByTag(p, sets)) node.is_hidden = true;
    }
    return node;
  });

  // Related tags, ranked by how many of the place's posts carry them and tied
  // on name. The place itself is dropped; its descendants stay, since a
  // country's own cities are what make its cloud read as geography. Counted
  // over every post in the sub-tree, not only the few returned above.
  const counts = new Map();
  for (const p of subtreePosts) {
    for (const t of p.tags || []) {
      if (t.slug === tag.slug || t.slug.startsWith("_")) continue;
      counts.set(t.slug, (counts.get(t.slug) || 0) + 1);
    }
  }
  const bySlug = new Map(state.tags.map((t) => [t.slug, t]));
  const tags = [...counts]
    .map(([slug, count]) => ({ tag: bySlug.get(slug), count }))
    .filter((row) => row.tag)
    // A hidden tag is not offered to a guest — the cloud is public navigation
    // like any other, and a chip leading to a 404 is worse than an absence.
    .filter((row) => state.authenticated || !sets.hidden.has(row.tag.id))
    .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
    .slice(0, LIMIT)
    .map(({ tag: t }) => {
      const node = { id: t.id, name: t.name, slug: t.slug, kind: t.kind };
      // Coordinates are what make a chip render as a place rather than a plain
      // tag (utils/tags.js tagKind).
      const at = (t.locations || [])[0];
      if (at) {
        node.latitude = at.latitude;
        node.longitude = at.longitude;
      }
      if (state.authenticated && sets.hidden.has(t.id)) node.is_hidden = true;
      return node;
    });

  // Edges only ever join nodes this payload carries, so the cloud wires itself
  // without the caller holding the whole graph. The centre is always wired.
  const wired = new Map(tags.map((t) => [t.slug, t.id]));
  wired.set(tag.slug, tag.id);
  const wiredIds = new Set(wired.values());

  const membershipEdges = [];
  for (const p of recent) {
    for (const t of p.tags || []) {
      if (wired.has(t.slug)) membershipEdges.push({ post: p.id, tag: wired.get(t.slug) });
    }
  }

  const hierarchyEdges = [];
  for (const id of wiredIds) {
    const t = state.tags.find((x) => x.id === id);
    for (const parent of t?.parents || []) {
      if (wiredIds.has(parent.id)) {
        hierarchyEdges.push({ parent: parent.id, child: id });
      }
    }
  }

  return { tags, posts, membershipEdges, hierarchyEdges };
}

/**
 * The tag graph narrowed to a timeline range — PagesHandler.GetTagsGraph with
 * `year_from`/`year_to` (api/internal/api/pages.go).
 *
 * The graph is one of the recorded blobs, but the range can't be: it is a
 * payload per range, and the Atlas redraws its markers from this on every move
 * of the timeline. So the blob supplies the nodes and the store supplies the
 * arithmetic — tags with nothing left in range drop out, the rest carry their
 * in-range count (which is what sizes a marker).
 *
 * Counts roll up the sub-tree, matching GetHierarchicalPostCountsInYearRange:
 * a post is usually tagged with its city and not its country, so counting only
 * direct tags would drop every country shape the moment the timeline narrowed —
 * emptying the Atlas of the very thing it draws.
 */
function scopedGraph(state, query) {
  const graph = state.pages.graph || {};
  const sets = hiddenSets(state);

  // The blob was recorded as the owner, so it holds the hidden place and the
  // marking that says so. Both come off for a guest — the point of the switch
  // is that the map redraws without them, and `is_hidden` is exactly what the
  // Atlas keys its concealed styling off.
  const visibleTags = (graph.tags || [])
    .filter((t) => state.authenticated || !sets.hidden.has(t.id))
    .map((t) => {
      if (state.authenticated) return { ...t, is_hidden: sets.hidden.has(t.id) };
      // eslint-disable-next-line no-unused-vars
      const { is_hidden, ...rest } = t;
      return rest;
    });

  const inRange = withinYears(feedPosts(state, sets), query);
  const inRangeIds = new Set(inRange.map((p) => p.id));

  const counts = new Map();
  for (const tag of state.tags) {
    const slugs = tagSlugClosure(state, tag);
    const n = inRange.filter((p) =>
      (p.tags || []).some((t) => slugs.has(t.slug)),
    ).length;
    if (n > 0) counts.set(tag.id, n);
  }

  const tags = visibleTags
    .filter((t) => counts.has(t.id))
    .map((t) => ({ ...t, post_count: counts.get(t.id) }));
  const kept = new Set(tags.map((t) => t.id));

  const scoped = {
    ...graph,
    tags,
    hierarchyEdges: (graph.hierarchyEdges || []).filter(
      (e) => kept.has(e.parent) && kept.has(e.child),
    ),
  };

  // The force-graph's post nodes, when the blob carries them (the Atlas asks
  // for `posts=0` and never sees these). Edges only ever join surviving nodes,
  // and `inRangeIds` is already the viewer's own set of posts — so a concealed
  // one takes its edges with it.
  if (graph.posts) {
    scoped.posts = graph.posts
      .filter((p) => inRangeIds.has(p.id))
      .map((p) => {
        if (state.authenticated) return p;
        // eslint-disable-next-line no-unused-vars
        const { status, is_hidden, ...rest } = p;
        return rest;
      });
    scoped.membershipEdges = (graph.membershipEdges || []).filter(
      (e) => inRangeIds.has(e.post) && kept.has(e.tag),
    );
  }

  return scoped;
}

/**
 * Walk a tag's ancestry for breadcrumbs.
 *
 * Recorded tags carry `parents[]`, so this follows the first parent up to the
 * root. Guarded against cycles — the tag graph allows multiple parents and a
 * malformed demo edit could otherwise hang the page.
 */
function breadcrumbsFor(state, tag) {
  const chain = [];
  const seen = new Set();
  let current = tag;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentRef = (current.parents || [])[0];
    if (!parentRef) break;
    const parent = state.tags.find((t) => t.id === parentRef.id);
    if (!parent) break;
    chain.unshift({ id: parent.id, name: parent.name, slug: parent.slug });
    current = parent;
  }
  return chain;
}

/** `{presets, active}` — the shape of GET /api/plugins/presets. */
function presetsView(state) {
  return { presets: state.pluginPresets, active: state.activePreset };
}

/**
 * Recompute each core plugin's `locked` flag.
 *
 * Mirrors plugins.IsLockedOff: the sole enabled member of a core area may not
 * be disabled, and the Plugins page renders that row read-only. The frontend
 * recomputes this itself after a single toggle, but a preset apply takes the
 * server's word for it — and a page revisit re-reads GET /api/plugins — so the
 * store has to keep the flag true.
 */
function relockPlugins(state) {
  const REQUIRED_SLOT = new Set(["1", "1+"]);
  for (const p of state.plugins) {
    if (!REQUIRED_SLOT.has(p.slot_rule)) continue;
    const enabled = state.plugins.filter((q) => q.slot === p.slot && q.enabled);
    p.locked = !!p.enabled && enabled.length === 1;
  }
}

/**
 * Set every plugin's enabled state from a preset's membership.
 *
 * Mirrors PluginsHandler.ApplyPreset (api/internal/api/plugin_presets.go),
 * including the two corrections it applies to the raw membership list: a core
 * area a preset leaves empty falls back to its default member (Minimalistic
 * names no immersive viewer, yet one has to stay on), and an exclusive area
 * keeps only its first enabled member (Fully featured names all three tag
 * visualizations, but only one can own /tags). Without both, the demo would
 * show states the real backend refuses to produce.
 */
function applyPluginPreset(state, list) {
  const want = new Set(list);
  const REQUIRED_SLOT = new Set(["1", "1+"]);
  const SINGLE_CLAIM_SLOT = new Set(["0-1", "1"]);

  const membersOf = (slot) => state.plugins.filter((p) => p.slot === slot);

  for (const p of state.plugins) {
    if (!REQUIRED_SLOT.has(p.slot_rule) || !p.slot) continue;
    const members = membersOf(p.slot);
    if (members.some((m) => want.has(m.id))) continue;
    want.add((members.find((m) => m.default_enabled) || members[0]).id);
  }

  const seenSlots = new Set();
  for (const p of state.plugins) {
    if (!SINGLE_CLAIM_SLOT.has(p.slot_rule) || !p.slot || seenSlots.has(p.slot)) continue;
    seenSlots.add(p.slot);
    let kept = false;
    for (const m of membersOf(p.slot)) {
      if (!want.has(m.id)) continue;
      if (kept) want.delete(m.id);
      else kept = true;
    }
  }

  for (const p of state.plugins) p.enabled = want.has(p.id);
  relockPlugins(state);
}

// ── Routes ────────────────────────────────────────────────────────────────

export const routes = [
  // ── Bootstrap ───────────────────────────────────────────────────────────

  ["GET", "/api/setup/status", () => ok({ setup_complete: true })],

  ["GET", "/api/settings/public", ({ state }) => ok(state.publicSettings)],

  [
    "GET",
    "/api/auth/me",
    ({ state }) =>
      state.authenticated
        ? ok(state.user)
        : // client.js exempts /api/auth/me from the global api:unauthorized
          // event, so a 401 here is the honest answer and costs nothing.
          { status: 401, body: { detail: "authentication required" } },
  ],

  [
    "GET",
    "/api/system/version",
    () => ok({ current: "demo", latest: "demo", update_available: false }),
  ],

  // ── Auth ────────────────────────────────────────────────────────────────

  [
    "POST",
    "/api/auth/login",
    ({ state }) => {
      // Any password is accepted: there is no credential to protect, and a
      // visitor who mistypes the hint should still get into the demo.
      state.authenticated = true;
      setAuthenticated(true);
      return ok({ user: state.user, message: "ok" });
    },
  ],

  [
    "POST",
    "/api/auth/logout",
    ({ state }) => {
      state.authenticated = false;
      setAuthenticated(false);
      return noContent();
    },
  ],

  [
    "GET",
    "/api/auth/sessions",
    () =>
      ok({
        sessions: [
          {
            id: 1,
            // TEST-NET-3 (RFC 5737) — a documentation address, so the Security
            // page shows a plausible session without inventing a real one.
            ip_address: "203.0.113.10",
            user_agent: navigator.userAgent,
            location: "Demo",
            created_at: new Date().toISOString(),
            last_activity: new Date().toISOString(),
            current: true,
          },
        ],
        total: 1,
      }),
  ],

  ["GET", "/api/auth/webauthn/status", () => ok({ enabled: false, credentials: [] })],
  ["GET", "/api/auth/api-keys", () => ok({ api_keys: [], total: 0 })],

  // ── Public page payloads ────────────────────────────────────────────────
  //
  // `menu`, `settings` and `tag_cloud` come from the recording; `posts` and
  // `pagination` are computed so posts created or unpublished inside the demo
  // show up on the public site the way they really would.

  [
    "GET",
    "/api/pages/home",
    ({ state, query }) => {
      const sets = hiddenSets(state);
      const perPage = Number(state.publicSettings?.posts_per_page) || 6;
      const rows = feedPosts(state, sets).sort(byNewest);
      const page = feedPage(state, rows, scheduledQueue(state), query, perPage);
      return ok({
        ...state.pages.home,
        ...page,
        posts: projectPosts(state, page.posts, sets),
        // The recorded cloud is the owner's. A guest gets the tags they may
        // actually follow — the same filtering GetTagCloud does at the source.
        ...(state.pages.home?.tag_cloud
          ? { tag_cloud: visibleCloud(state, state.pages.home.tag_cloud, sets) }
          : {}),
      });
    },
  ],

  // The tags index. Recorded as the owner, so a guest's copy has the hidden
  // tags taken out of it — otherwise the one page whose whole job is to list
  // the archive's tags would be the one place concealment did not reach.
  [
    "GET",
    "/api/pages/tags",
    ({ state }) => {
      const page = state.pages.tags || {};
      const sets = hiddenSets(state);
      const tags = (page.tags || [])
        .filter((t) => state.authenticated || !sets.hidden.has(t.id))
        .map((t) => projectTag(state, t, sets));
      return ok({ ...page, tags, total: tags.length });
    },
  ],
  ["GET", "/api/pages/graph", ({ state, query }) => ok(scopedGraph(state, query))],
  [
    "GET",
    "/api/pages/graph/tag/:id",
    ({ state, params, query }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      // A real 404 rather than the soft empty 200: the Atlas catches the
      // rejection and leaves the place unselected, where an empty body would
      // spawn a cloud of nothing around it.
      if (!tag) return notFound("tag not found");
      return ok(atlasCloud(state, tag, query));
    },
  ],
  ["GET", "/api/pages/map", ({ state }) => ok(state.pages.map ?? { locations: [] })],
  // `menu` is the header's tree and `tags` the site-title dropdown's; api/nav.js
  // falls back to `menu` when `tags` is absent, which is what the server sends
  // in the default "tags" mode. The empty fallback has to use the same key —
  // `{items: []}` would leave navTags undefined and refetch on every mount.
  //
  // Both trees are cut to what the viewer may follow: the header is the first
  // place a hidden place would leak, and it is on every page of the site.
  [
    "GET",
    "/api/pages/nav",
    ({ state }) => {
      const nav = state.pages.nav ?? { menu: [] };
      const sets = hiddenSets(state);
      return ok({
        ...nav,
        menu: visibleNavTree(state, nav.menu, sets),
        ...(nav.tags ? { tags: visibleNavTree(state, nav.tags, sets) } : {}),
      });
    },
  ],

  // Admin menu editor (/light/menu). Mirrors NavMenuHandler in
  // api/internal/api/nav_menu.go: the config lives in settings rows, and
  // `tag_items` is the tags-mode tree so the editor can preview a mode switch
  // before saving. Handled rather than left to the shim's empty-200 default so
  // a visitor can actually re-author the menu and watch the header follow.
  [
    "GET",
    "/api/nav-menu",
    ({ state }) => {
      const s = state.settings;
      return ok({
        mode: s.nav_menu_mode || "tags",
        items: parseJson(s.custom_nav_menu, []),
        custom_markdown: s.custom_markdown || "",
        inline_max: inlineMaxOrDefault(s.nav_inline_max),
        more_title: s.nav_more_title || "More",
        tag_items: state.navTagTree,
      });
    },
  ],
  [
    "PUT",
    "/api/nav-menu",
    ({ state, body }) => {
      const mode = ["tags", "custom", "none"].includes(body.mode) ? body.mode : "tags";
      const items = Array.isArray(body.items) ? body.items : [];
      applyNavMenu(state, { mode, items, markdown: body.custom_markdown || "" });

      if (body.inline_max >= 1 && body.inline_max <= 10) {
        state.settings.nav_inline_max = String(body.inline_max);
      }
      state.settings.nav_more_title = body.more_title || "More";

      return ok({
        mode,
        items,
        custom_markdown: state.settings.custom_markdown,
        inline_max: inlineMaxOrDefault(state.settings.nav_inline_max),
        more_title: state.settings.nav_more_title,
      });
    },
  ],

  [
    "GET",
    "/api/pages/tags/:slug",
    ({ state, params, query }) => {
      const sets = hiddenSets(state);
      const tag = state.tags.find((t) => t.slug === params.slug);
      // A hidden tag is a 404 for a guest, not an empty page: GetTagPage checks
      // EffectiveHidden before anything else, so the page does not exist rather
      // than existing and holding nothing.
      if (!tag || (!state.authenticated && sets.hidden.has(tag.id))) {
        return notFound("tag not found");
      }
      const perPage = Number(state.publicSettings?.posts_per_page) || 6;
      const rows = postsForTag(state, params.slug, sets);
      // Tag pages have the same left half as the home feed, holding the queued
      // posts filed under this tag or one below it.
      const page = feedPage(state, rows, queueForTag(state, params.slug), query, perPage);
      return ok({
        tag: projectTag(state, tag, sets),
        menu: visibleNavTree(state, state.pages.home?.menu ?? [], sets),
        breadcrumbs: breadcrumbsFor(state, tag),
        nav_children: (tag.children || [])
          .filter((c) => state.authenticated || !sets.hidden.has(c.id))
          .map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
        ...page,
        posts: projectPosts(state, page.posts, sets),
      });
    },
  ],

  // ── Timeline ────────────────────────────────────────────────────────────

  // The pills are recorded, their counts are not: they are a count of posts,
  // and how many posts there are is exactly what concealment changes. Rescoring
  // from the store keeps the histogram agreeing with the feed underneath it in
  // both views.
  [
    "GET",
    "/api/timeline",
    ({ state }) => {
      const timeline = state.timeline || {};
      const rows = feedPosts(state);
      const counts = new Map();
      for (const post of rows) {
        for (const t of post.tags || []) {
          if (t.kind === "year") counts.set(t.slug, (counts.get(t.slug) || 0) + 1);
        }
      }
      const pills = (timeline.pills || [])
        .map((pill) => ({ ...pill, post_count: counts.get(pill.slug) ?? 0 }))
        // A decade pill sums its years rather than carrying a tag of its own,
        // so it is left as recorded rather than counted to zero.
        .filter((pill) => pill.is_decade || pill.post_count > 0);
      return ok({ ...timeline, pills });
    },
  ],
  [
    "GET",
    "/api/timeline/locations",
    ({ state, query }) => ok(state.timelineLocations[query.tag] ?? []),
  ],

  // ── Posts ───────────────────────────────────────────────────────────────

  ["GET", "/api/posts/analytics", ({ state }) => ok(state.analytics)],

  [
    "GET",
    "/api/posts/slug/:slug",
    ({ state, params }) => {
      const sets = hiddenSets(state);
      const post = state.posts.find((p) => p.slug === params.slug);
      // The same gate as the by-id read: this is the URL a guessed or shared
      // slug arrives on, which is exactly what the status check is for.
      if (!post || (!state.authenticated && !publiclyReadable(post, sets))) {
        return notFound("post not found");
      }
      return ok(projectPost(state, postDetail(state, post), sets));
    },
  ],

  [
    // Which page of the home listing a given post falls on — used to send a
    // visitor back to the right page after opening a post. Returns position,
    // not content.
    "GET",
    "/api/posts/:slug/page",
    ({ state, params }) => {
      const perPage = Number(state.publicSettings?.posts_per_page) || 6;
      const rows = feedPosts(state).sort(byNewest);
      const idx = rows.findIndex((p) => p.slug === params.slug);
      if (idx === -1) return notFound("post not found");
      return ok({ page: Math.floor(idx / perPage) + 1, per_page: perPage });
    },
  ],

  [
    "GET",
    "/api/posts/:id/navigation",
    ({ state, params }) => ok(state.postNavigation[params.id] ?? {}),
  ],

  [
    // What the admin editor loads a post with (PostEditPage → api/posts.js
    // getPost). Missing, it fell to the soft empty 200 and the edit form opened
    // with every field blank — a post that reads fine on the public site and
    // has no title, slug or excerpt the moment you edit it.
    //
    // Registered after `/api/posts/analytics`: matching is first-hit in table
    // order, and this pattern would otherwise swallow that literal path.
    "GET",
    "/api/posts/:id",
    ({ state, params }) => {
      const sets = hiddenSets(state);
      const post = findPost(state, params.id);
      // A logged-out visitor gets a 404 for a draft, a hidden or scheduled
      // post, and for one filed under a tag that hides its posts — the checks
      // PostHandler.GetPostByID makes before it builds a response. A scheduled
      // post is finished writing and only waiting for its time; withholding it
      // is the whole reason isPubliclyReadableStatus exists.
      if (!post || (!state.authenticated && !publiclyReadable(post, sets))) {
        return notFound("post not found");
      }
      return ok(projectPost(state, postDetail(state, post), sets));
    },
  ],

  [
    "GET",
    "/api/posts",
    ({ state, query }) => {
      let rows = readablePosts(state);
      // "all" is the admin's explicit "don't filter" (PostHandler.ListPosts),
      // not a status any post carries.
      if (query.status && query.status !== "all") {
        rows = rows.filter((p) => p.status === query.status);
      }
      if (query.tag) {
        const slugs = tagFilterSlugs(state, query.tag);
        rows = rows.filter((p) => taggedWithAny(p, slugs));
      }
      // `q` is what every caller sends — the search page, the header typeahead,
      // the admin list and the command palette all name it that.
      if (query.q) rows = rows.filter((p) => postMatchesQuery(p, query.q));
      rows = rows.sort(byNewest);
      // A caller that sends no per_page gets the site's own page size, which is
      // what PostHandler.ListPosts falls back to. The header typeahead is that
      // caller (it asks for `limit`, which the real endpoint ignores too), so
      // the generic 20 made the demo's dropdown twice the length of a real
      // one's.
      const perPage = Number(state.settings?.posts_per_page) || 10;
      return ok(paginate(rows, query, "posts", perPage));
    },
  ],

  [
    "POST",
    "/api/posts",
    ({ state, body }) => {
      const id = nextId(state.posts);
      const now = new Date().toISOString();
      const detail = {
        ...body,
        id,
        slug: body.slug || `demo-post-${id}`,
        title: body.title || "Untitled",
        status: body.status || "draft",
        created_at: now,
        published_at: body.status === "published" ? now : null,
        tags: body.tags || [],
        media: [],
      };
      state.postDetail[String(id)] = detail;
      state.posts.unshift(toListShape(detail));
      return { status: 201, body: detail };
    },
  ],

  [
    "PUT",
    "/api/posts/:id",
    ({ state, params, body }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      const merged = { ...postDetail(state, post), ...body, id: post.id };
      state.postDetail[String(post.id)] = merged;
      Object.assign(post, toListShape(merged, post));
      return ok(merged);
    },
  ],

  [
    "PATCH",
    "/api/posts/:id/status",
    ({ state, params, body }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      post.status = body.status;
      if (body.status === "published" && !post.published_at) {
        post.published_at = new Date().toISOString();
      }
      const detail = state.postDetail[String(post.id)];
      if (detail) Object.assign(detail, { status: post.status, published_at: post.published_at });
      return ok(post);
    },
  ],

  [
    "PATCH",
    "/api/posts/:id/tags",
    ({ state, params, body }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      const ids = body.tag_ids || body.tags || [];
      post.tags = ids
        .map((id) => state.tags.find((t) => t.id === id || t.slug === id))
        .filter(Boolean)
        .map((t) => ({ name: t.name, slug: t.slug, kind: t.kind, is_hidden_posts: false }));
      const detail = state.postDetail[String(post.id)];
      if (detail) detail.tags = post.tags;
      return ok(post);
    },
  ],

  [
    "DELETE",
    "/api/posts/:id",
    ({ state, params }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      post.status = "trashed";
      return noContent();
    },
  ],

  [
    "POST",
    "/api/posts/:id/restore",
    ({ state, params }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      post.status = "draft";
      return ok(post);
    },
  ],

  [
    "DELETE",
    "/api/posts/:id/permanent",
    ({ state, params }) => {
      const idx = state.posts.findIndex((p) => p.id === Number(params.id));
      if (idx === -1) return notFound("post not found");
      state.posts.splice(idx, 1);
      delete state.postDetail[params.id];
      return noContent();
    },
  ],

  [
    "POST",
    "/api/posts/preview-render",
    ({ body }) => ok({ html: renderMarkdown(body?.content ?? "") }),
  ],

  // ── Tags ────────────────────────────────────────────────────────────────

  [
    "GET",
    "/api/tags/cloud",
    ({ state }) => {
      const cloud = state.tagCloud;
      // Recorded as `{tags: [...]}`, but an older bundle recorded the bare
      // array — both are filtered rather than one of them silently passing a
      // hidden tag through to a guest.
      if (Array.isArray(cloud)) return ok(visibleCloud(state, cloud));
      return ok({ ...cloud, tags: visibleCloud(state, cloud?.tags || []) });
    },
  ],

  [
    "GET",
    "/api/tags/slug/:slug",
    ({ state, params }) => {
      const sets = hiddenSets(state);
      const tag = state.tags.find((t) => t.slug === params.slug);
      if (!tag || (!state.authenticated && sets.hidden.has(tag.id))) {
        return notFound("tag not found");
      }
      return ok(projectTag(state, tag, sets));
    },
  ],

  [
    "GET",
    "/api/tags/:id",
    ({ state, params }) => {
      const sets = hiddenSets(state);
      const tag = state.tags.find((t) => t.id === Number(params.id));
      if (!tag || (!state.authenticated && sets.hidden.has(tag.id))) {
        return notFound("tag not found");
      }
      return ok(projectTag(state, tag, sets));
    },
  ],

  [
    "GET",
    "/api/tags",
    ({ state, query }) => {
      // readableTags drops what this viewer may not see and computes the
      // inherited flags for the owner, so a tag hidden inside the demo takes
      // its descendants with it the way the backend's TagGraph would.
      let rows = readableTags(state);
      if (query.q) {
        // Name *and* slug, like TagHandler.ListTags: "reykjavik" has to find
        // Reykjavík, which is exactly the query a visitor without the accent
        // available types.
        const q = String(query.q).trim().toLowerCase();
        rows = rows.filter(
          (t) =>
            (t.name || "").toLowerCase().includes(q) ||
            (t.slug || "").toLowerCase().includes(q),
        );
      }
      // `include_empty=false` (the search page and the header typeahead, which
      // offer tags as links) drops the ones that would lead to an empty page.
      if (query.include_empty === "false") rows = rows.filter((t) => t.post_count > 0);
      // The real endpoint returns the full set; the admin page paginates client
      // side. Matching that keeps the tag manager's counts honest.
      return ok({ tags: rows, total: rows.length });
    },
  ],

  [
    "POST",
    "/api/tags",
    ({ state, body }) => {
      const id = nextId(state.tags);
      const tag = {
        id,
        name: body.name || "new-tag",
        slug: body.slug || String(body.name || `tag-${id}`).toLowerCase().replace(/\s+/g, "-"),
        kind: body.kind || "tag",
        description: body.description ?? null,
        post_count: 0,
        parents: [],
        children: [],
        locations: [],
        hidden: false,
        hides_posts: false,
        effective_hidden: false,
        effective_hides_posts: false,
        in_breadcrumbs: true,
        in_ancestor_flyout: true,
        created_at: new Date().toISOString(),
      };
      state.tags.push(tag);
      return { status: 201, body: tag };
    },
  ],

  [
    "PUT",
    "/api/tags/:id",
    ({ state, params, body }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      if (!tag) return notFound("tag not found");
      Object.assign(tag, body);
      return ok(tag);
    },
  ],

  [
    "PATCH",
    "/api/tags/:id",
    ({ state, params, body }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      if (!tag) return notFound("tag not found");
      Object.assign(tag, body);
      return ok(tag);
    },
  ],

  [
    "DELETE",
    "/api/tags/:id",
    ({ state, params }) => {
      const idx = state.tags.findIndex((t) => t.id === Number(params.id));
      if (idx === -1) return notFound("tag not found");
      state.tags.splice(idx, 1);
      return noContent();
    },
  ],

  // ── Media ───────────────────────────────────────────────────────────────

  ["GET", "/api/media/stats", ({ state }) => ok(state.mediaStats)],
  ["GET", "/api/media/folders", ({ state }) => ok(state.mediaFolders)],
  ["GET", "/api/media/orphaned", () => ok({ media: [], total: 0 })],

  [
    "GET",
    "/api/media/:id",
    ({ state, params }) => {
      const m = state.media.find((x) => x.id === Number(params.id));
      return m ? ok(m) : notFound("media not found");
    },
  ],

  [
    "GET",
    "/api/media",
    ({ state, query }) => {
      let rows = state.media.slice();
      if (query.search) {
        const q = query.search.toLowerCase();
        rows = rows.filter((m) => (m.filename || "").toLowerCase().includes(q));
      }
      if (query.file_type) rows = rows.filter((m) => m.file_type === query.file_type);
      return ok(paginate(rows, query, "media", 50));
    },
  ],

  [
    "PATCH",
    "/api/media/:id",
    ({ state, params, body }) => {
      const m = state.media.find((x) => x.id === Number(params.id));
      if (!m) return notFound("media not found");
      Object.assign(m, body);
      return ok(m);
    },
  ],

  [
    "DELETE",
    "/api/media/:id",
    ({ state, params }) => {
      const idx = state.media.findIndex((x) => x.id === Number(params.id));
      if (idx === -1) return notFound("media not found");
      state.media.splice(idx, 1);
      return noContent();
    },
  ],

  // ── Settings, themes, plugins ───────────────────────────────────────────

  ["GET", "/api/settings", ({ state }) => ok(state.settings)],

  [
    "PUT",
    "/api/settings",
    ({ state, body }) => {
      Object.assign(state.settings, body);
      // Public settings are a projection of the same table, so keep the keys
      // the public site reads in step — otherwise changing the blog title in
      // the admin leaves the public header stale.
      for (const key of Object.keys(state.publicSettings)) {
        if (key in body) state.publicSettings[key] = body[key];
      }
      return ok(state.settings);
    },
  ],
  ["PATCH", "/api/settings", ({ state, body }) => {
    Object.assign(state.settings, body);
    return ok(state.settings);
  }],

  ["GET", "/api/themes/active", ({ state }) => ok(state.activeTheme)],
  ["GET", "/api/themes/custom-css", ({ state }) => ok(state.customCss)],
  ["GET", "/api/themes", ({ state }) => ok(state.themes)],

  [
    "PUT",
    "/api/themes/active",
    ({ state, body }) => {
      // Resolve against the catalogue rather than renaming the previous entry:
      // the response carries the theme's own description and swatch colours,
      // which the Themes page shows next to the highlight it just moved.
      const theme = findTheme(state.themes, body.name);
      if (!theme) return notFound("theme not found");

      state.activeTheme = { ...theme };
      state.settings.active_css_theme = theme.name;
      state.publicSettings.active_css_theme = theme.name;
      // Outlive this document: shim.js composes theme.css from the store, and
      // the store is re-seeded by every full page load — including the walk
      // from /light back out to the public site.
      storeThemeName(theme.name);
      return ok(state.activeTheme);
    },
  ],

  [
    "PUT",
    "/api/themes/custom-css",
    ({ state, body }) => {
      state.customCss = { css: body.css ?? "" };
      return ok(state.customCss);
    },
  ],

  ["GET", "/api/plugins", ({ state }) => ok(state.plugins)],
  ["GET", "/api/plugins/presets", ({ state }) => ok(presetsView(state))],

  // Preset membership editing. Unknown plugin ids are dropped rather than
  // rejected: the Plugins page only ever sends ids it just rendered.
  [
    "PUT",
    "/api/plugins/presets/:id",
    ({ state, params, body }) => {
      if (!state.pluginPresets[params.id]) return notFound("unknown preset");
      const known = new Set(state.plugins.map((p) => p.id));
      const wanted = Array.isArray(body?.plugins) ? body.plugins : [];
      state.pluginPresets[params.id] = [...new Set(wanted)].filter((id) => known.has(id));
      return ok(presetsView(state));
    },
  ],

  // Applying returns the whole catalog, which is what makes the site map, the
  // group cards and the toggles below re-render together in one round-trip.
  [
    "POST",
    "/api/plugins/presets/:id/apply",
    ({ state, params }) => {
      const list = state.pluginPresets[params.id];
      if (!list) return notFound("unknown preset");
      applyPluginPreset(state, list);
      state.activePreset = params.id;
      storePlugins(state.plugins);
      return ok(state.plugins);
    },
  ],

  [
    "PATCH",
    "/api/plugins/:id",
    ({ state, params, body }) => {
      const plugin = state.plugins.find((p) => p.id === params.id);
      if (!plugin) return notFound("plugin not found");
      plugin.enabled = !!body.enabled;
      // Single-claim slots allow only one member enabled at a time —
      // mirroring that here keeps the Plugins page's radio behaviour honest.
      if (plugin.enabled && plugin.slot_rule && (plugin.slot_rule === "0-1" || plugin.slot_rule === "1") && plugin.slot) {
        for (const other of state.plugins) {
          if (other !== plugin && other.slot === plugin.slot) other.enabled = false;
        }
      }
      relockPlugins(state);
      // An individual toggle diverges from whatever preset was applied — the
      // backend rewrites plugins.active_preset to "custom" for the same reason.
      state.activePreset = "custom";
      storePlugins(state.plugins);
      return ok(plugin);
    },
  ],

  // ── System ──────────────────────────────────────────────────────────────

  ["GET", "/api/system/stats", ({ state }) => ok(state.system.stats ?? {})],
  ["GET", "/api/system/health", ({ state }) => ok(state.system.health ?? {})],
  ["GET", "/api/system/disk", ({ state }) => ok(state.system.disk ?? {})],
  ["GET", "/api/system/migrations", ({ state }) => ok(state.system.migrations ?? [])],
  ["GET", "/api/system/backups", () => ok({ backups: [], total: 0 })],
  ["GET", "/api/system/audit/post-links", () => ok({ issues: [], checked: 0 })],
  ["GET", "/api/system/offline/stats", () => ok({ posts: 0, media: 0, bytes: 0 })],
  [
    "GET",
    "/api/system/logs",
    () =>
      ok({
        lines: [
          "This is a static demo — there is no server, so no live log to tail.",
        ],
      }),
  ],
  [
    "GET",
    "/api/system/photo-library",
    () => ok({ configured: false, files: [], total: 0 }),
  ],

  // ── Instagram ───────────────────────────────────────────────────────────

  ["GET", "/api/instagram/status", () => ok({ connected: false })],
  ["GET", "/api/instagram/import/status", () => ok({ running: false })],

  // ── Utilities ───────────────────────────────────────────────────────────

  ["GET", "/api/util/parse-maps-coords", () => ok({ latitude: null, longitude: null })],
];

/**
 * Minimal Markdown → HTML for the editor's live preview.
 *
 * Deliberately small: it exists so typing in the editor visibly renders, not to
 * reproduce the server's full pipeline. Recorded posts already carry real
 * `content_html` from the backend, so this only ever runs on text a visitor
 * typed themselves.
 */
function renderMarkdown(src) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return escape(src)
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .split(/\n{2,}/)
    .map((block) =>
      /^\s*<(h\d|blockquote|img|ul|ol|pre)/.test(block)
        ? block
        : `<p>${block.replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
}
