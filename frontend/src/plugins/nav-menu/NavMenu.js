import { store } from '../../store.js';
import { pluginHost } from '../../core/pluginHost.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { showCrumbDropdown, hideFlyout, hideFlyoutWithin } from '../../utils/tags.js';
import { TAGS_SVG, MAP_SVG, GLOBE_SVG } from '../../utils/icons.js';

const DEFAULT_INLINE_MAX = 4;

/**
 * NavMenu — the header's nav zone plus the burger's menu section.
 *
 * Renders the menu (custom links or nav tags — one model, see /api/pages/nav)
 * as visible inline links in `.site-nav-items`, with two overflow surfaces:
 *   - More ▾ — items past the configured inline cap (nav_inline_max), plus
 *     items folded right-to-left by the header fold controller (order 30).
 *   - burger — the full list, shown when the whole nav zone folds (order 40).
 *
 * Items with children get a dropdown: hover (with intent delay) on fine
 * pointers, tap-to-toggle on coarse — same interaction as breadcrumb crumbs.
 */
export class NavMenu {
  constructor({ navItemsEl, burgerTagsEl, burgerSitemapEl, ctx }) {
    this.navItemsEl = navItemsEl;
    this.burgerTagsEl = burgerTagsEl;
    this.burgerSitemapEl = burgerSitemapEl;
    this.ctx = ctx;
    this.fold = ctx.fold || null;
    this._unsubscribeNav = null;
    this._unsubscribeSettings = null;
    this._unregisterFold = null;
    this._onDocClick = null;
  }

  mount() {
    this._unsubscribeNav = store.subscribe('navTags', () => this.render());
    this._unsubscribeSettings = store.subscribe('settings', () => this.render());

    // Fold stage 30: inline links fold right-to-left into More ▾ before the
    // whole nav zone collapses into the burger (stage 40, PublicHeader).
    if (this.fold) {
      this._unregisterFold = this.fold.register(30, {
        reset: () => this._resetFoldedLinks(),
        ops: () => this._foldOps(),
      });
    }

    // One document-level listener closes the More panel on outside clicks.
    // It must be inert unless the panel is actually open: on touch, opening any
    // header dropdown *is* a document click, and an unconditional close here
    // would shut the panel the same tap just opened.
    // Capture phase, because content below stops propagation on its own taps
    // (a photo card's first tap reveals its overlay) — the panel must still
    // close when the tap lands there.
    this._onDocClick = (e) => {
      if (!this.navItemsEl.isConnected) return;
      const more = this.navItemsEl.querySelector('.nav-more.open');
      if (more && !more.contains(e.target)) this._closeMore();
    };
    document.addEventListener('click', this._onDocClick, true);

    this.render();
  }

  unmount() {
    if (this._unsubscribeNav) this._unsubscribeNav();
    if (this._unsubscribeSettings) this._unsubscribeSettings();
    if (this._unregisterFold) this._unregisterFold();
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick, true);
    hideFlyout();
  }

  /** Menu items normalized from the store: {name, href, slug, count, children[]}. */
  _items() {
    const navTags = store.get('navTags') || [];
    const settings = store.get('settings') || {};
    if (settings.nav_menu_mode === 'none') return [];
    const toItem = (t) => ({
      name: t.name,
      slug: t.slug || '',
      count: t.post_count || 0,
      href: t.url || (t.slug ? `/tags/${t.slug}` : null),
      children: (t.children || []).map(toItem),
    });
    return navTags.map(toItem).filter((i) => i.href || i.children.length);
  }

  render() {
    const settings = store.get('settings') || {};
    const user = store.get('user');
    const { currentPath } = this.ctx;

    const items = this._items();
    const inlineMax = parseInt(settings.nav_inline_max, 10) || DEFAULT_INLINE_MAX;
    // nav_inline_max caps the number of *visible* nav slots, and the "More ▾"
    // button takes one of those slots whenever it's shown. So if every item
    // fits (items <= max) show them all with no More; otherwise reserve a slot
    // for More and show max-1 links inline, folding the rest into the panel.
    // This avoids burying a single link under a More button that costs the same
    // room. (The fold controller still collapses more links into More when the
    // header actually runs out of horizontal space.)
    const cap = items.length <= inlineMax ? items.length : inlineMax - 1;
    this._inline = items.slice(0, cap);
    this._configOverflow = items.slice(cap);

    // Tags button — the active viz is the enabled tags-viz plugin (at most
    // one). None enabled → no tags link. Rendered as one more nav item.
    const activeTagsViz =
      ['tags-atlas', 'tags-map', 'tags-graph'].find((id) => pluginHost.isEnabled(id)) || '';
    const tagsVisibility = settings.tags_visibility || 'hidden';
    const tagsVisible = !!activeTagsViz && (tagsVisibility === 'all' || !!user);
    const tagsMeta = {
      'tags-graph': { icon: TAGS_SVG, label: 'All tags' },
      'tags-map': { icon: MAP_SVG, label: 'Map' },
      'tags-atlas': { icon: GLOBE_SVG, label: 'Atlas' },
    }[activeTagsViz] || { icon: TAGS_SVG, label: 'All tags' };

    const isActive = (href) => !!href && href === currentPath;

    // Inline links + More shell + tags icon.
    this.navItemsEl.innerHTML = `
      ${this._inline.map((it, i) => `
        <a href="${escapeHtml(it.href || '#')}"
           class="nav-menu-link${isActive(it.href) ? ' active' : ''}${it.children.length ? ' has-children' : ''}"
           data-nav-i="${i}">${escapeHtml(it.name)}</a>`).join('')}
      <span class="nav-more is-empty">
        <button type="button" class="nav-menu-link nav-more-btn"
                aria-haspopup="true" aria-expanded="false">${escapeHtml(settings.nav_more_title || 'More')}<span class="nav-more-caret" aria-hidden="true">▾</span></button>
        <div class="nav-more-panel"></div>
      </span>
      ${tagsVisible
        ? `<a href="/tags" class="header-action-btn${currentPath === '/tags' ? ' active' : ''}"
                  aria-label="${tagsMeta.label}" title="${tagsMeta.label}">
                 ${tagsMeta.icon}
               </a>`
        : ''}
    `;
    this._wireInline();
    this._syncMore();

    // Burger: the full menu, children indented.
    this.burgerTagsEl.innerHTML = items.length
      ? items.map((it) => {
          let html = `<a href="${escapeHtml(it.href || '#')}" class="burger-link burger-tag-link">${escapeHtml(it.name)}</a>`;
          it.children.forEach((c) => {
            if (!c.href) return;
            html += `<a href="${escapeHtml(c.href)}" class="burger-link burger-sub-link">${escapeHtml(c.name)}</a>`;
          });
          return html;
        }).join('')
      : '';

    // Burger sitemap.
    this.burgerSitemapEl.innerHTML = `
      ${tagsVisible ? `<a href="/tags" class="burger-link">${tagsMeta.label}</a>` : ''}
      <a href="/light" class="burger-link">${user ? 'Admin' : 'About'}</a>
    `;

    // New content, new widths — let the fold controller re-measure.
    this.fold?.relayout();
  }

  /** The child links (href-bearing) of a menu item, shaped for the dropdown. */
  _childItems(it) {
    return it.children
      .filter((c) => c.href)
      .map((c) => ({ name: c.name, slug: c.slug, count: c.count, href: c.href }));
  }

  /**
   * Wire a menu link that stands for an item with children so it reveals those
   * children in the shared header dropdown — hover-intent on fine pointers,
   * tap-to-open (then tap-again-to-navigate) on coarse. Used for both inline
   * links and the parent rows inside the More ▾ panel, so both surfaces behave
   * identically instead of More dumping the whole subtree inline.
   */
  _wireChildFlyout(el, childItems) {
    const group = this.navItemsEl.closest('.site-header-group');
    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    if (canHover) {
      el.addEventListener('mouseenter', () => {
        clearTimeout(this._hoverTimer);
        this._hoverTimer = setTimeout(() => showCrumbDropdown(el, childItems, navigate, group), 180);
      });
      el.addEventListener('mouseleave', () => clearTimeout(this._hoverTimer));
      el.addEventListener('click', () => { clearTimeout(this._hoverTimer); hideFlyout(); });
    } else {
      el.addEventListener('click', (e) => {
        if (el.classList.contains('is-flyout-open')) {
          const href = el.getAttribute('href');
          if (href && href !== '#') {
            hideFlyout();
            navigate(href);
            e.preventDefault();
            return;
          }
        }
        e.preventDefault();
        showCrumbDropdown(el, childItems, navigate, group);
      });
    }
  }

  /** Dropdowns for inline items with children (hover-intent / tap-toggle). */
  _wireInline() {
    this.navItemsEl.querySelectorAll('.nav-menu-link.has-children').forEach((el) => {
      const it = this._inline[Number(el.dataset.navI)];
      if (!it) return;
      const childItems = this._childItems(it);
      if (childItems.length) this._wireChildFlyout(el, childItems);
    });

    const moreBtn = this.navItemsEl.querySelector('.nav-more-btn');
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const more = moreBtn.closest('.nav-more');
      const open = more.classList.toggle('open');
      moreBtn.setAttribute('aria-expanded', String(open));
      // Closing the panel also dismisses the child dropdown it opened.
      if (!open) hideFlyoutWithin(more);
    });
  }

  _closeMore() {
    const more = this.navItemsEl.querySelector('.nav-more');
    if (!more) return;
    more.classList.remove('open');
    more.querySelector('.nav-more-btn')?.setAttribute('aria-expanded', 'false');
    // Only the child dropdown this panel owns — the flyout is a singleton, and
    // a breadcrumb may have just opened its own in the same click.
    hideFlyoutWithin(more);
  }

  /** Inline links currently visible (not folded into More), left to right. */
  _visibleLinks() {
    return [...this.navItemsEl.querySelectorAll('.nav-menu-link[data-nav-i]:not(.in-more)')];
  }

  _resetFoldedLinks() {
    this.navItemsEl.querySelectorAll('.nav-menu-link.in-more').forEach((a) => {
      a.classList.remove('in-more');
    });
    this._syncMore();
  }

  _foldOps() {
    return this._visibleLinks().reverse().map((el) => () => {
      el.classList.add('in-more');
      this._syncMore();
    });
  }

  /** Rebuild the More ▾ panel: config-overflow items + fold-folded links. */
  _syncMore() {
    const more = this.navItemsEl.querySelector('.nav-more');
    if (!more) return;
    const foldedIdx = [...this.navItemsEl.querySelectorAll('.nav-menu-link.in-more')]
      .map((a) => Number(a.dataset.navI))
      .sort((a, b) => a - b);
    const panelItems = [
      ...foldedIdx.map((i) => this._inline[i]).filter(Boolean),
      ...this._configOverflow,
    ];
    if (!panelItems.length) {
      // Transient: a fold relayout unfolds every link before re-folding, so
      // the panel empties mid-cycle. Hide the shell (CSS also hides an empty
      // `.open` panel) but keep the open state — closing here would clobber a
      // menu the user just opened whenever any ResizeObserver relayout fires.
      more.classList.add('is-empty');
      return;
    }
    more.classList.remove('is-empty');
    // Parents only — a parent with children reveals them in the shared
    // dropdown (like inline links) rather than flattening the whole subtree.
    const panel = more.querySelector('.nav-more-panel');
    panel.innerHTML = panelItems.map((it, i) => {
      const hasChildren = this._childItems(it).length > 0;
      const caret = hasChildren
        ? `<span class="nav-more-item-caret" aria-hidden="true">›</span>`
        : '';
      return `<a href="${escapeHtml(it.href || '#')}"
         class="nav-more-item${hasChildren ? ' has-children' : ''}"
         data-more-i="${i}">${escapeHtml(it.name)}${caret}</a>`;
    }).join('');
    panel.querySelectorAll('.nav-more-item.has-children').forEach((el) => {
      const childItems = this._childItems(panelItems[Number(el.dataset.moreI)]);
      if (childItems.length) this._wireChildFlyout(el, childItems);
    });
  }
}
