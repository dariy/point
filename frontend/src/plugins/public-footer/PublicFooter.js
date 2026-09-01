// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.12.
/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from "../../components/Component.js";
import { Pagination } from "../../components/shared/Pagination.js";
import { renderCopyright } from "../../utils/copyright.js";
import { html, raw } from "../../utils/helpers.js";
import {
  renderTagLink,
  buildTagIndex,
  parseTagUrl,
} from "../../utils/tagLinks.js";
import { setupTagFlyout } from "../../utils/tagFlyout.js";
import {
  RSS_SVG,
  SUN_SVG,
  MOON_SVG,
  LOGIN_SVG,
  LOGOUT_SVG,
  DASHBOARD_SVG,
  SLIDERS_SVG,
  EYE_SVG,
  EYE_OFF_SVG,
} from "../../utils/icons.js";
import { isRevelioOn, setRevelio } from "../../utils/revelio.js";
import { store } from "../../store.js";
import { pluginHost } from "../../core/pluginHost.js";
import { ViewContext } from "../../utils/viewContext.js";
import {
  getZoom,
  clampZoom,
  gridCols,
  maxZoomCols,
} from "../../utils/gridFit.js";

/**
 * Whether the actions drawer behind the sliders button is open.
 *
 * Module-level rather than per-instance: the footer is re-created on every page
 * render, and a drawer the reader opened to reach RSS or revelio should still
 * be open on the page they land on — closing it on each navigation made those
 * buttons feel like they had to be re-found every time.
 */
let drawerOpen = false;

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [] } = this.props;

    // Copyright line: admin-editable template with {{author_name}} / {{engine}}
    // tokens (point-62zu) and [text](url) links. Shared with the immersive
    // sheet's footer so the two render the same line.
    const copyright = renderCopyright(settings);

    let centerSlot = "";
    if (immersiveTags.length) {
      const navTags = store.get("navTags") || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      const visibleTags = immersiveTags.filter((t) => {
        if (!tagIndex) return true;
        const entry = tagIndex.get(t.slug);
        return !entry || entry.isLeaf;
      });
      const tagLinks = visibleTags.map((t) => renderTagLink(t));
      centerSlot = html`<div class="immersive-tags">${tagLinks}</div>`;
    } else {
      // Grid paginator slot — filled from the store-published page state (see
      // afterRender). Rendered unconditionally so a partial refresh that gains
      // pages (e.g. a timeline-scope change) has a mount to update; CSS shows
      // it on desktop / phone-landscape only, portrait phones keep the in-flow
      // paginator below the grid.
      centerSlot = html`<div class="footer-pagination"></div>`;
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
    const zoomSlider = html`<input type="range" class="footer-zoom" id="footer-zoom" min="1" max="${maxCols}" step="1" value="${maxCols + 1 - zoomCols}" title="Card size" aria-label="Card size">`;

    const rssButton = pluginHost.isEnabled("rss")
      ? html`<a href="/feed.xml" target="_blank" rel="noopener" class="footer-action-btn" title="RSS feed" aria-label="RSS feed">${raw(RSS_SVG)}</a>`
      : "";

    // Revelio (owner only): reveal or conceal everything a guest can't see —
    // hidden posts and tags, private media, and the scheduled queue on the
    // feed's negative pages. Concealed is the guest's own view of the site.
    const revelioOn = isRevelioOn();
    const revelioButton = store.get("user")
      ? html`<button class="footer-action-btn revelio-toggle${revelioOn ? " is-revealing" : ""}" id="revelio-toggle" type="button"
                aria-pressed="${revelioOn}"
                title="${revelioOn ? "Revelio: showing hidden items — click to view as a guest" : "Viewing as a guest — click to reveal hidden items"}"
                aria-label="${revelioOn ? "View as a guest" : "Reveal hidden items"}">${raw(revelioOn ? EYE_SVG : EYE_OFF_SVG)}</button>`
      : "";

    const themeToggle = html`<button class="footer-action-btn theme-toggle" id="theme-toggle" type="button" aria-label="Toggle theme">
                <span class="icon-sun">${raw(SUN_SVG)}</span>
                <span class="icon-moon">${raw(MOON_SVG)}</span>
              </button>`;

    // When signed in: keep the /light admin entrance link (one-tap to the
    // panel) and add a log out button next to it. When signed out: a single
    // log in link to the admin app.
    const authButton = store.get("user")
      ? html`<a href="/light" class="footer-action-btn" title="Admin panel" aria-label="Admin panel">${raw(DASHBOARD_SVG)}</a>
                <button class="footer-action-btn" id="footer-logout" type="button" title="Log out" aria-label="Log out">${raw(LOGOUT_SVG)}</button>`
      : html`<a href="/light" class="footer-action-btn" title="Log in" aria-label="Log in">${raw(LOGIN_SVG)}</a>`;

    return html`
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
                <div class="footer-sliding-actions${drawerOpen ? " is-expanded" : ""}">
                  ${zoomSlider}
                  ${rssButton}
                  ${revelioButton}
                  ${authButton}
                </div>
                <button class="footer-action-btn footer-slider-btn" id="footer-slider-btn" type="button" aria-label="Toggle actions" title="More Actions">
                  ${raw(SLIDERS_SVG)}
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
      const el = this.$(".footer-sliding-actions");
      if (!el) return;
      drawerOpen = el.classList.toggle("is-expanded");
    });

    this.$("#revelio-toggle")?.addEventListener("click", () => this._toggleRevelio());

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
      const { tag, navPath } = parseTagUrl(url);
      ViewContext.update({ tag, navPath, postSlug: null, query: null });
    });
  }

  /**
   * Flip revelio and re-render the site under the new visibility scope.
   *
   * Everything the switch changes is fetched, so all of it has to be dropped:
   * the list-page read cache, and the nav tree (auth-scoped — hidden tags come
   * and go with it). The router then rebuilds the current view in the same
   * document, which keeps the reader where they were with no page flash. The
   * drawer this button lives in survives because its open state outlives the
   * footer instance (see drawerOpen).
   */
  async _toggleRevelio() {
    setRevelio(!isRevelioOn());

    // A scheduled feed page has no counterpart on the guest side of the
    // switch — leave it for the newest published page rather than rendering an
    // empty one.
    const url = new URL(window.location.href);
    if (!isRevelioOn() && Number(url.searchParams.get("page") ?? 1) < 1) {
      url.searchParams.delete("page");
    }

    const [{ clearPostReadCache }, { loadNav }, { router }] = await Promise.all([
      import("../../api/posts.js"),
      import("../../api/nav.js"),
      import("../../router.js"),
    ]);
    clearPostReadCache(); // post reads *and* the list pages behind them
    store.set("tagCloud", null);
    await loadNav({ force: true });
    router.refresh(url.pathname + url.search + url.hash);
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
