/**
 * Unified tag link renderer — the single source of truth for rendering
 * public-facing tag <a> elements across all components.
 */

import { escapeHtml } from './helpers.js';

/**
 * Render a tag link `<a>` element with consistent class structure
 * and optional modifier classes.
 *
 * @param {string|{name:string, slug:string}} tag
 * @param {object}  [opts]
 * @param {boolean} [opts.active=false]  Add `active` class (nav-bar active state).
 * @param {string}  [opts.extra='']      Extra CSS classes appended to `tag-link`.
 * @param {string}  [opts.suffix='']     Raw HTML appended inside the link after the name
 *                                       (e.g. a `<span class="tag-count">` badge).
 * @returns {string} HTML string
 */
export function renderTagLink(tag, { active = false, extra = '', suffix = '' } = {}) {
  const name = typeof tag === 'string' ? tag : tag.name;
  const slug = typeof tag === 'string' ? tag : tag.slug;

  const classes = ['tag-link', active ? 'active' : '', extra]
    .filter(Boolean)
    .join(' ');

  return `<a href="/tag/${escapeHtml(slug)}" class="${classes}">${escapeHtml(name)}${suffix}</a>`;
}

/**
 * Build a flat lookup map from the navTags tree.
 * navTags is a strict tree (each node has exactly one parent).
 *
 * @param {object[]} navTags  Root-level tag nodes with nested .children[]
 * @param {string|null} [parentSlug]  Internal — parent slug for recursive calls
 * @param {Map} [map]  Internal — accumulator
 * @returns {Map<string, { tag: {name:string,slug:string}, parentSlug: string|null, isLeaf: boolean }>}
 */
export function buildTagIndex(navTags, parentSlug = null, map = new Map()) {
  for (const tag of navTags) {
    const isLeaf = !tag.children?.length;
    map.set(tag.slug, { tag: { name: tag.name, slug: tag.slug }, parentSlug, isLeaf });
    if (!isLeaf) buildTagIndex(tag.children, tag.slug, map);
  }
  return map;
}

/**
 * Return the ancestor chain of a tag in root-first order,
 * skipping system tags (slug starts with '_').
 *
 * @param {string} slug  The leaf tag's slug
 * @param {Map} index    Result of buildTagIndex()
 * @returns {{ name: string, slug: string }[]}  Root-first, immediate parent last
 */
export function getTagAncestors(slug, index) {
  const ancestors = [];
  const visited = new Set([slug]);
  let entry = index.get(slug);
  while (entry?.parentSlug) {
    if (visited.has(entry.parentSlug)) break;  // cycle guard
    visited.add(entry.parentSlug);
    entry = index.get(entry.parentSlug);
    if (entry && !entry.tag.slug.startsWith('_')) {
      ancestors.unshift(entry.tag);
    }
  }
  return ancestors;
}
