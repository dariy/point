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
import { APP_LOGO_SVG, LOGOUT_SVG } from '../../utils/icons.js';
import { store } from '../../store.js';

const NAV_ITEMS = [
  { href: '/light',          label: 'Dashboard',  icon: '⊞' },
  { href: '/light/posts',    label: 'Posts',       icon: '✎' },
  { href: '/light/media',    label: 'Media',       icon: '⌑' },
  { href: '/light/tags',     label: 'Tags',        icon: '⊿' },
  { href: '/light/settings', label: 'Settings',    icon: '⚙' },
  { href: '/light/security', label: 'Security',    icon: '⚿' },
  { href: '/light/system',   label: 'System',      icon: '⌥' },
];

export class LightSidebar extends Component {
  render() {
    const { currentPath = '', publicUrl = '/', user = {} } = this.props;
    const displayName = escapeHtml(user.display_name || user.username || 'Admin');

    const navItems = NAV_ITEMS.map(({ href, label, icon }) => {
      const isActive = href === '/light'
        ? currentPath === href
        : currentPath === href || currentPath.startsWith(href + '/');
      const cls = isActive ? ' class="nav-item active"' : ' class="nav-item"';
      return `
        <li${cls}>
          <a href="${escapeHtml(href)}">
            <span class="nav-icon" aria-hidden="true">${icon}</span>
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
          <a href="${escapeHtml(publicUrl)}" class="public-home-link" title="View public site" aria-label="View public site" data-external>↗</a>

        </div>
        <nav class="sidebar-nav" aria-label="Admin navigation">
          <ul>${navItems}</ul>
        </nav>
        <div class="sidebar-footer">
          <div class="user-info">
            <button class="logout-btn" id="logout-btn" type="button" aria-label="Logout" title="Logout">${LOGOUT_SVG}</button>
          </div>
          <button class="theme-toggle" id="sidebar-theme-toggle" aria-label="Toggle theme" type="button">
            <span class="icon-sun" aria-hidden="true">☀</span>
            <span class="icon-moon" aria-hidden="true">☾</span>
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
  }
}
