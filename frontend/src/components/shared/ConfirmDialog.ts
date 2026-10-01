/**
 * ConfirmDialog — specialized Modal for confirmations.
 */

import { Component } from '../Component.ts';
import { Modal } from './Modal.ts';
import { html, setHTML } from '../../utils/helpers.ts';
import type { Slot, RawHtml } from '../../utils/helpers.ts';

export interface ConfirmDialogProps {
  title?: Slot;
  /** Body text; markup only when it is html`` output and allowHtml is set. */
  message?: string | RawHtml;
  /** Primary button label. */
  confirmText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  variant?: 'primary' | 'danger';
  /** Render `message` as markup rather than text. */
  allowHtml?: boolean;
}

export class ConfirmDialog extends Component<ConfirmDialogProps> {
  render() {
    return html`<div id="modal-wrapper"></div>`;
  }
  afterRender() {
    const {
      title,
      message,
      onConfirm,
      onCancel
    } = this.props;
    const modal = this.mountChild(Modal, '#modal-wrapper', {
      title,
      footer: this._getFooterHtml(),
      onClose: onCancel
    });
    const body = modal.getBodyMount();
    if (body) {
      if (this.props.allowHtml) {
        // A message built with html`` lands as markup; a bare string is escaped
        // and shows its own angle brackets. That is the point — the flag can no
        // longer smuggle an unescaped caller-built string into innerHTML.
        setHTML(body, html`${message}`);
      } else {
        const p = document.createElement('p');
        p.textContent = String(message);
        body.appendChild(p);
      }
    }
    modal.$('#confirm-cancel-btn')?.addEventListener('click', () => onCancel?.());
    modal.$('#confirm-ok-btn')?.addEventListener('click', () => onConfirm?.());
  }
  _getFooterHtml() {
    const {
      confirmText = 'Confirm',
      variant = 'primary'
    } = this.props;
    return html`
      <button class="btn btn-secondary" id="confirm-cancel-btn">Cancel</button>
      <button class="btn btn-${variant}" id="confirm-ok-btn">${confirmText}</button>
    `;
  }
}
