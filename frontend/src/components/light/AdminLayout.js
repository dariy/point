/**
 * AdminLayout — shared layout helpers for all /light pages.
 *
 * Provides a template function for render() and a setup function for afterRender().
 */

import { LightSidebar } from './LightSidebar.js';
import { store } from '../../store.js';
import { syncQueue } from '../../utils/sync.js';
import { setupHeaderCompact } from '../../utils/headerCompact.js';
import { navigate } from '../../utils/helpers.js';

/**
 * Shared HTML template for admin pages.
 * To be used inside component.render().
 */
export function adminLayoutTemplate({ title = 'Admin', actions = '', banner = '', content = '' }) {
  const offline = store.get('offline_status') || {};
  const syncPill = renderSyncPill(offline);

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
          </div>
        </header>
        ${banner}
        <main class="light-content">${content}</main>
      </div>
    </div>`;
}

/**
 * Shared behavior for admin pages.
 * To be used inside component.afterRender().
 */
export function setupAdminLayout(component, { currentPath, publicUrl }) {
  component._cleanupHeaderCompact = setupHeaderCompact(component.$('.light-header'));
  
  component.mountChild(LightSidebar, '#sidebar-mount', {
    currentPath,
    publicUrl,
    user: store.get('user') || {},
    onLogout: async () => {
      try {
        const { logout } = await import('../../api/auth.js');
        await logout();
      } catch { /* ignore */ }
      store.set('user', null);
      navigate('/', { replace: true });
    },
  });

  component.$('#sync-pill-btn')?.addEventListener('click', () => onSyncPillClick());

  const unsub = store.subscribe('offline_status', () => updateSyncPill(component));
  return () => {
    unsub();
    component._cleanupHeaderCompact?.();
  };
}

function renderSyncPill(offline) {
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

  return `<button class="${cls}" id="sync-pill-btn" type="button">${text}</button>`;
}

function onSyncPillClick() {
  const offline = store.get('offline_status') || {};
  if (offline.failed) {
    navigate('/light/system');
  } else if (!offline.syncing && offline.pending) {
    syncQueue();
  }
}

function updateSyncPill(component) {
  const offline = store.get('offline_status') || {};
  const newPill = renderSyncPill(offline);
  const titleRow = component.$('.header-title-row');
  if (!titleRow) return;

  const existing = component.$('.sync-pill');
  if (existing) existing.remove();

  if (newPill) {
    titleRow.insertAdjacentHTML('beforeend', newPill);
    component.$('#sync-pill-btn')?.addEventListener('click', () => onSyncPillClick());
  }
}
