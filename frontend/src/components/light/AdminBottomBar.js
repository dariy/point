import { Component } from '../Component.js';
import {
  DASHBOARD_SVG, POSTS_SVG, MEDIA_SVG, PLUS_SVG, MENU_SVG,
  TAGS_SVG, MENU_SVG as NAV_MENU_SVG, THEMES_SVG, PLUGINS_SVG, SETTINGS_SVG, SECURITY_SVG, SYSTEM_SVG,
  SUN_SVG, MOON_SVG, EXTERNAL_LINK_SVG, LOGOUT_SVG, X_SVG
} from '../../utils/icons.js';
import { escapeHtml } from '../../utils/helpers.js';
import { store } from '../../store.js';

export class AdminBottomBar extends Component {
  render() {
    const { currentPath = '' } = this.props;

    const navItem = (href, icon, label, exact = false) => {
      const active = exact ? currentPath === href : currentPath === href || currentPath.startsWith(href + '/');
      const ariaCurrent = active ? ' aria-current="page"' : '';
      return `
        <a href="${escapeHtml(href)}"${ariaCurrent} class="bottom-bar-item ${active ? 'active' : ''}">
          <div class="bottom-bar-icon">${icon}</div>
          <span class="bottom-bar-label">${escapeHtml(label)}</span>
        </a>`;
    };

    return `
      <nav class="admin-bottom-bar" aria-label="Mobile navigation">
        ${navItem('/light', DASHBOARD_SVG, 'Home', true)}
        ${navItem('/light/posts', POSTS_SVG, 'Posts')}
        <a href="/light/posts/new" class="bottom-bar-item bottom-bar-add" aria-label="New Post">
          <div class="add-icon-wrap">${PLUS_SVG}</div>
        </a>
        ${navItem('/light/media', MEDIA_SVG, 'Media')}
        <button type="button" class="bottom-bar-item" id="bottom-bar-more" aria-label="More">
          <div class="bottom-bar-icon">${MENU_SVG}</div>
          <span class="bottom-bar-label">More</span>
        </button>
      </nav>
      <div class="admin-more-sheet-overlay" id="more-sheet-overlay">
        <div class="admin-more-sheet" id="more-sheet">
          <div class="more-sheet-header">
            <h3>More Actions</h3>
            <button type="button" class="more-sheet-close" id="more-sheet-close">${X_SVG}</button>
          </div>
          <div class="more-sheet-grid">
            ${this._renderMoreItem('/light/tags', TAGS_SVG, 'Tags')}
            ${this._renderMoreItem('/light/menu', NAV_MENU_SVG, 'Menu')}
            ${this._renderMoreItem('/light/themes', THEMES_SVG, 'Themes')}
            ${this._renderMoreItem('/light/plugins', PLUGINS_SVG, 'Plugins')}
            ${this._renderMoreItem('/light/settings', SETTINGS_SVG, 'Settings')}
            ${this._renderMoreItem('/light/security', SECURITY_SVG, 'Security')}
            ${this._renderMoreItem('/light/system', SYSTEM_SVG, 'System')}
          </div>
          <hr class="more-sheet-divider">
          <div class="more-sheet-footer">
            <button type="button" class="more-footer-btn" id="sheet-theme-toggle">
              <span class="icon-sun">${SUN_SVG}</span>
              <span class="icon-moon">${MOON_SVG}</span>
              <span>Theme</span>
            </button>
            <a href="${escapeHtml(this.props.publicUrl || '/')}" class="more-footer-btn" data-external>
              ${EXTERNAL_LINK_SVG}
              <span>View Site</span>
            </a>
            <button type="button" class="more-footer-btn text-danger" id="sheet-logout">
              ${LOGOUT_SVG}
              <span>Logout</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderMoreItem(href, icon, label) {
    const active = this.props.currentPath === href || this.props.currentPath?.startsWith(href + '/');
    return `
      <a href="${escapeHtml(href)}" class="more-grid-item ${active ? 'active' : ''}">
        <div class="more-item-icon">${icon}</div>
        <span class="more-item-label">${escapeHtml(label)}</span>
      </a>`;
  }

  afterRender() {
    const overlay = this.$('#more-sheet-overlay');
    const moreBtn = this.$('#bottom-bar-more');
    const closeBtn = this.$('#more-sheet-close');

    const open = () => {
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    };

    const close = () => {
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    };

    moreBtn?.addEventListener('click', open);
    closeBtn?.addEventListener('click', close);
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    this.$$('.more-grid-item').forEach(item => {
      item.addEventListener('click', close);
    });

    this.$('#sheet-theme-toggle')?.addEventListener('click', () => {
      const current = store.get('theme') || 'auto';
      const next = current === 'dark' ? 'light' : 'dark';
      store.set('theme', next);
    });

    this.$('#sheet-logout')?.addEventListener('click', () => {
      close();
      if (this.props.onLogout) this.props.onLogout();
    });
  }
}
