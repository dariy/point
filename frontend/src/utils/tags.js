/**
 * Unified tag link renderer — the single source of truth for rendering
 * public-facing tag <a> elements across all components.
 */

import { escapeHtml } from './helpers.js';
import { LOCK_SVG } from './icons.js';

/**
 * Render a tag link `<a>` element with consistent class structure,
 * lock-icon indication for hidden tags, and optional modifier classes.
 *
 * @param {string|{name:string, slug:string, is_hidden?:boolean}} tag
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
  const hidden = typeof tag === 'object' && tag !== null && (!!tag.is_hidden || !!tag.is_hidden_posts);

  const classes = ['tag-link', hidden ? 'is-hidden' : '', active ? 'active' : '', extra]
    .filter(Boolean)
    .join(' ');

  const lock = hidden ? LOCK_SVG : '';
  return `<a href="/tag/${escapeHtml(slug)}" class="${classes}">${lock}${escapeHtml(name)}${suffix}</a>`;
}
