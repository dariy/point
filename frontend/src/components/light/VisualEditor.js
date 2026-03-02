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
  _bindDrag() {
    const list = this.$('#ve-list');
    if (!list) return;

    let dragIdx = null;
    let indicator = null;

    const getCards = () => [...list.querySelectorAll('.ve-card')];

    const removeIndicator = () => {
      indicator?.remove();
      indicator = null;
    };

    const insertIndicator = (referenceCard, before) => {
      removeIndicator();
      indicator = document.createElement('div');
      indicator.className = 've-drop-indicator';
      if (before) {
        list.insertBefore(indicator, referenceCard);
      } else {
        referenceCard.insertAdjacentElement('afterend', indicator);
      }
    };

    // Compute drop slot index (0 = before first card, n = after last card)
    const slotFromEvent = (e) => {
      const cards = getCards();
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (e.clientY < mid) return i;
      }
      return cards.length;
    };

    // dragstart — only from the handle zone
    list.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.ve-card');
      if (!card) return;
      // Only start drag if initiated from the handle
      if (!e.target.closest('.ve-handle')) {
        e.preventDefault();
        return;
      }
      dragIdx = parseInt(card.dataset.index, 10);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    list.addEventListener('dragover', (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const cards = getCards();
      const slot = slotFromEvent(e);

      if (slot === 0) {
        if (cards[0]) insertIndicator(cards[0], true);
      } else if (slot >= cards.length) {
        if (cards[cards.length - 1]) insertIndicator(cards[cards.length - 1], false);
      } else {
        insertIndicator(cards[slot], true);
      }
    });

    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) removeIndicator();
    });

    list.addEventListener('drop', (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      removeIndicator();

      const slot = slotFromEvent(e);
      const next = [...this.props.images];
      const [moved] = next.splice(dragIdx, 1);
      // Adjust insertion index after removal
      const insertAt = slot > dragIdx ? slot - 1 : slot;
      next.splice(insertAt, 0, moved);

      dragIdx = null;
      this.props.onChange(next);
    });

    list.addEventListener('dragend', () => {
      dragIdx = null;
      removeIndicator();
      list.querySelectorAll('.ve-card.dragging').forEach((c) => c.classList.remove('dragging'));
    });
  }
  _bindLightbox() {}
}
