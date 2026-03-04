/**
 * TagsInput — inline tag-badge input with autocomplete.
 *
 * Props:
 *   tags     {string[]}   Initial tag names
 *   onChange {Function}   Called with updated string[] whenever tags change
 */

import { Component } from '../Component.js';
import { listTags } from '../../api/tags.js';
import { escapeHtml, debounce } from '../../utils/helpers.js';

export class TagsInput extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      tags: [...(props.tags || [])],
      input: '',
      suggestions: [],
      showSuggestions: false,
    };
    this._allTags = [];
    this._fetchSuggestions = debounce(this._fetchSuggestions.bind(this), 200);
  }

  render() {
    const { tags } = this.state;
    const badges = tags.map((t) =>
      `<span class="tag">
         ${escapeHtml(t)}
         <button class="tag-remove" data-tag="${escapeHtml(t)}" type="button" aria-label="Remove ${escapeHtml(t)}">×</button>
       </span>`
    ).join('');

    return `
      <div class="tags-input" id="tags-input-box">
        ${badges}
        <input type="text" id="tag-text-input" class="tag-text-field"
               placeholder="Add tag…" autocomplete="off" aria-label="Add a tag">
        <div class="tags-suggestions" id="tags-suggestions"></div>
      </div>`;
  }

  afterRender() {
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
    const input = this.$('#tag-text-input');
    if (!input) return;

    input.addEventListener('input', (e) => {
      const val = e.target.value;
      this.state.input = val;
      if (val.trim()) {
        this._fetchSuggestions(val.trim());
      } else {
        this._hideSuggestions();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = input.value.trim().replace(/,$/, '');
        if (val) this._addTag(val);
      } else if (e.key === 'Backspace' && !input.value && this.state.tags.length) {
        const tags = this.state.tags.slice(0, -1);
        this.setState({ tags });
        this.props.onChange?.(tags);
      } else if (e.key === 'Escape') {
        this._hideSuggestions();
      }
    });

    input.addEventListener('blur', () => {
      // Delay to allow suggestion click to register first.
      setTimeout(() => this._hideSuggestions(), 200);
    });
  }

  /** Add a tag if it isn't already present. */
  _addTag(name) {
    if (!name || this.state.tags.includes(name)) return;
    const tags = [...this.state.tags, name];
    this.setState({ tags });
    this.props.onChange?.(tags);

    const input = this.$('#tag-text-input');
    if (input) input.value = '';
    this._hideSuggestions();
  }

  async _fetchSuggestions(q) {
    try {
      if (!this._allTags.length) {
        const res = await listTags();
        this._allTags = (res.tags || []).map((t) => t.name);
      }
      const lower = q.toLowerCase();
      const matches = this._allTags.filter(
        (t) => t.toLowerCase().includes(lower) && !this.state.tags.includes(t)
      ).slice(0, 8);
      this._showSuggestions(matches, q);
    } catch {
      this._hideSuggestions();
    }
  }

  _showSuggestions(suggestions, input) {
    const box = this.$('#tags-suggestions');
    if (!box) return;

    if (!suggestions.length) {
      // Show option to create a new tag.
      box.textContent = '';
      const item = document.createElement('div');
      item.className = 'suggestion-item suggestion-create';
      item.textContent = `Create "${input}"`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._addTag(input);
      });
      box.appendChild(item);
      box.classList.add('show');
      return;
    }

    box.textContent = '';
    suggestions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.textContent = s;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._addTag(s);
      });
      box.appendChild(item);
    });
    box.classList.add('show');
  }

  _hideSuggestions() {
    const box = this.$('#tags-suggestions');
    if (box) box.classList.remove('show');
  }

  /** Public method: get current tags array. */
  getTags() {
    return [...this.state.tags];
  }
}
