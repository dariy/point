import { Component } from '../Component.js';
import { CodeJar } from '../../../vendor/codejar/codejar.js';
import { MAXIMIZE_SVG, MINIMIZE_SVG, CHECK_SVG } from '../../utils/icons.js';

import Prism from '../../../vendor/prismjs/prism-core.js';
window.Prism = Prism;
import '../../../vendor/prismjs/prism-markup.js';
import '../../../vendor/prismjs/prism-markdown.js';

// Extend markdown with point-specific tokens for image paths and fenced divs
if (Prism.languages.markdown) {
  Prism.languages['point-md'] = Prism.languages.extend('markdown', {});
  Prism.languages.insertBefore('point-md', 'hr', {
    'image-path': {
      pattern: /^\/\d{4}\/\d{2}\/.+$/m,
      alias: 'url',
    },
    'fenced-div': {
      pattern: /^:::(?:\{[^}\r\n]*\})?[ \t]*$/m,
      alias: 'keyword',
    },
  });
}

export class MarkdownEditor extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.value = props.value || '';
    this.placeholder = props.placeholder || 'Write your post content here…';
    this.onChange = props.onChange || (() => {});
    this.jar = null;
    this.isMaximized = props.isMaximized || false;
    this.id = props.id || `md-editor-${Math.random().toString(36).substring(2, 9)}`;
  }

  render() {
    const isMaximizedClass = this.isMaximized ? 'is-maximized' : '';
    return `
      <div class="markdown-editor-container" style="position: relative; border: var(--border-width, 1px) solid var(--border-primary, #ccc); border-radius: var(--border-radius, 4px); background: var(--surface-input, #fff); overflow: hidden; min-height: var(--editor-content-min-height, 400px); display: flex; flex-direction: column;">
        <button type="button" class="textarea-maximize-btn ${isMaximizedClass}" title="${this.isMaximized ? 'Minimize' : 'Maximize'}">
          ${this.isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG}
        </button>
        <button type="button" class="textarea-save-btn ${isMaximizedClass}" title="Save">
          ${CHECK_SVG}
        </button>
        <div id="${this.id}" class="codejar-editor language-point-md ${isMaximizedClass}"
             style="flex: 1; min-height: var(--editor-content-min-height, 400px); padding: 1rem; font-family: var(--font-mono, monospace); font-size: var(--font-size-sm, 14px); line-height: 1.6; color: var(--text-primary, #000); outline: none; white-space: pre-wrap; word-wrap: break-word;"
             data-placeholder="${this.placeholder}"></div>
      </div>
    `;
  }

  afterRender() {
    const editorElement = this.container.querySelector(`#${this.id}`);
    const maximizeBtn = this.container.querySelector('.textarea-maximize-btn');
    const saveBtn = this.container.querySelector('.textarea-save-btn');

    if (!editorElement) return;

    if (this.isMaximized) {
      document.body.classList.add('textarea-maximized-body-lock');
    }

    const lang = Prism.languages['point-md'] || Prism.languages.markdown;
    const langKey = Prism.languages['point-md'] ? 'point-md' : 'markdown';

    const highlight = (editor) => {
      if (lang) {
        editor.innerHTML = Prism.highlight(editor.textContent, lang, langKey);
      }
    };

    this.jar = CodeJar(editorElement, highlight, { tab: '  ' });
    this.jar.updateCode(this.value || '');

    this.jar.onUpdate((code) => {
      this.value = code;
      this.onChange(code);
    });

    if (maximizeBtn) {
      maximizeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleMaximize(editorElement, maximizeBtn, saveBtn);
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.container.dispatchEvent(new CustomEvent('textarea:save', { bubbles: true }));
      });
    }

    editorElement.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isMaximized) {
        this._toggleMaximize(editorElement, maximizeBtn, saveBtn);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.container.dispatchEvent(new CustomEvent('textarea:save', { bubbles: true }));
      }
    });
  }

  _toggleMaximize(editorElement, btn, saveBtn) {
    this.isMaximized = !this.isMaximized;
    editorElement.classList.toggle('is-maximized', this.isMaximized);
    btn.classList.toggle('is-maximized', this.isMaximized);
    if (saveBtn) saveBtn.classList.toggle('is-maximized', this.isMaximized);
    btn.innerHTML = this.isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG;
    btn.title = this.isMaximized ? 'Minimize' : 'Maximize';
    document.body.classList.toggle('textarea-maximized-body-lock', this.isMaximized);

    this.container.dispatchEvent(new CustomEvent('textarea:maximize', {
      bubbles: true,
      detail: { isMaximized: this.isMaximized }
    }));
  }

  beforeUnmount() {
    if (this.isMaximized) {
      document.body.classList.remove('textarea-maximized-body-lock');
    }
    if (this.jar) {
      this.jar.destroy();
      this.jar = null;
    }
  }

  getValue() {
    return this.value;
  }

  insertAtEnd(text) {
    if (!this.jar) return;
    const current = this.jar.toString();
    this.jar.updateCode(current.trimEnd() + '\n' + text);
  }
}
