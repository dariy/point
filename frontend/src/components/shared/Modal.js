/**
 * Modal — generic overlay dialog.
 */

import { Component } from '../Component.js';
import { html } from '../../utils/helpers.js';

/**
 * @typedef {object} ModalProps
 * @property {import('../../utils/helpers.js').Slot} [title]  Header title.
 * @property {() => void} [onClose]  Called when the close button, the backdrop
 *   or Escape dismisses the modal.
 * @property {import('../../utils/helpers.js').Slot} [footer]  Footer buttons,
 *   built with html``.
 * @property {string} [maxWidth]  e.g. '500px' (the default).
 */

/** @extends {Component<ModalProps>} */
export class Modal extends Component {
  render() {
    const { title = '', footer = '', maxWidth = '500px' } = this.props;

    return html`
      <div class="modal-overlay active" id="modal-backdrop">
        <div class="modal" style="max-width: ${maxWidth}">
          <header class="modal-header">
            <h3>${title}</h3>
            <button class="modal-close" id="modal-close-btn" aria-label="Close">×</button>
          </header>
          <div class="modal-body" id="modal-body-mount"></div>
          ${footer ? html`<footer class="modal-footer">${footer}</footer>` : ''}
        </div>
      </div>`;
  }

  afterRender() {
    const closeBtn = this.$('#modal-close-btn');
    const backdrop = this.$('#modal-backdrop');

    const handleClose = (e) => {
      if (e.target === closeBtn || e.target === backdrop) {
        this.props.onClose?.();
      }
    };

    closeBtn?.addEventListener('click', handleClose);
    backdrop?.addEventListener('click', handleClose);

    // Escape key to close
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this.props.onClose?.();
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  beforeUnmount() {
    window.removeEventListener('keydown', this._onKeyDown);
  }

  /**
   * Helper: returns the mount point for modal content.
   */
  getBodyMount() {
    return this.$('#modal-body-mount');
  }
}
