/**
 * Toast notification container.
 *
 * Subscribes to store key 'toast' and displays transient notifications.
 * Mount once at application startup inside #toasts.
 *
 * setToast({ message: 'Saved!', type: 'success' });
 * setToast({ message: 'Error', type: 'error' });
 * setToast({ message: 'Info', type: 'info' });
 *
 * Types: 'success' | 'error' | 'info' | 'warning'
 *
 * An action adds a button before the close button, and a toast with an action
 * stays longer (ACTION_DURATION_MS) so that there is time to click it:
 *
 * setToast({ message: 'Moved to Trash.', type: 'success',
 *            action: { label: 'Undo', onClick: () => restore() } });
 */

import { Component } from '../Component.ts';
import { onToast } from '../../store.ts';
import { html } from '../../utils/helpers.ts';

const DURATION_MS = 4000;
/** How long a toast with an action (for example "Undo") stays. */
export const ACTION_DURATION_MS = 8000;
const MAX_TOASTS = 5;

interface ToastPayload {
  message: string;
  type?: 'success' | 'error' | 'info' | 'warning';
  /** A button in the toast. A click runs onClick and closes the toast. */
  action?: { label: string; onClick: () => void };
}

interface ToastEntry {
  id: number;
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ToastContainer extends Component {
  _toasts: ToastEntry[];
  _nextId: number;

  constructor(container: HTMLElement, props = {}) {
    super(container, props);
    this._toasts = [];
    this._nextId = 1;
  }

  render() {
    return html``; // Container starts empty; toasts are appended dynamically.
  }

  afterRender() {
    this.subscribeStore(onToast, (payload: ToastPayload | null) => {
      if (payload) this._add(payload);
    });
  }

  _add({ message, type = 'info', action }: ToastPayload) {
    const id = this._nextId++;

    // Limit visible toasts.
    if (this._toasts.length >= MAX_TOASTS) {
      const oldest = this._toasts[0];
      this._remove(oldest.id);
    }

    const el = document.createElement('div');
    // A DOM property, not markup: escapeHtml() here only ever risked putting an
    // entity into a class name. `type` is the store's own enum in any case.
    el.className = `toast toast-${type}`;
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

    el.append(msg);
    if (action) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'toast-action';
      act.textContent = action.label;
      act.addEventListener('click', () => {
        this._remove(id);
        action.onClick();
      });
      el.append(act);
    }
    el.append(btn);
    this.container.appendChild(el);

    const entry: ToastEntry = { id, el, timer: null };
    entry.timer = setTimeout(() => this._remove(id), action ? ACTION_DURATION_MS : DURATION_MS);
    this._toasts.push(entry);

    // Trigger CSS enter animation next frame.
    requestAnimationFrame(() => el.classList.add('toast-visible'));
  }

  _remove(id: number) {
    const idx = this._toasts.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [entry] = this._toasts.splice(idx, 1);
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.classList.remove('toast-visible');
    entry.el.addEventListener('transitionend', () => entry.el.remove(), { once: true });
    // Fallback remove if transition doesn't fire.
    setTimeout(() => entry.el.remove(), 400);
  }
}
