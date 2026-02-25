/**
 * MediaPickerDialog — body-mounted media picker dialog for the post editor.
 *
 * Wraps MediaBrowser in picker mode inside a modal overlay.
 * Appended to document.body once and reused across open/close cycles.
 *
 * Usage:
 *   const picker = new MediaPickerDialog({ onConfirm: (items) => { ... } });
 *   picker.open();
 *   // later:
 *   picker.destroy();
 */

import { Component } from '../Component.js';
import { MediaBrowser } from './MediaBrowser.js';
import { store } from '../../store.js';

export class MediaPickerDialog extends Component {
  constructor({ onConfirm }) {
    const container = document.createElement('div');
    container.className = 'modal-overlay media-picker-overlay';
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-label', 'Insert Media');
    document.body.appendChild(container);

    super(container, { onConfirm });
    this._activeBrowser = null;
    this._keyHandler = null;
  }

  render() {
    return `
      <div class="modal media-picker-modal">
        <header class="modal-header">
          <h3>Insert Media</h3>
          <button class="modal-close" id="mpd-close-btn" aria-label="Close">\xd7</button>
        </header>
        <div class="modal-body media-picker-body" id="mpd-browser-mount"></div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" id="mpd-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="mpd-add-btn">Add selected</button>
        </footer>
      </div>`;
  }

  afterRender() {
    this.$('#mpd-close-btn')?.addEventListener('click', () => this.close());
    this.$('#mpd-cancel-btn')?.addEventListener('click', () => this.close());
    this.$('#mpd-add-btn')?.addEventListener('click', () => this._handleAdd());

    // Close on backdrop click
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
  }

  open() {
    if (this._activeBrowser) return; // already open
    this.container.classList.add('active');
    document.body.style.overflow = 'hidden';

    const mountEl = this.$('#mpd-browser-mount');
    if (mountEl) {
      const browser = this.mountChild(MediaBrowser, mountEl, { pickerMode: true });
      this._activeBrowser = browser;
    }

    this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._keyHandler);
  }

  close() {
    this.container.classList.remove('active');
    document.body.style.overflow = '';

    // Unmount the browser child without re-rendering the whole dialog
    if (this._activeBrowser) {
      this._activeBrowser.unmount();
      const idx = this._children.indexOf(this._activeBrowser);
      if (idx !== -1) this._children.splice(idx, 1);
      this._activeBrowser = null;
    }

    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  }

  destroy() {
    this.close();
    this.unmount();
    this.container.remove();
  }

  _handleAdd() {
    if (!this._activeBrowser) return;
    const items = this._activeBrowser.getSelectedItems();
    if (items.length === 0) {
      store.set('toast', { message: 'Select at least one item.', type: 'warning' });
      return;
    }
    this.props.onConfirm(items);
    this.close();
  }
}
