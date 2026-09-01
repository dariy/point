// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.11.
/**
 * Pointer gestures for the tags manager: the mobile swipe-to-reveal drawer and
 * desktop drag-and-drop reordering.
 *
 * The decisions each gesture makes — which way a drag is going, where a row
 * should sit mid-swipe, what a released swipe means, which third of a row you
 * dropped on, whether a reorder is even legal — are exported as pure functions
 * and tested directly. The bind* functions below are the listener plumbing
 * around them, and deliberately hold no page state: everything they need to
 * report goes out through callbacks.
 */

/** Same breakpoint as the post card list — see responsive.css. */
export const SWIPE_BREAKPOINT = '(max-width: 48em)';
/** Minimum drag to snap the drawer open. */
export const THRESHOLD_PX = 40;
/** Rubber-band resistance past either end. */
export const DAMPING = 0.55;
/** Movement below this is noise, not yet a direction. */
export const MIN_MOVE_PX = 8;

/**
 * Which way is this drag going?
 * Returns null while the movement is still too small to call — the caller must
 * not lock a direction until it is, or a slightly-off vertical scroll gets
 * hijacked into a horizontal swipe.
 */
export function gestureDirection(rawDx, rawDy, minMove = MIN_MOVE_PX) {
  const absDx = Math.abs(rawDx);
  const absDy = Math.abs(rawDy);
  if (Math.max(absDx, absDy) < minMove) return null;
  return absDx > absDy ? 'horizontal' : 'vertical';
}

/**
 * Where the row sits mid-swipe, in px, with rubber-banding at both ends:
 * past 0 (dragging a closed row rightward) and past -actionsWidth (dragging an
 * open row further left) both meet increasing resistance rather than a wall.
 */
export function swipeTranslate({ rawDx, isOpen, actionsWidth, damping = DAMPING }) {
  const baseOffset = isOpen ? -actionsWidth : 0;
  let translate = baseOffset + rawDx;

  if (translate > 0) {
    translate = translate * (1 - damping);
  } else if (translate < -actionsWidth) {
    const over = -actionsWidth - translate;
    translate = -actionsWidth - over * (1 - damping);
  }
  return translate;
}

/**
 * What a released swipe means.
 *
 *   'close'      an open row swiped back right — shut the drawer
 *   'snap-open'  an open row released short of closing — settle it back open
 *   'open'       a closed row swiped far enough left — reveal the actions
 *   'select'     a closed row swiped right — toggle selection, as on post cards
 *   'reset'      not far enough either way — snap back to rest
 */
export function swipeOutcome({ dx, isOpen, actionsWidth, threshold = THRESHOLD_PX }) {
  if (isOpen) return dx > threshold ? 'close' : 'snap-open';
  if (dx < -threshold && actionsWidth > 0) return 'open';
  if (dx > threshold) return 'select';
  return 'reset';
}

/**
 * Which third of the row the pointer is over: the outer quarters mean "put it
 * beside this tag", the middle half means "put it inside this tag".
 */
export function dropZoneFor(clientY, rect) {
  const rel = (clientY - rect.top) / rect.height;
  if (rel < 0.25) return 'before';
  if (rel > 0.75) return 'after';
  return 'on';
}

/**
 * What a drop should do.
 *
 * Reordering is only defined between siblings — the backend positions a tag
 * relative to one of its parent's children, so a before/after drop across two
 * different parents (or at the unparented top level) has no meaning and is
 * refused rather than silently reparenting.
 *
 * `siblingBefore` is only consulted for a 'before' drop, which is the one case
 * needing a lookup: dropping before a target means landing after whatever
 * currently precedes it, and null there means "move to the front".
 */
export function reorderPlan({ zone, dragParent, targetParent, targetId, siblingBefore }) {
  if (zone === 'on') return { action: 'reparent' };
  if (dragParent === null || dragParent === undefined || dragParent !== targetParent) {
    return { action: 'invalid' };
  }
  return {
    action: 'reorder',
    parentId: dragParent,
    afterId: zone === 'after' ? targetId : siblingBefore(targetId, dragParent),
  };
}

/** Read a row's data-parent-id, where an empty attribute means "top level". */
export function rowParentId(row) {
  return row.dataset.parentId !== '' ? parseInt(row.dataset.parentId, 10) : null;
}

/**
 * On narrow portrait viewports, hide .tm-actions off-screen and let users
 * swipe a row left to reveal them — the same drawer the post cards use in
 * /light/posts. Applies to tree rows and list-view table rows alike.
 *
 * Returns a cleanup function, or null when the gesture does not apply (desktop
 * width, or no matchMedia at all). Callers must call the previous cleanup
 * before rebinding after a re-render.
 */
export function bindSwipeToReveal(container, { onSelect } = {}) {
  if (!window.matchMedia) return null;      // SSR / test env guard
  const mql = window.matchMedia(SWIPE_BREAKPOINT);
  if (!mql.matches) return null;            // desktop — nothing to do

  let openRow = null;                       // currently revealed row (or null)
  let actionsWidth = 0;                     // measured width of the actions panel
  let startX = 0, startY = 0;
  let dragging = false;                     // true once we've committed to horizontal
  let decided = false;                      // true once direction is locked
  let dx = 0;
  const abortControllers = [];

  const closeOpen = () => {
    if (!openRow) return;
    openRow.style.transform = '';
    openRow.classList.remove('tm-row--revealed');
    openRow = null;
  };

  // Tree rows carry .tm-row; list-view rows are the <tr class="tm-tag-row">.
  container.querySelectorAll('.tm-row, .tm-tag-row').forEach(row => {
    if (!row.querySelector('.tm-actions')) return;
    const ac = new AbortController();
    abortControllers.push(ac);
    const sig = { signal: ac.signal };

    row.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      // If tapping inside the already-open row's actions, let buttons handle it
      if (row === openRow && e.target.closest('.tm-actions')) return;

      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dragging = false;
      decided = false;
      dx = 0;

      // Measure actions width (varies per row due to button count)
      const actions = row.querySelector('.tm-actions');
      actionsWidth = actions ? actions.offsetWidth : 0;

      // Disable transition during drag for responsive feel
      row.style.transition = 'none';
    }, { ...sig, passive: true });

    row.addEventListener('touchmove', e => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const rawDx = t.clientX - startX;
      const rawDy = t.clientY - startY;

      if (!decided) {
        const direction = gestureDirection(rawDx, rawDy);
        if (!direction) return;               // not enough movement
        decided = true;
        dragging = direction === 'horizontal';
        if (!dragging) return;                // vertical — bail, let scroll work

        // Close any other open row when starting a new swipe
        if (openRow && openRow !== row) closeOpen();
      }

      if (!dragging) return;
      e.preventDefault();

      dx = rawDx;
      row.style.transform = `translateX(${swipeTranslate({
        rawDx: dx, isOpen: row === openRow, actionsWidth,
      })}px)`;
    }, { ...sig, passive: false });

    row.addEventListener('touchend', () => {
      row.style.transition = ''; // restore CSS transition for snap

      if (!dragging) {
        // A tap (not a drag) — close any open row if tapping outside it
        if (openRow && openRow !== row) closeOpen();
        return;
      }

      switch (swipeOutcome({ dx, isOpen: row === openRow, actionsWidth })) {
        case 'close':
          closeOpen();
          break;
        case 'snap-open':
          row.style.transform = `translateX(${-actionsWidth}px)`;
          break;
        case 'open':
          closeOpen();
          row.style.transform = `translateX(${-actionsWidth}px)`;
          row.classList.add('tm-row--revealed');
          openRow = row;
          break;
        case 'select':
          row.style.transform = '';
          onSelect?.(row);
          break;
        default:
          row.style.transform = '';
      }
    }, { ...sig, passive: true });

    row.addEventListener('touchcancel', () => {
      row.style.transition = '';
      row.style.transform = row === openRow ? `translateX(${-actionsWidth}px)` : '';
    }, { ...sig, passive: true });
  });

  // Tap-elsewhere-to-close: listen on container
  const containerAc = new AbortController();
  abortControllers.push(containerAc);
  container.addEventListener('click', e => {
    if (!openRow) return;
    // If click is inside the open row, let it propagate normally
    if (openRow.contains(e.target)) return;
    closeOpen();
  }, { signal: containerAc.signal });

  return () => {
    abortControllers.forEach(ac => ac.abort());
    closeOpen();
  };
}

/**
 * Drag a tree row onto another tag to reparent it, or between two to reorder.
 *
 * @param {Element}  container
 * @param {object}   handlers
 * @param {Function} handlers.onReparent        (dragId, targetId) => void
 * @param {Function} handlers.onReorder         (dragId, parentId, afterId) => void
 * @param {Function} handlers.onInvalidReorder  () => void
 * @param {Function} handlers.siblingBefore     (targetId, parentId) => id|null
 */
export function bindDragAndDrop(container, { onReparent, onReorder, onInvalidReorder, siblingBefore } = {}) {
  let dragState = null;

  const clearIndicators = () => {
    container.querySelectorAll('.tm-row').forEach(r =>
      r.classList.remove('tm-drop-before', 'tm-drop-after', 'tm-drop-on'));
  };

  container.querySelectorAll('.tm-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      const id = parseInt(row.dataset.id, 10);
      dragState = { tagId: id, parentId: rowParentId(row) };
      row.classList.add('tm-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('tm-dragging');
      clearIndicators();
      dragState = null;
    });

    row.addEventListener('dragover', e => {
      if (!dragState) return;
      const targetId = parseInt(row.dataset.id, 10);
      if (dragState.tagId === targetId) return;

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      clearIndicators();
      const zone = dropZoneFor(e.clientY, row.getBoundingClientRect());
      if (zone === 'before') row.classList.add('tm-drop-before');
      else if (zone === 'after') row.classList.add('tm-drop-after');
      else row.classList.add('tm-drop-on');
    });

    row.addEventListener('dragleave', e => {
      if (!row.contains(e.relatedTarget)) {
        row.classList.remove('tm-drop-before', 'tm-drop-after', 'tm-drop-on');
      }
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragState) return;

      const { tagId: dragId, parentId: dragParent } = dragState;
      const targetId = parseInt(row.dataset.id, 10);
      if (dragId === targetId) { clearIndicators(); dragState = null; return; }

      // The indicator classes are the record of where dragover last landed.
      const zone = row.classList.contains('tm-drop-before') ? 'before'
                 : row.classList.contains('tm-drop-after') ? 'after'
                 : 'on';
      clearIndicators();
      dragState = null;

      const plan = reorderPlan({
        zone, dragParent, targetParent: rowParentId(row), targetId, siblingBefore,
      });

      if (plan.action === 'reparent') onReparent?.(dragId, targetId);
      else if (plan.action === 'invalid') onInvalidReorder?.();
      else onReorder?.(dragId, plan.parentId, plan.afterId);
    });
  });
}
