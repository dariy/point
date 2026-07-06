/**
 * LightSidebar — admin navigation sidebar.
 *
 * Props:
 *   currentPath  {string}   Active route path
 *   user         {object}   Current user (display_name, username)
 *   onLogout     {Function} Called when user clicks logout
 */

import { Component } from '../Component.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { DEBUG } from '../../utils/debug.js';
import { pluginHost } from '../../core/pluginHost.js';
import {
  APP_LOGO_SVG, LOGOUT_SVG, SUN_SVG, MOON_SVG,
  DASHBOARD_SVG, POSTS_SVG, MEDIA_SVG, TAGS_SVG, SETTINGS_SVG, SECURITY_SVG, SYSTEM_SVG,
  THEMES_SVG, MENU_SVG, PLUS_SVG, CHEVRON_SVG, PLUGINS_SVG, COMMENTS_SVG,
} from '../../utils/icons.js';

const WRITE_ITEMS = [
  { href: '/light',          label: 'Home',      icon: DASHBOARD_SVG },
  { href: '/light/posts',    label: 'Posts',     icon: POSTS_SVG     },
  { href: '/light/media',    label: 'Media',     icon: MEDIA_SVG     },
  { href: '/light/tags',     label: 'Tags',      icon: TAGS_SVG      },
];

const MANAGE_ITEMS = [
  { href: '/light/menu',     label: 'Menu',      icon: MENU_SVG      },
  { href: '/light/themes',   label: 'Themes',    icon: THEMES_SVG    },
  { href: '/light/plugins',  label: 'Plugins',   icon: PLUGINS_SVG   },
  { href: '/light/settings', label: 'Settings',  icon: SETTINGS_SVG  },
  { href: '/light/security', label: 'Security',  icon: SECURITY_SVG  },
  { href: '/light/system',   label: 'System',    icon: SYSTEM_SVG    },
];

export class LightSidebar extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      manageExpanded: localStorage.getItem('sidebar_manage_expanded') === 'true',
      collapsed: localStorage.getItem('sidebar_collapsed') === 'true',
    };
  }

  render() {
    const { currentPath = '' } = this.props;
    const { collapsed } = this.state;
    const version = store.get('version') || '';

    // Plugin-provided pages join the Manage group only while their plugin is
    // enabled (the manifest is enabled-only, so a disabled plugin disappears).
    const manageItems = [...MANAGE_ITEMS];
    if (pluginHost.isEnabled('comments')) {
      manageItems.splice(1, 0, { href: '/light/comments', label: 'Comments', icon: COMMENTS_SVG });
    }

    const isManageActive = manageItems.some(item =>
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
          <a href="${escapeHtml(item.href)}" title="${escapeHtml(item.label)}">
            ${item.icon}
            <span class="nav-label">${escapeHtml(item.label)}</span>
          </a>
        </li>`;
    };

    const writeItems = WRITE_ITEMS.map(renderItem).join('');
    const manageItemsHtml = manageItems.map(renderItem).join('');

    return `
      <aside class="light-sidebar${collapsed ? ' is-collapsed' : ''}">
        <div class="sidebar-header">
          <div class="site-branding">
            <button type="button" id="sidebar-collapse-btn" class="site-title-link" title="Toggle Sidebar" aria-label="Toggle Sidebar">
              <span class="site-title">
                ${APP_LOGO_SVG}
                <span class="site-name">Point</span>
              </span>
            </button>
          </div>
        </div>

        <nav class="sidebar-nav" aria-label="Admin navigation">
          <div class="sidebar-primary-action">
            <a href="/light/posts/new" class="btn btn-primary btn-block" title="New Post" aria-label="Create new post">
              ${PLUS_SVG}
              <span class="nav-label">New Post</span>
            </a>
          </div>

          <div class="nav-group">
            <h2 class="nav-group-title">Write</h2>
            <ul class="nav-group-items">${writeItems}</ul>
          </div>

          <div class="nav-group ${manageExpanded ? 'is-expanded' : 'is-collapsed'}" id="manage-group">
            <button class="nav-group-toggle" id="manage-toggle" type="button" aria-expanded="${manageExpanded}" title="Manage" aria-label="Toggle Manage group">
              <span class="nav-group-title">Manage</span>
              <span class="toggle-icon">${CHEVRON_SVG}</span>
            </button>
            <ul class="nav-group-items">${manageItemsHtml}</ul>
          </div>
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-version" aria-label="Version">${escapeHtml(version)}<span class="sidebar-build sidebar-build-${DEBUG ? 'debug' : 'release'}" title="Frontend bundle">${DEBUG ? 'debug' : 'release'}</span></div>
          <div class="sidebar-footer-actions">
            <div class="user-info">
              <button class="logout-btn" id="logout-btn" type="button" aria-label="Logout" title="Logout">${LOGOUT_SVG}</button>
            </div>
            <button class="theme-toggle" id="sidebar-theme-toggle" aria-label="Toggle theme" type="button" title="Toggle Theme">
              <span class="icon-sun">${SUN_SVG}</span>
              <span class="icon-moon">${MOON_SVG}</span>
            </button>
          </div>
        </div>
      </aside>`;
  }

  afterRender() {
    this.subscribeStore(store, 'plugin_toggled', () => this.renderToDOM());

    const { collapsed } = this.state;
    document.querySelector('.light-layout')?.classList.toggle('light-layout--collapsed', collapsed);

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

    this.$('#sidebar-collapse-btn')?.addEventListener('click', () => {
      const next = !this.state.collapsed;
      this.setState({ collapsed: next });
      localStorage.setItem('sidebar_collapsed', String(next));
      document.querySelector('.light-layout')?.classList.toggle('light-layout--collapsed', next);
    });
  }

  beforeUnmount() {
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) {
      overlay.classList.remove('active');
    }
  }
}
