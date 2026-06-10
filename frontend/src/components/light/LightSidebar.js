/**
 * LightSidebar — admin navigation sidebar.
 *
 * Props:
 *   currentPath  {string}   Active route path
 *   publicUrl    {string}   URL for the public-site link (defaults to '/')
 *   user         {object}   Current user (display_name, username)
 *   onLogout     {Function} Called when user clicks logout
 */

import { Component } from '../Component.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import {
  APP_LOGO_SVG, LOGOUT_SVG, SUN_SVG, MOON_SVG, EXTERNAL_LINK_SVG,
  DASHBOARD_SVG, POSTS_SVG, MEDIA_SVG, TAGS_SVG, SETTINGS_SVG, SECURITY_SVG, SYSTEM_SVG,
  THEMES_SVG, MENU_SVG, CHART_SVG, PLUS_SVG, CHEVRON_SVG,
} from '../../utils/icons.js';

const HAMBURGER_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="5" x2="18" y2="5"/><line x1="2" y1="10" x2="18" y2="10"/><line x1="2" y1="15" x2="18" y2="15"/></svg>`;

const WRITE_ITEMS = [
  { href: '/light',          label: 'Home',      icon: DASHBOARD_SVG },
  { href: '/light/posts',    label: 'Posts',     icon: POSTS_SVG     },
  { href: '/light/media',    label: 'Media',     icon: MEDIA_SVG     },
  { href: '/light/tags',     label: 'Tags',      icon: TAGS_SVG      },
];

const MANAGE_ITEMS = [
  { href: '/light/analytics', label: 'Analytics', icon: CHART_SVG     },
  { href: '/light/menu',     label: 'Menu',      icon: MENU_SVG      },
  { href: '/light/themes',   label: 'Themes',    icon: THEMES_SVG    },
  { href: '/light/settings', label: 'Settings',  icon: SETTINGS_SVG  },
  { href: '/light/security', label: 'Security',  icon: SECURITY_SVG  },
  { href: '/light/system',   label: 'System',    icon: SYSTEM_SVG    },
];

export class LightSidebar extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      manageExpanded: localStorage.getItem('sidebar_manage_expanded') === 'true',
    };
  }

  render() {
    const { currentPath = '', publicUrl = '/' } = this.props;
    const version = store.get('version') || '';

    const isManageActive = MANAGE_ITEMS.some(item => 
       currentPath === item.href || currentPath.startsWith(item.href + '/')
    );
    const manageExpanded = this.state.manageExpanded || isManageActive;

    const renderItem = (item) => {
      const isActive = item.href === '/light'
        ? currentPath === item.href
        : currentPath === item.href || currentPath.startsWith(item.href + '/');
      const cls = isActive ? ' class="nav-item active"' : ' class="nav-item"';
      return `
        <li${cls}>
          <a href="${escapeHtml(item.href)}">
            ${item.icon}
            <span>${escapeHtml(item.label)}</span>
          </a>
        </li>`;
    };

    const writeItems = WRITE_ITEMS.map(renderItem).join('');
    const manageItems = MANAGE_ITEMS.map(renderItem).join('');

    return `
      <aside class="light-sidebar">
        <div class="sidebar-header">
          <div class="site-branding">
            <a href="/light" class="site-title-link" aria-label="Admin home">
              <span class="site-title">
                ${APP_LOGO_SVG}
                Point
              </span>
            </a>
          </div>
          <a href="${escapeHtml(publicUrl)}" class="public-home-link" title="View public site" aria-label="View public site" data-external>${EXTERNAL_LINK_SVG}</a>
        </div>

        <nav class="sidebar-nav" aria-label="Admin navigation">
          <div class="sidebar-primary-action">
            <a href="/light/posts/new" class="btn btn-primary btn-block">
              ${PLUS_SVG}
              <span>New Post</span>
            </a>
          </div>

          <div class="nav-group">
            <h2 class="nav-group-title">Write</h2>
            <ul class="nav-group-items">${writeItems}</ul>
          </div>

          <div class="nav-group ${manageExpanded ? 'is-expanded' : 'is-collapsed'}" id="manage-group">
            <button class="nav-group-toggle" id="manage-toggle" type="button" aria-expanded="${manageExpanded}">
              <span class="nav-group-title">Manage</span>
              <span class="toggle-icon">${CHEVRON_SVG}</span>
            </button>
            <ul class="nav-group-items">${manageItems}</ul>
          </div>
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-version">${escapeHtml(version)}</div>
          <div class="sidebar-footer-actions">
            <div class="user-info">
              <button class="logout-btn" id="logout-btn" type="button" aria-label="Logout" title="Logout">${LOGOUT_SVG}</button>
            </div>
            <button class="theme-toggle" id="sidebar-theme-toggle" aria-label="Toggle theme" type="button">
              <span class="icon-sun">${SUN_SVG}</span>
              <span class="icon-moon">${MOON_SVG}</span>
            </button>
          </div>
        </div>
      </aside>`;
  }

  afterRender() {
    if (!this._subscribedVersion) {
      this.subscribeStore(store, 'version', (v) => {
        const el = this.$('.sidebar-version');
        if (el) el.textContent = v;
      });
      this._subscribedVersion = true;
    }

    this.$('#manage-toggle')?.addEventListener('click', () => {
      const next = !this.state.manageExpanded;
      this.setState({ manageExpanded: next });
      localStorage.setItem('sidebar_manage_expanded', String(next));
    });

    const btn = this.$('#logout-btn');
    if (btn && this.props.onLogout) {
      btn.addEventListener('click', this.props.onLogout);
    }

    this.$('#sidebar-theme-toggle')?.addEventListener('click', () => {
      const current = store.get('theme') || 'auto';
      const next = current === 'dark' ? 'light' : 'dark';
      store.set('theme', next);
    });

    this._setupMobileToggle();
  }

  beforeUnmount() {
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) {
      overlay.classList.remove('active');
    }
  }

  _setupMobileToggle() {
    // Find the sibling .light-header within the same .light-layout.
    const layout = this.container.closest('.light-layout') || this.container.parentElement;
    const header = layout?.querySelector('.light-header');
    if (!header) return;

    // Inject hamburger button only once.
    if (!header.querySelector('.sidebar-toggle-btn')) {
      const hamBtn = document.createElement('button');
      hamBtn.className = 'sidebar-toggle-btn';
      hamBtn.type = 'button';
      hamBtn.setAttribute('aria-label', 'Toggle navigation');
      hamBtn.innerHTML = HAMBURGER_SVG;
      header.insertBefore(hamBtn, header.firstChild);
    }

    // Create overlay if not yet present.
    let overlay = document.querySelector('.sidebar-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      document.body.appendChild(overlay);
    }

    const sidebar = this.$('.light-sidebar');
    const toggleOpen = () => {
      const isOpen = sidebar.classList.contains('open');
      sidebar.classList.toggle('open', !isOpen);
      overlay.classList.toggle('active', !isOpen);
    };
    const close = () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    };

    // Re-bind each time (component may re-render after navigation).
    const hamBtn = header.querySelector('.sidebar-toggle-btn');
    if (hamBtn) hamBtn.onclick = toggleOpen;
    overlay.onclick = close;

    // Close on any navigation link within the sidebar.
    this.$$('a').forEach(a => {
      if (!a.hasAttribute('data-external') && a.target !== '_blank') {
        a.addEventListener('click', close);
      }
    });
  }
}
