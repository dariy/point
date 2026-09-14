/**
 * ConfirmDialog — specialized Modal for confirmations.
 */

import { Component } from '../Component.js';
import { Modal } from './Modal.js';
import { html, setHTML } from '../../utils/helpers.js';

/**
 * @typedef {object} ConfirmDialogProps
 * @property {import('../../utils/helpers.js').Slot} [title]
 * @property {string|import('../../utils/helpers.js').RawHtml} [message]  Body
 *   text; markup only when it is html`` output and allowHtml is set.
 * @property {string} [confirmText]  Primary button label.
 * @property {() => void} [onConfirm]
 * @property {() => void} [onCancel]
 * @property {'primary'|'danger'} [variant]
 * @property {boolean} [allowHtml]  Render `message` as markup rather than text.
 */

/** @extends {Component<ConfirmDialogProps>} */
export class ConfirmDialog extends Component {
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
