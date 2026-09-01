// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.11.
/**
 * ConfirmDialog — specialized Modal for confirmations.
 *
 * Props:
 *   title        {string}    Heading
 *   message      {string}    Body text; markup only when it is html`` output
 *                            and allowHtml is set (see afterRender)
 *   confirmText  {string}    Label for primary button
 *   onConfirm    {Function}  Called when confirmed
 *   onCancel     {Function}  Called when cancelled
 *   variant      {string}    'danger' | 'primary'
 *   allowHtml    {boolean}   Render `message` as markup rather than as text
 */

import { Component } from '../Component.js';
import { Modal } from './Modal.js';
import { html, setHTML } from '../../utils/helpers.js';

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
        p.textContent = message;
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
