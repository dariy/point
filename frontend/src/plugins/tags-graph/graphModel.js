/**
 * graphModel.js — the data layer behind the public /tags graph.
 *
 * Turns the GET /api/pages/graph payload into nodes, links and an adjacency
 * index, and owns the two walks over that index which drive highlighting. It is
 * arithmetic over plain objects: nothing here knows about a canvas, a viewport
 * or a pointer.
 *
 *   nodes:  plain tag | year-tag (kind='year') | geo-tag (has lat/long) | post
 *   edges:  hierarchy (tag→tag parent/child) | membership (post→tag)
 */

import { tagKind } from '../../utils/tagLinks.js';

// Deterministic PRNG so the initial layout is stable across reloads.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Node radius, scaled by degree so busy tags read as hubs. Clamped at both
 * ends: an isolated node still has to be clickable, and a tag on every post
 * must not swallow the canvas.
 */
export function nodeRadius(type, degree) {
  const d = Math.sqrt(degree);
  if (type === 'post') return Math.max(3, Math.min(11, 2.5 + 1.4 * d));
  // tag / year / geo
  return Math.max(6, Math.min(36, 5 + 2.2 * d));
}

/**
 * Build the graph from the API payload.
 *
 * Tag and post ids share one namespace on the canvas, so they are prefixed
 * ('t1', 'p1') — without that a tag and a post with the same database id would
 * collide in nodeById and one would silently vanish.
 *
 * @param {object} data       { tags, posts, hierarchyEdges, membershipEdges }
 * @param {{width:number,height:number}} size  viewport, for the initial scatter
 * @returns {{nodes:object[], links:object[], nodeById:Map, neighbors:Map}}
 */
export function buildGraph(data, { width, height }) {
  const nodes = [];
  const links = [];
  const nodeById = new Map();
  const neighbors = new Map(); // node.id -> Set(node.id)

  const rng = mulberry32(0x9e3779b9);
  const cx = width / 2;
  const cy = height / 2;
  const spread = Math.min(width, height) * 0.42 || 300;

  const place = (node) => {
    // Phyllotaxis-ish initial scatter for a calm starting state.
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * spread;
    node.x = cx + Math.cos(a) * r;
    node.y = cy + Math.sin(a) * r;
    node.vx = 0;
    node.vy = 0;
    node.degree = 0;
  };

  const add = (node) => {
    place(node);
    nodes.push(node);
    nodeById.set(node.id, node);
  };

  (data.tags || []).forEach((t) => {
    add({
      id: 't' + t.id,
      type: tagKind(t), // year / geo / tag — shared with the pills + Atlas
      tagId: t.id,
      name: t.name,
      slug: t.slug,
      postCount: t.post_count || 0,
    });
  });

  (data.posts || []).forEach((p) => {
    add({
      id: 'p' + p.id,
      type: 'post',
      postId: p.id,
      name: p.title || p.slug,
      slug: p.slug,
    });
  });

  const addLink = (aId, bId, kind) => {
    const a = nodeById.get(aId);
    const b = nodeById.get(bId);
    if (!a || !b) return;
    links.push({ source: a, target: b, kind });
    a.degree++;
    b.degree++;
    if (!neighbors.has(a.id)) neighbors.set(a.id, new Set());
    if (!neighbors.has(b.id)) neighbors.set(b.id, new Set());
    neighbors.get(a.id).add(b.id);
    neighbors.get(b.id).add(a.id);
  };

  (data.hierarchyEdges || []).forEach((e) => addLink('t' + e.parent, 't' + e.child, 'hierarchy'));
  (data.membershipEdges || []).forEach((e) => addLink('p' + e.post, 't' + e.tag, 'membership'));

  // Radius depends on degree, so compute after all links are in.
  nodes.forEach((n) => {
    n.r = nodeRadius(n.type, n.degree);
  });

  return { nodes, links, nodeById, neighbors };
}

/**
 * The subset the legend leaves showing. Hiding a kind has to drop its links
 * too — a link with one hidden endpoint would otherwise be drawn running to
 * nothing. Returns the originals untouched when nothing is hidden.
 */
export function visibleSets({ nodes, links }, hiddenTypes) {
  if (!hiddenTypes.size) return { nodes, links };
  return {
    nodes: nodes.filter((n) => !hiddenTypes.has(n.type)),
    links: links.filter((l) => !hiddenTypes.has(l.source.type) && !hiddenTypes.has(l.target.type)),
  };
}

/**
 * Build the highlighted set for `seedIds`. Each seed lights its direct
 * neighbours; additionally, from a *tag* seed we step a second hop through
 * each adjacent post to the other tags that share it — surfacing related tags
 * and the two-segment path that connects them.
 *
 * @returns {{focus:Set<string>, related:Set<string>}}
 *   focus   — every highlighted node (faded peers are dimmed)
 *   related — the second-wave tags, ringed distinctly so "reached through a
 *             post" reads differently from a direct neighbour.
 */
export function expandFocus({ nodeById, neighbors }, seedIds) {
  const focus = new Set(seedIds);
  const related = new Set();
  for (const id of seedIds) {
    const seed = nodeById.get(id);
    const nbrs = neighbors.get(id);
    if (!nbrs) continue;
    const seedIsTag = seed && seed.type !== 'post';
    for (const nId of nbrs) {
      focus.add(nId);
      if (!seedIsTag) continue;
      const nNode = nodeById.get(nId);
      if (!nNode || nNode.type !== 'post') continue;
      // Second wave: bridge post → the other tags that carry it.
      const postNbrs = neighbors.get(nId);
      if (!postNbrs) continue;
      for (const tId of postNbrs) {
        if (tId === id) continue;
        focus.add(tId);
        related.add(tId);
      }
    }
  }
  return { focus, related };
}
