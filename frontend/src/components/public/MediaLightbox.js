/**
 * MediaLightbox — full-screen image viewer.
 * Now uses the unified MediaViewer component (point-x52z.19).
 *
 * Usage:
 *   const lb = new MediaLightbox();
 *   lb.open(images, startIndex);    // images: [{ src, alt }]
 */

import { MediaViewer } from '../../plugins/immersive/MediaViewer.js';

export class MediaLightbox {
  constructor() {
    this._images = [];
    this._index = 0;
    this._el = null;
    this._viewer = null;
    this._build();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Open the lightbox.
   * @param {Array<{ src: string, alt: string }>} images
   * @param {number} [startIndex]
   */
  open(images, startIndex = 0) {
    this._images = images;
    this._index = Math.max(0, Math.min(startIndex, images.length - 1));
    this._show();
  }

  destroy() {
    this._viewer?.unmount();
    this._el?.remove();
    this._el = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _build() {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Image viewer');
    
    const mount = document.createElement('div');
    mount.id = 'lightbox-viewer-mount';
    mount.style.width = '100%';
    mount.style.height = '100%';
    overlay.appendChild(mount);
    
    document.body.appendChild(overlay);
    this._el = overlay;
  }

  _show() {
    this._el.classList.add('active');
    document.body.classList.add('ui-hidden'); // hide main site header/footer
    
    const items = this._images.map(img => ({ type: 'image', url: img.src, alt: img.alt }));
    
    if (this._viewer) this._viewer.unmount();
    this._viewer = new MediaViewer(this._el.querySelector('#lightbox-viewer-mount'), {
      items,
      startIndex: this._index,
      showClose: true,
      showShare: true,
      onClose: () => this._hide(),
      onStep: (index) => { this._index = index; }
    });
    this._viewer.mount();
    this._el.focus();
  }

  _hide() {
    this._el.classList.remove('active');
    document.body.classList.remove('ui-hidden');
    this._viewer?.unmount();
    this._viewer = null;
  }
}
