/**
 * Modal — generic overlay dialog.
 */

import { Component } from '../Component.ts';
import { html } from '../../utils/helpers.ts';
import type { Slot } from '../../utils/helpers.ts';

export interface ModalProps {
  /** Header title. */
  title?: Slot;
  /**
   * Called when the close button, the backdrop or Escape dismisses the
   * modal.
   */
  onClose?: () => void;
  /** Footer buttons, built with html``. */
  footer?: Slot;
  /** e.g. '500px' (the default). */
  maxWidth?: string;
}

export class Modal extends Component<ModalProps> {
  _onKeyDown: (e: KeyboardEvent) => void;

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

    const handleClose = (e: Event) => {
      if (e.target === closeBtn || e.target === backdrop) {
        this.props.onClose?.();
      }
    };

    closeBtn?.addEventListener('click', handleClose);
    backdrop?.addEventListener('click', handleClose);

    // Escape key to close
    this._onKeyDown = (e: KeyboardEvent) => {
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
