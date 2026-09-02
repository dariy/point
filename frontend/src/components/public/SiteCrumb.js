/**
 * SiteCrumb — the blog title at the head of the breadcrumb trail, plus its
 * dropdown of root tags.
 *
 * It belongs to the header rather than the breadcrumbs plugin because it is
 * site identity, not page context: with breadcrumbs switched off the trail is
 * gone but the title (and the navigation it offers) must stay. The plugin fills
 * the trail beside it; both render into `.site-breadcrumb`, which is why each
 * gets its own wrapper — a Component owns its container's innerHTML.
 *
 * The dropdown lists root tags whatever the menu is made of, so on a site with
 * an authored menu it is the one surface still exposing the tag tree. Admins
 * can drop it with the `show_title_dropdown` setting (Plugins → Public Header).
 *
 * Props:
 *   settings {object}      Public settings (blog_title, show_title_dropdown)
 *   hasTrail {boolean}     Crumbs follow → render as a link with a separator
 *   group    {Element}     Header group; clicks inside it don't dismiss the panel
 *   fold     {HeaderFold}  Re-measured when late data changes our width
 */

import { Component } from '../Component.js';
import { getRootTags, onRootTags } from '../../store.js';
import { html, navigate } from '../../utils/helpers.js';
import { loadNav } from '../../api/nav.js';
import { tagHref } from '../../utils/tagLinks.js';
import { attachFlyoutTrigger, hideFlyoutWithin } from '../../utils/tagFlyout.js';

export class SiteCrumb extends Component {
  render() {
    const { settings = {}, hasTrail = false } = this.props;

    const title = settings.blog_title || 'Photo Blog';
    const crumbClass = hasTrail ? 'breadcrumb-link' : 'breadcrumb-current';
    const hasDropdown = this._items().length > 0;

    return html`<span class="crumb-pair" id="site-crumb-pair">
      <a href="/" class="${crumbClass} crumb-site${hasDropdown ? ' has-dropdown' : ''}" data-crumb="site"
         aria-label="${title}"${hasDropdown ? html` aria-haspopup="true"` : ''}>${title}</a>
      ${hasTrail ? html`<span class="breadcrumb-separator" aria-hidden="true"></span>` : ''}
    </span>`;
  }

  /** Whether the admin left the dropdown on (absent setting = on). */
  _dropdownEnabled() {
    const v = (this.props.settings || {}).show_title_dropdown;
    return v !== false && v !== 'false';
  }

  /**
   * The dropdown list: root tags shaped for the shared flyout.
   *
   * Read from the store rather than the header's `navTags` prop because the two
   * differ whenever the menu is custom — there `navTags` holds authored links
   * while this list stays the tag tree.
   */
  _items() {
    if (!this._dropdownEnabled()) return [];
    return (getRootTags() || []).map((t) => ({
      name: t.name,
      slug: t.slug,
      count: t.post_count,
      href: t.url || tagHref(t.slug),
    }));
  }

  afterRender() {
    const { group, fold } = this.props;

    // Own the fetch: the nav-menu plugin is the usual loader, but it can be
    // disabled — and then this dropdown would be the only nav left. Shared and
    // de-duplicated, so the common case still costs one request.
    if (this._dropdownEnabled()) loadNav();

    // The payload lands after first paint; re-render then so the crumb picks up
    // its dropdown, and let the header re-measure — it grew by a caret.
    this.subscribeStore(onRootTags, () => this._rerender());

    // Same trigger as every other crumb: hover-with-intent on a mouse, tap on
    // touch. The list is read at open time, never captured at wiring time.
    const crumb = this.$('.crumb-site.has-dropdown');
    if (crumb) attachFlyoutTrigger(crumb, () => this._items(), navigate, group);

    fold?.relayout();
  }

  beforeRender() {
    // A re-render replaces the element an open dropdown is anchored to. Only
    // ours: the flyout is a singleton the nav zone shares.
    hideFlyoutWithin(this.container);
  }

  beforeUnmount() {
    hideFlyoutWithin(this.container);
  }
}
