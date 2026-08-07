/**
 * Pointer-driven reordering of items across one or more containers.
 *
 * Pointer events rather than HTML5 drag-and-drop: DnD does not exist on iOS, so
 * a `draggable` list is dead weight on exactly the device this was asked for
 * (see VisualEditor, which is still DnD and therefore mouse-only). Pointer
 * events cover mouse, touch and pen through one code path.
 *
 * The util owns the gesture — press on a handle, a line showing where the item
 * would land, release — and nothing else. It never mutates the list itself:
 * `onDrop` gets the item, the container it was released over and the item it
 * would follow, and the caller decides what that means for its model.
 *
 * @param {object}   opts
 * @param {string}   opts.handleSelector  drag handle, inside an item
 * @param {string}   opts.itemSelector    a movable item
 * @param {Function} opts.containers      () => Element[] — evaluated per gesture
 * @param {Function} [opts.isEnabled]     () => boolean — gate the whole gesture
 * @param {Function} opts.onDrop          ({ item, from, to, afterEl }) => void
 * @returns {Function} cleanup
 */
export function attachPointerReorder({
  handleSelector,
  itemSelector,
  containers,
  isEnabled = () => true,
  onDrop,
}) {
  let item = null;      // the element being moved
  let from = null;      // container it started in
  let indicator = null; // the drop line
  let pointerId = null;
  let handleEl = null;

  const cleanupDrag = () => {
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

  /** The container under the pointer, or the one the gesture started in. */
  const containerAt = (x, y) => {
    for (const c of containers()) {
      if (!c || !c.isConnected) continue;
      const r = c.getBoundingClientRect();
      // Empty containers collapse to nothing; give them a band to aim at so a
      // list can be emptied and refilled.
      const pad = r.height < 8 ? 12 : 0;
      if (x >= r.left && x <= r.right && y >= r.top - pad && y <= r.bottom + pad) return c;
    }
    return from;
  };

  /** Place the drop line inside `container` for pointer position `y`. */
  const showIndicator = (container, y) => {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "reorder-indicator";
      indicator.setAttribute("aria-hidden", "true");
    }
    const items = [...container.querySelectorAll(itemSelector)].filter((el) => el !== item);
    const before = items.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
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
    // Claim the gesture: without capture a touch scrolls the page away from
    // under the finger, and a mouse that leaves the handle stops reporting.
    try { handle.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    e.preventDefault();
    item.classList.add("is-dragging");
    showIndicator(container, e.clientY);
  };

  const onPointerMove = (e) => {
    if (!item || e.pointerId !== pointerId) return;
    e.preventDefault();
    showIndicator(containerAt(e.clientX, e.clientY), e.clientY);
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
