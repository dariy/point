/**
 * NotificationLogButton — floating action button for the notification log.
 *
 * Body-mounted persistent component (same pattern as MediaPickerDialog).
 * Visible in the bottom-right corner only on admin (/light/*) routes when
 * there is at least one notification from the last 10 minutes.
 * Clicking opens a modal listing those notifications.
 *
 * Usage (once at app startup):
 *   const btn = new NotificationLogButton();
 *   btn.mount();
 */

import { Component } from '../Component.js';
import { store }     from '../../store.js';
import { Modal }     from './Modal.js';
import { escapeHtml } from '../../utils/helpers.js';
import { getRecentEntries } from '../../utils/notificationLog.js';

const TYPE_LABELS = { success: '✓', error: '✕', warning: '!', info: 'i' };

export class NotificationLogButton extends Component {
  constructor() {
    const container = document.createElement('div');
    container.className = 'notification-log-fab';
    document.body.appendChild(container);

    super(container, {});
    this._isOpen        = false;
    this._activeModal   = null;
    this._modalEl       = null;
    this._pruneTimer    = null;
  }

  render() {
    // Bell icon (inline SVG — no external dependency).
    return `
      <button class="notification-log-btn" aria-label="View notification history">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      </button>`;
  }

  afterRender() {
    this.$('.notification-log-btn')?.addEventListener('click', () => this._openModal());

    this.subscribeStore(store, 'toast_log', (entries) => {
      this._updateVisibility(entries, store.get('route'));
      this._schedulePruneTimer(entries);
      if (this._isOpen) this._refreshModalContent();
    });

    this.subscribeStore(store, 'route', (route) => {
      this._updateVisibility(store.get('toast_log'), route);
    });

    // Apply initial state (store may already have values at mount time).
    this._updateVisibility(store.get('toast_log'), store.get('route'));
    this._schedulePruneTimer(store.get('toast_log'));
  }

  beforeUnmount() {
    if (this._pruneTimer) clearTimeout(this._pruneTimer);
    this._closeModal();
  }

  // ── Visibility ────────────────────────────────────────────────────────────

  _updateVisibility(entries, route) {
    const isAdmin   = route?.pathname?.startsWith('/light');
    const hasRecent = Array.isArray(entries) && entries.length > 0;

    if (isAdmin && hasRecent) {
      this.container.classList.add('active');
    } else {
      this.container.classList.remove('active');
      if (this._isOpen) this._closeModal();
    }
  }

  /**
   * Schedule a one-shot timeout so the button hides the moment the oldest
   * entry ages out of the 10-minute window — no polling required.
   */
  _schedulePruneTimer(entries) {
    if (this._pruneTimer) clearTimeout(this._pruneTimer);
    if (!entries || entries.length === 0) return;

    const expiresIn = entries[0].timestamp + 10 * 60 * 1000 - Date.now();
    if (expiresIn <= 0) return;

    this._pruneTimer = setTimeout(() => {
      store.set('toast_log', getRecentEntries());
    }, expiresIn + 100); // small buffer to ensure _prune runs after expiry
  }

  // ── Modal ─────────────────────────────────────────────────────────────────

  _openModal() {
    if (this._isOpen) return;
    this._isOpen = true;

    this._modalEl = document.createElement('div');
    document.body.appendChild(this._modalEl);

    this._activeModal = new Modal(this._modalEl, {
      title:    'Notification History',
      maxWidth: '540px',
      onClose:  () => this._closeModal(),
    });
    this._activeModal.mount();

    this._refreshModalContent();
  }

  _closeModal() {
    if (!this._isOpen) return;
    this._isOpen = false;

    if (this._activeModal) {
      this._activeModal.unmount();
      this._activeModal = null;
    }
    if (this._modalEl) {
      this._modalEl.remove();
      this._modalEl = null;
    }
  }

  _refreshModalContent() {
    if (!this._activeModal) return;
    const bodyMount = this._activeModal.getBodyMount();
    if (!bodyMount) return;

    const entries = store.get('toast_log') ?? [];
    bodyMount.innerHTML = entries.length === 0
      ? `<p class="notification-log-empty">No recent notifications.</p>`
      : `<ul class="notification-log-list">${[...entries].reverse().map((e) => {
          const safeType = TYPE_LABELS[e.type] ? e.type : 'info';
          return `<li class="notification-log-item notification-log-item-${safeType}">
            <span class="notification-log-icon" aria-hidden="true">${TYPE_LABELS[safeType]}</span>
            <span class="notification-log-message">${escapeHtml(e.message)}</span>
          </li>`;
        }).join('')}</ul>`;
  }
}
