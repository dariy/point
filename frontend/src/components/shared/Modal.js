/**
 * Modal — generic overlay dialog.
 *
 * Props:
 *   title        {string}    Modal header title
 *   onClose      {Function}  Called when close button or backdrop is clicked
 *   footer       {string}    Optional HTML for footer buttons
 *   maxWidth     {string}    Optional max-width (e.g. '500px')
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

export class Modal extends Component {
  render() {
    const { title = '', footer = '', maxWidth = '500px' } = this.props;

    return `
      <div class="modal-overlay active" id="modal-backdrop">
        <div class="modal" style="max-width: ${escapeHtml(maxWidth)}">
          <header class="modal-header">
            <h3>${escapeHtml(title)}</h3>
            <button class="modal-close" id="modal-close-btn" aria-label="Close">×</button>
          </header>
          <div class="modal-body" id="modal-body-mount"></div>
          ${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
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
