/**
 * PromptDialog — specialized Modal for inputs.
 *
 * Props:
 *   title        {string}    Heading
 *   message      {string}    Body text
 *   defaultValue {string}    Initial value for input
 *   inputType    {string}    Input type, e.g. 'text' (default) or 'password'
 *   variant      {string}    Confirm button style: 'primary' (default) or 'danger'
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
    const { title, message, defaultValue = '', inputType = 'text', onCancel } = this.props;

    const modal = this.mountChild(Modal, '#modal-wrapper', {
      title,
      footer: this._getFooterHtml(),
      onClose: onCancel,
    });

    const body = modal.getBodyMount();
    if (body) {
      if (message) {
        // Render each newline-separated line as its own paragraph so a message can
        // put, e.g., an "Enter your password to confirm." line below a warning.
        message.split('\n').forEach((line) => {
          const text = line.trim();
          if (!text) return;
          const p = document.createElement('p');
          p.className = 'prompt-message';
          p.textContent = text;
          body.appendChild(p);
        });
      }

      const input = document.createElement('input');
      input.type = inputType;
      input.className = 'form-input';
      input.value = defaultValue;
      input.id = 'prompt-input';
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
    const { confirmText = 'Confirm', variant = 'primary' } = this.props;
    const okClass = variant === 'danger' ? 'btn-danger' : 'btn-primary';
    return `
      <button class="btn btn-secondary" id="prompt-cancel-btn">Cancel</button>
      <button class="btn ${okClass}" id="prompt-ok-btn">${escapeHtml(confirmText)}</button>
    `;
  }
}
