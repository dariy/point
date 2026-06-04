/**
 * ConfirmDialog — specialized Modal for confirmations.
 *
 * Props:
 *   title        {string}    Heading
 *   message      {string}    Body text
 *   confirmText  {string}    Label for primary button
 *   onConfirm    {Function}  Called when confirmed
 *   onCancel     {Function}  Called when cancelled
 *   variant      {string}    'danger' | 'primary'
 */

import { Component } from '../Component.js';
import { Modal } from './Modal.js';
import { escapeHtml } from '../../utils/helpers.js';

export class ConfirmDialog extends Component {
  render() {
    return `<div id="modal-wrapper"></div>`;
  }

  afterRender() {
    const { title, message, onConfirm, onCancel } = this.props;

    const modal = this.mountChild(Modal, '#modal-wrapper', {
      title,
      footer: this._getFooterHtml(),
      onClose: onCancel,
    });

    const body = modal.getBodyMount();
    if (body) {
      if (this.props.allowHtml) {
        // Caution: using innerHTML can lead to XSS if message is not sanitized.
        // Ensure all dynamic parts of the message are escaped by the caller.
        body.innerHTML = message;
      } else {
        const p = document.createElement('p');
        p.textContent = message;
        body.appendChild(p);
      }
    }

    modal.$('#confirm-cancel-btn')?.addEventListener('click', () => onCancel?.());
    modal.$('#confirm-ok-btn')?.addEventListener('click', () => onConfirm?.());
  }

  _getFooterHtml() {
    const { confirmText = 'Confirm', variant = 'primary' } = this.props;
    return `
      <button class="btn btn-secondary" id="confirm-cancel-btn">Cancel</button>
      <button class="btn btn-${variant}" id="confirm-ok-btn">${escapeHtml(confirmText)}</button>
    `;
  }
}
