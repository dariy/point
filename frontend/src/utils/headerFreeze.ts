/**
 * Header freeze — while the atlas layer shows the map (`body[data-atlas-layer]`
 * is `mapList` or `map`), the header keeps its current fold and compact state.
 * Controllers skip their relayout while frozen and run it once when the state
 * returns to `list`.
 */

/** True while the atlas layer is in `mapList` or `map`. */
export function isHeaderFrozen(): boolean {
  if (typeof document === 'undefined') return false;
  const state = document.body?.getAttribute('data-atlas-layer');
  return state === 'mapList' || state === 'map';
}

/** Call `cb` each time the header leaves the frozen state. Returns a disconnect function. */
export function onHeaderThaw(cb: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return () => {};
  let frozen = isHeaderFrozen();
  const mo = new MutationObserver(() => {
    const now = isHeaderFrozen();
    if (frozen && !now) cb();
    frozen = now;
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-atlas-layer'] });
  return () => mo.disconnect();
}
