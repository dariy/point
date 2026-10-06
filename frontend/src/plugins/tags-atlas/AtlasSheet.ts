/**
 * AtlasSheet — the bottom sheet that shows the posts of one Atlas place.
 *
 * One row of square post cards and a bar under it: the place label with its
 * post count, and a compact paginator. The row holds as many squares as fit
 * (fitColumns), and that count is the page size. Paging is the shared grid
 * engine (GridPager), so a swipe, a trackpad flick and the arrow keys page the
 * row like they page the home grid.
 *
 * States:
 *   hidden     no place; nothing on screen
 *   open       the sheet is up and the pager is armed
 *   collapsed  the sheet is down; a pill opens it again on the same page
 *
 * The sheet renders once. After that it changes its DOM in place, so the
 * grid, the paginator and the pager survive every state change.
 */

import { Component } from '../../components/Component.ts';
import { Pagination } from '../../components/shared/Pagination.ts';
import { GridPager } from '../../core/gridPager.ts';
import { pluginHost } from '../../core/pluginHost.ts';
import { getTagPage } from '../../api/pages.ts';
import { getSettings } from '../../store.ts';
import { html, setHTML } from '../../utils/helpers.ts';
import { refitPage } from '../../utils/gridFit.ts';

import type { Post } from '../../api/posts.ts';
import type { GridPagination } from '../../core/gridPager.ts';
import type { PostListHandle } from '../../pages/public/HomePage.ts';

/** Card width over card height. The sheet cards are square. */
export const CARD_ASPECT = 1;

/** The gap between two cards, in px. The CSS reads it as --atlas-sheet-gap. */
export const SHEET_GAP_PX = 8;

/** The column count when the row cannot be measured. */
const FALLBACK_COLS = 4;

/** The upper limit of the column count, as the page size limit of the grids. */
const MAX_COLS = 60;

/** The crossfade time of the grid, in ms. */
const FADE_MS = 200;

/** The place that the sheet shows. */
export interface AtlasSheetPlace {
  id: number;
  slug: string;
  name: string;
}

export interface AtlasSheetProps {
  /** True when the post must not show (the owner's "Hidden" filter). */
  skip?: (post: Post) => boolean;
  /** The timeline year scope for the page request. */
  scope?: () => { year_from?: number; year_to?: number };
  /** Open a post. `page` and `perPage` let the Atlas open the sheet again on return. */
  onOpenPost?: (post: Post, page: number, perPage: number) => void;
  /** Called when the sheet opens or closes. */
  onToggle?: (open: boolean) => void;
}

/**
 * The number of cards that fit in one row.
 *
 * @param width - Row width in px.
 * @param height - Row height in px. Zero or less gives the fallback of 4.
 * @param gap - Gap between two cards in px.
 * @param aspect - Card width over card height.
 */
export function fitColumns(width: number, height: number, gap: number, aspect: number): number {
  if (!(height > 0) || !(width > 0)) return FALLBACK_COLS;
  const card = height * aspect;
  return Math.max(1, Math.min(MAX_COLS, Math.floor((width + gap) / (card + gap))));
}

export class AtlasSheet extends Component<AtlasSheetProps> {
  _place: AtlasSheetPlace | null = null;
  _page = 1;
  _perPage = FALLBACK_COLS;
  _open = false;
  _pagination: GridPagination | null = null;
  _total = 0;
  /** Monotonic token. A newer request, or hide(), drops the response of an older one. */
  _req = 0;
  _grid: PostListHandle | null = null;
  _paginator: Pagination | null = null;
  _pager: GridPager;
  /** The grip drag in progress: the start Y and the last offset. */
  _drag: { id: number; y0: number; dy: number } | null = null;
  /** True when the last grip pointer moved, so the click that follows is not a tap. */
  _dragMoved = false;

  constructor(container: HTMLElement, props: AtlasSheetProps = {}) {
    super(container, props);
    this._pager = new GridPager({
      gridMount: () => this.$('#atlas-grid-mount'),
      gestureRoot: () => this.$('.atlas-sheet__main'),
      fetchPosts: async (page: number) => this._visible((await this._fetch(page)).posts || []),
      gotoPage: (page: number) => this._goto(page),
      onZoomCommit: () => {},
      isAlive: () => !this._unmounted,
      emptyHtml: html`<p class="empty-state">No posts.</p>`,
      zoom: false,
      edgeArrows: false,
      onVerticalSwipe: (dir) => {
        if (dir === 'down') this.collapse();
      },
    });
  }

  get place() { return this._place; }
  get page() { return this._page; }
  get isOpen() { return this._open; }

  render() {
    return html`
      <section class="atlas-sheet" aria-label="Posts of the place" inert>
        <button type="button" class="atlas-sheet__grip" aria-label="Collapse the posts"></button>
        <div class="atlas-sheet__main">
          <div class="atlas-sheet__row">
            <div id="atlas-grid-mount" class="atlas-sheet__grid"></div>
          </div>
          <div class="atlas-sheet__bar">
            <span class="atlas-sheet__label"></span>
            <div class="atlas-sheet__pages" id="atlas-pagination-mount"></div>
          </div>
        </div>
      </section>
      <button type="button" class="atlas-sheet-pill" hidden></button>`;
  }

  afterRender() {
    const grip = this.$('.atlas-sheet__grip') as HTMLElement;
    const pill = this.$('.atlas-sheet-pill') as HTMLElement;
    const row = this.$('.atlas-sheet__row') as HTMLElement;
    const sheet = this.$('.atlas-sheet') as HTMLElement;
    sheet.style.setProperty('--atlas-sheet-gap', `${SHEET_GAP_PX}px`);
    sheet.style.setProperty('--atlas-cols', String(this._perPage));

    this.on(grip, 'click', () => {
      if (this._dragMoved) {
        this._dragMoved = false;
        return;
      }
      this.collapse();
    });
    this.on(grip, 'pointerdown', (e: PointerEvent) => this._onGripDown(e));
    this.on(grip, 'pointermove', (e: PointerEvent) => this._onGripMove(e));
    this.on(grip, 'pointerup', (e: PointerEvent) => this._onGripUp(e));
    this.on(grip, 'pointercancel', () => this._endDrag(false));
    this.on(pill, 'click', () => this.expand());
    this.on(document, 'keydown', (e: KeyboardEvent) => this._onKeyDown(e));
    this.observe(new ResizeObserver(() => this._onResize())).observe(row);
    this.registerCleanup(() => this._pager.destroy());
  }

  /**
   * Show the posts of `place`. A closed sheet slides up and shows a spinner
   * until the page loads. An open sheet stays where it is and crossfades.
   *
   * @param place - The place.
   * @param opts.page - The page to show. Default 1.
   * @param opts.perPage - The page size that `page` counts in. When it is not
   *   the current fit, the page is converted with refitPage.
   */
  show(place: AtlasSheetPlace, { page = 1, perPage }: { page?: number; perPage?: number } = {}) {
    const wasOpen = this._open;
    this._place = place;
    this._total = 0;
    this._pagination = null;
    // The old place's pages stay off until the new page loads.
    this._paginator?.setProps({ page: 1, pages: 1, total: 0, compact: true, onPage: (p: number) => this._goto(p) });
    const fit = this._fit();
    this._setCols(fit);
    if (perPage && perPage !== fit) page = refitPage(page, perPage, fit);
    this._page = Math.max(1, page);
    this._setLabel(place.name, null);
    if (!wasOpen) {
      this._clearGrid();
      const gm = this.$('#atlas-grid-mount');
      if (gm) setHTML(gm, html`<div class="loading-spinner" aria-label="Loading posts…"></div>`);
      this._setOpen(true);
    }
    return this._load(this._page, { fade: wasOpen });
  }

  /** Slide the sheet down and show the pill. The place and the page stay. */
  collapse() {
    if (!this._open || !this._place) return;
    this._setOpen(false);
  }

  /** Slide the sheet up again on the same page. */
  expand() {
    if (this._open || !this._place) return;
    this._setOpen(true);
  }

  /** Drop the place, the pill and any request in flight. */
  hide() {
    this._req++;
    const wasOpen = this._open;
    this._place = null;
    this._pagination = null;
    this._open = false;
    const sheet = this.$('.atlas-sheet') as HTMLElement | null;
    if (sheet) {
      sheet.classList.remove('is-open');
      sheet.style.transform = '';
      sheet.inert = true;
    }
    const pill = this.$('.atlas-sheet-pill') as HTMLElement | null;
    if (pill) pill.hidden = true;
    this._pager.disarm();
    if (wasOpen) this.props.onToggle?.(false);
  }

  /** Props are read when they are used, so a prop change never rebuilds the sheet. */
  update() {
    return true;
  }

  beforeUnmount() {
    this._req++;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  _setOpen(open: boolean) {
    this._open = open;
    const sheet = this.$('.atlas-sheet') as HTMLElement | null;
    if (sheet) {
      sheet.classList.toggle('is-open', open);
      sheet.style.transform = '';
      sheet.style.transition = '';
      sheet.inert = !open;
    }
    const pill = this.$('.atlas-sheet-pill') as HTMLElement | null;
    if (pill) pill.hidden = open || !this._place;
    if (open && this._pagination) this._pager.arm({ ...this._pagination });
    if (!open) this._pager.disarm();
    this.props.onToggle?.(open);
  }

  _setLabel(name: string, total: number | null) {
    const count = total == null ? '' : `${total} post${total === 1 ? '' : 's'}`;
    const label = this.$('.atlas-sheet__label');
    if (label) label.textContent = count ? `${name} · ${count}` : name;
    const pill = this.$('.atlas-sheet-pill');
    if (pill) pill.textContent = count ? `▲ ${name} · ${total}` : `▲ ${name}`;
  }

  _setCols(cols: number) {
    this._perPage = cols;
    (this.$('.atlas-sheet') as HTMLElement | null)?.style.setProperty('--atlas-cols', String(cols));
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  _fetch(page: number) {
    const place = this._place!;
    return getTagPage(place.slug, { page, per_page: this._perPage, ...(this.props.scope?.() || {}) });
  }

  _visible(posts: Post[]) {
    const skip = this.props.skip;
    return skip ? posts.filter((p) => !skip(p)) : posts;
  }

  _goto(page: number) {
    if (!this._place || !this._pagination || page === this._page) return;
    this._page = page;
    void this._load(page, { fade: true });
  }

  /**
   * Fetch `page` and mount it. The crossfade copies HomePage._refreshPostContent:
   * a committed swipe hands off to the real grid under its ghost, anything else
   * fades the old grid out and the new grid in.
   */
  async _load(page: number, { fade = false, refit = false } = {}) {
    if (!this._place) return;
    const token = ++this._req;
    const place = this._place;
    const gm = this.$('#atlas-grid-mount') as HTMLElement | null;
    const seamless = this._pager.takeSeamless();
    const fromSwipe = seamless || this._pager.isMidSwipe();

    let fadeOut: Promise<unknown> = Promise.resolve();
    if (gm && fade && !fromSwipe && !refit) {
      gm.style.transition = `opacity ${FADE_MS / 1000}s ease-in`;
      gm.style.opacity = '0';
      fadeOut = new Promise((resolve) => setTimeout(resolve, FADE_MS));
    }

    let data;
    try {
      data = await this._fetch(page);
    } catch {
      if (token !== this._req || this._unmounted) return;
      await fadeOut;
      this._clearGrid();
      const mount = this.$('#atlas-grid-mount') as HTMLElement | null;
      if (mount) {
        mount.style.opacity = '';
        setHTML(mount, html`<p class="empty-state" role="alert">Failed to load posts.</p>`);
      }
      return;
    }
    if (token !== this._req || this._unmounted) return;
    await fadeOut;
    if (token !== this._req || this._unmounted) return;

    const pg = data.pagination || {};
    const pages = Math.max(1, pg.pages || 1);
    this._page = Math.min(Math.max(1, pg.page || page), pages);
    this._total = pg.total ?? (data.posts || []).length;
    // The sheet ignores min_page: the scheduled queue does not show here.
    this._pagination = { page: this._page, pages, total: this._total };
    this._setLabel(place.name, this._total);

    await this._mountGrid(this._visible(data.posts || []));
    if (token !== this._req || this._unmounted) return;
    this._syncPaginator();
    if (this._open) this._pager.arm({ ...this._pagination });

    const newGrid = this.$('#atlas-grid-mount') as HTMLElement | null;
    if (seamless) {
      this._pager.finishHandoff();
    } else if (newGrid && fade && !refit) {
      newGrid.style.transition = 'none';
      newGrid.style.opacity = '0';
      void newGrid.offsetWidth; // force a reflow so the next change animates
      newGrid.style.transition = `opacity ${FADE_MS / 1000}s ease-out`;
      newGrid.style.opacity = '1';
    }
  }

  /** Mount the shared post list, as HomePage._mountPostContent does. */
  async _mountGrid(posts: Post[]) {
    this._clearGrid();
    this._pager.resetGridStyles();
    const gm = this.$('#atlas-grid-mount') as HTMLElement | null;
    if (!gm) return;
    const settings = getSettings() || {};
    const page = this._page;
    const gridProps = {
      posts,
      showViewCount: !!settings.show_view_counts,
      emptyMessage: 'No posts.',
      onOpen: (post: Post) => this.props.onOpenPost?.(post, page, this._perPage),
    };
    let grid: PostListHandle | null;
    if (pluginHost.hasSlot('post-list')) {
      grid = await pluginHost.fillOne('post-list', gm, gridProps) as PostListHandle | null;
    } else {
      const mod = pluginHost.isEnabled('dynamic-post-list')
        ? await import('../dynamic-post-list/index.ts')
        : await import('../simple-post-list/index.ts');
      grid = mod.mount(gm, gridProps);
    }
    if (this._unmounted) {
      grid?.unmount();
      return;
    }
    this._grid = grid;
  }

  _clearGrid() {
    this._grid?.unmount();
    this._grid = null;
    this._pager.disarm();
  }

  _syncPaginator() {
    const pg = this._pagination;
    if (!pg) return;
    const props = {
      page: pg.page ?? 1,
      pages: pg.pages,
      total: pg.total,
      compact: true,
      onPage: (p: number) => this._goto(p),
    };
    if (this._paginator) this._paginator.setProps(props);
    else this._paginator = this.mountChild(Pagination, '#atlas-pagination-mount', props);
  }

  // ── Fit ────────────────────────────────────────────────────────────────────

  _fit() {
    const row = this.$('.atlas-sheet__row') as HTMLElement | null;
    if (!row) return FALLBACK_COLS;
    return fitColumns(row.clientWidth, row.clientHeight, SHEET_GAP_PX, CARD_ASPECT);
  }

  _onResize() {
    if (!this._place) return;
    const next = this._fit();
    if (next === this._perPage) return;
    const page = refitPage(this._page, this._perPage, next);
    this._setCols(next);
    this._page = page;
    void this._load(page, { refit: true });
  }

  // ── Grip and keys ──────────────────────────────────────────────────────────

  _onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !this._open || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    this.collapse();
  }

  _onGripDown(e: PointerEvent) {
    if (!this._open || e.button > 0) return;
    this._drag = { id: e.pointerId, y0: e.clientY, dy: 0 };
    this._dragMoved = false;
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  }

  _onGripMove(e: PointerEvent) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    if (d.dy > 4) this._dragMoved = true;
    const sheet = this.$('.atlas-sheet') as HTMLElement | null;
    if (!sheet) return;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${d.dy}px)`;
  }

  _onGripUp(e: PointerEvent) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    const sheet = this.$('.atlas-sheet') as HTMLElement | null;
    const h = sheet?.offsetHeight || 0;
    this._endDrag(h > 0 && d.dy > h / 3);
  }

  /** Finish a grip drag: collapse, or snap back to open. */
  _endDrag(collapse: boolean) {
    this._drag = null;
    const sheet = this.$('.atlas-sheet') as HTMLElement | null;
    if (sheet) {
      sheet.style.transition = '';
      sheet.style.transform = '';
    }
    if (collapse) this.collapse();
  }
}
