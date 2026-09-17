/**
 * Pointer-driven reordering of items across one or more containers.
 *
 * Pointer events rather than HTML5 drag-and-drop: DnD does not exist on iOS, so
 * a `draggable` list is dead weight on exactly the device this was asked for.
 * Pointer events cover mouse, touch and pen through one code path.
 *
 * The util owns the gesture — press on a handle, a line showing where the item
 * would land, release — and nothing else. It never mutates the list itself:
 * `onDrop` gets the item, the container it was released over and the item it
 * would follow, and the caller decides what that means for its model.
 *
 * @param {object}   opts
 * @param {string}   opts.handleSelector  drag handle, inside an item
 * @param {string}   opts.itemSelector    a movable item
 * @param {Function} opts.containers      () => Element[] — evaluated per
 *   gesture, and FIRST MATCH WINS: both the container under the pointer and
 *   the one an item started in are the first entry that claims it. A caller
 *   whose containers nest — a rail inside a card inside the list — must
 *   therefore list the inner one BEFORE its ancestor, or the ancestor
 *   swallows every drop over the inner one.
 * @param {"x"|"y"|Function} [opts.axis]  which way a list runs, or
 *   `(container) => "x"|"y"` when the containers do not agree; `"x"` is a
 *   horizontal rail, where the midpoint test, the drop line and the edge
 *   scroll all turn 90° (a rail scrolls itself, not the page). Resolved per
 *   placement, so one gesture can leave a vertical list and enter a
 *   horizontal rail and get the right line at each end.
 * @param {Function} [opts.isEnabled]     () => boolean — gate the whole gesture
 * @param {Function} opts.onDrop          ({ item, from, to, afterEl }) => void
 * @returns {Function} cleanup
 */
export function attachPointerReorder({
  handleSelector,
  itemSelector,
  containers,
  axis = "y",
  isEnabled = () => true,
  onDrop,
}) {
  /** Which way `container` runs. Asked per placement, never cached: a gesture
   *  that crosses containers crosses axes with them. */
  const isHorizontal = (container) =>
    (typeof axis === "function" ? axis(container) : axis) === "x";
  let item = null;      // the element being moved
  let from = null;      // container it started in
  let indicator = null; // the drop line
  let pointerId = null;
  let handleEl = null;
  let lastX = 0;
  let lastY = 0;
  let scrollRaf = null;

  const stopAutoScroll = () => {
    if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
  };

  const cleanupDrag = () => {
    stopAutoScroll();
    indicator?.remove();
    indicator = null;
    item?.classList.remove("is-dragging");
    if (handleEl && pointerId !== null) {
      try { handleEl.releasePointerCapture(pointerId); } catch { /* already gone */ }
    }
    item = null;
    from = null;
    handleEl = null;
    pointerId = null;
  };

  /**
   * Scroll speed for a pointer this close to either end of the scrollable
   * range. Without this a list taller than the screen — or a second list below
   * the fold — simply cannot be reached: the pointer is captured, so the usual
   * touch-scroll and edge-scroll behaviours are gone for the duration.
   */
  const edgeVelocity = (pos, lo, hi) => {
    const EDGE = 64;
    const SPEED = 16;
    if (pos - lo < EDGE) return -SPEED * (1 - (pos - lo) / EDGE);
    if (hi - pos < EDGE) return SPEED * (1 - (hi - pos) / EDGE);
    return 0;
  };

  /**
   * What the edge scroll moves, and the range the pointer is measured against:
   * the page between the viewport's top and bottom for a vertical list, and
   * the rail itself between its own left and right edges for a horizontal one
   * — a filmstrip overflows sideways inside a page that does not.
   */
  const scrollTarget = () => {
    const c = containerAt(lastX, lastY);
    if (!c || !isHorizontal(c)) {
      return { el: null, lo: 0, hi: window.innerHeight, pos: lastY };
    }
    // A rail short enough to fit has no scroll to drive, and its whole width
    // is inside the edge band — without this the loop would spin for the
    // length of every drag over a three-slide strip, scrolling nothing.
    if (c.scrollWidth <= c.clientWidth) return null;
    const r = c.getBoundingClientRect?.();
    return r ? { el: c, lo: r.left, hi: r.right, pos: lastX } : null;
  };

  const tickAutoScroll = () => {
    scrollRaf = null;
    if (!item) return;
    const target = scrollTarget();
    const v = target ? edgeVelocity(target.pos, target.lo, target.hi) : 0;
    if (!v) return;
    if (target.el) target.el.scrollLeft += v;
    else window.scrollBy(0, v);
    // The list moved under a stationary pointer, so what sits at that point
    // changed — re-place the line from the same client coordinates.
    showIndicator(containerAt(lastX, lastY), lastX, lastY);
    scrollRaf = requestAnimationFrame(tickAutoScroll);
  };

  const startAutoScroll = () => {
    if (scrollRaf !== null) return;
    const target = scrollTarget();
    if (target && edgeVelocity(target.pos, target.lo, target.hi)) {
      scrollRaf = requestAnimationFrame(tickAutoScroll);
    }
  };

  /** The container under the pointer, or the one the gesture started in.
   *  First match wins — see `containers` above: nested containers must be
   *  listed before their ancestors, whose rect contains theirs. */
  const containerAt = (x, y) => {
    for (const c of containers()) {
      if (!c || !c.isConnected) continue;
      const r = c.getBoundingClientRect();
      // Empty containers collapse to nothing; give them a band to aim at so a
      // list can be emptied and refilled.
      const padX = r.width < 8 ? 12 : 0;
      const padY = r.height < 8 ? 12 : 0;
      if (
        x >= r.left - padX &&
        x <= r.right + padX &&
        y >= r.top - padY &&
        y <= r.bottom + padY
      ) {
        return c;
      }
    }
    return from;
  };

  /** Place the drop line inside `container` for pointer position `x`/`y` —
   *  only the coordinate the list runs along decides where it goes. */
  const showIndicator = (container, x, y) => {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.setAttribute("aria-hidden", "true");
    }
    const horizontal = isHorizontal(container);
    // Reassigned every time, not once at creation: the same line moves between
    // containers mid-gesture, and a vertical rule left over from the list is
    // invisible inside a horizontal rail.
    indicator.className = `reorder-indicator${horizontal ? " reorder-indicator--x" : ""}`;
    // Direct children only. A descendant query would offer the slides of a
    // carousel nested inside a card as drop points for the outer list, and
    // `insertBefore` on an element that is not the container's own child
    // throws — so nesting works for every container without a second,
    // per-container selector.
    const items = [...container.children].filter(
      (el) => el !== item && el !== indicator && el.matches(itemSelector),
    );
    const before = items.find((el) => {
      const r = el.getBoundingClientRect();
      return horizontal ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    });
    if (before) container.insertBefore(indicator, before);
    else container.appendChild(indicator);
  };

  const onPointerDown = (e) => {
    if (!isEnabled() || e.button > 0) return;
    const handle = e.target.closest?.(handleSelector);
    if (!handle) return;
    const el = handle.closest(itemSelector);
    if (!el) return;
    const container = containers().find((c) => c?.contains(el));
    if (!container) return;

    item = el;
    from = container;
    handleEl = handle;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    // Claim the gesture: without capture a touch scrolls the page away from
    // under the finger, and a mouse that leaves the handle stops reporting.
    try { handle.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
    item.classList.add("is-dragging");
    showIndicator(container, e.clientX, e.clientY);
  };

  const onPointerMove = (e) => {
    if (!item || e.pointerId !== pointerId) return;
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    showIndicator(containerAt(lastX, lastY), lastX, lastY);
    startAutoScroll();
  };

  const onPointerUp = (e) => {
    if (!item || e.pointerId !== pointerId) return;
    const to = indicator?.parentElement || from;
    // The item the drop line sits after — the caller's anchor for "goes here".
    let afterEl = indicator?.previousElementSibling || null;
    while (afterEl && !afterEl.matches(itemSelector)) afterEl = afterEl.previousElementSibling;

    const moved = item;
    const source = from;
    cleanupDrag();
    onDrop({ item: moved, from: source, to, afterEl });
  };

  const onCancel = () => { if (item) cleanupDrag(); };
  const onKeyDown = (e) => { if (e.key === "Escape" && item) cleanupDrag(); };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onCancel, true);
  document.addEventListener("keydown", onKeyDown, true);

  return () => {
    cleanupDrag();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onCancel, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
