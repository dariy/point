/**
 * PromptDialog — specialized Modal for inputs.
 */

import { Component } from '../Component.ts';
import { Modal } from './Modal.ts';
import { html } from '../../utils/helpers.ts';
import type { Slot } from '../../utils/helpers.ts';

export interface PromptDialogProps {
  title?: Slot;
  /** Body text; each line becomes a paragraph. */
  message?: string;
  /** Initial value of the input. */
  defaultValue?: string;
  /** 'text' (the default) or 'password'. */
  inputType?: string;
  /** Confirm button style. */
  variant?: 'primary' | 'danger';
  /** Primary button label. */
  confirmText?: string;
  /** Called with the value. */
  onConfirm?: (value: string) => void;
  onCancel?: () => void;
}

export class PromptDialog extends Component<PromptDialogProps> {
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

  _handleConfirm(modal: Modal) {
    const { onConfirm } = this.props;
    const input = modal.$('#prompt-input') as HTMLInputElement | null;
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
