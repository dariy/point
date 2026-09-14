/**
 * PromptDialog — specialized Modal for inputs.
 */

import { Component } from '../Component.js';
import { Modal } from './Modal.js';
import { html } from '../../utils/helpers.js';

/**
 * @typedef {object} PromptDialogProps
 * @property {import('../../utils/helpers.js').Slot} [title]
 * @property {string} [message]  Body text; each line becomes a paragraph.
 * @property {string} [defaultValue]  Initial value of the input.
 * @property {string} [inputType]  'text' (the default) or 'password'.
 * @property {'primary'|'danger'} [variant]  Confirm button style.
 * @property {string} [confirmText]  Primary button label.
 * @property {(value: string) => void} [onConfirm]  Called with the value.
 * @property {() => void} [onCancel]
 */

/** @extends {Component<PromptDialogProps>} */
export class PromptDialog extends Component {
  render() {
    return html`
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
    return html`
      <button class="btn btn-secondary" id="prompt-cancel-btn">Cancel</button>
      <button class="btn ${okClass}" id="prompt-ok-btn">${confirmText}</button>
    `;
  }
}
