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
 *   20  ancestor crumbs → "…"      (PublicHeader, over Breadcrumbs' DOM)
 *   30  nav links → More ▾         (nav-menu plugin)
 *   40  nav zone → burger          (PublicHeader)
 *   50  brand text → logo only     (PublicHeader, site crumb pair)
 *   60  current crumb → ellipsis   (PublicHeader)
 *
 * Invariants encoded by that order: the current page's name is the last thing
 * to degrade, and every nav destination stays one tap away (inline → More →
 * burger).
 *
 * Layout is re-measured on container resize (ResizeObserver) and on any
 * explicit `relayout()` call — plugins call it after they render content that
 * changes the row's width (e.g. nav links arriving from the store). Late data
 * therefore triggers a re-flow instead of being silently invisible.
 */
export class HeaderFold {
  /**
   * @param {object} opts
   * @param {Element} opts.observe  Element whose size changes trigger relayout.
   * @param {() => boolean} opts.fits  Returns true when the header row fits.
   */
  constructor({ observe, fits }) {
    this._fits = fits;
    this._providers = [];
    this._busy = false;
    this._ro = new ResizeObserver(() => this.relayout());
    if (observe) this._ro.observe(observe);
  }

  register(order, { reset, ops } = {}) {
    const entry = { order, reset, ops };
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
    this._busy = true;
    try {
      for (const p of this._providers) p.reset?.();
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
    this._providers = [];
  }
}
