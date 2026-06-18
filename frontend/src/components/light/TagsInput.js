/**
 * TagsInput — inline tag-badge input with autocomplete.
 *
 * Props:
 *   tags     {string[]}   Initial tag names
 *   onChange {Function}   Called with updated string[] whenever tags change
 */

import { Component } from '../Component.js';
import { listTags, createTag } from '../../api/tags.js';
import { escapeHtml, debounce } from '../../utils/helpers.js';
import { openTagFamilyPopover } from './TagFamilyPopover.js';

let _tagInputCounter = 0;

export class TagsInput extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this._uid = `tags-input-${++_tagInputCounter}`;
    this.state = {
      tags: [...(props.tags || [])],
      input: '',
      suggestions: [],
      showSuggestions: false,
      isPopoverOpen: false,
      selectedIndex: -1,
    };
    this._allTags = [];
    this._fetchSuggestions = debounce(this._fetchSuggestions.bind(this), 200);
  }

  render() {
    const { tags } = this.state;
    const badges = tags.map((t) =>
      `<span class="tag tag-chip" data-tag="${escapeHtml(t)}">
         ${escapeHtml(t)}
         <button class="tag-remove" data-tag="${escapeHtml(t)}" type="button" aria-label="Remove ${escapeHtml(t)}">×</button>
       </span>`
    ).join('');

    return `
      <div class="tags-input" id="${this._uid}-box">
        ${badges}
        <input type="text" id="${this._uid}-text" class="tag-text-field"
               placeholder="Add tag…" autocomplete="off" aria-label="Add a tag">
        <div class="tags-suggestions" id="${this._uid}-suggestions"></div>
      </div>`;
  }

  afterRender() {
    // Family popover
    this.$$('.tag-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('tag-remove')) return;
        const tagName = chip.dataset.tag;
        const tagObj = this._allTags.find(t => t.name === tagName);
        if (tagObj) openTagFamilyPopover(tagObj.id, chip);
      });
    });

    // Remove-tag buttons
    this.$$('.tag-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        const tags = this.state.tags.filter((t) => t !== tag);
        this.setState({ tags });
        this.props.onChange?.(tags);
      });
    });

    // Text input
    const input = this.$(`#${this._uid}-text`);
    if (!input) return;

    input.addEventListener('input', (e) => {
      // Android virtual keyboards fire Enter as insertLineBreak (no keydown key).
      if (e.inputType === 'insertLineBreak') {
        input.value = input.value.replace(/\n/g, '');
        const val = input.value.trim();
        if (val) this._addTag(val);
        return;
      }

      const raw = e.target.value;

      // Handle comma as a delimiter (needed on Android where keydown may not fire).
      if (raw.includes(',')) {
        const parts = raw.split(',');
        const toAdd = parts[0].trim();
        input.value = parts.slice(1).join(',');
        if (toAdd) this._addTag(toAdd);
        this.state.input = input.value;
        if (input.value.trim()) {
          this._fetchSuggestions(input.value.trim());
        } else {
          this._hideSuggestions();
        }
        return;
      }

      this.state.input = raw;
      if (raw.trim()) {
        this._fetchSuggestions(raw.trim());
      } else {
        this._hideSuggestions();
      }
    });

    input.addEventListener('keydown', (e) => {
      const box = this.$(`#${this._uid}-suggestions`);
      const isBoxVisible = box && box.classList.contains('show');
      const items = isBoxVisible ? Array.from(box.querySelectorAll('.suggestion-item')) : [];

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!isBoxVisible || !items.length) return;
        e.preventDefault();
        
        if (this.state.selectedIndex >= 0 && items[this.state.selectedIndex]) {
          items[this.state.selectedIndex].classList.remove('selected');
        }

        if (e.key === 'ArrowDown') {
          this.state.selectedIndex = (this.state.selectedIndex + 1) % items.length;
        } else {
          this.state.selectedIndex = this.state.selectedIndex - 1;
          if (this.state.selectedIndex < 0) this.state.selectedIndex = items.length - 1;
        }

        items[this.state.selectedIndex].classList.add('selected');
        items[this.state.selectedIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (isBoxVisible && this.state.selectedIndex >= 0 && items[this.state.selectedIndex]) {
          items[this.state.selectedIndex].dispatchEvent(new MouseEvent('mousedown'));
        } else {
          const val = input.value.trim().replace(/,$/, '');
          if (val) this._addTag(val);
        }
      } else if (e.key === 'Backspace' && !input.value && this.state.tags.length) {
        const tags = this.state.tags.slice(0, -1);
        this.setState({ tags });
        this.props.onChange?.(tags);
        this.$(`#${this._uid}-text`)?.focus();
      } else if (e.key === 'Escape') {
        this._hideSuggestions();
      }
    });

    input.addEventListener('blur', () => {
      // Delay to allow suggestion click to register first.
      setTimeout(() => {
        if (!this.state.isPopoverOpen) {
          this._hideSuggestions();
        }
      }, 200);
    });
  }

  /** Add a tag if it isn't already present. */
  _addTag(name) {
    if (!name || this.state.tags.includes(name)) return;
    const tags = [...this.state.tags, name];
    this.setState({ tags });
    this.props.onChange?.(tags);

    const input = this.$(`#${this._uid}-text`);
    if (input) { input.value = ''; input.focus(); }
    this._hideSuggestions();
  }

  async _fetchSuggestions(q) {
    try {
      if (!this._allTags.length) {
        const res = await listTags();
        this._allTags = res.tags || [];
      }
      const lower = q.toLowerCase();
      const matches = this._allTags.filter(
        (t) => t.name.toLowerCase().includes(lower) && !this.state.tags.includes(t.name)
      ).slice(0, 8);
      this._showSuggestions(matches, q);
    } catch {
      this._hideSuggestions();
    }
  }

  _showSuggestions(suggestions, input) {
    this.state.selectedIndex = -1;
    const box = this.$(`#${this._uid}-suggestions`);
    if (!box) return;

    // Check if we should drop up
    const inputEl = this.$(`#${this._uid}-text`);
    if (inputEl) {
      const rect = inputEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < 250 && rect.top > 250) {
        box.classList.add('drop-up');
      } else {
        box.classList.remove('drop-up');
      }
    }

    if (!suggestions.length) {
      // Show option to create a new tag.
      box.textContent = '';
      const item = document.createElement('div');
      item.className = 'suggestion-item suggestion-create';
      item.textContent = `＋ Create "${input}"…`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._showCreateTagPopover(input);
      });
      box.appendChild(item);
      box.classList.add('show');
      return;
    }

    box.textContent = '';
    suggestions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.textContent = s.name_path || s.name;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._addTag(s.name);
      });
      box.appendChild(item);
    });

    // Also add create option at the end if not an exact match
    if (!suggestions.some(s => s.name.toLowerCase() === input.toLowerCase())) {
      const createItem = document.createElement('div');
      createItem.className = 'suggestion-item suggestion-create';
      createItem.textContent = `＋ Create "${input}"…`;
      createItem.style.borderTop = '1px solid var(--border-primary)';
      createItem.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._showCreateTagPopover(input);
      });
      box.appendChild(createItem);
    }

    box.classList.add('show');
  }

  _showCreateTagPopover(name) {
    const box = this.$(`#${this._uid}-suggestions`);
    if (!box) return;

    this.state.isPopoverOpen = true;
    box.textContent = '';
    const popover = document.createElement('div');
    popover.className = 'tag-create-popover';
    popover.innerHTML = `
      <div class="field">
        <label class="form-label">Name</label>
        <input type="text" class="new-tag-name form-input" value="${escapeHtml(name)}">
      </div>
      <div class="field">
        <label class="form-label">Parent (optional)</label>
        <div class="parent-field-wrapper">
          <input type="text" class="new-tag-parent form-input" placeholder="Search parents…" autocomplete="off">
          <div class="parent-suggestions tags-suggestions"></div>
        </div>
      </div>
      <div class="actions" style="display:flex; justify-content: flex-end; gap: var(--spacing-sm); margin-top: var(--spacing-sm);">
        <button type="button" class="btn btn-secondary btn-cancel">Cancel</button>
        <button type="button" class="btn btn-primary btn-create">Create</button>
      </div>
    `;

    box.appendChild(popover);
    box.classList.add('show');

    const nameInput = popover.querySelector('.new-tag-name');
    const parentInput = popover.querySelector('.new-tag-parent');
    const parentSuggestions = popover.querySelector('.parent-suggestions');
    const createBtn = popover.querySelector('.btn-create');
    const cancelBtn = popover.querySelector('.btn-cancel');

    let selectedParentId = null;

    // Parent autocomplete logic
    const fetchParentSuggestions = debounce(async (q) => {
      const lower = q.toLowerCase();
      const matches = this._allTags.filter(t => t.name.toLowerCase().includes(lower)).slice(0, 5);
      parentSuggestions.textContent = '';
      if (!matches.length) {
        parentSuggestions.classList.remove('show');
        return;
      }
      matches.forEach(m => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = m.name_path || m.name;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          parentInput.value = m.name;
          selectedParentId = m.id;
          parentSuggestions.textContent = '';
          parentSuggestions.classList.remove('show');
        });
        parentSuggestions.appendChild(item);
      });
      parentSuggestions.classList.add('show');
    }, 200);

    parentInput.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      if (!q) {
        parentSuggestions.textContent = '';
        parentSuggestions.classList.remove('show');
        selectedParentId = null;
        return;
      }
      fetchParentSuggestions(q);
    });

    const doCreate = async () => {
      const finalName = nameInput.value.trim();
      if (!finalName) return;
      try {
        const params = { name: finalName };
        if (selectedParentId) {
          params.parent_ids = [selectedParentId];
        }
        await createTag(params);
        this._addTag(finalName);
        this._hideSuggestions();
        this._allTags = []; // Force refresh on next search
      } catch (err) {
        console.error('Failed to create tag', err);
        alert('Failed to create tag. It may already exist.');
      }
    };

    createBtn.addEventListener('click', doCreate);
    cancelBtn.addEventListener('click', () => this._hideSuggestions());

    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doCreate();
      } else if (e.key === 'Escape') {
        this._hideSuggestions();
      }
    });

    nameInput.focus();
  }

  _hideSuggestions() {
    this.state.isPopoverOpen = false;
    const box = this.$(`#${this._uid}-suggestions`);
    if (box) box.classList.remove('show');
  }

  /** Public method: get current tags array. */
  getTags() {
    return [...this.state.tags];
  }
}
