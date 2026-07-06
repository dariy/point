/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from "../../components/Component.js";
import { Pagination } from "../../components/shared/Pagination.js";
import { escapeHtml } from "../../utils/helpers.js";
import {
  renderTagLink,
  buildTagIndex,
  setupTagFlyout,
} from "../../utils/tags.js";
import {
  RSS_SVG,
  SUN_SVG,
  MOON_SVG,
  LOGIN_SVG,
  LOGOUT_SVG,
  DASHBOARD_SVG,
  SLIDERS_SVG,
} from "../../utils/icons.js";
import { store } from "../../store.js";
import { pluginHost } from "../../core/pluginHost.js";
import { ViewContext } from "../../utils/viewContext.js";
import {
  getZoom,
  clampZoom,
  gridCols,
  maxZoomCols,
} from "../../utils/gridFit.js";

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [] } = this.props;
    const author = escapeHtml(
      settings.author_name || settings.blog_title || "",
    );

    const aboutHref = settings.about_post_id
      ? `/posts/${escapeHtml(settings.about_post_id)}`
      : "/light";

    // Copyright line: admin-editable template with {{author_name}} / {{engine}}
    // tokens (point-62zu). Literal text is escaped; only known tokens emit HTML.
    const tokens = {
      author_name: author ? `<a href="${aboutHref}">${author}</a>` : "",
      engine: `<a href="https://github.com/dariy/point" target="_blank" rel="noopener noreferrer">Point</a>`,
    };
    const template = (settings.footer_copyright || "").trim()
      || (author ? "© {{author_name}}, powered by {{engine}}" : "© powered by {{engine}}");
    const copyright = template.replace(
      /\{\{(\w+)\}\}|([^{]+|\{)/g,
      (m, token, literal) =>
        token !== undefined
          ? (token in tokens ? tokens[token] : escapeHtml(m))
          : escapeHtml(literal),
    );

    let centerSlot = "";
    if (immersiveTags.length) {
      const navTags = store.get("navTags") || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      const visibleTags = immersiveTags.filter((t) => {
        if (!tagIndex) return true;
        const entry = tagIndex.get(t.slug);
        return !entry || entry.isLeaf;
      });
      const tagLinks = visibleTags.map((t) => renderTagLink(t)).join("");
      centerSlot = `<div class="immersive-tags">${tagLinks}</div>`;
    } else {
      // Grid paginator slot — filled from the store-published page state (see
      // afterRender). Rendered unconditionally so a partial refresh that gains
      // pages (e.g. a timeline-scope change) has a mount to update; CSS shows
      // it on desktop / phone-landscape only, portrait phones keep the in-flow
      // paginator below the grid.
      centerSlot = `<div class="footer-pagination"></div>`;
    }

    // About (author link in .footer-copyright), Map and All tags (header
    // buttons) already have canonical entry points elsewhere, so the footer
    // actions only carry what isn't reachable from the chrome: RSS and the
    // theme toggle (moved here from the header).
    // Zoom slider for mouse users (CSS hides it on touch / non-grid pages).
    // Inverted mapping: sliding right = bigger cards = fewer columns.
    const maxCols = maxZoomCols();
    const zoomCols = clampZoom(
      getZoom() ||
        gridCols(document.querySelector(".grid-expand-mount .posts-grid")) ||
        3,
    );
    const zoomSlider = `<input type="range" class="footer-zoom" id="footer-zoom" min="1" max="${maxCols}" step="1" value="${maxCols + 1 - zoomCols}" title="Card size" aria-label="Card size">`;

    const rssButton = pluginHost.isEnabled("rss")
      ? `<a href="/feed.xml" target="_blank" rel="noopener" class="footer-action-btn" title="RSS feed" aria-label="RSS feed">${RSS_SVG}</a>`
      : "";

    const themeToggle = `<button class="footer-action-btn theme-toggle" id="theme-toggle" type="button" aria-label="Toggle theme">
                <span class="icon-sun">${SUN_SVG}</span>
                <span class="icon-moon">${MOON_SVG}</span>
              </button>`;

    // When signed in: keep the /light admin entrance link (one-tap to the
    // panel) and add a log out button next to it. When signed out: a single
    // log in link to the admin app.
    const authButton = store.get("user")
      ? `<a href="/light" class="footer-action-btn" title="Admin panel" aria-label="Admin panel">${DASHBOARD_SVG}</a>
                <button class="footer-action-btn" id="footer-logout" type="button" title="Log out" aria-label="Log out">${LOGOUT_SVG}</button>`
      : `<a href="/light" class="footer-action-btn" title="Log in" aria-label="Log in">${LOGIN_SVG}</a>`;

    return `
      <footer class="site-footer">
        <div class="footer-container">
          <div class="footer-content">
            <div class="footer-left">
              <p class="footer-copyright">${copyright}</p>
            </div>
            <div class="footer-center">
              ${centerSlot}
            </div>
            <div class="footer-right">
              <div class="footer-actions">
                <div class="footer-sliding-actions">
                  ${zoomSlider}
                  ${rssButton}
                  ${authButton}
                </div>
                <button class="footer-action-btn footer-slider-btn" id="footer-slider-btn" type="button" aria-label="Toggle actions" title="More Actions">
                  ${SLIDERS_SVG}
                </button>
                ${themeToggle}
              </div>
            </div>
          </div>
        </div>
      </footer>`;
  }

  afterRender() {
    // Zoom slider → ask the grid page to apply the zoom (it owns the debounced
    // per_page refit); sync back from every zoom change (pinch, wheel, keys).
    const zoomEl = this.$("#footer-zoom");
    if (zoomEl) {
      zoomEl.addEventListener("input", () => {
        const cols = Number(zoomEl.max) + 1 - Number(zoomEl.value);
        window.dispatchEvent(
          new CustomEvent("point:grid-zoom-request", { detail: { cols } }),
        );
      });
      this._onZoomSync = (e) => {
        const cols = e.detail?.cols;
        if (!cols) return;
        zoomEl.max = String(maxZoomCols()); // viewport may have resized
        zoomEl.value = String(Number(zoomEl.max) + 1 - clampZoom(cols));
      };
      window.addEventListener("point:grid-zoom", this._onZoomSync);
    }

    // Footer paginator: mirrors the page state the grid pages publish under the
    // store's 'pagination' key (null on non-grid views — Pagination renders
    // empty for pages <= 1). Page changes during a partial refresh don't re-fill
    // the footer, so keep the child live via a store subscription. Subscribe
    // once for the component's lifetime: re-subscribing on every render from
    // inside the store's notify loop would be visited again by the same
    // notification (Set.forEach sees values added mid-iteration) and recurse.
    const pagEl = this.$(".footer-pagination");
    if (pagEl) {
      this._pagination = this.mountChild(Pagination, pagEl, {
        ...(store.get("pagination") || {}),
        compact: true, // item count as tooltip — the centre slot is tight
        onPage: (p) => ViewContext.update({ page: p }),
      });
      if (!this._unsubPagination) {
        this._unsubPagination = store.subscribe("pagination", (pag) => {
          this._pagination?.setProps({ page: 0, pages: 0, total: 0, ...(pag || {}) });
        });
      }
    }

    // Theme toggle (moved here from the header; always visible in the footer).
    this.$("#theme-toggle")?.addEventListener("click", () => {
      const current = store.get("theme") || "auto";
      store.set("theme", current === "dark" ? "light" : "dark");
    });

    this.$("#footer-slider-btn")?.addEventListener("click", () => {
      this.$(".footer-sliding-actions")?.classList.toggle("is-expanded");
    });

    this.$("#footer-logout")?.addEventListener("click", async () => {
      try {
        const { logout } = await import("../../api/auth.js");
        await logout();
      } catch {
        /* ignore */
      }
      store.set("user", null);
      // Reload so admin-only affordances elsewhere on the page (edit buttons,
      // EXIF, etc.) reflect the logged-out state — re-rendering the footer
      // alone leaves stale admin UI on screen. (point-tj6k)
      window.location.reload();
    });

    const tagsEl = this.$(".immersive-tags");
    if (!tagsEl) return;
    const navTags = store.get("navTags") || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupFlyout = setupTagFlyout(tagsEl, tagIndex, (url) => {
      const slug = url.replace("/tags/", "");
      ViewContext.update({ tag: slug, postSlug: null, query: null });
    });
  }

  beforeRender() {
    this._cleanupFlyout?.();
    this._cleanupFlyout = null;
    if (this._onZoomSync) {
      window.removeEventListener("point:grid-zoom", this._onZoomSync);
      this._onZoomSync = null;
    }
  }

  beforeUnmount() {
    this.beforeRender();
    this._unsubPagination?.();
    this._unsubPagination = null;
  }
}
