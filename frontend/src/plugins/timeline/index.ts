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
  const flags = `${win.moreBefore ? " has-more-before" : ""}${win.moreAfter ? " has-more-after" : ""}`;
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
  _drag: { id: number, x: number, moved: boolean } | null = null;
  _wheelAcc = 0;
  _wheelTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by a slide: the click that ends it is not a tap. */
  _slid = false;

  constructor(container: HTMLElement, props: TimelineProps = {}) {
    super(container, props);
    this.state = { years: [] as number[], scope: null as YearSpan | null, isLoading: true };
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
    const btn = (e.target as Element | null)?.closest?.<HTMLElement>(".timeline-pill-btn");
    const year = parseInt(btn?.dataset.year ?? "", 10);
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
    return renderTimeline(this.state.years, this.state.scope);
  }

  afterRender(): void {
    const strip = this.$(".timeline-strip");
    if (!strip || !this.state.scope) return;
    strip.addEventListener("wheel", (e: WheelEvent) => {
      // Either wheel axis moves the year: one step per WHEEL_STEP of delta.
      e.preventDefault();
      this._wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (this._wheelTimer) clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => { this._wheelAcc = 0; }, 200);
      if (Math.abs(this._wheelAcc) >= Timeline.WHEEL_STEP) {
        const dir = Math.sign(this._wheelAcc);
        this._wheelAcc = 0;
        this.slide(dir);
      }
    }, { passive: false });
    // The atlas layer listens on document: a slide on the strip stays here.
    strip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation();
      this._drag = { id: e.pointerId, x: e.clientX, moved: false };
    });
    strip.addEventListener("pointermove", (e: PointerEvent) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      e.stopPropagation();
      const dx = e.clientX - d.x;
      if (Math.abs(dx) < Timeline.SLIDE_STEP_PX) return;
      if (!d.moved) {
        d.moved = true;
        this._cancelTap();
        try { strip.setPointerCapture(e.pointerId); } catch { /* pointer gone */ }
      }
      // Drag right shows the earlier year, as content follows the finger.
      d.x = e.clientX;
      this.slide(dx > 0 ? -1 : 1);
    });
    const end = (e: PointerEvent) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      e.stopPropagation();
      this._drag = null;
      if (d.moved) {
        this._slid = true;
        // A touch slide sends no click: clear the flag after the click would arrive.
        setTimeout(() => { this._slid = false; }, 0);
      }
    };
    strip.addEventListener("pointerup", end);
    strip.addEventListener("pointercancel", end);
    this._scrollActiveIntoView();
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
