/**
 * Turn Prism's automatic highlighting off. Import this *before* prism-core.
 *
 * prism-core ends by calling `Prism.highlightAll()` on itself unless it finds
 * `manual` already set on a pre-seeded `window.Prism` — and highlightAll goes
 * through `highlightElement`, whose bare `element.innerHTML =` inside the
 * vendored file is refused under `require-trusted-types-for 'script'`. Every
 * caller in this frontend drives Prism explicitly through the string-returning
 * `Prism.highlight()` and writes the result with setHTML(), so the automatic
 * pass was duplicated work even before it became a violation.
 *
 * Side-effect only: ES module evaluation follows import order, so an
 * `import './prismManual.js'` listed above the prism-core import runs first.
 */
if (typeof window !== 'undefined') {
  // Cast, because what is being put on the global here is deliberately a
  // partial Prism: prism-core reads `manual` off whatever it finds and then
  // replaces the global with the real thing.
  const w = /** @type {Record<string, any>} */ (/** @type {unknown} */ (window));
  w.Prism = Object.assign(w.Prism || {}, { manual: true });
}
