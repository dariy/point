/**
 * Navigation data — the header's menu and the root tag tree.
 *
 * Two consumers need it (the nav-menu plugin's links and the breadcrumbs
 * plugin's site-title dropdown), either of which can be disabled on its own,
 * so the fetch lives here and publishes to the store:
 *
 *   navTags   the menu as configured (`nav_menu_mode`): the tag tree, authored
 *             custom links, or nothing.
 *   rootTags  the root tag tree. In "custom" mode the server sends it
 *             separately — the menu shows links, so the site-title dropdown is
 *             the only place the tags stay reachable. In "tags" mode the menu
 *             already is the tree; in "none" mode there is nothing to show.
 */

import { api } from './client.js';
import { getNavTags, setNavTags, setRootTags } from '../store.js';

/**
 * One node of a nav tree — services.NavTagNode. `url` is set on an authored
 * custom link and absent on a tag.
 *
 * @typedef {object} NavTagNode
 * @property {number} id
 * @property {string} name
 * @property {string} slug
 * @property {string} [url]
 * @property {number} post_count
 * @property {boolean} is_related  A co-occurring tag under a show_related parent.
 * @property {boolean} show_in_ancestors
 * @property {NavTagNode[]} children
 */

/**
 * Navigation menu: hierarchical tag tree scoped to the current user's auth
 * level. Guests receive only public/visible tags; admins receive all tags.
 *
 * @returns {Promise<{ menu: NavTagNode[], tags?: NavTagNode[] }>}
 */
export function getNavMenu() {
  return api.get('/api/pages/nav');
}

let _inflight = null;
let _generation = 0;

/**
 * Fetch the nav payload and publish both halves to the store. Plain callers
 * share one request and skip it entirely once the menu is loaded — mounting
 * both plugins on a page costs one fetch. `force` always refetches: the menu
 * is auth-scoped, so login/logout and menu edits must re-read it.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function loadNav({ force = false } = {}) {
  if (!force) {
    if (_inflight) return _inflight;
    if (getNavTags()) return Promise.resolve();
  }
  const gen = ++_generation;
  const req = getNavMenu()
    .then((data) => {
      // A later refresh has already published; this response is stale.
      if (gen !== _generation) return;
      const menu = data.menu || [];
      setNavTags(menu);
      setRootTags(data.tags || menu);
    })
    .catch(() => { /* header degrades to identity + crumbs + tools */ })
    .finally(() => { if (_inflight === req) _inflight = null; });
  _inflight = req;
  return req;
}
