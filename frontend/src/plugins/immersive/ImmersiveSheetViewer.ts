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
 *     reveal the full sheet — breadcrumb, title, excerpt, tags, the map of the
 *     post's place, EXIF (inline, no extra click), action buttons and footer.
 *
 * The map is not a second map. The sheet has an empty slot (only for a post
 * with its own geo-tag, and only with `tags-atlas` on), and the atlas ocean
 * shows its one map through it (`presentAtlasOcean` with a window). The window
 * follows the slot while the sheet drags, slides and scrolls; the ocean is
 * `hidden` again when the sheet closes or the viewer goes.
 *
 * The gesture is a snap: it only ever rests fully open or fully closed, never
 * mid-way. Swipe up opens, swipe down collapses (or, when already closed,
 * dismisses the viewer).
 *
 * Touch input in landscape (the same test as the map layer's side split,
 * atlasLayerLayout.ts::onAtlasSide) uses the side layout: the photo is on the
 * left, and the sheet is a right column that is always open and scrolls. There
 * is no sheet drag. A swipe left or right on the photo still steps, and a swipe
 * down still dismisses. A rotation changes the layout with no reload.
 *
 * Selected via the `immersive_overlay_mode` site setting (classic | sheet);
 * the classic MediaViewer is left untouched.
 */

import type { MediaViewerProps } from '../../components/shared/MediaViewer.ts';
import { MediaViewer } from '../../components/shared/MediaViewer.ts';
import type { PostStub } from '../../api/posts.ts';
import { html, setHTML, linkify, raw, sharePost, navigate } from '../../utils/helpers.ts';
import { getNavTags, getSettings, getTheme, getUser, setTheme } from '../../store.ts';
import { pluginHost } from '../../core/pluginHost.ts';
import { ViewContext } from '../../utils/viewContext.ts';
import { renderTagLink, buildTagIndex, parseTagUrl, postGeoTag } from '../../utils/tagLinks.ts';
import { atlasPresentation, collapseAtlasOcean, expandAtlasOcean, presentAtlasOcean } from '../tags-atlas/atlasOcean.ts';
import type { AtlasWindow } from '../tags-atlas/atlasOcean.ts';
import { fromPostState, sheetReturnOf, sheetReturnState } from '../tags-atlas/atlasFromPost.ts';
import { markAtlasOpen, takeAtlasReturn } from '../../utils/atlasReturn.ts';
import { searchWithState, searchWithView } from '../tags-atlas/atlasLayerState.ts';
import { onAtlasSide } from '../tags-atlas/atlasLayerLayout.ts';
import { setupTagFlyout } from '../../utils/tagFlyout.ts';
import { exifVisible, buildExifMap, metadataForSrc, curatedExifRows } from '../../utils/exif.ts';
import { SHARE_SVG, EDIT_SVG, RSS_SVG, SUN_SVG, MOON_SVG, CHEVRON_SVG } from '../../utils/icons.ts';
import { immersiveNavTargets } from '../../utils/immersiveNav.ts';
import { renderCopyright } from '../../utils/copyright.ts';
const SHEET_ANIM_MS = 340;
const SHEET_ANIM = `transform ${SHEET_ANIM_MS / 1000}s cubic-bezier(0.22, 0.61, 0.36, 1)`;
/** The map zoom in the sheet's slot: a town and its streets. */
const SHEET_MAP_ZOOM = 10;
/** The full map's zoom after a tap on the slot: the place and the places near it. */
const FULL_MAP_ZOOM = 6;
export class ImmersiveSheetViewer extends MediaViewer {
  _sheetOpen: boolean;
  _sheetHeight: number;
  _currentOffset: number;
  _sheetDrag: boolean;
  _wrapper: HTMLElement | null = null;
  _sheetExifMeta: ReturnType<typeof metadataForSrc>[] | null = null;
  _sheetFlyoutCleanup: (() => void) | null = null;
  _sheetCommentsComps: { unmount?: () => void }[] | null = null;
  _onResize: (() => void) | null = null;
  /** Stop the frames that measure the sheet again after a resize. */
  _resizeSettleStop: (() => void) | null = null;
  _sheetObserver: ResizeObserver | null = null;
  _swipeAxis: 'v' | 'h' | null = null;
  /** The current touch started in the map slot: the swipe leaves the sheet alone. */
  _swipeInMap = false;
  /** The ocean shows through this viewer's slot. */
  _mapShown = false;
  /** Stop the frame loop that keeps the window on the slot during a sheet slide. */
  _mapFollowStop: (() => void) | null = null;
  /** A tap opened the full map: the ocean is not this viewer's now. */
  _mapLeaving = false;
  /** The way back from the full map: the ocean shrinks into the slot (collapse). */
  _mapReturning = false;
  /** The history entry was read for a return (once per viewer). */
  _returnChecked = false;
  /** Touch landscape: the sheet is a right column, always open. */
  _side = false;
  /** The portrait open state before the side layout forced it open. */
  _openBeforeSide: boolean | null = null;
  /** Stop the side watcher (onAtlasSide). */
  _sideStop: (() => void) | null = null;
  constructor(container: HTMLElement, props: MediaViewerProps = {}) {
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
    const settings = getSettings() || {};
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
    // An empty slot: the atlas ocean shows the map through it (_syncMapWindow).
    // It floats right in the EXIF column, under the EXIF block; the text flows on the left.
    const geo = this._mapGeoTag();
    const mapHtml = geo ? html`<div class="immersive-sheet-map" role="img" aria-label="${`Map: ${geo.name}`}"></div>` : '';
    return html`
      <div class="immersive-sheet" aria-hidden="true">
        <button class="immersive-sheet-grip" type="button" aria-label="Collapse details"></button>
        <div class="immersive-sheet-scroll">
          <div class="immersive-sheet-body">
            <aside class="immersive-sheet-exif hidden" aria-label="Camera data"></aside>
            ${mapHtml}
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
    const user = getUser();
    const editBtn = user && editUrl ? html`<a class="immersive-sheet-action" href="${editUrl}" data-action="edit">${raw(EDIT_SVG)}<span>Edit</span></a>` : '';
    const shareBtn = html`<button class="immersive-sheet-action" type="button" data-action="share">${raw(SHARE_SVG)}<span>Share</span></button>`;
    return html`<div class="immersive-sheet-actions">${editBtn}${shareBtn}</div>`;
  }
  _renderFooter(prev: PostStub | null | undefined, next: PostStub | null | undefined) {
    const settings = getSettings() || {};
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
    const navLink = (postObj: PostStub | null | undefined, side: 'left' | 'right') => {
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
    const settings = getSettings() || {};
    const media = this.props.media || [];
    if (exifVisible(settings, getUser()) && media.length) {
      const exifMap = buildExifMap(media);
      const meta = (this.props.items || []).map(it => it.type === 'image' && it.url ? metadataForSrc(exifMap, it.url) : null);
      if (meta.some(Boolean)) this._sheetExifMeta = meta;
    }
    this._updateSheetExif();

    // Tag flyouts inside the sheet.
    const tagsEl = this.$('.immersive-sheet-tags');
    if (tagsEl) {
      const navTags = getNavTags() || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      this._sheetFlyoutCleanup = setupTagFlyout(tagsEl, tagIndex, url => {
        const { tag, navPath } = parseTagUrl(url);
        ViewContext.update({
          tag,
          navPath,
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
    this._wireSheetMap();
    // The map sync waits for the return check below: a return holds the map.
    let sideReady = false;
    this._sideStop = onAtlasSide(side => this._applySide(side, sideReady));
    sideReady = true;
    const resync = () => {
      this._measureSheet();
      if (this._sheetOpen) this._setSheetOffset(this._sheetHeight, false);
    };
    // On iOS the resize (a rotation) can come before the layout settles. Sync
    // now, and again after two frames, when the slot has its new place.
    this._onResize = () => {
      resync();
      this._resizeSettleStop?.();
      let id = requestAnimationFrame(() => {
        id = requestAnimationFrame(() => {
          this._resizeSettleStop = null;
          resync();
        });
      });
      this._resizeSettleStop = () => cancelAnimationFrame(id);
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
    if (!this._returnChecked) {
      this._returnChecked = true;
      const ret = sheetReturnOf(history.state);
      if (ret) {
        this._returnToSheet(ret.atlasReturn);
        return;
      }
    }
    // A re-render with the sheet open puts the window on the new slot.
    if (this._sheetOpen) this._setSheetOffset(this._sheetHeight, false);
  }

  /**
   * The post's history entry asks for the open sheet: a Back from the full map
   * (atlasFromPost.ts). The sheet is open at once, with no slide; the ocean
   * holds the full map over the page and shrinks it into the slot after the
   * slot's first layout (atlasOcean.ts::collapse). The list URL marker of a
   * post that the map layer opened comes back, so a close still lands there.
   */
  _returnToSheet(atlasReturn: string | null) {
    if (atlasReturn) markAtlasOpen({ returnUrl: atlasReturn });
    this._sheetOpen = true;
    this._sheetDrag = false;
    this._showUI();
    this._wrapper?.classList.add('sheet-open');
    this.$('.immersive-sheet')?.setAttribute('aria-hidden', 'false');
    const geo = this._mapGeoTag();
    if (!this.$('.immersive-sheet-map') || !geo) {
      // No slot (no geo-tag now, or the atlas is off): a held map must go.
      if (atlasPresentation() === 'window') presentAtlasOcean('hidden');
      this._setSheetOffset(this._sheetHeight, false);
      return;
    }
    this._mapReturning = true;
    this._setSheetOffset(this._sheetHeight, false);
    const center = { lat: geo.latitude, lng: geo.longitude };
    const slot = (): AtlasWindow | null => {
      if (!this._mapReturning) return null;
      // The sheet can grow after the first render (images, comments): keep it open.
      this._measureSheet();
      if (!this._side && this._currentOffset !== this._sheetHeight) this._setSheetOffset(this._sheetHeight, false);
      const el = this.$('.immersive-sheet-map');
      if (!el) return null;
      return {
        kind: 'window',
        rect: el.getBoundingClientRect(),
        clip: this.$('.immersive-sheet-scroll')?.getBoundingClientRect(),
        center,
        zoom: SHEET_MAP_ZOOM,
        place: { slug: geo.slug },
        onTap: () => this._onMapTap()
      };
    };
    void collapseAtlasOcean(slot).then(() => {
      if (!this._mapReturning) return;
      this._mapReturning = false;
      this._mapShown = atlasPresentation() === 'window';
      // The slot can move during the tween; the window follows it now.
      this._syncMapWindow();
    });
  }
  /**
   * Turn the side layout on or off. On: the sheet opens, with no slide and no
   * transform (CSS places the column). Off: the sheet goes back to its
   * portrait state from before the side layout. `sync` puts the map window on
   * the slot (false only during the first wiring).
   */
  _applySide(side: boolean, sync = true) {
    if (side === this._side && this._wrapper?.classList.contains('immersive-sheet-side') === side) return;
    this._side = side;
    this._wrapper?.classList.toggle('immersive-sheet-side', side);
    this._sheetDrag = false;
    const sheet = this.$('.immersive-sheet');
    if (side) {
      if (this._openBeforeSide == null) this._openBeforeSide = this._sheetOpen;
      this._sheetOpen = true;
      this._wrapper?.classList.add('sheet-open');
      sheet?.setAttribute('aria-hidden', 'false');
    } else {
      const open = this._openBeforeSide ?? this._sheetOpen;
      this._openBeforeSide = null;
      this._sheetOpen = open;
      this._wrapper?.classList.toggle('sheet-open', open);
      sheet?.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    this._measureSheet();
    if (!sync) {
      this._clearSheetTransforms();
      return;
    }
    this._setSheetOffset(this._sheetOpen && !side ? this._sheetHeight : 0, false);
  }

  /** The side layout: no inline slide on the photo or the sheet. */
  _clearSheetTransforms() {
    for (const el of [this.$('.immersive-visuals'), this.$('.immersive-sheet')]) {
      if (!el) continue;
      el.style.transition = 'none';
      el.style.transform = '';
    }
  }

  /** In the side layout the photo stage is left of the column. */
  _stageWidth() {
    if (!this._side) return super._stageWidth();
    return this.$('.immersive-visuals')?.clientWidth || super._stageWidth();
  }

  /** In the side layout the column scrolls: a touch there starts no swipe. */
  _gestureIgnoreSelector() {
    return '.immersive-sheet-side .immersive-sheet';
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
      if (this._sheetOpen && !this._side) {
        e.stopPropagation();
        this._closeSheet();
      }
    }, true);
    const actions = this.$('.immersive-sheet-actions');
    this.on(actions, 'click', e => {
      const el = (e.target as Element).closest<HTMLElement>('[data-action]');
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
      const current = getTheme() || 'auto';
      setTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  // ── The map slot (the atlas ocean's window) ──────────────────────────────────

  /** The post's own geo-tag, when the atlas is on. No tag: no slot, no Leaflet. */
  _mapGeoTag() {
    if (!pluginHost.isEnabled('tags-atlas')) return null;
    return postGeoTag(this.props.post);
  }
  _wireSheetMap() {
    if (!this.$('.immersive-sheet-map')) return;
    this.on(this.$('.immersive-sheet-scroll'), 'scroll', () => this._syncMapWindow(), { passive: true });
    // The ocean is above the slot, so a touch there reaches the map, not the
    // sheet. A touch that does land on the slot (the ocean is not over it yet)
    // still must not drag the sheet.
    this.on(this._wrapper, 'touchstart', e => {
      this._swipeInMap = !!(e.target as Element).closest?.('.immersive-sheet-map');
    }, { capture: true, passive: true });
  }

  /**
   * A tap in the window opens the geo-tag's page in `map` state, at the place.
   * The ocean grows the window to the whole screen while the viewer fades
   * (`immersive-map-leaving`); then the move. The tag page's attach sets the
   * zoom, selects the place and focuses this post's chip
   * (atlasOcean.ts::expand). The history entry carries `fromPost` (the way
   * back to this post) and `sheet: 'open'`.
   */
  _onMapTap() {
    const geo = this._mapGeoTag();
    const postSlug = this.props.post?.slug;
    if (!geo || !postSlug || this._mapLeaving) return;
    this._mapLeaving = true;
    this._mapReturning = false;
    this._stopMapFollow();
    // The tag page owns the ocean from here: this viewer's cleanup must not hide it.
    this._mapShown = false;
    this.container.classList.add('immersive-map-leaving');
    const center = { lat: geo.latitude, lng: geo.longitude };
    const search = searchWithView(searchWithState('', 'map'), { ...center, zoom: FULL_MAP_ZOOM });
    const path = `/tags/${encodeURIComponent(geo.slug)}${search}`;
    const title = this.props.post?.title || '';
    void expandAtlasOcean({ center, zoom: FULL_MAP_ZOOM, focusPostSlug: postSlug }).then(() => {
      // Back to this entry opens the sheet and shrinks the map into the slot.
      // The post page drops the list URL marker when it unmounts; the entry keeps it.
      history.replaceState(sheetReturnState(history.state, takeAtlasReturn()), '');
      navigate(path, { state: fromPostState(postSlug, title) });
    });
  }

  /**
   * Put the ocean's window on the slot, or hide the ocean when the slot is off
   * screen (the sheet is shut). The first window of a post centres the geo-tag;
   * the next ones move the map with the slot, so a pan in the window stays.
   */
  _syncMapWindow() {
    if (this._mapLeaving || this._mapReturning) return;
    const slot = this.$('.immersive-sheet-map');
    const geo = slot ? this._mapGeoTag() : null;
    // A shut sheet has no slot on screen; a closing slide keeps the window to the end.
    // The side column is always open.
    if (!slot || !geo || !this._side && this._currentOffset <= 0 && !this._mapFollowStop) {
      this._hideMapWindow();
      return;
    }
    const rect = slot.getBoundingClientRect();
    const scroller = this.$('.immersive-sheet-scroll')?.getBoundingClientRect();
    presentAtlasOcean({
      kind: 'window',
      rect,
      clip: scroller,
      center: this._mapShown ? undefined : { lat: geo.latitude, lng: geo.longitude },
      zoom: this._mapShown ? undefined : SHEET_MAP_ZOOM,
      place: this._mapShown ? undefined : { slug: geo.slug },
      onTap: () => this._onMapTap()
    });
    this._mapShown = true;
  }

  /** Hide the ocean if this viewer's window is what it shows. */
  _hideMapWindow() {
    this._stopMapFollow();
    if (!this._mapShown) return;
    this._mapShown = false;
    // A list page that attached in the meantime owns the ocean now.
    if (atlasPresentation() === 'window') presentAtlasOcean('hidden');
  }

  /** Keep the window on the slot for one sheet slide (a CSS transition). */
  _followMapWindow() {
    this._stopMapFollow();
    if (!this.$('.immersive-sheet-map')) return;
    const end = performance.now() + SHEET_ANIM_MS + 50;
    let id = 0;
    const step = (now: number) => {
      this._syncMapWindow();
      if (now < end) id = requestAnimationFrame(step);
      else {
        this._mapFollowStop = null;
        this._syncMapWindow();
      }
    };
    id = requestAnimationFrame(step);
    this._mapFollowStop = () => cancelAnimationFrame(id);
  }
  _stopMapFollow() {
    this._mapFollowStop?.();
    this._mapFollowStop = null;
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
  _onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as Element).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (this._zoomState.scale > 1) return super._onKeyDown(e);
    // The side column is always open: Up and Down only scroll it.
    if (this._side && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      this._scrollSheet(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
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
  _scrollSheet(dir: number) {
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

  _onSwipeMove(dx: number, dy: number) {
    // A drag in the map slot pans the map; the sheet does not move.
    if (this._swipeInMap) return;
    if (this._zoomState.scale > 1) return super._onSwipeMove(dx, dy);

    // Latch the axis on the first move so a diagonal drag can't flip handlers
    // mid-gesture; reset in _onSwipeCommit / _onSwipeCancel.
    if (this._swipeAxis == null) {
      this._swipeAxis = Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h';
    }
    if (this._side) {
      // The side column does not drag. A swipe down on the photo dismisses.
      this._sheetDrag = false;
      if (this._swipeAxis === 'h') return super._onSwipeMove(dx, 0);
      return super._onSwipeMove(0, Math.max(0, dy));
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
  _onSwipeCommit(dir: 'left' | 'right' | 'up' | 'down') {
    this._swipeAxis = null;
    if (this._swipeInMap) {
      this._swipeInMap = false;
      return;
    }
    if (this._zoomState.scale > 1) return super._onSwipeCommit(dir);
    if (this._side) {
      if (dir === 'down') return this.props.onClose?.();
      if (dir === 'up') return super._onSwipeCancel();
      return super._onSwipeCommit(dir);
    }
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
    if (this._swipeInMap) {
      this._swipeInMap = false;
      return;
    }
    if (this._sheetDrag) {
      this._sheetDrag = false;
      // Snap to the nearer end state — never rest mid-way.
      if (this._currentOffset > this._sheetHeight / 2) this._openSheet();else this._closeSheet();
      return;
    }
    super._onSwipeCancel();
  }
  _setSheetOffset(px: number, animate: boolean) {
    if (this._side) {
      // The side column has no slide: CSS places it, and the window follows the slot.
      this._currentOffset = 0;
      this._clearSheetTransforms();
      this._stopMapFollow();
      this._syncMapWindow();
      return;
    }
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
    if (animate) this._followMapWindow();
    else {
      this._stopMapFollow();
      this._syncMapWindow();
    }
  }
  _openSheet() {
    if (this._side) return;
    if (!this._sheetHeight) this._measureSheet();
    this._sheetOpen = true;
    this._sheetDrag = false;
    this._showUI();
    this._wrapper?.classList.add('sheet-open');
    this.$('.immersive-sheet')?.setAttribute('aria-hidden', 'false');
    this._setSheetOffset(this._sheetHeight, true);
  }
  _closeSheet() {
    if (this._side) return;
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
  _finalizeSwap(newIndex: number) {
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
  beforeUnmount() {
    // A return that did not end: the held map is this viewer's to hide. (A
    // re-render also runs _cleanup; the return goes on through it.)
    if (this._mapReturning) {
      this._mapReturning = false;
      this._mapShown = true;
    }
    super.beforeUnmount();
    this._mapLeaving = false;
    this.container.classList.remove('immersive-map-leaving');
  }
  _cleanup() {
    super._cleanup();
    this._hideMapWindow();
    // A re-render during a leave keeps `_mapLeaving` (beforeUnmount ends it):
    // the re-wired viewer must not put a window on the expand (atlasOcean.ts).
    this._swipeInMap = false;
    this._sideStop?.();
    this._sideStop = null;
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    this._resizeSettleStop?.();
    this._resizeSettleStop = null;
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