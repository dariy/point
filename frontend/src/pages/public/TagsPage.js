/**
 * TagsPage — interactive force-directed tag graph.
 *
 * Fetches: GET /api/pages/graph
 * Renders four node kinds (plain tag / year-tag / geo-tag / post) and two edge
 * kinds (parent/child hierarchy + post→tag membership) on a <canvas> via the
 * dependency-free TagGraph controller. Node size scales with degree; nodes are
 * draggable; the view supports zoom/pan; the search box highlights tag nodes.
 *
 * A visually-hidden alphabetical tag list is kept as the keyboard / screen-reader
 * fallback, since a canvas graph is not directly accessible.
 *
 * Props (from router): { params, query }
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { getTagsGraph } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, setCanonical, removeCanonical } from '../../utils/helpers.js';
import { SEARCH_SVG } from '../../utils/icons.js';
import { TagGraph } from '../../utils/tagGraph.js';

export default class TagsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, data: null, total: 0, error: null, filter: '' };
    this._graph = null;
    this._resizeObs = null;
    this._themeListener = null;
  }

  render() {
    const { loading, data, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper site-wrapper--graph">
          <div id="header-mount"></div>
          <main class="site-main site-main--graph" aria-busy="true">
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

    const tags = (data && data.tags) || [];
    const fallback = tags
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (t) =>
          `<li><a href="/tags/${escapeHtml(t.slug)}">${escapeHtml(t.name)} (${escapeHtml(String(t.post_count || 0))})</a></li>`,
      )
      .join('');

    return `
      <div class="site-wrapper site-wrapper--graph">
        <div id="header-mount"></div>
        <main class="site-main site-main--graph">
          <div class="tag-graph">
            <canvas id="tag-graph-canvas" role="img" aria-label="Force-directed graph of tags and posts"></canvas>

            <div class="tag-graph-legend">
              <div class="tag-graph-toggles" role="group" aria-label="Show or hide node types">
                <button type="button" class="tg-toggle" data-type="tag" aria-pressed="true"><span class="tg-dot tg-dot--tag"></span>Tag</button>
                <button type="button" class="tg-toggle" data-type="year" aria-pressed="true"><span class="tg-dot tg-dot--year"></span>Year</button>
                <button type="button" class="tg-toggle" data-type="geo" aria-pressed="true"><span class="tg-dot tg-dot--geo"></span>Place</button>
                <button type="button" class="tg-toggle" data-type="post" aria-pressed="true"><span class="tg-dot tg-dot--post"></span>Post</button>
              </div>
              <div class="tag-graph-legend__lines" aria-hidden="true">
                <span class="tg-legend-row"><span class="tg-line tg-line--hier"></span>Parent/child</span>
                <span class="tg-legend-row"><span class="tg-line tg-line--memb"></span>Shared post</span>
                <span class="tag-graph-legend__hint">Size = connections</span>
              </div>
            </div>

            <div class="tag-graph-controls">
              <button type="button" id="tg-zoom-in" aria-label="Zoom in">+</button>
              <button type="button" id="tg-zoom-out" aria-label="Zoom out">−</button>
              <button type="button" id="tg-reset" aria-label="Reset view">⟳</button>
            </div>
          </div>

          <ul class="sr-only" aria-label="All tags">${fallback}</ul>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const navTags = store.get('navTags') || [];
    const loaded = !this.state.loading && this.state.data && !this.state.error;

    // Once the graph is loaded, surface "All tags (N)" as the breadcrumb and the
    // highlight filter inline in the header — keeping the page body for the graph.
    const filterSlot = loaded
      ? `<div class="tag-filter-box header-tag-filter">
           ${SEARCH_SVG}
           <input type="search" id="tag-filter-input" placeholder="Highlight tags…" value="${escapeHtml(this.state.filter)}" aria-label="Highlight tags in the graph">
         </div>`
      : '';

    this.mountChild(PublicHeader, '#header-mount', {
      settings,
      navTags,
      currentPath: '/tags',
      breadcrumb: loaded ? [{ name: `All tags (${this.state.total})` }] : [],
      slot: filterSlot,
    });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (this.state.loading) {
      this._load();
      return;
    }
    if (this.state.error || !this.state.data) return;

    this._initGraph();

    const filterInput = this.$('#tag-filter-input');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        this.state.filter = e.target.value;
        this._graph?.setFilter(this.state.filter);
      });
      if (this.state.filter) {
        filterInput.focus();
        this._graph?.setFilter(this.state.filter);
      }
    }

    this.$('#tg-zoom-in')?.addEventListener('click', () => this._graph?.zoomBy(1.25));
    this.$('#tg-zoom-out')?.addEventListener('click', () => this._graph?.zoomBy(1 / 1.25));
    this.$('#tg-reset')?.addEventListener('click', () => this._graph?.resetView());

    // Node-type toggles (Tag / Year / Place / Post) — show or hide each kind.
    this.container.querySelectorAll('.tg-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        const nowOff = btn.getAttribute('aria-pressed') === 'true';
        btn.setAttribute('aria-pressed', String(!nowOff));
        btn.classList.toggle('is-off', nowOff);
        this._graph?.setTypeHidden(type, nowOff);
      });
    });
  }

  _initGraph() {
    const canvas = this.$('#tag-graph-canvas');
    if (!canvas) return;

    this._graph = new TagGraph(canvas, this.state.data, {
      onNavigate: (href) => navigate(href),
    });
    this._graph.start();

    this._resizeObs = new ResizeObserver(() => this._graph?.resize());
    this._resizeObs.observe(canvas);

    this._themeListener = () => this._graph?.refreshTheme();
    document.addEventListener('themechange', this._themeListener);
  }

  _teardownGraph() {
    this._resizeObs?.disconnect();
    this._resizeObs = null;
    if (this._themeListener) {
      document.removeEventListener('themechange', this._themeListener);
      this._themeListener = null;
    }
    this._graph?.destroy();
    this._graph = null;
  }

  beforeRender() {
    // Runs before every re-render (incl. the loading → loaded transition).
    this._teardownGraph();
  }

  beforeUnmount() {
    this._teardownGraph();
    removeCanonical();
  }

  async _load() {
    try {
      const data = await getTagsGraph();
      document.title = 'Tags';
      setCanonical(`${window.location.origin}/tags`);
      this.setState({
        loading: false,
        data,
        total: (data.tags || []).length,
        error: null,
      });
    } catch (err) {
      this.setState({ loading: false, data: null, total: 0, error: err.message || 'Failed to load tags.' });
    }
  }
}
