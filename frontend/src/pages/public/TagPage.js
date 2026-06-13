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
import { PublicHeader } from "../../components/public/PublicHeader.js";
import { PublicFooter } from "../../components/public/PublicFooter.js";
import { PostGrid } from "../../components/public/PostGrid.js";
import {
  PostContent,
  shouldUseImmersive,
} from "../../components/public/PostContent.js";
import { Timeline } from "../../components/public/Timeline.js";
import { Pagination } from "../../components/shared/Pagination.js";
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
} from "../../utils/gestures.js";
import { ViewContext } from "../../utils/viewContext.js";
import { FilterChipsRow } from "../../components/public/FilterChipsRow.js";

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
    this.props.params = params;
    this.props.query = query;
    this._load();
  }

  _isPostView() {
    return !!this.props.query?.slug;
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
        <div id="filter-chips-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount" class="grid-expand-mount"></div>
          </div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }
  afterRender() {
    document.body.classList.remove("immersive-layout", "ui-hidden");
    this._gesture?.destroy();
    this._trackpad?.destroy();
    const settings = store.get("settings") || {};
    const rootMenu = store.get("navTags") || [];
    const navChildren = this.state.data?.nav_children || [];
    const isCustomMenu = settings.nav_menu_mode === "custom";
    const navTags =
      !isCustomMenu && navChildren.length ? navChildren : rootMenu;
    const slug = this.props.params?.slug || "";
    const { data, post } = this.state;

    const canShowTimeline =
      settings.timeline_mode === "all" ||
      (store.get("user") && settings.timeline_mode === "hidden");
    if (
      canShowTimeline &&
      !this._isPostView() &&
      !this.state.loading &&
      !this.state.error
    ) {
      const vc = ViewContext.current();
      this.mountChild(Timeline, "#timeline-mount", {
        mode: "filter",
        initialRange: vc.years ? { from: vc.years[0], to: vc.years[1] } : undefined,
        onRangeChange: (range) => this._onTimelineRangeChange(range),
      });
    }

    const vc = ViewContext.current();
    if (!vc.isDefault() && this.state.data && !this._isPostView()) {
      this.mountChild(FilterChipsRow, "#filter-chips-mount", {
        total: this.state.data.pagination?.total || this.state.data.total || 0,
      });
    }

    // Build breadcrumb: ancestors are links, current tag is the non-linked tail.
    const tag = data?.tag;
    const breadcrumbs = data?.breadcrumbs || [];
    const lastCrumbIsCurrentTag =
      breadcrumbs.length > 0 &&
      breadcrumbs[breadcrumbs.length - 1]?.slug === tag?.slug;
    const computedBreadcrumb = lastCrumbIsCurrentTag
      ? breadcrumbs.map((bc) => ({
          name: bc.name,
          slug: bc.slug,
          is_hidden: bc.is_hidden,
        }))
      : [
          ...breadcrumbs.map((bc) => ({
            name: bc.name,
            slug: bc.slug,
            is_hidden: bc.is_hidden,
          })),
          ...(tag
            ? [{ name: tag.name, slug: tag.slug, is_hidden: tag.is_hidden }]
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

      this.mountChild(PublicHeader, "#header-mount", {
        settings,
        navTags: immersive && !isCustomMenu ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb: headerBreadcrumb,
        currentPath: "",
        editUrl: post ? `/light/posts/${post.id}/edit` : null,
      });

      this.mountChild(PublicFooter, "#footer-mount", {
        settings,
        immersiveTags: immersive ? post.tags || [] : [],
        immersiveNav: immersive ? { prev: prevPost, next: nextPost } : null,
        tagSlug: immersive ? slug : null,
        exifMedia: immersive ? post.media || [] : [],
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
      const page = parseInt(this.props.query?.page || "1", 10);

      this.mountChild(PublicHeader, "#header-mount", {
        settings,
        navTags: this._isPostView() ? [] : navTags,
        currentTagSlug: slug,
        breadcrumb,
        currentPath: "",
        editUrl: tag ? `/light/tags/${tag.slug}` : null,
      });
      this.mountChild(PublicFooter, "#footer-mount", { settings });

      if (this.state.loading || !data) return;

      const { posts = [], pagination = {} } = data;

      this.mountChild(PostGrid, "#grid-mount", {
        posts,
        showViewCount: !!settings.show_view_counts,
        useThumbnails: settings.use_thumbnails !== false,
        tagSlug: slug,
        tagPage: page,
        emptyMessage: "No posts in this tag yet.",
      });

      if (pagination.pages > 1) {
        this.mountChild(Pagination, "#pagination-mount", {
          page: pagination.page,
          pages: pagination.pages,
          total: pagination.total,
          onPage: (p) => ViewContext.update({ page: p }),
        });
      }

      // Always set up gestures so horizontal swipes are captured and rubber-banded
      // even on single-page lists (prevents browser history back/forward).
      {
        const gridMount = this.$("#grid-mount");
        let previewEl = null;
        this._gesture = new GestureController(this.$(".site-main"), {
          onSwipeMove: (dx, dy) => {
            if (Math.abs(dx) > Math.abs(dy)) {
              const blocked =
                (dx < 0 && pagination.page >= pagination.pages) ||
                (dx > 0 && pagination.page <= 1);
              const tx = blocked ? rubberBand(dx) : dx;
              gridMount.style.transform = `translateX(${tx}px)`;
              gridMount.style.transition = "none";
              gridMount.style.opacity = blocked
                ? Math.max(0.85, 1 - Math.abs(tx) / (window.innerWidth || 500))
                : Math.max(0.2, 1 - Math.abs(tx) / (window.innerWidth || 500));

              if (blocked) return;

              if (!previewEl) {
                previewEl = document.createElement("div");
                previewEl.className = "grid-preview-placeholder";
                previewEl.innerHTML = `
                  <div class="posts-grid placeholder-grid" style="opacity: 0.5;">
                    <div class="post-card-slot"></div>
                    <div class="post-card-slot"></div>
                    <div class="post-card-slot"></div>
                    <div class="post-card-slot"></div>
                  </div>
                `;
                gridMount.parentElement.appendChild(previewEl);

                const targetPage =
                  dx < 0 ? pagination.page + 1 : pagination.page - 1;
                getTagPage(slug, { page: targetPage })
                  .then((data) => {
                    if (previewEl && data.posts) {
                      const html = data.posts
                        .map((p, i) => {
                          const img = p.media?.find(
                            (m) => m.type === "image",
                          )?.url;
                          const bg = img
                            ? `url(${img}) center/cover`
                            : "var(--surface-card)";
                          const cls =
                            i === data.posts.findIndex((x) => x.is_featured)
                              ? " featured-post"
                              : "";
                          return `<div class="post-card-slot${cls}"><div class="post-card" style="background: ${bg}; opacity: 0.8;"></div></div>`;
                        })
                        .join("");
                      previewEl.innerHTML = `<div class="posts-grid">${html}</div>`;
                    }
                  })
                  .catch(() => {});
              }

              const offset = dx < 0 ? "100%" : "-100%";
              previewEl.style.transform = `translateX(calc(${offset} + ${dx}px))`;
            }
          },
          onSwipeCancel: () => {
            if (gridMount) {
              gridMount.style.transition =
                "transform 0.3s ease, opacity 0.3s ease";
              gridMount.style.transform = "";
              gridMount.style.opacity = "1";
            }
            if (previewEl) {
              previewEl.style.transition =
                "transform 0.3s ease, opacity 0.3s ease";
              previewEl.style.opacity = "0";
              setTimeout(() => {
                previewEl?.remove();
                previewEl = null;
              }, 300);
            }
          },
          onSwipeCommit: (dir) => {
            if (dir === "left" && pagination.page < pagination.pages) {
              ViewContext.update({ page: pagination.page + 1 });
            } else if (dir === "right" && pagination.page > 1) {
              ViewContext.update({ page: pagination.page - 1 });
            } else {
              // Reset visuals if not committed
              if (gridMount) {
                gridMount.style.transition =
                  "transform 0.3s ease, opacity 0.3s ease";
                gridMount.style.transform = "";
                gridMount.style.opacity = "1";
              }
              if (previewEl) {
                previewEl.style.transition =
                  "transform 0.3s ease, opacity 0.3s ease";
                previewEl.style.opacity = "0";
                setTimeout(() => {
                  previewEl?.remove();
                  previewEl = null;
                }, 300);
              }
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
    }
  }
  beforeUnmount() {
    this._gesture?.destroy();
    this._trackpad?.destroy();
    removeCanonical();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _onTimelineRangeChange({ from, to }) {
    const vc = ViewContext.current();
    if (vc.years && vc.years[0] === from && vc.years[1] === to) return;
    ViewContext.update({ years: [from, to] });
  }

  async _load() {
    const vc = ViewContext.current();
    const { slug } = this.props.params || {};

    if (!slug) {
      this.setState({ loading: false, error: "Invalid tag URL." });
      return;
    }

    const apiParams = { page: vc.page };
    if (vc.years) {
      apiParams.year_from = vc.years[0];
      apiParams.year_to = vc.years[1];
    }
    if (vc.query) apiParams.q = vc.query;

    try {
      const data = await getTagPage(slug, apiParams);

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
