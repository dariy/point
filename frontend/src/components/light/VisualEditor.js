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
import { updateMedia, reextractMediaEXIF } from '../../api/media.js';
import { store } from '../../store.js';

export class VisualEditor extends Component {
  render() {
    const { nodes = [] } = this.props;

    const insertZone = (index) =>
      `<div class="ve-insert-zone" data-insert-at="${index}">
         <div class="ve-insert-actions">
           <button class="ve-insert-btn ve-insert-text" type="button" title="Insert text node">+ Text</button>
           <button class="ve-insert-btn ve-insert-media" type="button" title="Insert media node">+ Media</button>
         </div>
       </div>`;

    const cards = nodes.map((node, i) => {
      if (node.type === 'image') {
        const thumb = `${node.path}?thumb`;
        const filename = node.path.split('/').pop();
        const mediaByPath = this.props.mediaByPath || {};
        const media = mediaByPath[node.path];
        const mediaId = media ? escapeHtml(String(media.id)) : '';

        const exifBtn = mediaId
          ? `<button class="ve-exif-toggle btn btn-sm" data-media-id="${mediaId}" type="button" title="Edit EXIF">\u2139 EXIF</button>`
          : '';
        const exifPanel = mediaId
          ? `<div class="ve-exif-panel" data-media-id="${mediaId}" hidden>
               ${this._renderVeExifRows(media)}
               <div class="exif-actions">
                 <button class="btn btn-sm ve-exif-add-btn" type="button">+ Add field</button>
                 <button class="btn btn-sm ve-exif-save-btn" data-media-id="${mediaId}" type="button">Save EXIF</button>
                 <button class="btn btn-sm ve-exif-reextract-btn" data-media-id="${mediaId}" type="button">Re-extract</button>
               </div>
             </div>`
          : '';

        return `
          ${insertZone(i)}
          <div class="ve-card" data-index="${i}">
            <div class="ve-handle" title="Drag to reorder">
              <span class="ve-handle-dots"></span>
            </div>
            <img class="ve-thumb" src="${escapeHtml(thumb)}"
                 alt="${escapeHtml(filename)}"
                 data-full="${escapeHtml(node.path)}"
                 loading="lazy">
            <div class="ve-card-row">
              <span class="ve-path">${escapeHtml(node.path)}</span>
              ${exifBtn}
              <button class="ve-remove" data-index="${i}" type="button"
                      aria-label="Remove image" title="Remove">&times;</button>
            </div>
            ${exifPanel}
          </div>`;
      } else {
        return `
          ${insertZone(i)}
          <div class="ve-card ve-card--text" data-index="${i}">
            <div class="ve-handle" title="Drag to reorder">
              <span class="ve-handle-dots"></span>
            </div>
            <span class="ve-text-icon" aria-hidden="true">¶</span>
            <textarea class="ve-text-area" placeholder="Add text\u2026" rows="1">${escapeHtml(node.text || '')}</textarea>
            <button class="ve-remove" data-index="${i}" type="button"
                    aria-label="Remove text block" title="Remove">&times;</button>
          </div>`;
      }
    }).join('');

    const empty = nodes.length === 0
      ? `<p class="ve-empty">No content yet. Use the buttons to add text or media.</p>`
      : '';

    return `
      <div class="ve-root">
        <div class="ve-list" id="ve-list">
          ${cards}
          ${insertZone(nodes.length)}
          ${empty}
        </div>
      </div>`;
  }

  afterRender() {
    this._bindRemove();
    this._bindDrag();
    this._bindLightbox();
    this._bindInlineRename();
    this._bindInsertZones();
    this._bindTextCards();
    this._bindVeExif();
  }

  _renderVeExifRows(media) {
    const metadata = (media && media.metadata) || {};
    const rows = Object.entries(metadata).map(([k, v]) =>
      `<tr>
        <td><input class="exif-key" value="${escapeHtml(String(k))}" placeholder="Field name" aria-label="EXIF field name"></td>
        <td><input class="exif-val" value="${escapeHtml(String(v))}" placeholder="Value" aria-label="EXIF value"></td>
        <td><button class="exif-delete-btn" type="button" title="Remove">\u00d7</button></td>
      </tr>`
    ).join('');
    return `<table class="exif-table"><thead><tr><th>Field</th><th>Value</th><th></th></tr></thead><tbody class="exif-rows">${rows}</tbody></table>`;
  }

  _bindVeExif() {
    this.container.querySelectorAll('.ve-exif-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = btn.closest('.ve-card').querySelector('.ve-exif-panel');
        if (panel) panel.hidden = !panel.hidden;
      });
    });

    const bindDelete = (scope) => {
      scope.querySelectorAll('.exif-delete-btn').forEach((b) => {
        b.addEventListener('click', () => b.closest('tr').remove());
      });
    };
    bindDelete(this.container);

    this.container.querySelectorAll('.ve-exif-add-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tbody = btn.closest('.ve-exif-panel').querySelector('.exif-rows');
        const tr = document.createElement('tr');
        ['Field name', 'Value'].forEach((placeholder, colIdx) => {
          const td = document.createElement('td');
          const input = document.createElement('input');
          input.className = colIdx === 0 ? 'exif-key' : 'exif-val';
          input.placeholder = placeholder;
          input.setAttribute('aria-label', `EXIF ${placeholder.toLowerCase()}`);
          td.appendChild(input);
          tr.appendChild(td);
        });
        const tdDel = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'exif-delete-btn';
        delBtn.title = 'Remove';
        delBtn.textContent = '\u00d7';
        delBtn.addEventListener('click', () => tr.remove());
        tdDel.appendChild(delBtn);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
    });

    this.container.querySelectorAll('.ve-exif-save-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.mediaId, 10);
        const panel = btn.closest('.ve-exif-panel');
        const metadata = {};
        panel.querySelectorAll('.exif-rows tr').forEach((tr) => {
          const key = tr.querySelector('.exif-key')?.value.trim();
          const val = tr.querySelector('.exif-val')?.value.trim();
          if (key) metadata[key] = val;
        });
        try {
          await updateMedia(id, { metadata });
          store.set('toast', { message: 'EXIF saved.', type: 'success' });
        } catch (err) {
          store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
        }
      });
    });

    this.container.querySelectorAll('.ve-exif-reextract-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Re-extract will overwrite manual EXIF edits. Continue?')) return;
        const id = parseInt(btn.dataset.mediaId, 10);
        try {
          const updated = await reextractMediaEXIF(id);
          const metadata = updated.metadata || {};
          const panel = btn.closest('.ve-exif-panel');
          const tbody = panel.querySelector('.exif-rows');
          while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
          Object.entries(metadata).forEach(([k, v]) => {
            const tr = document.createElement('tr');
            ['exif-key', 'exif-val'].forEach((cls, i) => {
              const td = document.createElement('td');
              const input = document.createElement('input');
              input.className = cls;
              input.value = String(i === 0 ? k : v);
              input.placeholder = i === 0 ? 'Field name' : 'Value';
              td.appendChild(input);
              tr.appendChild(td);
            });
            const tdDel = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'exif-delete-btn';
            delBtn.title = 'Remove';
            delBtn.textContent = '\u00d7';
            delBtn.addEventListener('click', () => tr.remove());
            tdDel.appendChild(delBtn);
            tr.appendChild(tdDel);
            tbody.appendChild(tr);
          });
          const msg = Object.keys(metadata).length ? 'EXIF re-extracted.' : 'No EXIF data found in this file.';
          store.set('toast', { message: msg, type: 'success' });
        } catch (err) {
          store.set('toast', { message: err.message || 'Re-extract failed.', type: 'error' });
        }
      });
    });
  }

  /**
   * Read current node state from DOM (capturing live textarea values)
   * and serialize to the plain-text content format.
   * Called by PostEditPage at save time.
   * @returns {string}
   */
  serializeNodes() {
    const nodes = this.props.nodes || [];
    return nodes.map((node, i) => {
      if (node.type === 'image') return node.path;
      const card = this.container.querySelector(`.ve-card[data-index="${i}"]`);
      const ta = card?.querySelector('.ve-text-area');
      return ta ? ta.value : (node.text || '');
    }).join('\n');
  }

  _bindInsertZones() {
    this.container.querySelectorAll('.ve-insert-text').forEach((btn) => {
      btn.addEventListener('click', () => {
        const zone = btn.closest('.ve-insert-zone');
        if (!zone) return;
        const at = parseInt(zone.dataset.insertAt, 10);
        const next = [...this.props.nodes];
        next.splice(at, 0, { type: 'text', text: '' });
        this.props.onChange(next);
        // After parent re-renders via setProps, focus the new textarea
        requestAnimationFrame(() => {
          const cards = this.container.querySelectorAll('.ve-card');
          cards[at]?.querySelector('.ve-text-area')?.focus();
        });
      });
    });

    this.container.querySelectorAll('.ve-insert-media').forEach((btn) => {
      btn.addEventListener('click', () => {
        const zone = btn.closest('.ve-insert-zone');
        if (!zone) return;
        const at = parseInt(zone.dataset.insertAt, 10);
        if (this.props.onAddMedia) {
          this.props.onAddMedia(at);
        }
      });
    });
  }

  _bindTextCards() {
    this.container.querySelectorAll('.ve-text-area').forEach((ta) => {
      const resize = () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      };
      resize();
      ta.addEventListener('input', () => {
        resize();
        const card = ta.closest('.ve-card');
        if (card) {
          const idx = parseInt(card.dataset.index, 10);
          if (this.props.nodes[idx]) {
            this.props.nodes[idx].text = ta.value;
          }
        }
        if (this.props.onInput) {
          this.props.onInput();
        }
      });
    });
  }

  _bindRemove() {
    this.container.querySelectorAll('.ve-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.index, 10);
        const next = [...this.props.nodes];
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
      const next = [...this.props.nodes];
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
        const node = this.props.nodes[idx];
        if (!node || node.type !== 'image') return;
        this._startRename(span, node.path);
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
        // Sanitise: keep only letters, digits, hyphens and underscores.
        const newBase = input.value.trim().replace(/[^a-zA-Z0-9\-_]/g, '');
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
