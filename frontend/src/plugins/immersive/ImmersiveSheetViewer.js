/**
 * ImmersiveSheetViewer — alternate immersive overlay (the "sheet" mode).
 *
 * Shows the photo exactly like the classic immersive viewer (it extends
 * MediaViewer and reuses all of its carousel / zoom / cross-post machinery),
 * but replaces the overlay with a swipe-up detail sheet:
 *
 *   - Closed state: just the photo, with a small "swipe up" hint and a floating
 *     back / share bar.
 *   - Open state: the photo (and the sheet beneath it) slide up far enough to
 *     reveal the full sheet — breadcrumb, title, excerpt, tags, EXIF (inline,
 *     no extra click), action buttons and footer.
 *
 * The gesture is a snap: it only ever rests fully open or fully closed, never
 * mid-way. Swipe up opens, swipe down collapses (or, when already closed,
 * dismisses the viewer).
 *
 * Selected via the `immersive_overlay_mode` site setting (classic | sheet);
 * the classic MediaViewer is left untouched.
 */

import { MediaViewer } from '../../components/shared/MediaViewer.js';
import { html, setHTML, linkify, raw, sharePost } from '../../utils/helpers.js';
import { store } from '../../store.js';
import { pluginHost } from '../../core/pluginHost.js';
import { ViewContext } from '../../utils/viewContext.js';
import { renderTagLink, buildTagIndex } from '../../utils/tagLinks.js';
import { setupTagFlyout } from '../../utils/tagFlyout.js';
import { exifVisible, buildExifMap, metadataForSrc, curatedExifRows } from '../../utils/exif.js';
import { SHARE_SVG, EDIT_SVG, RSS_SVG, SUN_SVG, MOON_SVG, CHEVRON_SVG } from '../../utils/icons.js';
import { immersiveNavTargets } from '../../utils/immersiveNav.js';
import { renderCopyright } from '../../utils/copyright.js';
const SHEET_ANIM = 'transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1)';
export class ImmersiveSheetViewer extends MediaViewer {
  constructor(container, props = {}) {
    super(container, props);
    this._sheetOpen = false; // current snap state
    this._sheetHeight = 0; // px the stage travels when fully open
    this._currentOffset = 0; // px currently translated
    this._sheetDrag = false; // true when the active vertical drag drives the sheet
  }

  // EXIF is rendered inline inside the sheet, so skip the floating flyout.
  _useFloatingExif() {
    return false;
  }
  _renderExtras() {
    return html`
      <button class="immersive-sheet-hint" type="button" aria-label="Show details">
        <span class="immersive-sheet-hint-chevron">${raw(CHEVRON_SVG)}</span>
        <span class="immersive-sheet-hint-label">Details</span>
      </button>
      ${this._renderSheet()}`;
  }
  _renderSheet() {
    const {
      post,
      navPrev,
      navNext
    } = this.props;
    const settings = store.get('settings') || {};
    if (!post) return html`<div class="immersive-sheet" aria-hidden="true"></div>`;
    const showViews = settings.show_view_counts && post.view_count != null;
    const viewsLine = showViews ? html`<div class="immersive-sheet-meta">${`${post.view_count} views`}</div>` : '';

    // The breadcrumb doubles as the title — just the post title, no site crumb.
    const breadcrumb = html`<nav class="immersive-sheet-crumbs" aria-label="Breadcrumb"><span class="immersive-sheet-crumb-current">${post.title || ''}</span></nav>`;
    const excerpt = post.excerpt ? html`<p class="immersive-sheet-excerpt">${linkify(post.excerpt)}</p>` : '';

    // The post's own tags — ancestors the page endpoints add for subtree
    // matching are marked `inherited` and belong to the breadcrumb, not here.
    const tags = (post.tags || []).filter(t => !t.inherited);
    const tagsHtml = tags.length ? html`<div class="immersive-sheet-tags">${tags.map(t => renderTagLink(t))}</div>` : '';
    return html`
      <div class="immersive-sheet" aria-hidden="true">
        <button class="immersive-sheet-grip" type="button" aria-label="Collapse details"></button>
        <div class="immersive-sheet-scroll">
          <div class="immersive-sheet-body">
            <aside class="immersive-sheet-exif hidden" aria-label="Camera data"></aside>
            <div class="immersive-sheet-main">
              ${breadcrumb}
              ${viewsLine}
              ${excerpt}
              ${tagsHtml}
              ${this._renderActions()}
            </div>
            <div class="immersive-sheet-comments"></div>
          </div>
          ${this._renderFooter(navPrev, navNext)}
        </div>
      </div>`;
  }
  _renderActions() {
    const {
      editUrl
    } = this.props;
    const user = store.get('user');
    const editBtn = user && editUrl ? html`<a class="immersive-sheet-action" href="${editUrl}" data-action="edit">${raw(EDIT_SVG)}<span>Edit</span></a>` : '';
    const shareBtn = html`<button class="immersive-sheet-action" type="button" data-action="share">${raw(SHARE_SVG)}<span>Share</span></button>`;
    return html`<div class="immersive-sheet-actions">${editBtn}${shareBtn}</div>`;
  }
  _renderFooter(prev, next) {
    const settings = store.get('settings') || {};
    // Same renderer as the site footer — the admin-editable `footer_copyright`
    // template, so the sheet can't show a different line than the home page.
    const copyright = html`<p class="immersive-sheet-copyright">${renderCopyright(settings)}</p>`;

    // Keep the footer's ‹ left / right › links pointing at the same posts the
    // on-photo nav panels do, under either reading direction — same resolver,
    // so they can't drift apart ('back' is the left panel, 'fwd' the right).
    const {
      back: leftPost,
      fwd: rightPost
    } = immersiveNavTargets(settings, prev, next);
    const navLink = (postObj, side) => {
      if (!postObj) return html`<span></span>`;
      const rel = postObj === prev ? 'prev' : 'next';
      const label = postObj.title || (side === 'left' ? 'Previous' : 'Next');
      const text = side === 'left' ? `‹ ${label}` : `${label} ›`;
      return html`<a class="immersive-sheet-postnav ${side}" href="/posts/${postObj.slug}" rel="${rel}">${text}</a>`;
    };
    const nav = leftPost || rightPost ? html`<div class="immersive-sheet-postnav-row">${navLink(leftPost, 'left')}${navLink(rightPost, 'right')}</div>` : '';

    // RSS + theme toggle live bottom-right, mirroring the footer on other pages.
    const rssBtn = pluginHost.isEnabled("rss") ? html`<a class="footer-action-btn" href="/feed.xml" target="_blank" rel="noopener" title="RSS feed" aria-label="RSS feed">${raw(RSS_SVG)}</a>` : '';
    const themeBtn = html`<button class="footer-action-btn theme-toggle immersive-sheet-theme" type="button" aria-label="Toggle theme">
        <span class="icon-sun">${raw(SUN_SVG)}</span><span class="icon-moon">${raw(MOON_SVG)}</span>
      </button>`;
    return html`<div class="immersive-sheet-footer">
      ${nav}
      <div class="immersive-sheet-footer-bottom">
        ${copyright}
        <div class="immersive-sheet-footer-actions footer-actions">${rssBtn}${themeBtn}</div>
      </div>
    </div>`;
  }
  _initInteractivity() {
    super._initInteractivity();
    this._wrapper = this.$('.media-viewer-wrapper');
    this._wrapper?.classList.add('immersive-sheet-mode');

    // Per-slide EXIF metadata for the inline block (mirrors MediaViewer's
    // floating control, which we suppressed via _useFloatingExif()).
    this._sheetExifMeta = null;
    const settings = store.get('settings') || {};
    const media = this.props.media || [];
    if (exifVisible(settings, store.get('user')) && media.length) {
      const exifMap = buildExifMap(media);
      const meta = (this.props.items || []).map(it => it.type === 'image' && it.url ? metadataForSrc(exifMap, it.url) : null);
      if (meta.some(Boolean)) this._sheetExifMeta = meta;
    }
    this._updateSheetExif();

    // Tag flyouts inside the sheet.
    const tagsEl = this.$('.immersive-sheet-tags');
    if (tagsEl) {
      const navTags = store.get('navTags') || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      this._sheetFlyoutCleanup = setupTagFlyout(tagsEl, tagIndex, url => {
        const slug = url.replace('/tags/', '');
        ViewContext.update({
          tag: slug,
          postSlug: null,
          query: null
        });
      });
    }
    const commentsEl = this.$('.immersive-sheet-comments');
    if (commentsEl && pluginHost.isEnabled("comments")) {
      pluginHost.fill("post-comments", commentsEl, {
        post: this.props.post,
        url: window.location.href
      }).then(res => {
        this._sheetCommentsComps = res;
      });
    }
    this._wireSheetControls();
    this._onResize = () => {
      this._measureSheet();
      if (this._sheetOpen) this._setSheetOffset(this._sheetHeight, false);
    };
    window.addEventListener('resize', this._onResize);
    const sheetEl = this.$('.immersive-sheet');
    if (sheetEl) {
      this._sheetObserver = new ResizeObserver(() => {
        this._measureSheet();
        if (this._sheetOpen) this._setSheetOffset(this._sheetHeight, false);
      });
      this._sheetObserver.observe(sheetEl);
    }
    this._measureSheet();
  }
  _wireSheetControls() {
    this.on(this.$('.immersive-sheet-hint'), 'click', e => {
      e.stopPropagation();
      this._openSheet();
    });
    this.on(this.$('.immersive-sheet-grip'), 'click', e => {
      e.stopPropagation();
      this._closeSheet();
    });

    // Tapping the photo strip while the sheet is open collapses it (instead of
    // letting MediaViewer's background-tap close the whole viewer).
    const visuals = this.$('.immersive-visuals');
    this.on(visuals, 'click', e => {
      if (this._sheetOpen) {
        e.stopPropagation();
        this._closeSheet();
      }
    }, true);
    const actions = this.$('.immersive-sheet-actions');
    this.on(actions, 'click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'edit') return; // let the link navigate
      e.preventDefault();
      e.stopPropagation();
      if (action === 'share') sharePost({
        title: document.title,
        url: window.location.href
      });
    });
    this.on(this.$('.immersive-sheet-theme'), 'click', e => {
      e.stopPropagation();
      const current = store.get('theme') || 'auto';
      store.set('theme', current === 'dark' ? 'light' : 'dark');
    });
  }

  // ── Keyboard → sheet ────────────────────────────────────────────────────────

  /**
   * Up/down drive the sheet the same way the vertical swipe does: Up opens it,
   * Down collapses it — falling through to MediaViewer's close only once the
   * sheet is already closed, so Down never skips a state. Escape likewise peels
   * off one layer at a time. While the sheet is open the same keys scroll its
   * body first; the sheet scroller isn't focusable, so scroll it by hand rather
   * than hoping the browser's default lands on it.
   */
  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (this._zoomState.scale > 1) return super._onKeyDown(e);
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this._sheetOpen) return this._openSheet();
      return this._scrollSheet(-1);
    }
    if (e.key === 'ArrowDown' && this._sheetOpen) {
      e.preventDefault();
      if (!this._scrollSheet(1)) this._closeSheet();
      return;
    }
    if (e.key === 'Escape' && this._sheetOpen) {
      e.preventDefault();
      return this._closeSheet();
    }
    super._onKeyDown(e);
  }

  /**
   * Scroll the open sheet one step in `dir` (-1 up, 1 down).
   * Returns false when it was already at that end, so the caller can fall
   * through to collapsing the sheet.
   */
  _scrollSheet(dir) {
    const el = this.$('.immersive-sheet-scroll');
    if (!el) return false;
    const room = dir < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop;
    if (room <= 1) return false;
    el.scrollBy({
      top: dir * Math.max(80, el.clientHeight * 0.4),
      behavior: 'smooth'
    });
    return true;
  }

  /** Measure how far the stage must travel to fully reveal the sheet. */
  _measureSheet() {
    const sheet = this.$('.immersive-sheet');
    if (!sheet) return;
    const h = sheet.getBoundingClientRect().height;
    this._sheetHeight = Math.min(h, window.innerHeight);
  }

  // ── Vertical gesture → sheet ───────────────────────────────────────────────

  _onSwipeMove(dx, dy) {
    if (this._zoomState.scale > 1) return super._onSwipeMove(dx, dy);

    // Latch the axis on the first move so a diagonal drag can't flip handlers
    // mid-gesture; reset in _onSwipeCommit / _onSwipeCancel.
    if (this._swipeAxis == null) {
      this._swipeAxis = Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h';
    }
    if (this._swipeAxis === 'v') {
      // Vertical: drive the sheet, except a downward drag while closed, which
      // falls back to MediaViewer's swipe-to-dismiss.
      if (!this._sheetOpen && dy > 0) {
        this._sheetDrag = false;
        return super._onSwipeMove(0, dy);
      }
      this._sheetDrag = true;
      if (!this._sheetHeight) this._measureSheet();
      const base = this._sheetOpen ? this._sheetHeight : 0;
      let offset = base - dy; // dragging up (dy<0) increases the reveal
      offset = Math.max(0, Math.min(this._sheetHeight, offset));
      this._setSheetOffset(offset, false);
      return;
    }

    // Horizontal carousel only makes sense with the sheet closed.
    this._sheetDrag = false;
    if (this._sheetOpen) return;
    super._onSwipeMove(dx, 0);
  }
  _onSwipeCommit(dir) {
    this._swipeAxis = null;
    if (this._zoomState.scale > 1) return super._onSwipeCommit(dir);
    if (dir === 'up') return this._openSheet();
    if (dir === 'down') {
      if (this._sheetOpen || this._sheetDrag) return this._closeSheet();
      return this.props.onClose?.();
    }
    if (this._sheetOpen) return; // ignore horizontal flips while open
    super._onSwipeCommit(dir);
  }
  _onSwipeCancel() {
    this._swipeAxis = null;
    if (this._sheetDrag) {
      this._sheetDrag = false;
      // Snap to the nearer end state — never rest mid-way.
      if (this._currentOffset > this._sheetHeight / 2) this._openSheet();else this._closeSheet();
      return;
    }
    super._onSwipeCancel();
  }
  _setSheetOffset(px, animate) {
    this._currentOffset = px;
    const t = animate ? SHEET_ANIM : 'none';
    const visuals = this.$('.immersive-visuals');
    const sheet = this.$('.immersive-sheet');
    // Keep the photo centered in the remaining visible area above the sheet.
    // By translating it up by exactly half the sheet's offset, we shift its
    // center from window.innerHeight/2 to (window.innerHeight - px)/2.
    const imgPx = px / 2;
    if (visuals) {
      visuals.style.transition = t;
      visuals.style.transform = `translateY(${-imgPx}px)`;
    }
    if (sheet) {
      sheet.style.transition = t;
      sheet.style.transform = `translateY(${-px}px)`;
    }
  }
  _openSheet() {
    if (!this._sheetHeight) this._measureSheet();
    this._sheetOpen = true;
    this._sheetDrag = false;
    this._showUI();
    this._wrapper?.classList.add('sheet-open');
    this.$('.immersive-sheet')?.setAttribute('aria-hidden', 'false');
    this._setSheetOffset(this._sheetHeight, true);
  }
  _closeSheet() {
    this._sheetOpen = false;
    this._sheetDrag = false;
    this._wrapper?.classList.remove('sheet-open');
    this.$('.immersive-sheet')?.setAttribute('aria-hidden', 'true');
    this._setSheetOffset(0, true);
  }

  // ── Keep the inline EXIF block pointed at the active slide ──────────────────

  _updateExif() {
    super._updateExif();
    this._updateSheetExif();
  }
  _finalizeSwap(newIndex) {
    super._finalizeSwap(newIndex);
    this._updateSheetExif();
  }
  _updateSheetExif() {
    const mount = this.$('.immersive-sheet-exif');
    if (!mount) return;
    const bodyEl = this.$('.immersive-sheet-body');
    const rows = curatedExifRows(this._sheetExifMeta?.[this._index] || null);
    if (!rows.length) {
      mount.textContent = '';
      mount.classList.add('hidden');
      bodyEl?.classList.remove('has-exif');
      return;
    }
    const body = rows.map(({
      label,
      value
    }) => html`<div class="immersive-sheet-exif-row"><span class="immersive-sheet-exif-key">${label}</span><span class="immersive-sheet-exif-val">${value}</span></div>`);
    setHTML(mount, html`<div class="immersive-sheet-exif-title">Camera data</div>${body}`);
    mount.classList.remove('hidden');
    bodyEl?.classList.add('has-exif');
  }
  _cleanup() {
    super._cleanup();
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    if (this._sheetObserver) {
      this._sheetObserver.disconnect();
      this._sheetObserver = null;
    }
    this._sheetFlyoutCleanup?.();
    this._sheetFlyoutCleanup = null;
    if (this._sheetCommentsComps) {
      this._sheetCommentsComps.forEach(c => c?.unmount?.());
      this._sheetCommentsComps = null;
    }
  }
}