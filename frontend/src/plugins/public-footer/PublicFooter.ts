/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 */

import { Component } from "../../components/Component.ts";
import { Pagination } from "../../components/shared/Pagination.ts";
import { renderCopyright } from "../../utils/copyright.ts";
import type { Slot, StoreSettings } from "../../utils/helpers.ts";
import type { PostTag } from "../../api/posts.ts";
import { html, raw } from "../../utils/helpers.ts";
import {
  renderTagLink,
  buildTagIndex,
  parseTagUrl,
} from "../../utils/tagLinks.ts";
import { setupTagFlyout } from "../../utils/tagFlyout.ts";
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
} from "../../utils/icons.ts";
import { isRevelioOn, setRevelio } from "../../utils/revelio.ts";
import {
  getNavTags,
  getPagination,
  getTheme,
  getUser,
  onPagination,
  setTagCloudCache,
  setTheme,
  setUser,
} from "../../store.ts";
import { pluginHost } from "../../core/pluginHost.ts";
import { ViewContext } from "../../utils/viewContext.ts";
import {
  getZoom,
  clampZoom,
  gridCols,
  maxZoomCols,
} from "../../utils/gridFit.ts";

/**
 * Whether the actions drawer behind the sliders button is open.
 *
 * Module-level rather than per-instance: the footer is re-created on every page
 * render, and a drawer the reader opened to reach RSS or revelio should still
 * be open on the page they land on — closing it on each navigation made those
 * buttons feel like they had to be re-found every time.
 */
let drawerOpen = false;

/**
 * A portrait viewport this narrow always gets the narrow footer line. Wider
 * viewports get it only when the one-line atlas footer overflows (see _fitLine).
 */
const NARROW_QUERY = "(orientation: portrait) and (max-width: 48em)";

export interface PublicFooterProps {
  /** Public settings; reads blog_title and author_name. */
  settings?: StoreSettings;
  /**
   * When non-empty, the footer renders them as the immersive tag bar in place
   * of the pagination slot.
   */
  immersiveTags?: PostTag[];
}

export class PublicFooter extends Component<PublicFooterProps> {
  _onZoomSync: ((e: Event) => void) | null = null;
  _pagination: Pagination | null = null;
  _unsubPagination: Function | null = null;
  _cleanupFlyout: (() => void) | null = null;
  _lineObserver: ResizeObserver | null = null;
  _onDocKey: ((e: KeyboardEvent) => void) | null = null;
  _onDocClick: ((e: MouseEvent) => void) | null = null;
  render() {
    const { settings = {}, immersiveTags = [] } = this.props;

    // Copyright line: admin-editable template with {{author_name}} / {{engine}}
    // tokens (point-62zu) and [text](url) links. Shared with the immersive
    // sheet's footer so the two render the same line.
    const copyright = renderCopyright(settings);

    let centerSlot: Slot = "";
    if (immersiveTags.length) {
      const navTags = getNavTags() || [];
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
    const revelioButton = getUser()
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
    const authButton = getUser()
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
                <div class="footer-menu">
                  <div class="footer-sliding-actions${drawerOpen ? " is-expanded" : ""}">
                    ${zoomSlider}
                    ${rssButton}
                    ${revelioButton}
                    ${authButton}
                  </div>
                  ${themeToggle}
                </div>
                <button class="footer-action-btn footer-slider-btn" id="footer-slider-btn" type="button" aria-label="Toggle actions" title="More Actions" aria-expanded="false">
                  ${raw(SLIDERS_SVG)}
                </button>
              </div>
            </div>
          </div>
        </div>
      </footer>`;
  }

  afterRender() {
    // Zoom slider → ask the grid page to apply the zoom (it owns the debounced
    // per_page refit); sync back from every zoom change (pinch, wheel, keys).
    const zoomEl = (this.$("#footer-zoom") as HTMLInputElement|null);
    if (zoomEl) {
      zoomEl.addEventListener("input", () => {
        const cols = Number(zoomEl.max) + 1 - Number(zoomEl.value);
        window.dispatchEvent(
          new CustomEvent("point:grid-zoom-request", { detail: { cols } }),
        );
      });
      this._onZoomSync = (e) => {
        const cols = (e as CustomEvent<{ cols?: number }>).detail?.cols;
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
        ...(getPagination() || {}),
        compact: true, // item count as tooltip — the centre slot is tight
        onPage: (p) => ViewContext.update({ page: p }),
      });
      if (!this._unsubPagination) {
        this._unsubPagination = onPagination((pag) => {
          this._pagination?.setProps({ page: 0, pages: 0, total: 0, ...(pag || {}) });
        });
      }
    }

    // Theme toggle (moved here from the header; always visible in the footer).
    this.$("#theme-toggle")?.addEventListener("click", () => {
      const current = getTheme() || "auto";
      setTheme(current === "dark" ? "light" : "dark");
    });

    // On a wide line the button slides the drawer open beside it. On the narrow
    // atlas line (.footer-menu is not display: contents there) the drawer and
    // the theme toggle are a popover above the button.
    const actions = this.$(".footer-actions");
    const sliderBtn = this.$("#footer-slider-btn");
    const menu = this.$(".footer-menu");
    const setOpen = (open: boolean) => {
      actions?.classList.toggle("is-open", open);
      sliderBtn?.setAttribute("aria-expanded", String(open));
    };
    sliderBtn?.addEventListener("click", () => {
      if (menu && getComputedStyle(menu).display !== "contents") {
        setOpen(!actions?.classList.contains("is-open"));
        return;
      }
      const el = this.$(".footer-sliding-actions");
      if (!el) return;
      drawerOpen = el.classList.toggle("is-expanded");
    });
    this._onDocKey = (e) => {
      if (e.key === "Escape" && actions?.classList.contains("is-open")) setOpen(false);
    };
    this._onDocClick = (e) => {
      if (actions?.classList.contains("is-open") && !actions.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", this._onDocKey);
    document.addEventListener("click", this._onDocClick, true);

    // The line changes width when the footer turns into the atlas line, when
    // the paginator shows, hides or changes its page count, and when the
    // drawer slides open.
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => this._fitLine());
      for (const sel of [".footer-content", ".footer-center", ".footer-actions"]) {
        const el = this.$(sel);
        if (el) ro.observe(el);
      }
      this._lineObserver = ro;
    }
    this._fitLine();

    this.$("#revelio-toggle")?.addEventListener("click", () => this._toggleRevelio());

    this.$("#footer-logout")?.addEventListener("click", async () => {
      try {
        const { logout } = await import("../../api/auth.ts");
        await logout();
      } catch {
        /* ignore */
      }
      setUser(null);
      // Reload so admin-only affordances elsewhere on the page (edit buttons,
      // EXIF, etc.) reflect the logged-out state — re-rendering the footer
      // alone leaves stale admin UI on screen. (point-tj6k)
      window.location.reload();
    });

    const tagsEl = this.$(".immersive-tags");
    if (!tagsEl) return;
    const navTags = getNavTags() || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupFlyout = setupTagFlyout(tagsEl, tagIndex, (url) => {
      const { tag, navPath } = parseTagUrl(url);
      ViewContext.update({ tag, navPath, postSlug: null, query: null });
    });
  }

  /**
   * Mark the footer narrow when the viewport is a narrow portrait one, or when
   * the full line (copyright, paginator, every action) does not fit. CSS uses
   * `.is-narrow` only on the one-line atlas footer (css/public/footer.css):
   * there it hides the copyright and folds the actions into the popover.
   * The class comes off for the measurement, so the full line is what is
   * measured and the result does not flip back and forth.
   */
  _fitLine() {
    const footer = this.$(".site-footer");
    const content = this.$(".footer-content");
    if (!footer || !content) return;
    footer.classList.remove("is-narrow");
    const narrow = window.matchMedia?.(NARROW_QUERY).matches
      || content.scrollWidth > content.clientWidth + 1;
    footer.classList.toggle("is-narrow", narrow);
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
      import("../../api/posts.ts"),
      import("../../api/nav.ts"),
      import("../../router.ts"),
    ]);
    clearPostReadCache(); // post reads *and* the list pages behind them
    setTagCloudCache(null);
    await loadNav({ force: true });
    router.refresh(url.pathname + url.search + url.hash);
  }

  beforeRender() {
    this._cleanupFlyout?.();
    this._cleanupFlyout = null;
    this._lineObserver?.disconnect();
    this._lineObserver = null;
    if (this._onDocKey) document.removeEventListener("keydown", this._onDocKey);
    if (this._onDocClick) document.removeEventListener("click", this._onDocClick, true);
    this._onDocKey = null;
    this._onDocClick = null;
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
