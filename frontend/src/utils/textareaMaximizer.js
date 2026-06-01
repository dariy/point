import { MAXIMIZE_SVG, MINIMIZE_SVG } from './icons.js';

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

    // Create the button
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'textarea-maximize-btn';
    btn.title = 'Maximize';
    btn.innerHTML = MAXIMIZE_SVG;

    // We need the parent to be relative to position the button
    const parent = textarea.parentElement;
    if (parent) {
      const computedStyle = window.getComputedStyle(parent);
      if (computedStyle.position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(btn);
    }

    const toggleMaximize = () => {
      const isMaximized = textarea.classList.toggle('is-maximized');
      btn.classList.toggle('is-maximized', isMaximized);
      btn.innerHTML = isMaximized ? MINIMIZE_SVG : MAXIMIZE_SVG;
      btn.title = isMaximized ? 'Minimize' : 'Maximize';
      
      // Prevent body scrolling when maximized
      if (isMaximized) {
        document.body.classList.add('textarea-maximized-body-lock');
      } else {
        document.body.classList.remove('textarea-maximized-body-lock');
      }

      // If it's the main content editor, we might want to notify it
      textarea.dispatchEvent(new CustomEvent('textarea:maximize', { detail: { isMaximized } }));
    };

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMaximize();
    });

    // Handle Escape key to minimize
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && textarea.classList.contains('is-maximized')) {
        toggleMaximize();
      }
    });
  });
}
