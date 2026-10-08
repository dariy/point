/**
 * HeaderFold — the single fold controller for the public header.
 *
 * The header renders four zones on one row (identity · context · nav · tools).
 * When the row overflows, parts fold in a fixed order of expendability. This
 * controller owns that decision: components and plugins register *providers*
 * that contribute ordered fold operations, and `relayout()` resets everything,
 * then applies ops one at a time until the row fits.
 *
 * Provider contract:
 *   register(order, { reset?, ops? }) → unregister()
 *     reset()  undo every fold this provider can apply (called on each relayout)
 *     ops()    return an array of functions, each applying one further fold
 *              step; called fresh on each relayout so it can reflect current DOM
 *
 * Canonical order slots (leave gaps for future stages):
 *   10  subtitle / ornament        (PublicHeader)
 *   30  nav links → More ▾         (nav-menu plugin)
 *   32  timeline → short form      (PublicHeader: active pill + year spinner)
 *   35  ancestor crumbs → "…"      (PublicHeader, over Breadcrumbs' DOM)
 *   40  nav zone → burger          (PublicHeader)
 *   50  brand text → logo only     (PublicHeader, site crumb pair)
 *   60  current crumb → ellipsis   (PublicHeader)
 *
 * Invariants encoded by that order (see FOLD_ORDER):
 *   - The timeline takes its short form before any crumb folds. The short
 *     form keeps every year one tap away (the spinner); a folded crumb does not.
 *   - The current crumb (the leaf) is the last crumb to fold: the ancestors
 *     and the site title fold before it.
 *   - Every nav destination stays one tap away (inline → More → burger).
 *
 * Layout is re-measured on container resize (ResizeObserver) and on any
 * explicit `relayout()` call — plugins call it after they render content that
 * changes the row's width (e.g. nav links arriving from the store). Late data
 * therefore triggers a re-flow instead of being silently invisible.
 */
/** Fold order slots of the core providers. Lower orders fold first. */
export const FOLD_ORDER = {
  subtitle: 10,
  navLinks: 30,
  timeline: 32,
  ancestorCrumbs: 35,
  nav: 40,
  brand: 50,
  currentCrumb: 60,
} as const;

interface FoldProvider {
  order: number;
  reset?: () => void;
  ops?: () => Array<() => void>;
}

import { isHeaderFrozen, onHeaderThaw } from './headerFreeze.ts';

export class HeaderFold {
  _fits: () => boolean;
  _providers: FoldProvider[];
  _busy: boolean;
  _ro: ResizeObserver;
  _thaw: () => void;

  /**
   * @param opts.observe - Element whose size changes trigger relayout.
   * @param opts.fits - Returns true when the header row fits.
   */
  constructor({ observe, fits }: { observe: Element; fits: () => boolean }) {
    this._fits = fits;
    this._providers = [];
    this._busy = false;
    this._ro = new ResizeObserver(() => this.relayout());
    if (observe) this._ro.observe(observe);
    this._thaw = onHeaderThaw(() => this.relayout());
  }

  /**
   * @param order - Lower orders fold first.
   * @param provider.reset - Undo every fold this provider applies.
   * @param provider.ops - One function per further fold.
   * @returns unregister
   */
  register(
    order: number,
    { reset, ops }: { reset?: () => void; ops?: () => Array<() => void> } = {},
  ): () => void {
    const entry: FoldProvider = { order, reset, ops };
    this._providers.push(entry);
    this._providers.sort((a, b) => a.order - b.order);
    this.relayout();
    return () => {
      const i = this._providers.indexOf(entry);
      if (i >= 0) this._providers.splice(i, 1);
    };
  }

  relayout() {
    // Folding must not re-trigger itself through the ResizeObserver.
    if (this._busy) return;
    // The atlas map layer freezes the header: no unfold while frozen, and
    // thawing runs relayout again. An overflowing row still folds — a page
    // that loads in the map view is frozen before its first layout.
    const frozen = isHeaderFrozen();
    if (frozen && this._fits()) return;
    this._busy = true;
    try {
      if (!frozen) for (const p of this._providers) p.reset?.();
      if (this._fits()) return;
      const ops = this._providers.flatMap((p) => (p.ops ? p.ops() : []));
      let i = 0;
      while (i < ops.length) {
        ops[i++]();
        if (this._fits()) return;
      }
    } finally {
      this._busy = false;
    }
  }

  destroy() {
    this._ro.disconnect();
    this._thaw();
    this._providers = [];
  }
}
