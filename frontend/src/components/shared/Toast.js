/**
 * Toast notification container.
 *
 * Subscribes to store key 'toast' and displays transient notifications.
 * Mount once at application startup inside #toasts.
 *
 * store.set('toast', { message: 'Saved!', type: 'success' });
 * store.set('toast', { message: 'Error', type: 'error' });
 * store.set('toast', { message: 'Info', type: 'info' });
 *
 * Types: 'success' | 'error' | 'info' | 'warning'
 */

import { Component } from '../Component.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';

const DURATION_MS = 4000;
const MAX_TOASTS = 5;

export class ToastContainer extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._toasts = [];
    this._nextId = 1;
  }

  render() {
    return ''; // Container starts empty; toasts are appended dynamically.
  }

  afterRender() {
    this.subscribeStore(store, 'toast', (payload) => {
      if (payload) this._add(payload);
    });
  }

  _add({ message, type = 'info' }) {
    const id = this._nextId++;

    // Limit visible toasts.
    if (this._toasts.length >= MAX_TOASTS) {
      const oldest = this._toasts[0];
      this._remove(oldest.id);
    }

    const el = document.createElement('div');
    el.className = `toast toast-${escapeHtml(type)}`;
    el.setAttribute('role', 'alert');
    el.setAttribute('data-id', String(id));

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;

    const btn = document.createElement('button');
    btn.className = 'toast-close';
    btn.setAttribute('aria-label', 'Dismiss');
    btn.textContent = '×';
    btn.addEventListener('click', () => this._remove(id));

    el.append(msg, btn);
    this.container.appendChild(el);

    const entry = { id, el, timer: null };
    entry.timer = setTimeout(() => this._remove(id), DURATION_MS);
    this._toasts.push(entry);

    // Trigger CSS enter animation next frame.
    requestAnimationFrame(() => el.classList.add('toast-visible'));
  }

  _remove(id) {
    const idx = this._toasts.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [entry] = this._toasts.splice(idx, 1);
    clearTimeout(entry.timer);
    entry.el.classList.remove('toast-visible');
    entry.el.addEventListener('transitionend', () => entry.el.remove(), { once: true });
    // Fallback remove if transition doesn't fire.
    setTimeout(() => entry.el.remove(), 400);
  }
}
