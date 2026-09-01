import { raw } from "../utils/helpers.js";
import { html, setHTML } from "../utils/helpers.js";
import { MAXIMIZE_SVG, MINIMIZE_SVG, CHECK_SVG } from './icons.js';
import { acquireScrollLock, releaseScrollLock } from './scrollLock.js';

/**
 * Setup "Maximize" buttons for all raw textareas in the given container.
 * 
 * Each textarea will get a button that toggles 'is-maximized' class on it.
 * 
 * @param {HTMLElement} container
 */
export function setupTextareaMaximizer(container) {
  if (!container) return;
  const textareas = container.querySelectorAll('textarea');
  textareas.forEach(textarea => {
    // Avoid double initialization
    if (textarea.dataset.maximizerSetup) return;
    textarea.dataset.maximizerSetup = 'true';

    // Create the buttons
    const isInitialMaximized = textarea.classList.contains('is-maximized');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'textarea-maximize-btn' + (isInitialMaximized ? ' is-maximized' : '');
    btn.title = isInitialMaximized ? 'Minimize' : 'Maximize';
    setHTML(btn, html`${raw(isInitialMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG)}`);
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'textarea-save-btn' + (isInitialMaximized ? ' is-maximized' : '');
    saveBtn.title = 'Save';
    setHTML(saveBtn, html`${raw(CHECK_SVG)}`);
    if (isInitialMaximized) {
      acquireScrollLock(textarea);
    }

    // We need the parent to be relative to position the button
    const parent = textarea.parentElement;
    if (parent) {
      const computedStyle = window.getComputedStyle(parent);
      if (computedStyle.position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(btn);
      parent.appendChild(saveBtn);
    }
    /**
     * Stands in for the textarea's parent in the layout while the parent is
     * reparented onto <body>. Closure-scoped because this callback is created
     * once per textarea.
     * @type {HTMLElement|null}
     */
    let placeholder = null;

    const toggleMaximize = () => {
      const isMaximized = textarea.classList.toggle('is-maximized');
      btn.classList.toggle('is-maximized', isMaximized);
      saveBtn.classList.toggle('is-maximized', isMaximized);
      setHTML(btn, html`${raw(isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG)}`);
      btn.title = isMaximized ? 'Minimize' : 'Maximize';

      // Prevent body scrolling and stacking context traps when maximized
      if (isMaximized) {
        acquireScrollLock(textarea);
        if (parent) {
          placeholder = document.createElement('div');
          placeholder.className = 'textarea-placeholder';
          placeholder.style.height = parent.offsetHeight + 'px';
          parent.parentNode.insertBefore(placeholder, parent);
          document.body.appendChild(parent);
        }
      } else {
        releaseScrollLock(textarea);
        if (parent && placeholder) {
          placeholder.parentNode.insertBefore(parent, placeholder);
          placeholder.remove();
          placeholder = null;
        }
      }

      // If it's the main content editor, we might want to notify it
      textarea.dispatchEvent(new CustomEvent('textarea:maximize', {
        bubbles: true,
        detail: {
          isMaximized
        }
      }));
    };
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleMaximize();
    });
    saveBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      textarea.dispatchEvent(new CustomEvent('textarea:save', {
        bubbles: true
      }));
    });

    // Handle Escape key to minimize and Ctrl+S to save
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Escape' && textarea.classList.contains('is-maximized')) {
        toggleMaximize();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        textarea.dispatchEvent(new CustomEvent('textarea:save', {
          bubbles: true
        }));
      }
    });
  });
}