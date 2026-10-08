import { html, setHTML, raw } from "../../utils/helpers.ts";
import { Component } from '../Component.ts';
import { CodeJar } from '../../../vendor/codejar/codejar.js';
import { MAXIMIZE_SVG, MINIMIZE_SVG, CHECK_SVG } from '../../utils/icons.ts';
import { acquireScrollLock, releaseScrollLock } from '../../utils/scrollLock.ts';
// prismManual must be imported before prism-core — see that file.
import '../../utils/prismManual.ts';
import Prism from '../../../vendor/prismjs/prism-core.js';
// The language files below are vendored global scripts reading a bare `Prism`,
// so the module's export has to be on the global before they are imported.
window.Prism = Prism;

// The vendored typings list only the built-in languages; markdown and
// point-md are added at runtime by the imports and the block below.
const languages = Prism.languages as typeof Prism.languages & Record<string, Parameters<typeof Prism.highlight>[1] | undefined>;
import '../../../vendor/prismjs/prism-markup.js';
import '../../../vendor/prismjs/prism-markdown.js';

// Extend markdown with point-specific tokens for image paths and fenced divs
if (languages.markdown) {
  languages['point-md'] = Prism.languages.extend('markdown', {});
  Prism.languages.insertBefore('point-md', 'hr', {
    'image-path': {
      pattern: /^\/\d{4}\/\d{2}\/.+$/m,
      alias: 'url'
    },
    'fenced-div': {
      pattern: /^:::(?:\{[^}\r\n]*\})?[ \t]*$/m,
      alias: 'keyword'
    }
  });
}
export interface MarkdownEditorProps {
  value?: string;
  placeholder?: string;
  onChange?: (code: string) => void;
  isMaximized?: boolean;
  /** Element id of the editor; generated when absent. */
  id?: string;
}

export class MarkdownEditor extends Component<MarkdownEditorProps> {
  value: string;
  placeholder: string;
  onChange: (code: string) => void;
  jar: ReturnType<typeof CodeJar> | null;
  isMaximized: boolean;
  id: string;

  constructor(container: HTMLElement, props: MarkdownEditorProps = {}) {
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
    return html`
      <div class="markdown-editor-container" style="position: relative; border: var(--border-width, 1px) solid var(--border-primary, #ccc); border-radius: var(--border-radius, 4px); background: var(--surface-input, #fff); overflow: hidden; min-height: var(--editor-content-min-height, 400px); display: flex; flex-direction: column;">
        <button type="button" class="textarea-maximize-btn ${isMaximizedClass}" title="${this.isMaximized ? 'Minimize' : 'Maximize'}">
          ${raw(this.isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG)}
        </button>
        <button type="button" class="textarea-save-btn ${isMaximizedClass}" title="Save">
          ${raw(CHECK_SVG)}
        </button>
        <div id="${this.id}" class="codejar-editor language-point-md ${isMaximizedClass}"
             style="flex: 1; min-height: var(--editor-content-min-height, 400px); padding: 1rem; font-family: var(--font-mono, monospace); font-size: var(--font-size-sm, 14px); line-height: 1.6; color: var(--text-primary, #000); outline: none; white-space: pre-wrap; word-wrap: break-word;"
             data-placeholder="${this.placeholder}"></div>
      </div>
    `;
  }
  afterRender() {
    const editorElement = this.container.querySelector<HTMLElement>(`#${this.id}`);
    const maximizeBtn = this.container.querySelector<HTMLButtonElement>('.textarea-maximize-btn');
    const saveBtn = this.container.querySelector<HTMLButtonElement>('.textarea-save-btn');
    if (!editorElement) return;
    if (this.isMaximized) {
      acquireScrollLock(this);
    }
    const lang = languages['point-md'] || languages.markdown;
    const langKey = languages['point-md'] ? 'point-md' : 'markdown';
    const highlight = (editor: HTMLElement) => {
      if (lang) {
        // Prism emits markup by design; it is the sanctioned raw() the
        // convention names alongside the SVG constants, and its input here is
        // the editor's own textContent.
        // eslint-disable-next-line point/restricted-syntax
        setHTML(editor, html`${raw(Prism.highlight(editor.textContent ?? '', lang, langKey))}`);
      }
    };
    this.jar = CodeJar(editorElement, highlight, {
      tab: '  '
    });
    this.jar.updateCode(this.value || '');
    this.jar.onUpdate((code: string) => {
      this.value = code;
      this.onChange(code);
    });
    if (maximizeBtn) {
      maximizeBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleMaximize(editorElement, maximizeBtn, saveBtn);
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        this.container.dispatchEvent(new CustomEvent('textarea:save', {
          bubbles: true
        }));
      });
    }
    editorElement.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isMaximized && maximizeBtn) {
        this._toggleMaximize(editorElement, maximizeBtn, saveBtn);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.container.dispatchEvent(new CustomEvent('textarea:save', {
          bubbles: true
        }));
      }
    });
  }
  _toggleMaximize(editorElement: HTMLElement, btn: HTMLButtonElement, saveBtn: HTMLButtonElement | null) {
    this.isMaximized = !this.isMaximized;
    editorElement.classList.toggle('is-maximized', this.isMaximized);
    btn.classList.toggle('is-maximized', this.isMaximized);
    if (saveBtn) saveBtn.classList.toggle('is-maximized', this.isMaximized);
    setHTML(btn, html`${raw(this.isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG)}`);
    btn.title = this.isMaximized ? 'Minimize' : 'Maximize';
    if (this.isMaximized) acquireScrollLock(this);
    else releaseScrollLock(this);
    this.container.dispatchEvent(new CustomEvent('textarea:maximize', {
      bubbles: true,
      detail: {
        isMaximized: this.isMaximized
      }
    }));
  }
  beforeUnmount() {
    releaseScrollLock(this);
    if (this.jar) {
      this.jar.destroy();
      this.jar = null;
    }
  }
  getValue() {
    return this.value;
  }
  insertAtEnd(text: string) {
    if (!this.jar) return;
    const current = this.jar.toString();
    this.jar.updateCode(current.trimEnd() + '\n' + text);
  }
}