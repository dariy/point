import { store } from '../store.js';
import { navigate } from './helpers.js';

/**
 * ViewContext — unified filter and navigation state for the public site.
 *
 * Owns { tag, years, query, page, postSlug } parsed from / serialized to the URL.
 * Components read from the context and emit changes to it; the context
 * then performs the navigation.
 */
export class ViewContext {
  /**
   * @param {string} pathname 
   * @param {Record<string, string>} query 
   */
  constructor(pathname, query) {
    /** @type {string} */
    this.path = pathname;
    /** @type {string|null} */
    this.tag = null;
    /** @type {[number, number]|null} [startYear, endYear] */
    this.years = null;
    /** @type {string|null} */
    this.query = query.q || null;
    /** @type {number} */
    this.page = parseInt(query.page, 10) || 1;
    /** @type {number|null} Posts per page — device-fit, persisted in the URL. */
    this.perPage = parseInt(query.per_page, 10) || null;
    /** @type {string|null} Post slug */
    this.postSlug = null;

    // 1. Extract post slug: /posts/:slug
    if (pathname.startsWith('/posts/')) {
      const parts = pathname.split('/');
      this.postSlug = parts[2] ? decodeURIComponent(parts[2]) : null;
    } else if (query.slug) {
      // Or as a query param in /tags/:slug?slug=...
      this.postSlug = query.slug;
    }

    // 2. Extract tag from pathname: /tags/:slug
    if (pathname.startsWith('/tags/')) {
      const parts = pathname.split('/');
      if (parts[2]) {
        this.tag = decodeURIComponent(parts[2]);
      }
    } else if (query.tag) {
      // Also allow tag as a query param (A3: scoped search)
      this.tag = query.tag;
    }

    // 3. Extract years from query (?timeline=). The /tags modules (map/atlas)
    //    and the home/graph views all carry the year range this way.
    if (query.timeline) {
      const parts = query.timeline.split('-');
      if (parts.length === 2) {
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);
        if (!isNaN(start) && !isNaN(end)) {
          this.years = [start, end];
        }
      }
    }
  }

  /**
   * Get the current context from the store.
   * @returns {ViewContext}
   */
  static current() {
    const route = store.get('route') || { pathname: window.location.pathname, query: {} };
    return new ViewContext(route.pathname, route.query);
  }

  /**
   * Navigate to a new context by merging changes into the current one.
   * @param {Partial<{tag: string|null, years: [number, number]|null, query: string|null, page: number, postSlug: string|null}>} changes
   * @param {{ replace?: boolean }} [opts]
   */
  static update(changes, { replace = false } = {}) {
    const next = ViewContext.current();

    // Apply changes
    if ('tag' in changes) next.tag = changes.tag;
    if ('years' in changes) next.years = changes.years;
    if ('query' in changes) next.query = changes.query;
    if ('page' in changes) next.page = changes.page;
    if ('per_page' in changes) next.perPage = changes.per_page;
    if ('postSlug' in changes) next.postSlug = changes.postSlug;

    // Reset page to 1 if primary filters change, unless page was explicitly provided
    const filtersChanged = ('tag' in changes || 'query' in changes || 'years' in changes);
    if (filtersChanged && !('page' in changes)) {
      next.page = 1;
    }

    // Perform navigation
    navigate(next.toUrl(), { replace });
  }

  /**
   * Serialize context back to a URL.
   * @returns {string}
   */
  toUrl() {
    let path = '/';
    const params = new URLSearchParams();

    // Tags module view (tag cloud / map / atlas are all served at /tags).
    // Carries only the timeline year range as a query param.
    if (this.path === '/tags' || this.path === '/tags/') {
      if (this.years) {
        params.set('timeline', `${this.years[0]}-${this.years[1]}`);
      }
      const tagsSearch = params.toString();
      return tagsSearch ? `/tags?${tagsSearch}` : '/tags';
    }

    // Search view
    if (this.query) {
      path = '/search';
      params.set('q', this.query);
      if (this.tag) params.set('tag', this.tag);
    } 
    // Tag view or Home view
    else if (this.tag) {
      path = `/tags/${encodeURIComponent(this.tag)}`;
    }

    // Single post view (may be in context of a tag)
    if (this.postSlug) {
      if (path.startsWith('/tags/')) {
        params.set('slug', this.postSlug);
      } else {
        path = `/posts/${encodeURIComponent(this.postSlug)}`;
      }
    }

    // Common filters
    if (this.years) {
      params.set('timeline', `${this.years[0]}-${this.years[1]}`);
    }

    if (this.page > 1) {
      params.set('page', this.page.toString());
    }

    if (this.perPage) {
      params.set('per_page', this.perPage.toString());
    }

    const search = params.toString();
    return search ? `${path}?${search}` : path;
  }

  /**
   * Check if the context is empty (homepage, no filters).
   * @returns {boolean}
   */
  isDefault() {
    return !this.tag && !this.years && !this.query && this.page === 1 && !this.postSlug;
  }
}
