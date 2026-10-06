import { getRoute } from '../store.ts';
import { navigate } from './helpers.ts';

/** `url` plus the `atlas` and `view` parameters of the current location. */
function carryAtlasParams(url: string): string {
  const from = new URLSearchParams(window.location.search);
  const [path = '', search = ''] = url.split('?');
  const params = new URLSearchParams(search);
  for (const key of ['atlas', 'view']) {
    const value = from.get(key);
    if (value !== null) params.set(key, value);
  }
  const out = params.toString();
  return out ? `${path}?${out}` : path;
}

/**
 * ViewContext — unified filter and navigation state for the public site.
 *
 * Owns { tag, years, query, page, postSlug } parsed from / serialized to the URL.
 * Components read from the context and emit changes to it; the context
 * then performs the navigation.
 */
export class ViewContext {
  path: string;
  tag: string | null;
  /** [startYear, endYear] */
  years: [number, number] | null;
  query: string | null;
  /** Feed page. 1 is the newest published posts; 0 and below
   *  are the owner's scheduled queue extending to the left of it, so this is
   *  parsed as a signed integer rather than defaulted through `|| 1`. */
  page: number;
  /** Posts per page — device-fit, persisted in the URL. */
  perPage: number | null;
  /** Post slug */
  postSlug: string | null;
  /** Geo-tag slug picked on the atlas map; filters the home list (?place=). */
  place: string | null;
  /** Navigation trail (ancestor slug chain, `/`-joined)
   *  carried so the server can build breadcrumbs for the drilled branch. */
  navPath: string | null;

  constructor(pathname: string, query: Record<string, string>) {
    this.path = pathname;
    this.tag = null;
    this.years = null;
    this.query = query.q || null;
    this.page = Number.isInteger(parseInt(query.page, 10))
      ? parseInt(query.page, 10)
      : 1;
    this.perPage = parseInt(query.per_page, 10) || null;
    this.postSlug = null;
    this.place = query.place || null;
    this.navPath = query.path || null;

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

  /** Get the current context from the store. */
  static current(): ViewContext {
    const route: {
      pathname: string;
      query: Record<string, string>;
    } = getRoute() || { pathname: window.location.pathname, query: {} };
    return new ViewContext(route.pathname, route.query);
  }

  /** Navigate to a new context by merging changes into the current one. */
  static update(
    changes: Partial<{
      tag: string | null;
      navPath: string | null;
      years: [number, number] | null;
      query: string | null;
      page: number;
      per_page: number;
      postSlug: string | null;
      place: string | null;
    }>,
    { replace = false }: { replace?: boolean } = {},
  ) {
    const next = ViewContext.current();

    // Apply changes
    if ('tag' in changes) next.tag = changes.tag ?? null;
    // The navigation trail belongs to a specific tag: honour an explicit value,
    // otherwise drop any stale trail when the tag itself changes.
    if ('navPath' in changes) next.navPath = changes.navPath ?? null;
    else if ('tag' in changes) next.navPath = null;
    if ('years' in changes) next.years = changes.years ?? null;
    if ('query' in changes) next.query = changes.query ?? null;
    if ('page' in changes) next.page = changes.page ?? next.page;
    if ('per_page' in changes) next.perPage = changes.per_page ?? null;
    if ('postSlug' in changes) next.postSlug = changes.postSlug ?? null;
    if ('place' in changes) next.place = changes.place ?? null;

    // Reset page to 1 if primary filters change, unless page was explicitly provided
    const filtersChanged = ('tag' in changes || 'query' in changes);
    if ((filtersChanged || 'place' in changes || 'years' in changes) && !('page' in changes)) {
      next.page = 1;
    }

    // Perform navigation. The map layer's state and viewport ride on the URL
    // through a page or fit change of the same list; a new filter starts in `list`.
    const url = next.toUrl();
    navigate(filtersChanged ? url : carryAtlasParams(url), { replace });
  }

  /** Serialize context back to a URL. */
  toUrl(): string {
    let path = '/';
    const params = new URLSearchParams();

    // Tags module view (tag cloud / map / atlas are all served at /tags).
    // Carries only the timeline year range as a query param. A search leaves
    // the module entirely, so it must not be short-circuited back to /tags.
    // /map is the same module under its own path and keeps it the same way.
    const modulePath = this.path.replace(/\/$/, '');
    if (!this.query && (modulePath === '/tags' || modulePath === '/map')) {
      if (this.years) {
        params.set('timeline', `${this.years[0]}-${this.years[1]}`);
      }
      const tagsSearch = params.toString();
      return tagsSearch ? `${modulePath}?${tagsSearch}` : modulePath;
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
      if (this.navPath) params.set('path', this.navPath);
    }

    // Single post view (may be in context of a tag). A search supersedes it:
    // otherwise searching while a post is open re-serializes back to that post
    // and the results never load.
    if (this.postSlug && !this.query) {
      if (path.startsWith('/tags/')) {
        params.set('slug', this.postSlug);
      } else {
        path = `/posts/${encodeURIComponent(this.postSlug)}`;
      }
    }

    // The atlas place filter only narrows the home list.
    if (this.place && path === '/') params.set('place', this.place);

    // Common filters
    if (this.years) {
      params.set('timeline', `${this.years[0]}-${this.years[1]}`);
    }

    // Page 1 is the default and stays out of the URL; every other page —
    // including the scheduled queue's 0, -1, -2 … — is serialized.
    if (this.page !== 1) {
      params.set('page', this.page.toString());
    }

    if (this.perPage) {
      params.set('per_page', this.perPage.toString());
    }

    const search = params.toString();
    return search ? `${path}?${search}` : path;
  }

  /** Check if the context is empty (homepage, no filters). */
  isDefault(): boolean {
    return !this.tag && !this.years && !this.query && this.page === 1 && !this.postSlug;
  }
}
