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
import { PostCard } from "../../components/public/PostCard.js";
import {
  PostContent,
  shouldUseImmersive,
} from "../../components/public/PostContent.js";
import { Pagination } from "../../components/shared/Pagination.js";
import { pluginHost } from "../../core/pluginHost.js";
import { getTagPage } from "../../api/pages.js";
import { getPostBySlug } from "../../api/posts.js";
import { store } from "../../store.js";
import {
  escapeHtml,
  setCanonical,
  removeCanonical,
} from "../../utils/helpers.js";
import {
  GestureController,
  TrackpadDetector,
  rubberBand,
} from "../../core/gestures.js";
import { ViewContext } from "../../utils/viewContext.js";
import { computePerPage, cachedPerPage } from "../../utils/gridFit.js";

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
  }

  onRouteUpdate(params, query) {
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
    const gridMount = this.$("#grid-mount");
    const seamless = this._seamlessSwipe;
    this._seamlessSwipe = false;
    const fromSwipe = seamless || !!(gridMount && gridMount.style.transform);
    let fadeOut = Promise.resolve();
    if (gridMount && !fromSwipe) {
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
    this._clearPostContent();
    this._mountPostContent();
    this._timeline?.setScope(
      vc.years ? { from: vc.years[0], to: vc.years[1] } : null,
    );
    this._timeline?.setCount(this.state.data?.pagination?.total ?? this.state.data?.total ?? 0);

    const newGrid = this.$("#grid-mount");
    if (seamless) {
      // The real grid is now mounted and centred directly under the committed
      // ghost; drop the ghost to reveal it — identical pixels, so no blink.
      this._committedGhost?.remove();
      this._committedGhost = null;
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
  _reconcilePerPage({ fromResize = false } = {}) {
    if (this._unmounted || this._isPostView()) return;
    const grid = this.$(".posts-grid");
    if (!grid) return;
    const vc = ViewContext.current();
    // An explicit per_page in the URL is reproduced as-is on load; only an
    // actual resize re-fits it to the new window.
    if (!fromResize && vc.perPage) return;
    const fit = computePerPage(this._minPerPage(), grid);
    const current = this._loadedPerPage || fit;
    if (fit === current) return;
    const firstIndex = (vc.page - 1) * current;
    const newPage = Math.floor(firstIndex / fit) + 1;
    ViewContext.update({ per_page: fit, page: newPage }, { replace: true });
  }

  _onResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this._reconcilePerPage({ fromResize: true }), 200);
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
    document.body.classList.remove("immersive-layout", "ui-hidden", "immersive-overlay-sheet");
    this._gesture?.destroy();
    this._trackpad?.destroy();
    const settings = store.get("settings") || {};
    const rootMenu = store.get("navTags") || [];
    const isCustomMenu = settings.nav_menu_mode === "custom";
    // Use the full hierarchical menu tree from the page response so every crumb
    // (site root, ancestors, current tag) can resolve its children for ▾ carets.
    // Fall back to the store's navTags if the page hasn't loaded yet.
    const navTags = isCustomMenu ? rootMenu : (this.state.data?.menu || rootMenu);
    const slug = this.props.params?.slug || "";
    const { data, post } = this.state;

    const canShowTimeline = pluginHost.hasSlot("timeline");
    this._canShowTimeline = canShowTimeline;
    if (
      canShowTimeline &&
      !this._isPostView() &&
      !this.state.loading &&
      !this.state.error &&
      pluginHost.hasSlot("timeline")
    ) {
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
      const posts = data?.posts || [];
      const postIndex = posts.findIndex((p) => p.slug === post.slug);
      const prevPost = postIndex > 0 ? posts[postIndex - 1] : null;
      const nextPost =
        postIndex !== -1 && postIndex < posts.length - 1
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
        currentPath: "",
        editUrl: post ? `/light/posts/${post.id}/edit` : null,
        total: this.state.data?.pagination?.total || this.state.data?.total || 0,
        timelineVisible: this._canShowTimeline,
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
        onEnterImmersive: (idx = 0) => {
          const hash = idx === 0 ? "" : `#${idx + 1}`;
          window.history.replaceState(
            null,
            "",
            window.location.pathname + window.location.search + hash,
          );
          this.setState({ forceImmersive: true, startIndex: idx });
        },
      });
    } else {
      // ── Grid view ───────────────────────────────────────────────────────────
      pluginHost.fill("header", this.$("#header-mount"), {
        settings,
        navTags: this._isPostView() ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb,
        currentPath: "",
        editUrl: tag ? `/light/tags/${tag.slug}` : null,
        total: this.state.data?.pagination?.total || this.state.data?.total || 0,
        timelineVisible: this._canShowTimeline,
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
    const gridMountEl = this.$("#grid-mount");
    if (gridMountEl) {
      gridMountEl.style.transform = "";
      gridMountEl.style.opacity = "";
      gridMountEl.style.transition = "";
    }

    this._postChildren.push(
      this.mountChild(PostGrid, "#grid-mount", {
        posts,
        showViewCount: !!settings.show_view_counts,
        useThumbnails: settings.use_thumbnails !== false,
        tagSlug: slug,
        tagPage: page,
        emptyMessage: "No posts in this tag yet.",
      }),
    );

    if (pagination.pages > 1) {
      this._postChildren.push(
        this.mountChild(Pagination, "#pagination-mount", {
          page: pagination.page,
          pages: pagination.pages,
          total: pagination.total,
          onPage: (p) => ViewContext.update({ page: p }),
        }),
      );
    }

    this._setupGestures(pagination);
    this._preloadAdjacentGrids(pagination, slug);

    // After the real grid has laid out, fit per_page to the viewport.
    requestAnimationFrame(() => this._reconcilePerPage());
  }

  _clearPostContent() {
    for (const c of this._postChildren || []) {
      c.unmount();
      const i = this._children.indexOf(c);
      if (i !== -1) this._children.splice(i, 1);
    }
    this._postChildren = [];
    this._gesture?.destroy();
    this._trackpad?.destroy();
    this._clearPageGhosts();
  }

  _setupGestures(pagination) {
    // Always capture horizontal swipes (even on single-page lists) so they
    // rubber-band instead of triggering browser history back/forward.
    const gridMount = this.$("#grid-mount");
    const vw = () => window.innerWidth || 500;
    const atEnd = () => pagination.page >= pagination.pages;
    const atStart = () => pagination.page <= 1;

    this._gesture = new GestureController(this.$(".site-main"), {
      onSwipeMove: (dx, dy) => {
        if (Math.abs(dx) <= Math.abs(dy)) return;
        const dir = dx < 0 ? "next" : "prev";
        const blocked = (dir === "next" && atEnd()) || (dir === "prev" && atStart());
        const tx = blocked ? rubberBand(dx) : dx;
        const ratio = Math.abs(tx) / vw();

        gridMount.style.transition = "none";
        gridMount.style.transform = `translateX(${tx}px)`;

        // Slide the preloaded neighbour grid in from the opposite edge, in
        // lockstep with the outgoing grid — the same "infinite stripe" feel as
        // the immersive post-to-post swipe.
        const ghost = blocked ? null : this._pageGhost(dir);
        gridMount.style.opacity = String(
          ghost ? Math.max(0, 1 - ratio) : Math.max(blocked ? 0.85 : 0.2, 1 - ratio),
        );

        this._clearOtherPeek(dir);
        if (ghost) {
          const offset = dir === "next" ? vw() : -vw();
          ghost.style.transition = "none";
          ghost.style.transform = `translateX(${offset + tx}px)`;
          ghost.style.opacity = String(Math.min(1, ratio));
          ghost.style.zIndex = "10";
          this._peekGhost = ghost;
        }
      },
      onSwipeCancel: () => this._resetGridSwipe(),
      onSwipeCommit: (dir) => {
        // Only horizontal swipes paginate; a vertical swipe is a page scroll.
        if (dir !== "left" && dir !== "right") return;
        const d = dir === "left" ? "next" : "prev";
        if ((d === "next" && atEnd()) || (d === "prev" && atStart())) {
          this._resetGridSwipe();
        } else {
          this._commitPageSwipe(d, pagination);
        }
      },
    });

    this._trackpad = new TrackpadDetector(this.$(".site-main"), {
      onHorizontal: (dir) => {
        if (dir === "left" && pagination.page < pagination.pages) {
          ViewContext.update({ page: pagination.page + 1 });
        } else if (dir === "right" && pagination.page > 1) {
          ViewContext.update({ page: pagination.page - 1 });
        }
      },
    });
  }

  // ── Adjacent-page preloading + swipe peek ──────────────────────────────────

  /** The preloaded ghost grid element for a drag direction, if ready. */
  _pageGhost(dir) {
    return this._pageGhosts?.[dir]?.el || null;
  }

  /**
   * Preload the previous/next page and render its grid into an off-screen ghost
   * element, so a swipe reveals the real next page (not a skeleton) and a
   * committed swipe hands off to it seamlessly. Mirrors MediaViewer's
   * _preloadNeighbors for the immersive carousel.
   */
  async _preloadAdjacentGrids(pagination, slug) {
    this._pageGhosts = this._pageGhosts || { prev: null, next: null };
    const container = this.$("#grid-mount")?.parentElement;
    if (!container || !pagination || pagination.pages <= 1) return;
    const version = (this._ghostVersion = (this._ghostVersion || 0) + 1);
    const vc = ViewContext.current();

    const build = async (dir) => {
      const page = dir === "next" ? pagination.page + 1 : pagination.page - 1;
      if (page < 1 || page > pagination.pages) return;
      let data;
      try {
        data = await getTagPage(slug, this._buildParams({ ...vc, page }));
      } catch {
        return;
      }
      if (this._unmounted || version !== this._ghostVersion) return;
      const el = document.createElement("div");
      el.className = "grid-preview-placeholder";
      el.dataset.edge = dir;
      el.innerHTML = this._buildGridHtml(data.posts || [], slug, page);
      el.style.transform = `translateX(${dir === "next" ? "100%" : "-100%"})`;
      el.style.opacity = "0";
      container.appendChild(el);
      this._pageGhosts[dir] = { page, el };
    };
    await Promise.all([build("prev"), build("next")]);
  }

  /** Build static grid markup (real cards, no listeners) for a ghost preview. */
  _buildGridHtml(posts, slug, page) {
    if (!posts.length) return '<p class="empty-state">No posts in this tag yet.</p>';
    const settings = store.get("settings") || {};
    const heroIndex = posts.findIndex((p) => p.is_featured);
    const dummy = document.createElement("div");
    const slots = posts
      .map((post, i) => {
        const cls = i === heroIndex ? " featured-post" : "";
        const card = new PostCard(dummy, {
          post,
          showViewCount: !!settings.show_view_counts,
          useThumbnails: settings.use_thumbnails !== false,
          isHero: i === heroIndex,
          tagSlug: slug,
          tagPage: page,
        }).render();
        return `<div class="post-card-slot${cls}">${card}</div>`;
      })
      .join("");
    return `<div class="posts-grid">${slots}</div>`;
  }

  /** Remove the off-screen ghost grids and invalidate any in-flight preload. */
  _clearPageGhosts() {
    this._ghostVersion = (this._ghostVersion || 0) + 1;
    if (this._pageGhosts) {
      for (const dir of ["prev", "next"]) {
        this._pageGhosts[dir]?.el?.remove();
        this._pageGhosts[dir] = null;
      }
    }
    this._peekGhost = null;
  }

  /** Snap a ghost peeking from the wrong side back off-screen instantly. */
  _clearOtherPeek(dir) {
    const g = this._peekGhost;
    if (g && g.dataset.edge !== dir) {
      g.style.transition = "none";
      g.style.transform = `translateX(${g.dataset.edge === "next" ? "100%" : "-100%"})`;
      g.style.opacity = "0";
      this._peekGhost = null;
    }
  }

  /** Animate the active grid back and settle the peeking ghost off-screen. */
  _resetGridSwipe() {
    const gridMount = this.$("#grid-mount");
    if (gridMount) {
      gridMount.style.transition = "transform 0.3s ease, opacity 0.3s ease";
      gridMount.style.transform = "";
      gridMount.style.opacity = "1";
    }
    const g = this._peekGhost;
    if (g) {
      const w = window.innerWidth || 500;
      g.style.transition = "transform 0.3s ease, opacity 0.3s ease";
      g.style.transform = `translateX(${g.dataset.edge === "next" ? w : -w}px)`;
      g.style.opacity = "0";
      this._peekGhost = null;
    }
  }

  /**
   * Carry a committed swipe to rest: the active grid finishes sliding off while
   * the preloaded neighbour grid slides to centre, then the route swaps under
   * it — the new page's real grid mounts beneath the ghost and the ghost is
   * dropped, so the motion flows unbroken with no reload blink.
   */
  _commitPageSwipe(dir, pagination) {
    const ghost = this._pageGhost(dir);
    const targetPage = dir === "next" ? pagination.page + 1 : pagination.page - 1;

    // No preloaded grid yet (slow network / just landed): fall back to the
    // plain crossfade by navigating straight away.
    if (!ghost) {
      this._resetGridSwipe();
      ViewContext.update({ page: targetPage });
      return;
    }

    const gridMount = this.$("#grid-mount");
    const w = window.innerWidth || 500;
    const T = "transform 0.28s ease-out, opacity 0.28s ease-out";

    if (gridMount) {
      gridMount.style.transition = T;
      gridMount.style.transform = `translateX(${dir === "next" ? -w : w}px)`;
      gridMount.style.opacity = "0";
    }
    ghost.style.transition = T;
    ghost.style.transform = "translateX(0)";
    ghost.style.opacity = "1";
    ghost.style.zIndex = "11";

    // Hold this ghost on screen across the route swap; _refreshPostContent drops
    // it once the real grid is mounted underneath.
    this._committedGhost = ghost;
    this._pageGhosts[dir] = null;
    this._peekGhost = null;

    setTimeout(() => {
      if (this._unmounted) return;
      this._seamlessSwipe = true;
      ViewContext.update({ page: targetPage });
    }, 280);
  }

  beforeUnmount() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
    this._clearPageGhosts();
    this._committedGhost?.remove();
    this._committedGhost = null;
    clearTimeout(this._resizeTimer);
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    removeCanonical();
  }

  mount() {
    // Seed the per_page cache from the window size so the first fetch is sized
    // before the grid exists to be measured.
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

        // Check for hash to set initial slide index (e.g. #2 -> index 1)
        let startIndex = 0;
        let forceImmersive = false;
        const hash = window.location.hash;
        if (hash && hash.startsWith("#")) {
          const num = parseInt(hash.slice(1), 10);
          if (!isNaN(num) && num > 0) {
            startIndex = Math.max(0, num - 1);
            if (num > 1) forceImmersive = true;
          }
        }

        this.setState({
          loading: false,
          data,
          post,
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
