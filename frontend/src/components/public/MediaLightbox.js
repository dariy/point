/**
 * MediaLightbox — full-screen image viewer.
 *
 * Usage:
 *   const lb = new MediaLightbox();
 *   lb.open(images, startIndex);    // images: [{ src, alt }]
 *
 * The lightbox appends itself to <body> once and reuses across calls.
 * No Component base class — it manages its own DOM element directly.
 */

export class MediaLightbox {
  constructor() {
    this._images = [];
    this._index = 0;
    this._el = null;
    this._imgEl = null;
    this._captionEl = null;
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

    const content = document.createElement('div');
    content.className = 'lightbox-content';

    const img = document.createElement('img');
    img.className = 'lightbox-image';
    img.alt = '';

    const caption = document.createElement('p');
    caption.className = 'lightbox-caption';

    const close = document.createElement('button');
    close.className = 'lightbox-close';
    close.setAttribute('aria-label', 'Close lightbox');
    close.textContent = '×';

    const prev = document.createElement('button');
    prev.className = 'lightbox-prev';
    prev.setAttribute('aria-label', 'Previous image');
    prev.textContent = '‹';

    const next = document.createElement('button');
    next.className = 'lightbox-next';
    next.setAttribute('aria-label', 'Next image');
    next.textContent = '›';

    content.append(img, caption, close, prev, next);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    this._el = overlay;
    this._imgEl = img;
    this._captionEl = caption;
    this._prevBtn = prev;
    this._nextBtn = next;

    // Event wiring
    close.addEventListener('click', () => this._hide());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._hide();
    });
    prev.addEventListener('click', () => this._step(-1));
    next.addEventListener('click', () => this._step(1));
    document.addEventListener('keydown', (e) => {
      if (!this._el?.classList.contains('active')) return;
      if (e.key === 'Escape') this._hide();
      if (e.key === 'ArrowLeft') this._step(-1);
      if (e.key === 'ArrowRight') this._step(1);
    });
  }

  _show() {
    this._render();
    this._el.classList.add('active');
    document.body.style.overflow = 'hidden';
    this._el.focus();
  }

  _hide() {
    this._el.classList.remove('active');
    document.body.style.overflow = '';
  }

  _step(delta) {
    const count = this._images.length;
    if (!count) return;
    this._index = (this._index + delta + count) % count;
    this._render();
  }

  _render() {
    const { src, alt } = this._images[this._index] || {};
    if (src) this._imgEl.src = src;
    this._imgEl.alt = alt || '';
    this._captionEl.textContent = alt || '';

    const hasMultiple = this._images.length > 1;
    this._prevBtn.hidden = !hasMultiple;
    this._nextBtn.hidden = !hasMultiple;
  }
}
