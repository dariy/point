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

import { MediaViewer } from './MediaViewer.js';
import { escapeHtml, sharePost, linkify } from '../../utils/helpers.js';
import { store } from '../../store.js';
import { pluginHost } from '../../core/pluginHost.js';
import { ViewContext } from '../../utils/viewContext.js';
import { renderTagLink, buildTagIndex, setupTagFlyout } from '../../utils/tags.js';
import { exifVisible, buildExifMap, metadataForSrc, curatedExifRows } from '../../utils/exif.js';
import { SHARE_SVG, EDIT_SVG, RSS_SVG, SUN_SVG, MOON_SVG, ARTICLE_SVG, CHEVRON_SVG } from '../../utils/icons.js';

const SHEET_ANIM = 'transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1)';

export class ImmersiveSheetViewer extends MediaViewer {
  constructor(container, props = {}) {
    super(container, props);
    this._sheetOpen = false;     // current snap state
    this._sheetHeight = 0;       // px the stage travels when fully open
    this._currentOffset = 0;     // px currently translated
    this._sheetDrag = false;     // true when the active vertical drag drives the sheet
  }

  // EXIF is rendered inline inside the sheet, so skip the floating flyout.
  _useFloatingExif() { return false; }

  _renderExtras() {
    return `
      <button class="immersive-sheet-hint" type="button" aria-label="Show details">
        <span class="immersive-sheet-hint-chevron">${CHEVRON_SVG}</span>
        <span class="immersive-sheet-hint-label">Details</span>
      </button>
      ${this._renderSheet()}`;
  }

  _renderSheet() {
    const { post, navPrev, navNext } = this.props;
    const settings = store.get('settings') || {};
    if (!post) return '<div class="immersive-sheet" aria-hidden="true"></div>';

    const showViews = settings.show_view_counts && post.view_count != null;
    const viewsLine = showViews
      ? `<div class="immersive-sheet-meta">${escapeHtml(`${post.view_count} views`)}</div>`
      : '';

    // The breadcrumb doubles as the title — just the post title, no site crumb.
    const breadcrumb = `<nav class="immersive-sheet-crumbs" aria-label="Breadcrumb"><span class="immersive-sheet-crumb-current">${escapeHtml(post.title || '')}</span></nav>`;

    const excerpt = post.excerpt
      ? `<p class="immersive-sheet-excerpt">${linkify(post.excerpt)}</p>`
      : '';

    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tags = (post.tags || []).filter((t) => {
      if (!tagIndex) return true;
      const entry = tagIndex.get(t.slug);
      return !entry || entry.isLeaf;
    });
    const tagsHtml = tags.length
      ? `<div class="immersive-sheet-tags">${tags.map((t) => renderTagLink(t)).join('')}</div>`
      : '';

    return `
      <div class="immersive-sheet" aria-hidden="true">
        <button class="immersive-sheet-grip" type="button" aria-label="Collapse details"></button>
        <div class="immersive-sheet-scroll">
          <div class="immersive-sheet-body">
            <div class="immersive-sheet-main">
              ${breadcrumb}
              ${viewsLine}
              ${excerpt}
              ${tagsHtml}
              ${this._renderActions()}
            </div>
            <aside class="immersive-sheet-exif hidden" aria-label="Camera data"></aside>
          </div>
          ${this._renderFooter(navPrev, navNext)}
        </div>
      </div>`;
  }

  _renderActions() {
    const { editUrl, onToggleImmersive } = this.props;
    const user = store.get('user');

    const articleBtn = onToggleImmersive
      ? `<button class="immersive-sheet-action" type="button" data-action="article">${ARTICLE_SVG}<span>Article</span></button>`
      : '';
    const editBtn = (user && editUrl)
      ? `<a class="immersive-sheet-action" href="${escapeHtml(editUrl)}" data-action="edit">${EDIT_SVG}<span>Edit</span></a>`
      : '';
    const shareBtn = `<button class="immersive-sheet-action" type="button" data-action="share">${SHARE_SVG}<span>Share</span></button>`;

    return `<div class="immersive-sheet-actions">${articleBtn}${editBtn}${shareBtn}</div>`;
  }

  _renderFooter(prev, next) {
    const settings = store.get('settings') || {};
    const author = escapeHtml(settings.author_name || settings.blog_title || '');
    const aboutHref = settings.about_post_id ? `/posts/${escapeHtml(settings.about_post_id)}` : '/light';
    const copyright = `<p class="immersive-sheet-copyright">
        <a href="/light">&copy;</a>${author ? ` <a href="${aboutHref}">${author}</a>, powered by <a href="https://github.com/dariy/point" target="_blank" rel="noopener noreferrer">Point</a>` : ''}
      </p>`;

    // Keep the footer's ‹ left / right › links pointing at the same posts the
    // on-photo nav panels do, under either reading direction (the
    // immersive_nav_direction setting). The left nav panel ('back') crosses to
    // feedMode ? navPrev : navNext; the right panel ('fwd') to the other — so
    // mirror that here instead of hard-coding prev-left / next-right.
    const feedMode = settings.immersive_nav_direction === 'feed';
    const leftPost = feedMode ? prev : next;
    const rightPost = feedMode ? next : prev;

    const navLink = (postObj, side) => {
      if (!postObj) return '<span></span>';
      const rel = postObj === prev ? 'prev' : 'next';
      const label = escapeHtml(postObj.title || (side === 'left' ? 'Previous' : 'Next'));
      const text = side === 'left' ? `‹ ${label}` : `${label} ›`;
      return `<a class="immersive-sheet-postnav ${side}" href="/posts/${escapeHtml(postObj.slug)}" rel="${rel}">${text}</a>`;
    };

    const nav = (leftPost || rightPost)
      ? `<div class="immersive-sheet-postnav-row">${navLink(leftPost, 'left')}${navLink(rightPost, 'right')}</div>`
      : '';

    // RSS + theme toggle live bottom-right, mirroring the footer on other pages.
    const rssBtn = pluginHost.isEnabled("rss")
      ? `<a class="footer-action-btn" href="/feed.xml" target="_blank" rel="noopener" title="RSS feed" aria-label="RSS feed">${RSS_SVG}</a>`
      : '';
    const themeBtn = `<button class="footer-action-btn theme-toggle immersive-sheet-theme" type="button" aria-label="Toggle theme">
        <span class="icon-sun">${SUN_SVG}</span><span class="icon-moon">${MOON_SVG}</span>
      </button>`;

    return `<div class="immersive-sheet-footer">
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
      const meta = (this.props.items || []).map((it) =>
        it.type === 'image' && it.url ? metadataForSrc(exifMap, it.url) : null,
      );
      if (meta.some(Boolean)) this._sheetExifMeta = meta;
    }
    this._updateSheetExif();

    // Tag flyouts inside the sheet.
    const tagsEl = this.$('.immersive-sheet-tags');
    if (tagsEl) {
      const navTags = store.get('navTags') || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      this._sheetFlyoutCleanup = setupTagFlyout(tagsEl, tagIndex, (url) => {
        const slug = url.replace('/tags/', '');
        ViewContext.update({ tag: slug, postSlug: null, query: null });
      });
    }

    this._wireSheetControls();

    this._onResize = () => { if (!this._sheetOpen) this._measureSheet(); };
    window.addEventListener('resize', this._onResize);
    this._measureSheet();
  }

  _wireSheetControls() {
    this._on(this.$('.immersive-sheet-hint'), 'click', (e) => { e.stopPropagation(); this._openSheet(); });
    this._on(this.$('.immersive-sheet-grip'), 'click', (e) => { e.stopPropagation(); this._closeSheet(); });

    // Tapping the photo strip while the sheet is open collapses it (instead of
    // letting MediaViewer's background-tap close the whole viewer).
    const visuals = this.$('.immersive-visuals');
    this._on(visuals, 'click', (e) => {
      if (this._sheetOpen) { e.stopPropagation(); this._closeSheet(); }
    }, true);

    const actions = this.$('.immersive-sheet-actions');
    this._on(actions, 'click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'edit') return; // let the link navigate
      e.preventDefault();
      e.stopPropagation();
      if (action === 'article') this.props.onToggleImmersive?.();
      else if (action === 'share') sharePost({ title: document.title, url: window.location.href });
    });

    this._on(this.$('.immersive-sheet-theme'), 'click', (e) => {
      e.stopPropagation();
      const current = store.get('theme') || 'auto';
      store.set('theme', current === 'dark' ? 'light' : 'dark');
    });
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
      if (this._currentOffset > this._sheetHeight / 2) this._openSheet();
      else this._closeSheet();
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
    if (visuals) { visuals.style.transition = t; visuals.style.transform = `translateY(${-imgPx}px)`; }
    if (sheet) { sheet.style.transition = t; sheet.style.transform = `translateY(${-px}px)`; }
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
    const body = rows.map(({ label, value }) =>
      `<div class="immersive-sheet-exif-row"><span class="immersive-sheet-exif-key">${escapeHtml(label)}</span><span class="immersive-sheet-exif-val">${escapeHtml(value)}</span></div>`,
    ).join('');
    mount.innerHTML = `<div class="immersive-sheet-exif-title">Camera data</div>${body}`;
    mount.classList.remove('hidden');
    bodyEl?.classList.add('has-exif');
  }

  _cleanup() {
    super._cleanup();
    if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
    this._sheetFlyoutCleanup?.();
    this._sheetFlyoutCleanup = null;
  }
}
