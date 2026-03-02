/**
 * VisualEditor — visual image-sequence editor for immersive posts.
 *
 * Props:
 *   images    {string[]}  Ordered list of bare image paths.
 *   onChange  {fn}        Called with new string[] on any mutation.
 *   onAdd     {fn}        Called when user clicks "Add images" — opens picker.
 *   onRename  {fn}        Async (oldPath, newFilename) => Promise. Called on inline rename.
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
        <div class="ve-card" data-index="${i}">
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
    this._bindInlineRename();
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

    // Enable dragging only when mousedown starts on the handle
    list.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.ve-handle');
      if (!handle) return;
      const card = handle.closest('.ve-card');
      if (card) card.setAttribute('draggable', 'true');
    });

    list.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.ve-card');
      if (!card || card.getAttribute('draggable') !== 'true') return;
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
      list.querySelectorAll('.ve-card').forEach((c) => {
        c.classList.remove('dragging');
        c.removeAttribute('draggable');
      });
    });
  }
  _bindInlineRename() {
    this.container.querySelectorAll('.ve-path').forEach((span) => {
      span.addEventListener('click', () => {
        const card = span.closest('.ve-card');
        if (!card) return;
        const idx = parseInt(card.dataset.index, 10);
        const path = this.props.images[idx];
        if (!path) return;
        this._startRename(span, path);
      });
    });
  }

  _startRename(span, path) {
    const lastSlash = path.lastIndexOf('/');
    const prefix   = path.slice(0, lastSlash + 1);   // e.g. "/2026/02/"
    const fullName  = path.slice(lastSlash + 1);       // e.g. "photo.jpg"
    const lastDot   = fullName.lastIndexOf('.');
    const base = lastDot !== -1 ? fullName.slice(0, lastDot) : fullName;
    const ext  = lastDot !== -1 ? fullName.slice(lastDot)  : '';

    const form = document.createElement('span');
    form.className = 've-rename-form';

    const prefixEl = document.createElement('span');
    prefixEl.className = 've-rename-prefix';
    prefixEl.textContent = prefix;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 've-rename-input';
    input.value = base;

    const extEl = document.createElement('span');
    extEl.className = 've-rename-ext';
    extEl.textContent = ext;

    form.appendChild(prefixEl);
    form.appendChild(input);
    form.appendChild(extEl);

    span.replaceWith(form);
    input.focus();
    input.select();

    const cancel = () => {
      if (document.body.contains(form)) form.replaceWith(span);
    };

    let submitting = false;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const newBase = input.value.trim();
        if (!newBase || newBase === base) { cancel(); return; }
        const promise = this.props.onRename?.(path, newBase + ext);
        if (!promise) { cancel(); return; }
        submitting = true;
        input.disabled = true;
        promise.catch(() => {
          submitting = false;
          input.disabled = false;
          input.focus();
        });
      }
    });

    input.addEventListener('blur', () => {
      if (submitting) return;
      setTimeout(() => {
        if (!submitting && document.body.contains(form)) cancel();
      }, 150);
    });
  }

  _bindLightbox() {
    this.container.querySelectorAll('.ve-thumb').forEach((img) => {
      img.addEventListener('click', () => {
        const full = img.dataset.full;
        if (!full) return;

        const overlay = document.createElement('div');
        overlay.className = 've-lightbox';

        const fullImg = document.createElement('img');
        fullImg.src = full;
        fullImg.alt = '';
        overlay.appendChild(fullImg);
        document.body.appendChild(overlay);

        const close = () => {
          overlay.remove();
          document.removeEventListener('keydown', onKey);
        };
        overlay.addEventListener('click', close);
        const onKey = (e) => {
          if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
      });
    });
  }
}
