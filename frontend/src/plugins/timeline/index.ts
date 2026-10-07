import { Component } from "../../components/Component.ts";
import { getTimeline } from "../../api/timeline.ts";
import type { TimelinePill } from "../../api/timeline.ts";
import { html } from "../../utils/helpers.ts";

/** A year range: the first and last year, inclusive. */
interface YearSpan {
  from: number;
  to: number;
}

/**
 * A year range the timeline reports in filter mode. `isFullExtent` is set when
 * there is no year filter (the collapsed state), which the host reads as "all".
 */
export interface TimelineRange extends YearSpan {
  source: string;
  isFullExtent?: boolean;
}

export interface TimelineProps {
  /** Context tag slug. */
  context?: string;
  mode?: "popover" | "filter";
  /** Filter mode. */
  onRangeChange?: (range: TimelineRange) => void;
  /** The range to open on. Expands the timeline. */
  initialRange?: YearSpan;
  /** A year to open on. Expands the timeline. */
  initialYear?: string;
  /** Show `initialYear` without reporting it: the page already lists that year (a year tag). */
  quiet?: boolean;
  /** The host's post count. Not shown. */
  total?: number;
  canShow?: boolean;
}

/**
 * The year a tag stands for, else null. The server's rule: kind = 'year' and
 * the year is the slug read as an integer (queries_posts.go, CAST(slug AS INTEGER)).
 */
export function yearOfTag(tag: { kind?: string, slug?: string } | null | undefined): number | null {
  if (!tag || tag.kind !== "year") return null;
  const y = parseInt(tag.slug ?? "", 10);
  return Number.isNaN(y) ? null : y;
}

/** The years that have posts, ascending. Decade pills are not years. */
export function yearsOf(pills: TimelinePill[]): number[] {
  const years = new Set<number>();
  for (const p of pills) if (!p.is_decade) years.add(p.year);
  return [...years].sort((a, b) => a - b);
}

/** The pills the expanded strip shows: the active year and its neighbours. */
export interface YearWindow {
  shown: number[];
  /** Years before the first shown pill are hidden. */
  moreBefore: boolean;
  /** Years after the last shown pill are hidden. */
  moreAfter: boolean;
}

/**
 * The year the strip centres on: the last year of the scope, or the nearest
 * year that has posts when the scope year has none.
 */
export function anchorYear(years: number[], scope: YearSpan): number {
  if (years.includes(scope.to)) return scope.to;
  return years.reduce((best, y) => (Math.abs(y - scope.to) < Math.abs(best - scope.to) ? y : best), years[0]);
}

/** A maximum of 3 pills: the year before `active`, `active`, the year after. */
export function yearWindow(years: number[], active: number): YearWindow {
  const i = years.indexOf(active);
  if (i < 0) return { shown: [], moreBefore: false, moreAfter: false };
  const lo = Math.max(0, i - 1);
  const hi = Math.min(years.length - 1, i + 1);
  return { shown: years.slice(lo, hi + 1), moreBefore: lo > 0, moreAfter: hi < years.length - 1 };
}

/** The year one step from `active` (-1 before, +1 after), else null at the edge. */
export function stepYear(years: number[], active: number, dir: number): number | null {
  const i = years.indexOf(active);
  if (i < 0) return null;
  const y = years[i + Math.sign(dir)];
  return y === undefined ? null : y;
}

/**
 * The timeline markup. Collapsed: one "All years" pill. Expanded: a maximum of
 * 3 pills around the active year, with a flag on each side that hides more.
 */
export function renderTimeline(years: number[], scope: YearSpan | null) {
  if (!scope) {
    return html`
      <div class="timeline-container is-collapsed" role="group" aria-label="Date timeline">
        <div class="timeline-strip">
          <button type="button" class="timeline-pill-btn is-active" data-action="expand" aria-pressed="true">All years</button>
        </div>
      </div>
    `;
  }
  const win = yearWindow(years, anchorYear(years, scope));
  const i = win.shown.indexOf(anchorYear(years, scope));
  // has-prev / has-next: a neighbour pill is shown, for the header fold that hides it.
  const flags = `${win.moreBefore ? " has-more-before" : ""}${win.moreAfter ? " has-more-after" : ""}`
    + `${i > 0 ? " has-prev" : ""}${i < win.shown.length - 1 ? " has-next" : ""}`;
  return html`
    <div class="timeline-container is-expanded${flags}" role="group" aria-label="Date timeline">
      <div class="timeline-strip" tabindex="-1">
        ${win.shown.map((y) => {
          const on = y >= scope.from && y <= scope.to;
          return html`<button type="button" class="timeline-pill-btn${on ? " is-active" : ""}" data-action="pick" data-year="${y}" aria-pressed="${on ? "true" : "false"}">${y}</button>`;
        })}
      </div>
    </div>
  `;
}

/**
 * The short form's spinner panel: the year before `year`, `year`, the year
 * after, top to bottom, with a "…" mark on a side that hides more years.
 */
export function renderSpinner(years: number[], year: number) {
  const win = yearWindow(years, year);
  return html`
    <div class="timeline-spinner" role="listbox" aria-label="Year">
      ${win.moreBefore ? html`<span class="timeline-spinner-more" aria-hidden="true">…</span>` : ""}
      ${win.shown.map((y) => {
        const on = y === year;
        return html`<button type="button" class="timeline-spinner-year${on ? " is-active" : ""}" data-action="spin" data-year="${y}" role="option" aria-selected="${on ? "true" : "false"}">${y}</button>`;
      })}
      ${win.moreAfter ? html`<span class="timeline-spinner-more" aria-hidden="true">…</span>` : ""}
    </div>
  `;
}

/** The year the next expansion focuses: the last one picked, else the newest. */
let lastFocusedYear: number | null = null;

/**
 * Timeline component — a strip of year pills, collapsed to "All years" when
 * there is no year filter.
 */
export class Timeline extends Component<TimelineProps> {
  /** Two taps within this many ms make a double tap. */
  static DOUBLE_TAP_MS = 300;
  _lastTap = 0;
  _tapTimer: ReturnType<typeof setTimeout> | null = null;
  _onClick = (e: Event) => this._handleClick(e as MouseEvent);
  _onKeydown = (e: Event) => {
    const key = (e as KeyboardEvent).key;
    // The open spinner panel: Up/Down move, Enter confirms, Escape cancels.
    if (this.state.panel) {
      if (key === "ArrowUp" || key === "ArrowDown") this._previewStep(key === "ArrowUp" ? -1 : 1);
      else if (key === "Enter") this._confirmPanel();
      else if (key === "Escape") this._closePanel();
      else return;
      e.preventDefault();
      this.$(".timeline-spinner-year.is-active, .timeline-pill-btn.is-active")?.focus();
      return;
    }
    // Escape on the focused timeline collapses it.
    if (key === "Escape" && this.state.scope) this.collapse();
    // Left and Right move the expanded strip one year.
    if ((key === "ArrowLeft" || key === "ArrowRight") && this.state.scope) {
      e.preventDefault();
      this.slide(key === "ArrowLeft" ? -1 : 1);
      this.$(".timeline-pill-btn.is-active")?.focus();
    }
  };

  /** A drag this many px wide moves one year. */
  static SLIDE_STEP_PX = 40;
  /** Wheel delta that moves one year. */
  static WHEEL_STEP = 60;
  /** A vertical drag this many px tall moves the spinner one year. */
  static SPIN_STEP_PX = 32;
  _drag: { id: number, x: number, y: number, moved: boolean, vertical: boolean } | null = null;
  _wheelAcc = 0;
  _wheelTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wheel pause, in ms, that commits the previewed year. */
  static WHEEL_COMMIT_MS = 250;
  /** Set by a slide: the click that ends it is not a tap. */
  _slid = false;
  _onDragMove = (e: PointerEvent) => {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    if (d.vertical) {
      const dy = e.clientY - d.y;
      if (Math.abs(dy) < Timeline.SPIN_STEP_PX) return;
      d.moved = true;
      // Drag down shows the earlier year, as the column follows the finger.
      d.y = e.clientY;
      this._previewStep(dy > 0 ? -1 : 1);
      return;
    }
    const dx = e.clientX - d.x;
    if (Math.abs(dx) < Timeline.SLIDE_STEP_PX) return;
    if (!d.moved) {
      d.moved = true;
      this._cancelTap();
    }
    // Drag right shows the earlier year, as content follows the finger.
    d.x = e.clientX;
    this._previewStep(dx > 0 ? -1 : 1);
  };
  _onDragEnd = (e: PointerEvent) => {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._endDrag();
    if (!d.moved) return;
    this._slid = true;
    // A touch slide sends no click: clear the flag after the click would arrive.
    setTimeout(() => { this._slid = false; }, 0);
    // The spinner panel keeps the previewed year until a confirm.
    if (!d.vertical) this._commitPreview();
  };
  /** A pointerdown outside the timeline closes the spinner panel without a change. */
  _onOutsideDown = (e: Event) => {
    if (!this.container.contains(e.target as Node)) this._closePanel();
  };

  constructor(container: HTMLElement, props: TimelineProps = {}) {
    super(container, props);
    this.state = { years: [] as number[], scope: null as YearSpan | null, isLoading: true, preview: null as number | null, panel: false };
  }

  mount(): void {
    this.container.addEventListener("click", this._onClick);
    this.container.addEventListener("keydown", this._onKeydown);
    this._fetchData();
  }

  beforeUnmount(): void {
    this.container.removeEventListener("click", this._onClick);
    this.container.removeEventListener("keydown", this._onKeydown);
    if (this._tapTimer) clearTimeout(this._tapTimer);
    this._tapTimer = null;
    if (this._wheelTimer) clearTimeout(this._wheelTimer);
    this._wheelTimer = null;
    this._endDrag();
    document.removeEventListener("pointerdown", this._onOutsideDown, true);
  }

  /** The short form: the header fold shows only the active pill (fold 70). */
  _isShort(): boolean {
    return !!this.container.closest?.(".fold-timeline");
  }

  /** Open the spinner panel on the active year. */
  _openPanel(): void {
    if (!this.state.scope || this.state.panel) return;
    this.setState({ panel: true, preview: null });
    document.addEventListener("pointerdown", this._onOutsideDown, true);
    this.$(".timeline-spinner-year.is-active")?.focus();
  }

  /** Close the spinner panel without a change (Escape, an outside tap). */
  _closePanel(): void {
    if (!this.state.panel) return;
    document.removeEventListener("pointerdown", this._onOutsideDown, true);
    this.setState({ panel: false, preview: null });
  }

  /** Close the spinner panel and report the previewed year: one focusYear call. */
  _confirmPanel(): void {
    const scope: YearSpan | null = this.state.scope;
    if (!this.state.panel || !scope) return;
    const year: number = this.state.preview ?? anchorYear(this.state.years, scope);
    document.removeEventListener("pointerdown", this._onOutsideDown, true);
    this.state.panel = false;
    this.state.preview = null;
    this.focusYear(year);
    // focusYear does not re-render when the year did not change.
    this._rerender();
  }

  _endDrag(): void {
    this._drag = null;
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragEnd);
    window.removeEventListener("pointercancel", this._onDragEnd);
  }

  /**
   * Show the year one step from the shown one, without reporting it: the post
   * list does not change until `_commitPreview`.
   */
  _previewStep(dir: number): void {
    const scope: YearSpan | null = this.state.scope;
    if (!scope) return;
    const years: number[] = this.state.years;
    const from: number = this.state.preview ?? anchorYear(years, scope);
    const next = stepYear(years, from, dir);
    if (next !== null && next !== this.state.preview) this.setState({ preview: next });
  }

  /** Report the previewed year, if any (drag release, wheel pause). */
  _commitPreview(): void {
    const year: number | null = this.state.preview ?? null;
    if (year === null) return;
    this.state.preview = null;
    this.focusYear(year);
    // focusYear does not re-render when the year did not change.
    this._rerender();
  }

  /** Move the active year one step (-1 before, +1 after). No move at the edge. */
  slide(dir: number): void {
    const scope: YearSpan | null = this.state.scope;
    if (!scope) return;
    const years: number[] = this.state.years;
    const next = stepYear(years, anchorYear(years, scope), dir);
    if (next !== null) this.focusYear(next);
  }

  /** A pending single tap is not a tap when a slide starts. */
  _cancelTap(): void {
    if (this._tapTimer) clearTimeout(this._tapTimer);
    this._tapTimer = null;
    this._lastTap = 0;
  }

  /**
   * A keyboard click (detail 0) acts at once: Enter on "All years" expands.
   * A pointer click waits for a second tap: two within DOUBLE_TAP_MS toggle the
   * state and send no single-tap action; one tap picks its year when the wait ends.
   */
  _handleClick(e: MouseEvent): void {
    if (this._slid) {
      this._slid = false;
      e.stopPropagation();
      return;
    }
    const spin = (e.target as Element | null)?.closest?.<HTMLElement>(".timeline-spinner-year");
    if (spin) {
      // In the panel a tap acts at once: the active year confirms, a neighbour is previewed.
      const y = parseInt(spin.dataset.year ?? "", 10);
      const shown: number | null = this.state.preview ?? (this.state.scope ? anchorYear(this.state.years, this.state.scope) : null);
      if (y === shown) this._confirmPanel();
      else if (!Number.isNaN(y)) this.setState({ preview: y });
      return;
    }
    const btn = (e.target as Element | null)?.closest?.<HTMLElement>(".timeline-pill-btn");
    const year = parseInt(btn?.dataset.year ?? "", 10);
    // Short form: a tap on the one pill opens the panel at once, another tap closes it.
    if (btn && btn.dataset.action === "pick" && (this.state.panel || this._isShort())) {
      const now = Date.now();
      if (!this.state.panel) {
        this._lastTap = now;
        this._openPanel();
      } else if (e.detail !== 0 && now - this._lastTap < Timeline.DOUBLE_TAP_MS) {
        // A double tap still toggles: the first tap opened the panel.
        this._lastTap = 0;
        this._closePanel();
        this.toggle();
      } else {
        this._closePanel();
      }
      return;
    }
    // A tap on the empty strip counts toward a double tap but has no single-tap action.
    const single = () => {
      if (!btn) return;
      if (btn.dataset.action === "expand") this.expand();
      else if (!Number.isNaN(year)) this.focusYear(year);
    };
    if (e.detail === 0) {
      single();
      return;
    }
    const now = Date.now();
    if (this._tapTimer && now - this._lastTap < Timeline.DOUBLE_TAP_MS) {
      clearTimeout(this._tapTimer);
      this._tapTimer = null;
      this._lastTap = 0;
      this.toggle();
      return;
    }
    this._lastTap = now;
    if (this._tapTimer) clearTimeout(this._tapTimer);
    // "All years" has no single-tap action: it only expands on a double tap or Enter.
    this._tapTimer = setTimeout(() => {
      this._tapTimer = null;
      if (btn && btn.dataset.action !== "expand") single();
    }, Timeline.DOUBLE_TAP_MS);
  }

  /** Collapsed ↔ expanded. */
  toggle(): void {
    if (this.state.isLoading) return;
    if (this.state.scope) this.collapse();
    else this.expand();
  }

  async _fetchData(): Promise<void> {
    try {
      const payload = await getTimeline({ context: this.props.context });
      if (this._unmounted) return;
      const years = yearsOf(payload?.pills ?? []);
      if (years.length === 0) {
        this.unmount();
        return;
      }
      const { initialRange, initialYear } = this.props;
      let scope: YearSpan | null = null;
      if (initialRange) {
        scope = initialRange;
      } else if (initialYear && years.includes(parseInt(initialYear, 10))) {
        const y = parseInt(initialYear, 10);
        scope = { from: y, to: y };
      }
      // A range over every year filters nothing: show it collapsed.
      if (scope && scope.from <= years[0] && scope.to >= years[years.length - 1]) scope = null;
      this.state = { years, scope, isLoading: false };
      this._rerender();
      if (scope && this.props.mode === "filter" && !this.props.quiet) this._emit(scope);
    } catch (err) {
      if ((err as { status?: number }).status !== 404) {
        console.error("Timeline fetch failed:", err);
      }
      if (!this._unmounted) this.unmount();
    }
  }

  render() {
    if (this.state.isLoading) return html``;
    const { years, scope, preview, panel } = this.state;
    const shown = scope && preview != null ? { from: preview, to: preview } : scope;
    const strip = renderTimeline(years, shown);
    if (!panel || !shown) return strip;
    return html`${strip}${renderSpinner(years, shown.to)}`;
  }

  afterRender(): void {
    // The pills set the header slot's width: the header folds again.
    this.container.dispatchEvent(new CustomEvent("timeline:render", { bubbles: true }));
    this._bindSpinner();
    const strip = this.$(".timeline-strip");
    if (!strip || !this.state.scope) return;
    strip.addEventListener("wheel", (e: WheelEvent) => {
      // Either wheel axis previews the next year: one step per WHEEL_STEP of
      // delta. The wheel has no release, so a short pause commits the year.
      e.preventDefault();
      this._wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(this._wheelAcc) >= Timeline.WHEEL_STEP) {
        const dir = Math.sign(this._wheelAcc);
        this._wheelAcc = 0;
        this._previewStep(dir);
      }
      if (this._wheelTimer) clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => {
        this._wheelTimer = null;
        this._wheelAcc = 0;
        this._commitPreview();
      }, Timeline.WHEEL_COMMIT_MS);
    }, { passive: false });
    // The atlas layer listens on document: a slide that starts on the strip stays here.
    strip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (this._drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.stopPropagation();
      // The short form's one pill opens the panel: no horizontal slide.
      if (this.state.panel || this._isShort()) return;
      this._startDrag(e, false);
    });
    this._scrollActiveIntoView();
  }

  /** Follow a drag on window until the release, also outside the strip or panel. */
  _startDrag(e: PointerEvent, vertical: boolean): void {
    this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, vertical };
    // The preview re-renders the strip, so the drag follows the pointer on
    // window until the release, also outside the strip or the panel.
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragEnd);
    window.addEventListener("pointercancel", this._onDragEnd);
  }

  /** The spinner panel: a vertical drag, swipe or wheel moves the previewed year. */
  _bindSpinner(): void {
    const panel = this.$(".timeline-spinner");
    if (!panel) return;
    panel.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      this._wheelAcc += e.deltaY;
      if (Math.abs(this._wheelAcc) < Timeline.WHEEL_STEP) return;
      const dir = Math.sign(this._wheelAcc);
      this._wheelAcc = 0;
      this._previewStep(dir);
    }, { passive: false });
    panel.addEventListener("pointerdown", (e: PointerEvent) => {
      if (this._drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.stopPropagation();
      this._startDrag(e, true);
    });
  }

  /** Centre the active pill when the slot clips the strip. */
  _scrollActiveIntoView(): void {
    const strip = this.$(".timeline-strip");
    const active = this.$(".timeline-pill-btn.is-active");
    if (!strip || !active || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = Math.max(0, active.offsetLeft - strip.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2);
  }

  _emit(scope: YearSpan | null): void {
    const years: number[] = this.state.years;
    const from = scope ? scope.from : years[0];
    const to = scope ? scope.to : years[years.length - 1];
    this.props.onRangeChange?.({ from, to, source: "pill", isFullExtent: !scope });
  }

  /** Show every year, focused on the last one picked (else the newest). */
  expand(): void {
    const years: number[] = this.state.years;
    if (this.state.isLoading || years.length === 0) return;
    const year = lastFocusedYear !== null && years.includes(lastFocusedYear) ? lastFocusedYear : years[years.length - 1];
    this.focusYear(year);
  }

  /** Make one year the active pill and report it. */
  focusYear(year: number): void {
    lastFocusedYear = year;
    const scope = { from: year, to: year };
    const cur: YearSpan | null = this.state.scope;
    if (cur && cur.from === year && cur.to === year) return;
    this.setState({ scope });
    this._emit(scope);
  }

  /** Show only "All years" and report that the year filter is gone. */
  collapse(): void {
    if (!this.state.scope) return;
    this.setState({ scope: null });
    this._emit(null);
  }

  /**
   * Move to a year range without reporting it, for a host whose scope changed
   * from outside (back/forward, a cleared chip). null collapses.
   */
  setScope(range: YearSpan | null): void {
    const years: number[] = this.state.years;
    let next = range;
    if (next && years.length && next.from <= years[0] && next.to >= years[years.length - 1]) next = null;
    if (this.state.isLoading) {
      this.props.initialRange = next ?? undefined;
      return;
    }
    const cur: YearSpan | null = this.state.scope;
    const same = !next && !cur || next && cur && next.from === cur.from && next.to === cur.to;
    if (same) return;
    if (next && next.from === next.to) lastFocusedYear = next.from;
    this.setState({ scope: next });
  }

  /** The host's post count. The pills do not show it. */
  setCount(n: number): void {
    this.props.total = n;
  }
}

export function mount(el: HTMLElement, ctx: TimelineProps): Timeline {
  const comp = new Timeline(el, ctx);
  comp.mount();
  return comp;
}
