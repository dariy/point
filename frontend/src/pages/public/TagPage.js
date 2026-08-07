/**
 * TagPage — posts filtered by a single tag, with breadcrumb navigation.
 *
 * Grid mode (no query.slug):  GET /api/pages/tags/:slug
 * Post mode  (query.slug set): GET /api/pages/tags/:slug  +  GET /api/posts/slug/:slug
 *
 * In post mode the page renders the specific post in immersive layout, with
 * prev/next navigation scoped to this tag's post list.  URLs take the form:
 *   /tags/2018?slug=some-post-slug
 *
 * Props (from router): { params: { slug }, query: { page, slug } }
 */

import { Component } from "../../components/Component.js";

import { PostGrid } from "../../components/public/PostGrid.js";
import {
  PostContent,
  shouldUseImmersive,
} from "../../components/public/PostContent.js";
import { Pagination } from "../../components/shared/Pagination.js";
import { pluginHost } from "../../core/pluginHost.js";
import { getTagPage } from "../../api/pages.js";
import { getPostBySlug, getPostNavigation } from "../../api/posts.js";
import { store } from "../../store.js";
import {
  escapeHtml,
  isShortViewport,
  setCanonical,
  removeCanonical,
} from "../../utils/helpers.js";
import { GridPager } from "../../core/gridPager.js";
import { ViewContext } from "../../utils/viewContext.js";
import { enterImmersive, exitImmersive, decodeImmersiveHash } from "../../utils/immersiveNav.js";
import {
  computePerPage,
  cachedPerPage,
  applyZoomVar,
  watchChromeFit,
  createFitLatch,
} from "../../utils/gridFit.js";

export default class TagPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      data: null,
      post: null,
      error: null,
      forceImmersive: false,
      startIndex: 0,
    };
    // Stops the viewport fit chasing a per_page whose own chrome moves the
    // target — see createFitLatch.
    this._fitLatch = createFitLatch();
    // Swipe/trackpad/keyboard pagination and pinch zoom for the grid — see
    // core/gridPager.js. Shared with HomePage and SearchPage.
    this._pager = new GridPager({
      gridMount: () => this.$("#grid-mount"),
      gestureRoot: () => this.$(".site-main"),
      fetchPosts: async (page) => {
        const slug = this.props.params?.slug;
        if (!slug) return [];
        const data = await getTagPage(slug, this._buildParams({ ...ViewContext.current(), page }));
        return data.posts || [];
      },
      // The ghost's cards must carry the same tag context as the live grid, so a
      // card tapped mid-swipe opens inside this tag rather than standalone.
      cardProps: (_post, page) => ({ tagSlug: this.props.params?.slug || "", tagPage: page }),
      gotoPage: (p) => ViewContext.update({ page: p }),
      onZoomCommit: () => {
        this._fitLatch.reset(); // a new column count is a new question to fit
        this._reconcilePerPage({ fromResize: true });
      },
      isAlive: () => !this._unmounted,
      emptyHtml: '<p class="empty-state">No posts in this tag yet.</p>',
    });
  }

  onRouteUpdate(params, query) {
    // Any URL-driven change invalidates the history entry enterImmersive() pushed.
    this._immersivePushed = false;
    const prevVc = this._loadedVc;
    this.props.params = params;
    this.props.query = query;
    const nextVc = ViewContext.current();
    // A timeline-scope or pagination change within the same tag only affects the
    // post list — refresh it in place rather than remounting the whole page (and
    // the timeline, the visible "blink").
    if (this._canPartialUpdate(prevVc, nextVc)) {
      this._refreshPostContent();
    } else {
      this._load();
    }
  }

  _isPostView() {
    return !!this.props.query?.slug;
  }

  _canPartialUpdate(prev, next) {
    if (!prev || !this.state.data || this.state.error) return false;
    // Switching into/out of the immersive post view changes the whole layout.
    if (prev.postSlug || next.postSlug) return false;
    return prev.tag === next.tag && prev.query === next.query;
  }

  async _refreshPostContent() {
    const vc = ViewContext.current();
    const { slug } = this.props.params || {};
    if (!slug) {
      this._load();
      return;
    }

    // A swipe that committed has already slid the preloaded neighbour grid to
    // centre (the "committed ghost"); we just hand off to the real grid under
    // it with no fade. Otherwise crossfade like post-to-post navigation: fade
    // the current grid out while the next page loads, then fade the fresh grid
    // in.
    // A refit is a resize of the current view, not a move to another one: the
    // posts already on screen stay exactly where they are and only the tail of
    // the list changes. Crossfading it blanked the grid and read as a page
    // turn — it updates in place instead (_applyRefit).
    const refit = this._refitRefresh;
    this._refitRefresh = false;

    const gridMount = this.$("#grid-mount");
    const seamless = this._pager.takeSeamless();
    const fromSwipe = seamless || this._pager.isMidSwipe();
    let fadeOut = Promise.resolve();
    if (gridMount && !fromSwipe && !refit) {
      gridMount.style.transition = "opacity 0.2s ease-in";
      gridMount.style.opacity = "0";
      fadeOut = new Promise((resolve) => setTimeout(resolve, 200));
    }

    let data;
    try {
      data = await getTagPage(slug, this._buildParams(vc));
    } catch (err) {
      const msg =
        err.status === 404 ? "Not found." : err.message || "Failed to load.";
      this.setState({ loading: false, data: null, post: null, error: msg });
      return;
    }
    if (this._unmounted) return;
    await fadeOut;
    if (this._unmounted) return;
    this.state.data = data;
    this.state.error = null;
    this._loadedVc = vc;
    document.title = `${data.tag?.name || slug} — Posts`;
    setCanonical(
      vc.page > 1
        ? `${window.location.origin}/tags/${slug}?page=${vc.page}`
        : `${window.location.origin}/tags/${slug}`,
    );
    // A refit changes neither the timeline's scope nor its total, so it stops
    // here — the grid keeps its cards and the paginator is re-pointed in place.
    if (refit && this._applyRefit()) return;
    this._clearPostContent();
    this._mountPostContent();
    this._timeline?.setScope(
      vc.years ? { from: vc.years[0], to: vc.years[1] } : null,
    );
    this._timeline?.setCount(this.state.data?.pagination?.total ?? this.state.data?.total ?? 0);

    const newGrid = this.$("#grid-mount");
    if (seamless) {
      // The real grid is mounted and centred directly under the committed ghost;
      // hand off to it — identical pixels, so no blink.
      this._pager.finishHandoff();
    } else if (newGrid) {
      // Fade the freshly-mounted grid in. _mountPostContent() reset the mount's
      // inline styles, so we start from a clean opacity:0 and transition up.
      newGrid.style.transition = "none";
      newGrid.style.opacity = "0";
      void newGrid.offsetWidth; // force reflow so the next change animates
      newGrid.style.transition = "opacity 0.2s ease-out";
      newGrid.style.opacity = "1";
    }
  }

  _minPerPage() {
    return (store.get("settings") || {}).posts_per_page || 10;
  }

  _buildParams(vc) {
    // per_page is the device-fit value from the URL, or the cached estimate for
    // a fresh load that hasn't been reconciled against the real grid yet.
    const perPage = vc.perPage || cachedPerPage(this._minPerPage());
    this._loadedPerPage = perPage;
    const params = { page: vc.page, per_page: perPage };
    if (vc.years) {
      params.year_from = vc.years[0];
      params.year_to = vc.years[1];
    }
    if (vc.query) params.q = vc.query;
    // Carry the explicit navigation path so the server can build breadcrumbs
    // matching the branch the user drilled through (tags form a DAG).
    if (this.props.query?.path) params.path = this.props.query.path;
    return params;
  }

  // Measure the rendered grid and, if the viewport fits a different number of
  // posts than we loaded, persist the new per_page to the URL — recomputing the
  // page so the first post currently shown stays visible on the resized list.
  _reconcilePerPage({ fromResize = false, settling = false } = {}) {
    if (this._unmounted || this._isPostView()) return;
    const grid = this.$(".posts-grid");
    if (!grid) return;
    applyZoomVar(); // reclamp the zoom column count to the current viewport
    const vc = ViewContext.current();
    // An explicit per_page in the URL is reproduced as-is on load; only an
    // actual resize re-fits it to the new window. A settling pass is the
    // exception that is not a new decision: it re-measures a value THIS mount
    // computed (_fitOwned) now that the chrome around the grid has finished
    // laying out, so a hand-typed ?per_page= is still reproduced untouched.
    if (vc.perPage && !fromResize && !(settling && this._fitOwned)) return;
    const fit = computePerPage(this._minPerPage(), grid);
    const current = this._loadedPerPage || fit;
    const next = this._fitLatch.accept(current, fit);
    if (next === null) return;
    const firstIndex = (vc.page - 1) * current;
    const newPage = Math.floor(firstIndex / next) + 1;
    this._fitOwned = true;
    // Tells the refresh this update provokes that it is a refit, not a
    // navigation — see _refreshPostContent.
    this._refitRefresh = true;
    ViewContext.update({ per_page: next, page: newPage }, { replace: true });
  }

  _onResize() {
    // Reset on the event, not on the debounced re-fit: the chrome observer fires
    // sooner than 200ms, and a settling pass that ran against the old latch
    // would have its decision cleared out from under it — one whole extra
    // flicker cycle before the new viewport settles.
    this._fitLatch.reset();
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this._reconcilePerPage({ fromResize: true }), 200);
  }

  /** (Re)arm the settling re-fit for the chrome around the grid — see watchChromeFit. */
  _watchChrome() {
    this._unwatchChrome?.();
    this._unwatchChrome = watchChromeFit(this.container, () => this._reconcilePerPage({ settling: true }));
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading…"></div>
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

    if (this._isPostView()) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main">
            <div class="main-container">
              <div id="content-mount"></div>
            </div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    return `
      <div class="site-wrapper tags-page">
        <div id="header-mount"></div>
        <div id="timeline-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount" class="grid-expand-mount"></div>
            <div id="pagination-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }
  afterRender() {
    // Reset the footer paginator's feed; _mountPostContent republishes it when
    // the grid view has pages, so the post/loading/error views show none.
    store.set("pagination", null);
    document.body.classList.remove("immersive-layout", "ui-hidden", "immersive-overlay-sheet");
    this._pager.disarm();
    const settings = store.get("settings") || {};
    const rootMenu = store.get("navTags") || [];
    const isCustomMenu = settings.nav_menu_mode === "custom";
    // Use the full hierarchical menu tree from the page response so every crumb
    // (site root, ancestors, current tag) can resolve its children for ▾ carets.
    // Fall back to the store's navTags if the page hasn't loaded yet.
    const navTags = isCustomMenu ? rootMenu : (this.state.data?.menu || rootMenu);
    const slug = this.props.params?.slug || "";
    const { data, post } = this.state;

    // One condition, used both to mount the timeline and to tell the header it
    // is there: a post view or an error page renders none, and the header must
    // not drop the year crumb on the strength of a timeline that never appears.
    const canShowTimeline =
      pluginHost.hasSlot("timeline") &&
      !this._isPostView() &&
      !this.state.loading &&
      !this.state.error;
    this._canShowTimeline = canShowTimeline;
    if (canShowTimeline) {
      const vc = ViewContext.current();
      const total = this.state.data?.pagination?.total || this.state.data?.total || 0;
      pluginHost.fill("timeline", this.$("#timeline-mount"), {
        mode: "filter",
        initialRange: vc.years ? { from: vc.years[0], to: vc.years[1] } : undefined,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
        total,
      }).then((comps) => {
        if (comps[0] && !this._unmounted) {
          this._timeline = comps[0];
          this._children.push(comps[0]);
        }
      });
    }

    // Build breadcrumb: ancestors are links, current tag is the non-linked tail.
    // Preserve any server-provided `href` — when a navigation `path` is active
    // each ancestor crumb carries its own truncated path so clicking up the
    // trail keeps the navigated branch.
    const tag = data?.tag;
    const breadcrumbs = data?.breadcrumbs || [];
    const pathSlugs = (this.props.query?.path || "")
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    // Self-link for the current tag carries the full navigated path.
    const currentHref = tag
      ? pathSlugs.length
        ? `/tags/${tag.slug}?path=${pathSlugs.join("/")}`
        : `/tags/${tag.slug}`
      : null;
    const lastCrumbIsCurrentTag =
      breadcrumbs.length > 0 &&
      breadcrumbs[breadcrumbs.length - 1]?.slug === tag?.slug;
    const mapCrumb = (bc) => ({
      name: bc.name,
      slug: bc.slug,
      is_hidden: bc.is_hidden,
      href: bc.href,
    });
    const computedBreadcrumb = lastCrumbIsCurrentTag
      ? breadcrumbs.map(mapCrumb)
      : [
          ...breadcrumbs.map(mapCrumb),
          ...(tag
            ? [
                {
                  name: tag.name,
                  slug: tag.slug,
                  is_hidden: tag.is_hidden,
                  href: currentHref,
                },
              ]
            : []),
        ];
    const bcCacheKey = `bc:tag:${slug}`;
    if (data) store.set(bcCacheKey, computedBreadcrumb);
    const breadcrumb = computedBreadcrumb.length
      ? computedBreadcrumb
      : store.get(bcCacheKey) || [];

    if (this._isPostView() && post) {
      // ── Post immersive view within tag context ──────────────────────────────
      // Prev/next come from the tag-scoped navigation endpoint so the immersive
      // carousel crosses page boundaries and spans the whole tag collection.
      // Fall back to the loaded page's neighbours if the nav fetch is absent.
      const posts = data?.posts || [];
      const postIndex = posts.findIndex((p) => p.slug === post.slug);
      const nav = this.state.nav;
      const prevPost = nav
        ? nav.prev
        : postIndex > 0 ? posts[postIndex - 1] : null;
      const nextPost = nav
        ? nav.next
        : postIndex !== -1 && postIndex < posts.length - 1
          ? posts[postIndex + 1]
          : null;

      const immersive = this.state.forceImmersive || shouldUseImmersive(post);
      const headerBreadcrumb = post
        ? [...breadcrumb, { name: post.title, slug: null }]
        : breadcrumb;

      pluginHost.fill("header", this.$("#header-mount"), {
        settings,
        navTags: immersive && !isCustomMenu ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb: headerBreadcrumb,
        currentPath: window.location.pathname,
        editUrl: post ? `/light/posts/${post.id}/edit` : null,
        total: this.state.data?.pagination?.total || this.state.data?.total || 0,
        timelineVisible: this._canShowTimeline && !isShortViewport(),
      }).then(comps => {
        if (comps[0] && !this._unmounted) this._children.push(comps[0]);
      });

      pluginHost.fill("footer", this.$("#footer-mount"), {
        settings,
        immersiveTags: immersive ? post.tags || [] : [],
        immersiveNav: immersive ? { prev: prevPost, next: nextPost } : null,
        tagSlug: immersive ? slug : null,
        exifMedia: immersive ? post.media || [] : [],
      }).then(comps => {
        if (comps[0] && !this._unmounted) this._children.push(comps[0]);
      });

      this.mountChild(PostContent, "#content-mount", {
        post,
        showViewCount: !!settings.show_view_counts,
        showImmersiveExcerpt: settings.show_immersive_excerpt !== "false",
        prevPost,
        nextPost,
        tagSlug: slug,
        forceImmersive: immersive,
        startIndex: this.state.startIndex,
        onExitImmersive: () => exitImmersive(this),
        onEnterImmersive: (idx = 0) => enterImmersive(this, idx),
      });
    } else {
      // ── Grid view ───────────────────────────────────────────────────────────
      pluginHost.fill("header", this.$("#header-mount"), {
        settings,
        navTags: this._isPostView() ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb,
        currentPath: window.location.pathname,
        editUrl: tag ? `/light/tags/${tag.slug}` : null,
        total: this.state.data?.pagination?.total || this.state.data?.total || 0,
        // Hidden timeline ⇒ the year crumb is the only thing left saying the
        // list is filtered — see the same call in HomePage.
        timelineVisible: this._canShowTimeline && !isShortViewport(),
        // Same distraction-free toggle the home grid offers.
        distractionToggle: true,
      }).then(comps => {
        if (comps[0] && !this._unmounted) this._children.push(comps[0]);
      });
      pluginHost.fill("footer", this.$("#footer-mount"), { settings }).then(comps => {
        if (comps[0] && !this._unmounted) this._children.push(comps[0]);
      });

      if (this.state.loading || !data) return;

      this._mountPostContent();
    }
  }

  // Mounts the filter-dependent grid-view content (filter chips, post grid,
  // pagination, swipe gestures). Tracked separately from page chrome so a
  // timeline-scope or page change can refresh just this in place — see
  // _refreshPostContent — without remounting the timeline.
  _mountPostContent() {
    const settings = store.get("settings") || {};
    const slug = this.props.params?.slug || "";
    const page = parseInt(this.props.query?.page || "1", 10);
    const { posts = [], pagination = {} } = this.state.data || {};

    this._postChildren = [];

    // A paginated swipe leaves an inline transform on the grid mount; clear it so
    // the refreshed grid isn't left offset.
    this._pager.resetGridStyles();

    this._postChildren.push(
      this.mountChild(PostGrid, "#grid-mount", {
        posts,
        showViewCount: !!settings.show_view_counts,
        tagSlug: slug,
        tagPage: page,
        emptyMessage: "No posts in this tag yet.",
      }),
    );

    this._syncPagination(pagination);
    this._pager.arm(pagination);

    // After the real grid has laid out, fit per_page to the viewport — then keep
    // watching, because the chrome it has to measure around itself arrives later
    // (see _watchChrome).
    requestAnimationFrame(() => this._reconcilePerPage());
    this._watchChrome();
  }

  /**
   * Mount, update or drop the in-flow paginator for `pagination`, and publish
   * the same state for the footer paginator (on desktop and phone-landscape CSS
   * shows that one instead). Kept apart from _mountPostContent so a refit can
   * re-point it without the grid beside it being rebuilt.
   */
  _syncPagination(pagination) {
    const existing = this._postChildren[1];
    if (pagination.pages > 1) {
      const props = {
        page: pagination.page,
        pages: pagination.pages,
        total: pagination.total,
        onPage: (p) => ViewContext.update({ page: p }),
      };
      if (existing) existing.setProps(props);
      else this._postChildren[1] = this.mountChild(Pagination, "#pagination-mount", props);
    } else if (existing) {
      existing.unmount();
      const at = this._children.indexOf(existing);
      if (at !== -1) this._children.splice(at, 1);
      this._postChildren.length = 1;
    }

    store.set("pagination", pagination.pages > 1
      ? { page: pagination.page, pages: pagination.pages, total: pagination.total }
      : null);
  }

  /**
   * Apply a per_page refit without remounting anything: hand the grid its new
   * tail, re-point the paginator, re-arm the pager on the new page count.
   *
   * @returns {boolean} false when the grid could not take the new list in place
   *   (the lists diverge), leaving the caller to fall back to a remount.
   */
  _applyRefit() {
    const grid = this._postChildren?.[0];
    const { posts = [], pagination = {} } = this.state.data || {};
    if (!grid?.reconcile?.(posts)) return false;
    this._syncPagination(pagination);
    this._pager.arm(pagination);
    this._watchChrome();
    return true;
  }

  _clearPostContent() {
    for (const c of this._postChildren || []) {
      c.unmount();
      const i = this._children.indexOf(c);
      if (i !== -1) this._children.splice(i, 1);
    }
    this._postChildren = [];
    this._pager.disarm();
  }

  beforeUnmount() {
    // Non-grid pages (post, search) share the footer — don't leave a stale
    // paginator feed behind.
    store.set("pagination", null);
    this._pager.destroy();
    clearTimeout(this._resizeTimer);
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    this._unwatchChrome?.();
    this._unwatchChrome = null;
    removeCanonical();
  }

  mount() {
    // Seed the per_page cache from the window size so the first fetch is sized
    // before the grid exists to be measured.
    applyZoomVar(); // reflect a sticky zoom before the first grid paints
    if (!ViewContext.current().perPage) computePerPage(this._minPerPage(), null);
    this._resizeHandler = () => this._onResize();
    window.addEventListener("resize", this._resizeHandler);
    super.mount();
    this._load();
  }

  async _onTimelineRangeChange({ from, to, isFullExtent }) {
    const years = isFullExtent ? null : [from, to];
    const vc = ViewContext.current();
    const same = years
      ? vc.years && vc.years[0] === years[0] && vc.years[1] === years[1]
      : !vc.years;
    if (same) return;
    ViewContext.update({ years });
  }

  async _load() {
    const vc = ViewContext.current();
    this._loadedVc = vc;
    // A full render rebuilds the grid anyway; don't leave the flag set for
    // whatever refresh comes next.
    this._refitRefresh = false;
    const { slug } = this.props.params || {};

    if (!slug) {
      this.setState({ loading: false, error: "Invalid tag URL." });
      return;
    }

    try {
      const data = await getTagPage(slug, this._buildParams(vc));

      if (vc.postSlug) {
        const post = await getPostBySlug(vc.postSlug);
        document.title = `${post.title} — ${data.tag?.name || slug}`;
        setCanonical(`${window.location.origin}/posts/${post.slug}`);

        // Tag-scoped prev/next spans the whole tag collection (all pages), not
        // just the loaded grid page. Optional — fall back to no cross-post nav.
        let nav = null;
        try { nav = await getPostNavigation(post.id, slug); } catch { /* optional */ }

        // The slide hash (#1, #2, …) encodes forced immersive mode + start index.
        const { startIndex, forceImmersive } = decodeImmersiveHash(window.location.hash);

        this.setState({
          loading: false,
          data,
          post,
          nav,
          error: null,
          startIndex,
          forceImmersive,
        });
      } else {
        document.title = `${data.tag?.name || slug} — Posts`;
        const canonicalUrl =
          vc.page > 1
            ? `${window.location.origin}/tags/${slug}?page=${vc.page}`
            : `${window.location.origin}/tags/${slug}`;
        setCanonical(canonicalUrl);
        this.setState({ loading: false, data, post: null, error: null });
      }
    } catch (err) {
      const msg =
        err.status === 404 ? "Not found." : err.message || "Failed to load.";
      this.setState({ loading: false, data: null, post: null, error: msg });
    }
  }
}
