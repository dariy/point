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
import { escapeHtml } from '../../utils/helpers.js';

export default class TagsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, tags: [], total: 0, error: null };
  }

  render() {
    const { loading, tags, total, error } = this.state;

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
            <p class="error-message" role="alert">${escapeHtml(error)}</p>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    // Render only top-level tags (no parents); children rendered recursively.
    const rootTags = tags.filter((t) => !t.parents?.length);
    const tree = rootTags.map((t) => this._renderTag(t, tags, 0)).join('');

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <header class="tag-header">
              <h1 class="tag-name">All Tags</h1>
              <p class="tag-count">${escapeHtml(String(total))} tags</p>
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
  }

  mount() {
    super.mount();
    this._load();
  }

  /**
   * Recursively render a tag and its children.
   * @param {object} tag
   * @param {object[]} allTags  Full tag list for resolving children by ID
   * @param {number}   depth
   */
  _renderTag(tag, allTags, depth) {
    if (tag.is_hidden) return '';

    const children = (tag.children || [])
      .map((child) => allTags.find((t) => t.id === child.id))
      .filter(Boolean)
      .map((child) => this._renderTag(child, allTags, depth + 1))
      .join('');

    const count = tag.post_count ? ` <span class="tag-count">(${escapeHtml(String(tag.post_count))})</span>` : '';
    const important = tag.is_important ? ' tag-important' : '';

    return `
      <li class="tags-tree-item${important}" role="treeitem" aria-expanded="${children ? 'true' : 'false'}">
        <a href="/tag/${escapeHtml(tag.slug)}" class="tags-tree-link">
          ${escapeHtml(tag.name)}${count}
        </a>
        ${tag.description ? `<p class="tags-tree-desc">${escapeHtml(tag.description)}</p>` : ''}
        ${children ? `<ul class="tags-tree-children" role="group">${children}</ul>` : ''}
      </li>`;
  }

  async _load() {
    try {
      const { tags, total } = await getTagsPage();
      document.title = 'Tags';
      this.setState({ loading: false, tags, total, error: null });
    } catch (err) {
      this.setState({ loading: false, tags: [], total: 0, error: err.message || 'Failed to load tags.' });
    }
  }
}
