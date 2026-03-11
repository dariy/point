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
import { syncQueue } from '../../utils/sync.js';

export class AdminLayout extends Component {
  render() {
    const { title = 'Admin', actions = '' } = this.props;

    const offline = store.get('offline_status') || {};
    const syncPill = this._renderSyncPill(offline);

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <div class="header-title-row">
              <h1>${title}</h1>
              ${syncPill}
            </div>
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

  _renderSyncPill(offline) {
    if (!offline.has_ops && !offline.syncing) return '';

    let text = '';
    let cls = 'sync-pill';

    if (offline.syncing) {
      text = '⟳ Syncing…';
      cls += ' syncing';
    } else if (offline.failed) {
      text = `⚠ ${offline.failed} failed`;
      cls += ' failed';
    } else if (offline.pending) {
      text = `● ${offline.pending} pending`;
      cls += ' pending';
    } else {
      text = '✓ Synced';
      cls += ' synced';
    }

    return `<button class="${cls}" id="sync-pill-btn">${text}</button>`;
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

    this.$('#sync-pill-btn')?.addEventListener('click', () => {
      const offline = store.get('offline_status') || {};
      if (offline.failed) {
        import('../../utils/helpers.js').then(m => m.navigate('/light/system'));
      } else if (!offline.syncing && offline.pending) {
        syncQueue();
      }
    });
  }

  /**
   * Returns the mount point for the actual page content.
   */
  getContentMount() {
    return this.$('#layout-content-mount');
  }
}
