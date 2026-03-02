/**
 * VisualEditor — visual image-sequence editor for immersive posts.
 *
 * Props:
 *   images    {string[]}  Ordered list of bare image paths.
 *   onChange  {fn}        Called with new string[] on any mutation.
 *   onAdd     {fn}        Called when user clicks "Add images" — opens picker.
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

export class VisualEditor extends Component {
  render() {
    const { images = [] } = this.props;

    const cards = images.map((path, i) => {
      const thumb = `/media/thumbnails${path}`;
      const filename = path.split('/').pop();
      return `
        <div class="ve-card" data-index="${i}" draggable="true">
          <div class="ve-handle" title="Drag to reorder">
            <span class="ve-handle-dots"></span>
          </div>
          <img class="ve-thumb" src="${escapeHtml(thumb)}"
               alt="${escapeHtml(filename)}"
               data-full="/media/originals${escapeHtml(path)}"
               loading="lazy">
          <span class="ve-path">${escapeHtml(path)}</span>
          <button class="ve-remove" data-index="${i}" type="button"
                  aria-label="Remove image" title="Remove">&times;</button>
        </div>`;
    }).join('');

    const empty = images.length === 0
      ? `<p class="ve-empty">No images yet. Click <strong>Media</strong> to add some.</p>`
      : '';

    return `
      <div class="ve-root">
        <div class="ve-list" id="ve-list">${cards}${empty}</div>
      </div>`;
  }

  afterRender() {
    this._bindRemove();
    this._bindDrag();
    this._bindLightbox();
  }

  _bindRemove() {
    this.container.querySelectorAll('.ve-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.index, 10);
        const next = [...this.props.images];
        next.splice(idx, 1);
        this.props.onChange(next);
      });
    });
  }

  // Drag and lightbox wired in later tasks — stubs to avoid errors
  _bindDrag() {}
  _bindLightbox() {}
}
