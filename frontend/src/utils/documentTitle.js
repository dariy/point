/**
 * The browser tab title.
 *
 * Setting a title is naturally per-page; *clearing* one cannot be. A page that
 * has no title of its own — the home page, every admin page — would otherwise
 * keep whatever the last page left behind, so the reset belongs in the one
 * place every navigation passes through (see Router._render) rather than in
 * fifteen pages that each have to remember.
 *
 * The order that makes both halves work: the router sets the route's title
 * before the page mounts, and a page that knows more — a post's title is not
 * known until its fetch resolves — calls setPageTitle() once it does.
 */

import { getSettings } from '../store.js';

/** Shown before settings load, and when the blog has no title of its own. */
const FALLBACK_SITE_TITLE = 'Point';

/**
 * The site's own name: the title a page with nothing to add falls back to.
 * @returns {string}
 */
export function siteTitle() {
  const settings = /** @type {{ blog_title?: string }} */ (getSettings()) || {};
  return settings.blog_title || FALLBACK_SITE_TITLE;
}

/**
 * Set the tab title to `<name> — <site>`, or to the site name alone when there
 * is no name (or the name already *is* the site name — no "Blog — Blog").
 *
 * @param {string} [name]  the page-specific part
 */
export function setPageTitle(name) {
  const part = (name || '').trim();
  const site = siteTitle();
  document.title = part && part !== site ? `${part} — ${site}` : site;
}
