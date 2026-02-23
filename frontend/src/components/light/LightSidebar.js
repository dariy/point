/**
 * LightSidebar — admin navigation sidebar.
 *
 * Props:
 *   currentPath  {string}   Active route path
 *   user         {object}   Current user (display_name, username)
 *   onLogout     {Function} Called when user clicks logout
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

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
    const { currentPath = '', user = {} } = this.props;
    const displayName = escapeHtml(user.display_name || user.username || 'Admin');

    const navItems = NAV_ITEMS.map(({ href, label, icon }) => {
      const isActive = currentPath === href || currentPath.startsWith(href + '/');
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
          <a href="/light" class="app-logo-link" aria-label="Admin home">
            <span class="app-logo" aria-hidden="true">P</span>
            <span class="logo">Point</span>
          </a>
          <a href="/" class="public-home-link" title="View public site" aria-label="View public site" data-external>↗</a>
        </div>
        <nav class="sidebar-nav" aria-label="Admin navigation">
          <ul>${navItems}</ul>
        </nav>
        <div class="sidebar-footer">
          <div class="user-info">
            <button class="btn btn-primary" id="logout-btn" type="button">Logout</button>
          </div>
        </div>
      </aside>`;
  }

  afterRender() {
    const btn = this.$('#logout-btn');
    if (btn && this.props.onLogout) {
      btn.addEventListener('click', this.props.onLogout);
    }
  }
}
