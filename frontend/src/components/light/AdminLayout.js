/**
 * AdminLayout — shared layout for all /light pages.
 *
 * Wraps a page component with the admin sidebar and header.
 *
 * Props:
 *   title        {string}    Page title
 *   currentPath  {string}    For sidebar active state
 *   actions      {string}    Optional HTML for header actions
 *   user         {object}    Current user
 *   onLogout     {Function}  Logout handler
 */

import { Component } from '../Component.js';
import { LightSidebar } from './LightSidebar.js';
import { store } from '../../store.js';

export class AdminLayout extends Component {
  render() {
    const { title = 'Admin', actions = '' } = this.props;

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>${title}</h1>
            <div class="header-actions">
              ${actions}
              <button class="theme-toggle" id="admin-theme-toggle" aria-label="Toggle theme" type="button">
                <span class="icon-sun" aria-hidden="true">☀</span>
                <span class="icon-moon" aria-hidden="true">☾</span>
              </button>
            </div>
          </header>
          <main class="light-content" id="layout-content-mount"></main>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: this.props.currentPath,
      user: this.props.user,
      onLogout: this.props.onLogout,
    });

    const btn = this.$('#admin-theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = store.get('theme') || 'auto';
        const next = current === 'dark' ? 'light' : 'dark';
        store.set('theme', next);
      });
    }
  }

  /**
   * Returns the mount point for the actual page content.
   */
  getContentMount() {
    return this.$('#layout-content-mount');
  }
}
