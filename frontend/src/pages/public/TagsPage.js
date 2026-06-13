/**
 * TagsPage — full tag directory with hierarchy.
 *
 * Fetches: GET /api/pages/tags
 * Props (from router): { params, query }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { getTagsPage } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, setCanonical, removeCanonical } from '../../utils/helpers.js';
import { buildTagIndex, renderTagLink, setupTagFlyout } from '../../utils/tags.js';
import { LOCK_SVG, CHEVRON_SVG, SEARCH_SVG } from '../../utils/icons.js';

export default class TagsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, tags: [], total: 0, error: null, filter: '' };
  }

  render() {
    const { loading, tags, total, error, filter } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading tags…"></div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    if (error) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main">
            <div class="main-container">
               <p class="error-message" role="alert">${escapeHtml(error)}</p>
            </div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    const tagIds = new Set(tags.map((t) => t.id));
    const rootTags = tags.filter((t) => !t.parents?.some((p) => tagIds.has(p.id)));
    const tree = rootTags.map((t) => this._renderTag(t, tags, 0)).join('');

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <header class="tag-header">
              <h1 class="tag-name">All Tags</h1>
              <p class="tag-count">${escapeHtml(String(total))} tags</p>
              
              <div class="tag-filter-box">
                ${SEARCH_SVG}
                <input type="search" id="tag-filter-input" placeholder="Filter tags..." value="${escapeHtml(filter)}" aria-label="Filter tags list">
              </div>
            </header>
            <ul class="tags-tree" role="tree">${tree}</ul>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const navTags = store.get('navTags') || [];
    this.mountChild(PublicHeader, '#header-mount', { settings, navTags, currentPath: '/tags' });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    this._cleanupFlyout?.();
    const tree = this.$('.tags-tree');
    if (tree) {
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      this._cleanupFlyout = setupTagFlyout(tree, tagIndex, navigate);
    }

    // Filter logic
    const filterInput = this.$('#tag-filter-input');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase().trim();
        this.state.filter = val;
        this._filterTree(val);
      });
      if (this.state.filter) filterInput.focus();
    }

    // Collapse logic
    this.container.querySelectorAll('.toggle-branch').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const item = btn.closest('.tags-tree-item');
        const isExpanded = item.getAttribute('aria-expanded') === 'true';
        item.setAttribute('aria-expanded', String(!isExpanded));
      });
    });
  }

  _filterTree(query) {
    const items = this.container.querySelectorAll('.tags-tree-item');
    items.forEach(item => {
      const name = item.querySelector('.tag-link .name')?.textContent?.toLowerCase() || '';
      const slug = item.querySelector('.tag-link')?.getAttribute('href')?.toLowerCase() || '';
      const match = !query || name.includes(query) || slug.includes(query);
      
      // If it matches, show it and all its parents
      if (match && query) {
        item.classList.add('is-match');
        item.classList.remove('is-hidden');
        let parent = item.parentElement.closest('.tags-tree-item');
        while (parent) {
          parent.classList.remove('is-hidden');
          parent.setAttribute('aria-expanded', 'true');
          parent = parent.parentElement.closest('.tags-tree-item');
        }
      } else {
        item.classList.remove('is-match');
        if (query) item.classList.add('is-hidden');
        else item.classList.remove('is-hidden');
      }
    });
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
    removeCanonical();
  }

  mount() {
    super.mount();
    this._load();
  }

  _renderTag(tag, allTags, depth) {
    const childTags = (tag.children || [])
      .map((child) => allTags.find((t) => t.id === child.id))
      .filter(Boolean);

    const childrenHtml = childTags
      .map((child) => this._renderTag(child, allTags, depth + 1))
      .join('');

    const count = tag.post_count ? ` <span class="tag-count">(${escapeHtml(String(tag.post_count))})</span>` : '';
    const lockPrefix = tag.is_hidden ? LOCK_SVG : '';

    // Collapse toggle is a sibling of the tag link inside .tags-tree-row
    // (not nested inside the <a>) so that the chevron-rotation and row-flex
    // CSS in tag-archive.css applies and the button stays valid HTML.
    const toggle = childTags.length
      ? `<button class="toggle-branch" aria-label="Toggle branch">${CHEVRON_SVG}</button>`
      : '';

    // Wrap the name in a .name span so the filter logic can match on it.
    const link = renderTagLink(tag, {
      extra: `tags-tree-link${tag.is_hidden ? ' is-hidden' : ''}`,
      prefix: `${lockPrefix}<span class="name">`,
      suffix: `</span>${count}`,
    });

    return `
      <li class="tags-tree-item" role="treeitem" aria-expanded="true">
        <div class="tags-tree-row">${toggle}${link}</div>
        ${tag.description ? `<p class="tags-tree-desc">${escapeHtml(tag.description)}</p>` : ''}
        ${childrenHtml ? `<ul class="tags-tree-children" role="group">${childrenHtml}</ul>` : ''}
      </li>`;
  }

  async _load() {
    try {
      const { tags, total } = await getTagsPage();
      document.title = 'Tags';
      setCanonical(`${window.location.origin}/tags`);
      this.setState({ loading: false, tags, total, error: null });
    } catch (err) {
      this.setState({ loading: false, tags: [], total: 0, error: err.message || 'Failed to load tags.' });
    }
  }
}
