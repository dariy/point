/**
 * Refcounted body scroll lock.
 *
 * Overlays (dialogs, sheets, the command palette, a maximized editor) stop the
 * page behind them from scrolling by pinning `document.body`'s overflow. Doing
 * that inline at each site produced two bugs, both of which stranded the admin
 * with an unscrollable page and nothing on screen to explain it:
 *
 *  1. Each site cleared the lock by assigning `''` rather than restoring what
 *     was there before, so an inner dialog closing unlocked the page underneath
 *     an outer overlay that was still open.
 *  2. The lock was released only from the site's own close handler, which never
 *     runs when the overlay is *unmounted* instead of closed — and
 *     `Component._rerender()` unmounts every child on every `setState()`.
 *
 * A single owner-keyed registry fixes both. The first acquire records the body's
 * previous overflow and pins it; every later acquire only adds an owner; the
 * page is restored to its recorded value when the last owner releases. Releasing
 * an owner that never acquired, or acquiring twice with the same owner, is a
 * no-op, so a `beforeUnmount()` can release unconditionally.
 *
 * The owner is any stable value identifying the holder — usually the component
 * instance (`this`), or the element for element-scoped locks. It is held
 * strongly, so a holder that never releases keeps the page locked: release from
 * `beforeUnmount()`, not only from close().
 */

const owners = new Set();
let previousOverflow = null;

/**
 * Lock body scrolling on behalf of `owner`. Idempotent per owner.
 * @param {*} owner Stable identity for the holder (component instance, element).
 */
export function acquireScrollLock(owner) {
  if (owner === undefined || owner === null) return;
  if (owners.has(owner)) return;
  if (owners.size === 0) {
    previousOverflow = document.body?.style?.overflow ?? '';
  }
  owners.add(owner);
  if (document.body?.style) document.body.style.overflow = 'hidden';
}

/**
 * Release `owner`'s lock. The body is restored only when no owner is left.
 * Safe to call for an owner that holds nothing.
 * @param {*} owner
 */
export function releaseScrollLock(owner) {
  if (!owners.delete(owner)) return;
  if (owners.size > 0) return;
  if (document.body?.style) document.body.style.overflow = previousOverflow ?? '';
  previousOverflow = null;
}

/** @returns {boolean} whether any owner currently holds the lock. */
export function isScrollLocked() {
  return owners.size > 0;
}

/** @returns {number} how many owners hold the lock — for tests and debugging. */
export function scrollLockOwnerCount() {
  return owners.size;
}
