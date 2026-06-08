import { MAXIMIZE_SVG, MINIMIZE_SVG, CHECK_SVG } from './icons.js';

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
    btn.innerHTML = isInitialMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'textarea-save-btn' + (isInitialMaximized ? ' is-maximized' : '');
    saveBtn.title = 'Save';
    saveBtn.innerHTML = CHECK_SVG;

    if (isInitialMaximized) {
      document.body.classList.add('textarea-maximized-body-lock');
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

    const toggleMaximize = () => {
      const isMaximized = textarea.classList.toggle('is-maximized');
      btn.classList.toggle('is-maximized', isMaximized);
      saveBtn.classList.toggle('is-maximized', isMaximized);
      btn.innerHTML = isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG;
      btn.title = isMaximized ? 'Minimize' : 'Maximize';
      
      // Prevent body scrolling when maximized
      if (isMaximized) {
        document.body.classList.add('textarea-maximized-body-lock');
      } else {
        document.body.classList.remove('textarea-maximized-body-lock');
      }

      // If it's the main content editor, we might want to notify it
      textarea.dispatchEvent(new CustomEvent('textarea:maximize', { 
        bubbles: true,
        detail: { isMaximized } 
      }));
    };

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMaximize();
    });

    saveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      textarea.dispatchEvent(new CustomEvent('textarea:save', { bubbles: true }));
    });

    // Handle Escape key to minimize and Ctrl+S to save
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && textarea.classList.contains('is-maximized')) {
        toggleMaximize();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        textarea.dispatchEvent(new CustomEvent('textarea:save', { bubbles: true }));
      }
    });
  });
}
