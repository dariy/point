import { store } from '../../store.js';
import { pluginHost } from '../../core/pluginHost.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { showCrumbDropdown, hideFlyout } from '../../utils/tags.js';
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
    this._onDocClick = (e) => {
      const more = this.navItemsEl.querySelector('.nav-more');
      if (more && !more.contains(e.target)) this._closeMore();
    };
    document.addEventListener('click', this._onDocClick);

    this.render();
  }

  unmount() {
    if (this._unsubscribeNav) this._unsubscribeNav();
    if (this._unsubscribeSettings) this._unsubscribeSettings();
    if (this._unregisterFold) this._unregisterFold();
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
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
    this._inline = items.slice(0, inlineMax);
    this._configOverflow = items.slice(inlineMax);

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
                aria-haspopup="true" aria-expanded="false">More<span class="nav-more-caret" aria-hidden="true">▾</span></button>
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

  /** Dropdowns for inline items with children (hover-intent / tap-toggle). */
  _wireInline() {
    const group = this.navItemsEl.closest('.site-header-group');
    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let hoverTimer = null;

    this.navItemsEl.querySelectorAll('.nav-menu-link.has-children').forEach((el) => {
      const it = this._inline[Number(el.dataset.navI)];
      if (!it) return;
      const items = it.children
        .filter((c) => c.href)
        .map((c) => ({ name: c.name, slug: c.slug, count: c.count, href: c.href }));
      if (!items.length) return;

      if (canHover) {
        el.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => showCrumbDropdown(el, items, navigate, group), 180);
        });
        el.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
        el.addEventListener('click', () => { clearTimeout(hoverTimer); hideFlyout(); });
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
          showCrumbDropdown(el, items, navigate, group);
        });
      }
    });

    const moreBtn = this.navItemsEl.querySelector('.nav-more-btn');
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const more = moreBtn.closest('.nav-more');
      const open = more.classList.toggle('open');
      moreBtn.setAttribute('aria-expanded', String(open));
    });
  }

  _closeMore() {
    const more = this.navItemsEl.querySelector('.nav-more');
    if (!more) return;
    more.classList.remove('open');
    more.querySelector('.nav-more-btn')?.setAttribute('aria-expanded', 'false');
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
      more.classList.add('is-empty');
      this._closeMore();
      return;
    }
    more.classList.remove('is-empty');
    more.querySelector('.nav-more-panel').innerHTML = panelItems.map((it) => {
      let html = `<a href="${escapeHtml(it.href || '#')}" class="nav-more-item">${escapeHtml(it.name)}</a>`;
      it.children.forEach((c) => {
        if (!c.href) return;
        html += `<a href="${escapeHtml(c.href)}" class="nav-more-item nav-more-sub">${escapeHtml(c.name)}</a>`;
      });
      return html;
    }).join('');
  }
}
