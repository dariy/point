import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { TAGS_SVG, MAP_SVG, GLOBE_SVG } from '../../utils/icons.js';

export class NavMenu {
  constructor({ navItemsEl, burgerTagsEl, burgerSitemapEl, ctx }) {
    this.navItemsEl = navItemsEl;
    this.burgerTagsEl = burgerTagsEl;
    this.burgerSitemapEl = burgerSitemapEl;
    this.ctx = ctx;
    this._unsubscribeNav = null;
    this._unsubscribeSettings = null;
  }

  mount() {
    this._unsubscribeNav = store.subscribe('navTags', () => this.render());
    this._unsubscribeSettings = store.subscribe('settings', () => this.render());
    this.render();
  }

  unmount() {
    if (this._unsubscribeNav) this._unsubscribeNav();
    if (this._unsubscribeSettings) this._unsubscribeSettings();
  }

  render() {
    const navTags = store.get('navTags') || [];
    const settings = store.get('settings') || {};
    const user = store.get('user');
    const { currentPath } = this.ctx;
    
    const isCustomMenu = settings.nav_menu_mode === 'custom';

    // Tags Button Html
    const tagsModule = settings.tags_module || 'atlas';
    const tagsVisibility = settings.tags_visibility || 'hidden';
    const tagsVisible = tagsModule !== 'none' && (tagsVisibility === 'all' || !!user);
    const tagsMeta = {
      cloud: { icon: TAGS_SVG, label: 'All tags' },
      map: { icon: MAP_SVG, label: 'Map' },
      atlas: { icon: GLOBE_SVG, label: 'Atlas' },
    }[tagsModule] || { icon: TAGS_SVG, label: 'All tags' };

    this.navItemsEl.innerHTML = tagsVisible
      ? `<a href="/tags" class="header-action-btn${currentPath === '/tags' ? ' active' : ''}"
                   aria-label="${tagsMeta.label}" title="${tagsMeta.label}">
                  ${tagsMeta.icon}
                </a>`
      : '';

    // Burger Tag Links Html
    this.burgerTagsEl.innerHTML = navTags.length
      ? navTags.map(t => {
          const href = t.url ? escapeHtml(t.url) : `/tags/${escapeHtml(t.slug)}`;
          let html = `<a href="${href}" class="burger-link burger-tag-link">${escapeHtml(t.name)}</a>`;
          if (isCustomMenu && t.children && t.children.length) {
              t.children.forEach(c => {
                  const cHref = c.url ? escapeHtml(c.url) : `/tags/${escapeHtml(c.slug)}`;
                  html += `<a href="${cHref}" class="burger-link burger-sub-link">${escapeHtml(c.name)}</a>`;
              });
          }
          return html;
        }).join('')
      : '';
      
    // Burger Sitemap Html
    this.burgerSitemapEl.innerHTML = `
      ${tagsVisible ? `<a href="/tags" class="burger-link">${tagsMeta.label}</a>` : ''}
      <a href="/light" class="burger-link">About</a>
      ${user ? `<a href="/light" class="burger-link">Admin</a>` : ''}
    `;
  }
}
