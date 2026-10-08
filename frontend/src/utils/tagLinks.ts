/**
 * Pure tag helpers — how a tag becomes a URL, a colour bucket, an <a>, and how
 * the nav payload becomes the index the flyout walks for ancestors.
 *
 * No DOM, no module state: every function here is a value in, a string or a
 * plain object out. Every public surface that shows a tag goes through these —
 * the pills, the strip, the Atlas cloud, the graph, the breadcrumb — so a
 * change here is a change everywhere at once.
 *
 * The DOM behaviour that used to share this file lives in tagFlyout.ts (the
 * shared dropdown singleton) and tagStrip.ts (the scrollable strip).
 */

import { html } from './helpers.ts';
import type { RawHtml, Slot } from './helpers.ts';

/**
 * Build a tag URL whose `path` query carries the ancestor slug chain the user
 * drilled through to reach it. Empty chain → bare /tags/<slug>.
 *
 * @param pathSlugs - ancestor slugs, root-first (current tag excluded)
 */
export function tagHref(slug: string, pathSlugs: string[] = []) {
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
 */
export function parseTagUrl(url: string): { tag: string, navPath: string | null } {
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
/** Any tag-like value the tag helpers accept: a bare slug or a tag object. */
export type TagLike = string | {
  name?: string;
  slug?: string;
  url?: string;
  kind?: string;
  latitude?: number | null;
  longitude?: number | null;
};

/** One nav-tree node as buildTagIndex reads it. */
export interface TagIndexSource {
  name: string;
  slug: string;
  post_count?: number;
  show_in_ancestors?: boolean;
  children?: TagIndexSource[];
}

/** A tag as the index stores it: name, slug and post count. */
export interface TagIndexTag {
  name: string;
  slug: string;
  count?: number;
}

export interface TagIndexEntry {
  tag: TagIndexTag;
  parentSlug: string | null;
  isLeaf: boolean;
  children: TagIndexTag[];
  showInAncestors: boolean;
}

export type TagIndex = Map<string, TagIndexEntry>;

export function tagKind(tag: TagLike | null | undefined) {
  if (!tag || typeof tag === 'string') return 'tag';
  if (tag.kind === 'year') return 'year';
  if (typeof tag.latitude === 'number' && typeof tag.longitude === 'number') return 'geo';
  return 'tag';
}

/**
 * One tag as an <a>. `prefix` and `suffix` are markup slots: html`` output
 * goes in as markup, a plain string is escaped as text. The tag's own name
 * always goes through the tag.
 *
 * @returns interpolate it directly; no raw()
 *   at the call site.
 */
export function renderTagLink(
  tag: TagLike,
  { active = false, extra = '', prefix = '' as Slot, suffix = '' as Slot } = {},
): RawHtml {
  const name = typeof tag === 'string' ? tag : tag.name;
  const slug = typeof tag === 'string' ? tag : tag.slug;
  const href = (typeof tag === 'object' && tag.url) ? tag.url : `/tags/${slug}`;
  const classes = ['tag-link', `tag-kind-${tagKind(tag)}`, active ? 'active' : '', extra].filter(Boolean).join(' ');
  const isExternal = /^https?:\/\//.test(href);
  return html`<a href="${href}" class="${classes}"${isExternal ? html` target="_blank" rel="noopener noreferrer"` : ''}>${prefix}${name}${suffix}</a>`;
}

export function buildTagIndex(
  navTags: TagIndexSource[],
  parentSlug: string | null = null,
  map: TagIndex = new Map(),
): TagIndex {
  for (const tag of navTags) {
    const children = (tag.children || []).map((c: TagIndexSource) => ({ name: c.name, slug: c.slug, count: c.post_count }));
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

export function getTagAncestors(slug: string, index: TagIndex): TagIndexTag[] {
  const ancestors: TagIndexTag[] = [];
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
