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
import { escapeHtml } from '../../utils/helpers.js';
import {
  APP_LOGO_SVG, LOGOUT_SVG, SUN_SVG, MOON_SVG, EXTERNAL_LINK_SVG,
  DASHBOARD_SVG, POSTS_SVG, MEDIA_SVG, TAGS_SVG, SETTINGS_SVG, SECURITY_SVG, SYSTEM_SVG,
  THEMES_SVG,
} from '../../utils/icons.js';
import { store } from '../../store.js';

const HAMBURGER_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="5" x2="18" y2="5"/><line x1="2" y1="10" x2="18" y2="10"/><line x1="2" y1="15" x2="18" y2="15"/></svg>`;

const NAV_ITEMS = [
  { href: '/light',          label: 'Dashboard', icon: DASHBOARD_SVG },
  { href: '/light/posts',    label: 'Posts',     icon: POSTS_SVG     },
  { href: '/light/media',    label: 'Media',     icon: MEDIA_SVG     },
  { href: '/light/tags',     label: 'Tags',      icon: TAGS_SVG      },
  { href: '/light/themes',   label: 'Themes',    icon: THEMES_SVG    },
  { href: '/light/settings', label: 'Settings',  icon: SETTINGS_SVG  },
  { href: '/light/security', label: 'Security',  icon: SECURITY_SVG  },
  { href: '/light/system',   label: 'System',    icon: SYSTEM_SVG    },
];

export class LightSidebar extends Component {
  render() {
    const { currentPath = '', publicUrl = '/' } = this.props;

    const navItems = NAV_ITEMS.map(({ href, label, icon }) => {
      const isActive = href === '/light'
        ? currentPath === href
        : currentPath === href || currentPath.startsWith(href + '/');
      const cls = isActive ? ' class="nav-item active"' : ' class="nav-item"';
      return `
        <li${cls}>
          <a href="${escapeHtml(href)}">
            ${icon}
            ${escapeHtml(label)}
          </a>
        </li>`;
    }).join('');

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
          <ul>${navItems}</ul>
        </nav>
        <div class="sidebar-footer">
          <div class="user-info">
            <button class="logout-btn" id="logout-btn" type="button" aria-label="Logout" title="Logout">${LOGOUT_SVG}</button>
          </div>
          <button class="theme-toggle" id="sidebar-theme-toggle" aria-label="Toggle theme" type="button">
            <span class="icon-sun">${SUN_SVG}</span>
            <span class="icon-moon">${MOON_SVG}</span>
          </button>
        </div>
      </aside>`;
  }

  afterRender() {
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
