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
import { Timeline } from '../../components/public/Timeline.js';
import { ViewContext } from '../../utils/viewContext.js';

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
        <div id="timeline-mount"></div>
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
    this._updateBreadcrumb(null);
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (this.state.loading) {
      this._load();
      return;
    }

    this._canShowTimeline = settings.timeline_mode === 'all' || (store.get('user') && settings.timeline_mode === 'hidden');
    if (this._canShowTimeline) {
      const vc = ViewContext.current();
      this._timeline = this.mountChild(Timeline, '#timeline-mount', {
        mode: 'filter',
        initialRange: vc.years ? { from: vc.years[0], to: vc.years[1] } : undefined,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
        total: this.state.total,
      });
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

    // Apply URL selection on initial load if query exists
    this._applyUrlSelection();
  }

  onRouteUpdate(params, query) {
    const oldQuery = this.props.query || {};
    this.props.query = query || {};
    if (oldQuery.timeline !== query.timeline) {
      this.setState({ loading: true });
    } else {
      this._applyUrlSelection();
    }
  }

  _onTimelineRangeChange({ from, to, isFullExtent }) {
    const years = isFullExtent ? null : [from, to];
    const vc = ViewContext.current();
    const same = years
      ? vc.years && vc.years[0] === years[0] && vc.years[1] === years[1]
      : !vc.years;
    if (same) return;

    const slug = Object.keys(this.props.query || {}).find(k => k !== 'timeline') || null;
    let url = '/tags';
    const p = new URLSearchParams();
    if (slug) p.set(slug, '');
    if (years) p.set('timeline', `${years[0]}-${years[1]}`);
    
    let searchStr = p.toString();
    // remove trailing = for flag params
    searchStr = searchStr.replace(/=&/g, '&').replace(/=$/, '');
    if (searchStr) url += '?' + searchStr;
    navigate(url);
  }

  _onGraphSelect(node) {
    if (node && node.type !== 'post') {
      navigate('/tags?' + node.slug);
    } else {
      navigate('/tags');
    }
  }

  _applyUrlSelection() {
    if (!this._graph) return;
    const slug = Object.keys(this.props.query || {}).find(k => k !== 'timeline') || null;
    const node = this._graph.selectNodeBySlug(slug);
    this._updateBreadcrumb(node);
  }

  _updateBreadcrumb(node) {
    const loaded = !this.state.loading && this.state.data && !this.state.error;
    
    let breadcrumb = loaded ? [{ name: `All tags (${this.state.total})` }] : [];
    if (loaded && node) {
      const stats = this._graph?.getSelectionStats();
      if (stats) {
        breadcrumb = [
          { name: 'All tags', url: '/tags' },
          { name: `${node.name} (${stats.tagCount} tags, ${stats.postCount} posts)` }
        ];
      }
    }

    const settings = store.get('settings') || {};
    const navTags = store.get('navTags') || [];
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
      breadcrumb,
      slot: filterSlot,
    });
  }

  _initGraph() {
    const canvas = this.$('#tag-graph-canvas');
    if (!canvas) return;

    this._graph = new TagGraph(canvas, this.state.data, {
      onNavigate: (href) => navigate(href),
      onSelect: (node) => this._onGraphSelect(node)
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
      const vc = ViewContext.current();
      const params = {};
      if (vc.years) {
        params.year_from = vc.years[0];
        params.year_to = vc.years[1];
      }
      const data = await getTagsGraph(params);
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
