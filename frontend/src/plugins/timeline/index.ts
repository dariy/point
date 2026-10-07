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
  /** The host's post count. Not shown. */
  total?: number;
  canShow?: boolean;
}

/** The years that have posts, ascending. Decade pills are not years. */
export function yearsOf(pills: TimelinePill[]): number[] {
  const years = new Set<number>();
  for (const p of pills) if (!p.is_decade) years.add(p.year);
  return [...years].sort((a, b) => a - b);
}

/**
 * The timeline markup. Collapsed: one "All years" pill. Expanded: one pill per
 * year, the ones inside `scope` active. No arrow controls.
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
  return html`
    <div class="timeline-container is-expanded" role="group" aria-label="Date timeline">
      <div class="timeline-strip">
        ${years.map((y) => {
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
  actions = {
    expand(this: Timeline) {
      this.expand();
    },
    pick(this: Timeline, _e: Event, el: Element) {
      const year = parseInt(el.getAttribute("data-year") ?? "", 10);
      if (!Number.isNaN(year)) this.focusYear(year);
    }
  };

  constructor(container: HTMLElement, props: TimelineProps = {}) {
    super(container, props);
    this.state = { years: [] as number[], scope: null as YearSpan | null, isLoading: true };
  }

  mount(): void {
    this._fetchData();
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
      this._bindActions();
      this._rerender();
      if (scope && this.props.mode === "filter") this._emit(scope);
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
    if (!strip) return;
    strip.addEventListener("wheel", (e: WheelEvent) => {
      // A vertical wheel over an overflowing strip scrolls it sideways.
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }, { passive: false });
    this._scrollActiveIntoView();
  }

  _scrollActiveIntoView(): void {
    const strip = this.$(".timeline-strip");
    const active = this.$(".timeline-pill-btn.is-active");
    if (!strip || !active) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const left = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
    strip.scrollLeft = Math.max(0, left);
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
