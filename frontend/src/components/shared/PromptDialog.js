/**
 * PromptDialog — specialized Modal for inputs.
 *
 * Props:
 *   title        {string}    Heading
 *   message      {string}    Body text
 *   defaultValue {string}    Initial value for input
 *   confirmText  {string}    Label for primary button
 *   onConfirm    {Function}  Called when confirmed with value
 *   onCancel     {Function}  Called when cancelled
 */

import { Component } from '../Component.js';
import { Modal } from './Modal.js';
import { escapeHtml } from '../../utils/helpers.js';

export class PromptDialog extends Component {
  render() {
    return `
      <div id="modal-wrapper"></div>
    `;
  }

  afterRender() {
    const { title, message, defaultValue = '', onCancel } = this.props;

    const modal = this.mountChild(Modal, '#modal-wrapper', {
      title,
      footer: this._getFooterHtml(),
      onClose: onCancel,
    });

    const body = modal.getBodyMount();
    if (body) {
      if (message) {
        const p = document.createElement('p');
        p.style.marginBottom = '1rem';
        p.textContent = message;
        body.appendChild(p);
      }

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-input';
      input.value = defaultValue;
      input.id = 'prompt-input';
      input.style.width = '100%';
      body.appendChild(input);

      // Focus input shortly after render
      setTimeout(() => input.focus(), 50);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._handleConfirm(modal);
        }
      });
    }

    modal.$('#prompt-cancel-btn')?.addEventListener('click', () => onCancel?.());
    modal.$('#prompt-ok-btn')?.addEventListener('click', () => this._handleConfirm(modal));
  }

  _handleConfirm(modal) {
    const { onConfirm } = this.props;
    const input = modal.$('#prompt-input');
    if (onConfirm && input) {
      onConfirm(input.value);
    }
  }

  _getFooterHtml() {
    const { confirmText = 'Confirm' } = this.props;
    return `
      <button class="btn btn-secondary" id="prompt-cancel-btn">Cancel</button>
      <button class="btn btn-primary" id="prompt-ok-btn">${escapeHtml(confirmText)}</button>
    `;
  }
}
