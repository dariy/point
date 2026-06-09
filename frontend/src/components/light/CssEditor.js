import { Component } from '../Component.js';
import { CodeJar } from '../../../vendor/codejar/codejar.js';
import { MAXIMIZE_SVG, MINIMIZE_SVG } from '../../utils/icons.js';

// Import Prism core and ensure it is global before importing language components
import Prism from '../../../vendor/prismjs/prism-core.js';
window.Prism = Prism;
import '../../../vendor/prismjs/prism-css.js';

/**
 * CssEditor component.
 * Wraps CodeJar and PrismJS to provide a code editor with CSS syntax highlighting.
 */
export class CssEditor extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.value = props.value || '';
    this.placeholder = props.placeholder || '/* Add your CSS here */';
    this.onChange = props.onChange || (() => {});
    this.jar = null;
    this.isMaximized = false;
    // We'll generate a unique ID so we can use standard textarea label associations
    this.id = props.id || `css-editor-${Math.random().toString(36).substring(2, 9)}`;
  }

  render() {
    // We add some basic styles to ensure visibility even if CSS tokens are missing
    return `
      <div class="css-editor-container" style="position: relative; border: var(--border-width, 1px) solid var(--border-primary, #ccc); border-radius: var(--border-radius, 4px); background: var(--surface-input, #fff); overflow: hidden; min-height: 200px; display: flex; flex-direction: column;">
        <button type="button" class="textarea-maximize-btn" title="Maximize">
          ${MAXIMIZE_SVG}
        </button>
        <div id="${this.id}" class="codejar-editor language-css" 
             style="flex: 1; min-height: 200px; padding: 1rem; font-family: var(--font-mono, monospace); font-size: var(--font-size-sm, 14px); line-height: 1.5; color: var(--text-primary, #000); outline: none; white-space: pre-wrap; word-wrap: break-word;"
             data-placeholder="${this.placeholder}"></div>
      </div>
    `;
  }

  afterRender() {
    const editorElement = this.container.querySelector(`#${this.id}`);
    const maximizeBtn = this.container.querySelector('.textarea-maximize-btn');
    
    if (!editorElement) return;
    
    // Highlight function using Prism
    const highlight = (editor) => {
      if (window.Prism && window.Prism.languages.css) {
        const code = editor.textContent;
        editor.innerHTML = window.Prism.highlight(code, window.Prism.languages.css, 'css');
      }
    };

    this.jar = CodeJar(editorElement, highlight, {
      tab: '  ',
      indentOn: /{[ \t]*$/
    });
    
    // Set initial value
    this.jar.updateCode(this.value || '');
    
    // Listen for changes
    this.jar.onUpdate((code) => {
      this.value = code;
      this.onChange(code);
    });

    // Maximize functionality
    if (maximizeBtn) {
      maximizeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleMaximize(editorElement, maximizeBtn);
      });
    }

    // Handle Escape key to minimize
    editorElement.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isMaximized) {
        this._toggleMaximize(editorElement, maximizeBtn);
      }
    });
  }

  _toggleMaximize(editorElement, btn) {
    this.isMaximized = !this.isMaximized;
    editorElement.classList.toggle('is-maximized', this.isMaximized);
    btn.classList.toggle('is-maximized', this.isMaximized);
    btn.innerHTML = this.isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG;
    btn.title = this.isMaximized ? 'Minimize' : 'Maximize';

    if (this.isMaximized) {
      document.body.classList.add('textarea-maximized-body-lock');
    } else {
      document.body.classList.remove('textarea-maximized-body-lock');
    }
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
}
