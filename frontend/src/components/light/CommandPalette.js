import { Component } from '../Component.js';
import { listPosts } from '../../api/posts.js';
import { listTags } from '../../api/tags.js';
import { html, navigate, raw, debounce } from '../../utils/helpers.js';
import { SEARCH_SVG, POSTS_SVG, TAGS_SVG, SETTINGS_SVG, DASHBOARD_SVG } from '../../utils/icons.js';
import { acquireScrollLock, releaseScrollLock } from '../../utils/scrollLock.js';

const STATIC_PAGES = [
  { href: '/light', label: 'Dashboard', icon: DASHBOARD_SVG },
  { href: '/light/posts', label: 'Posts List', icon: POSTS_SVG },
  { href: '/light/posts/new', label: 'New Post', icon: POSTS_SVG },
  { href: '/light/tags', label: 'Tags Manager', icon: TAGS_SVG },
  { href: '/light/settings', label: 'Settings', icon: SETTINGS_SVG },
];

export class CommandPalette extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      isOpen: false,
      query: '',
      results: [],
      selectedIndex: 0,
    };
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onGlobalKeyDown = this._onKeyDownGlobal.bind(this);
    this._performSearch = debounce(this._search.bind(this), 200);
  }

  render() {
    const { isOpen, query, results, selectedIndex } = this.state;
    if (!isOpen) return html``;

    return html`
      <div class="cp-overlay" id="cp-overlay">
        <div class="cp-dialog" id="cp-dialog" role="dialog" aria-modal="true" aria-label="Command Palette">
          <div class="cp-search-row">
            ${raw(SEARCH_SVG)}
            <input type="text" id="cp-input" class="cp-input" placeholder="Search posts, tags, pages…" value="${query}" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="cp-results" aria-expanded="true" role="combobox">
            <kbd class="cp-esc-hint">ESC</kbd>
          </div>
          <div class="cp-results" id="cp-results" role="listbox" aria-label="Search results">
            ${results.map((r, i) => html`
              <div class="cp-result-item ${i === selectedIndex ? 'selected' : ''}" 
                   data-index="${i}" role="option" aria-selected="${i === selectedIndex}">
                <div class="cp-result-icon">${raw(r.icon)}</div>
                <div class="cp-result-info">
                  <div class="cp-result-label">${r.label}</div>
                  ${r.sublabel ? html`<div class="cp-result-sublabel">${r.sublabel}</div>` : ''}
                </div>
                ${r.type ? html`<div class="cp-result-type">${r.type}</div>` : ''}
              </div>
            `)}
            ${results.length === 0 && query ? html`<div class="cp-no-results">No results found</div>` : ''}
          </div>
          <div class="cp-footer">
            <span class="cp-hint"><strong>↑↓</strong> to navigate</span>
            <span class="cp-hint"><strong>↵</strong> to select</span>
          </div>
        </div>
      </div>
    `;
  }

  afterRender() {
    if (!this.state.isOpen) return;

    const input = this.$('#cp-input');
    input?.focus();

    input?.addEventListener('input', (e) => {
      const q = e.target.value;
      this.setState({ query: q, selectedIndex: 0 });
      this._performSearch(q);
    });

    this.$('#cp-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'cp-overlay') this.close();
    });

    this.$$('.cp-result-item').forEach(item => {
      item.addEventListener('mouseenter', () => {
        this.setState({ selectedIndex: parseInt(item.dataset.index, 10) });
      });
      item.addEventListener('click', () => this._selectCurrent());
    });

    this.$('#cp-dialog')?.addEventListener('keydown', this._onKeyDown);
  }

  mount() {
    super.mount();
    document.addEventListener('keydown', this._onGlobalKeyDown);
  }

  unmount() {
    document.removeEventListener('keydown', this._onGlobalKeyDown);
    super.unmount();
  }

  open() {
    this.setState({ isOpen: true, query: '', results: this._getDefaultResults(), selectedIndex: 0 });
    acquireScrollLock(this);
  }

  close() {
    this.setState({ isOpen: false });
    releaseScrollLock(this);
  }

  beforeUnmount() {
    // A page setState() unmounts this palette without ever calling close(); the
    // lock has to come off here or the page stays unscrollable (p-overlay-scroll-lock-leak).
    releaseScrollLock(this);
  }

  _onKeyDownGlobal(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      this.open();
    }
    if (e.key === 'Escape' && this.state.isOpen) {
      this.close();
    }
  }

  _onKeyDown(e) {
    const { results, selectedIndex } = this.state;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.setState({ selectedIndex: (selectedIndex + 1) % results.length });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.setState({ selectedIndex: (selectedIndex - 1 + results.length) % results.length });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this._selectCurrent();
    }
  }

  _selectCurrent() {
    const item = this.state.results[this.state.selectedIndex];
    if (item) {
      this.close();
      if (item.href.startsWith('http')) {
        window.open(item.href, '_blank');
      } else {
        navigate(item.href);
      }
    }
  }

  _getDefaultResults() {
    return STATIC_PAGES.map(p => ({ ...p, type: 'Page' }));
  }

  async _search(q) {
    if (!q) {
      this.setState({ results: this._getDefaultResults() });
      return;
    }

    try {
      const [postsResp, tagsResp] = await Promise.all([
        listPosts({ q, per_page: 5 }).catch(() => ({ posts: [] })),
        listTags({ q, per_page: 5 }).catch(() => ({ tags: [] }))
      ]);

      const posts = (postsResp.posts || postsResp.items || []).map(p => ({
        label: p.title,
        sublabel: p.slug,
        href: `/light/posts/${p.id}/edit`,
        icon: POSTS_SVG,
        type: 'Post'
      }));

      const tags = (tagsResp.tags || []).map(t => ({
        label: t.name,
        sublabel: t.name_path,
        href: `/light/tags?search=${encodeURIComponent(t.slug)}`,
        icon: TAGS_SVG,
        type: 'Tag'
      }));

      const pages = STATIC_PAGES.filter(p => p.label.toLowerCase().includes(q.toLowerCase()))
        .map(p => ({ ...p, type: 'Page' }));

      this.setState({ results: [...pages, ...posts, ...tags].slice(0, 10) });
    } catch (err) {
      console.error('Command palette search failed', err);
    }
  }
}
