/**
 * Pure tag helpers — how a tag becomes a URL, a colour bucket, an <a>, and how
 * the nav payload becomes the index the flyout walks for ancestors.
 *
 * No DOM, no module state: every function here is a value in, a string or a
 * plain object out. Every public surface that shows a tag goes through these —
 * the pills, the strip, the Atlas cloud, the graph, the breadcrumb — so a
 * change here is a change everywhere at once.
 *
 * The DOM behaviour that used to share this file lives in tagFlyout.js (the
 * shared dropdown singleton) and tagStrip.js (the scrollable strip).
 */

import { escapeHtml } from './helpers.js';

/**
 * Build a tag URL whose `path` query carries the ancestor slug chain the user
 * drilled through to reach it. Empty chain → bare /tags/<slug>.
 *
 * @param {string} slug
 * @param {string[]} [pathSlugs] ancestor slugs, root-first (current tag excluded)
 */
export function tagHref(slug, pathSlugs = []) {
  const chain = (pathSlugs || []).filter(Boolean);
  return chain.length
    ? `/tags/${slug}?path=${chain.join('/')}`
    : `/tags/${slug}`;
}

/**
 * Inverse of {@link tagHref}: split a `/tags/<slug>?path=<trail>` href into its
 * decoded tag slug and navigation trail. Used by flyout navigateFns so the
 * `path` query survives instead of being swept into the tag slug (which would
 * then get percent-encoded into a broken `/tags/slug%3Fpath%3D…` URL).
 *
 * @param {string} url
 * @returns {{ tag: string, navPath: string|null }}
 */
export function parseTagUrl(url) {
  const u = new URL(url, window.location.origin);
  return {
    tag: decodeURIComponent(u.pathname.replace('/tags/', '')),
    navPath: u.searchParams.get('path') || null,
  };
}

/**
 * Classify a tag into a colour bucket — the single source of truth shared by
 * the tag pills, the Atlas cloud and the tags graph. Mirrors the original
 * AtlasPage._kindOf / tagGraph._classifyTag logic so every surface agrees.
 *
 * Buckets: 'year' (a year/decade tag), 'geo' (carries lat/long), else 'tag'.
 */
export function tagKind(tag) {
  if (!tag || typeof tag === 'string') return 'tag';
  if (tag.kind === 'year') return 'year';
  if (typeof tag.latitude === 'number' && typeof tag.longitude === 'number') return 'geo';
  return 'tag';
}

export function renderTagLink(tag, { active = false, extra = '', prefix = '', suffix = '' } = {}) {
  const name = typeof tag === 'string' ? tag : tag.name;
  const slug = typeof tag === 'string' ? tag : tag.slug;
  const href = (typeof tag === 'object' && tag.url) ? tag.url : `/tags/${slug}`;
  const classes = ['tag-link', `tag-kind-${tagKind(tag)}`, active ? 'active' : '', extra].filter(Boolean).join(' ');
  const isExternal = /^https?:\/\//.test(href);
  const externalAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${escapeHtml(href)}" class="${classes}"${externalAttrs}>${prefix}${escapeHtml(name)}${suffix}</a>`;
}

export function buildTagIndex(navTags, parentSlug = null, map = new Map()) {
  for (const tag of navTags) {
    const children = (tag.children || []).map(c => ({ name: c.name, slug: c.slug, count: c.post_count }));
    map.set(tag.slug, { 
      tag: { name: tag.name, slug: tag.slug, count: tag.post_count }, 
      parentSlug, 
      isLeaf: !children.length, 
      children,
      showInAncestors: tag.show_in_ancestors !== false 
    });
    if (tag.children?.length) buildTagIndex(tag.children, tag.slug, map);
  }
  return map;
}

export function getTagAncestors(slug, index) {
  const ancestors = [];
  const visited = new Set([slug]);
  let entry = index.get(slug);
  while (entry?.parentSlug) {
    if (visited.has(entry.parentSlug)) break;
    visited.add(entry.parentSlug);
    entry = index.get(entry.parentSlug);
    if (entry && !entry.tag.slug.startsWith('_') && entry.showInAncestors !== false) {
      ancestors.unshift(entry.tag);
    }
  }
  return ancestors;
}
