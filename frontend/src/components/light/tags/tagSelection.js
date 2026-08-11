/**
 * tagSelection — select mode in the tags manager: the bulk toolbar, the ways
 * into and out of selecting, and the selection itself.
 *
 * Three things here are worth naming.
 *
 * A tag can sit under several parents, so ONE TAG OWNS SEVERAL ROWS. The
 * selection is held as a set of ids and pushed out to every row carrying that
 * id by hand, rather than by re-rendering — a re-render would pull focus off
 * the list view's search box mid-keystroke, and that box is how a user narrows
 * a selection in the first place. Everything below follows from that: the DOM
 * is updated in place while the set is the truth.
 *
 * "Select all" means all SELECTABLE, which in the list view is whatever the
 * search and parent filters left visible. Selecting rows a user cannot see and
 * then deleting them is the one mistake this screen must not make.
 *
 * The select-all box is tri-state, and `indeterminate` is a hint only — it is
 * never read back. Same rule as the editor's toggle trees (tagToggleTree.js):
 * a checked box is never also indeterminate, since browsers paint the partial
 * mark over the tick and would hide it.
 *
 * The module holds no page state. What it needs it reads through `state()` on
 * every event — the selection set is mutated in place between renders, so a
 * snapshot taken at bind time would go stale — and everything the page must
 * react to leaves through `onModeChange` / `onBulkDone`.
 */

import { CHECK_SVG, TRASH_SVG } from '../../../utils/icons.js';
import { matchesListFilter } from './TagListView.js';
import { SWIPE_BREAKPOINT } from './tagGestures.js';
import { bulkVisibility, bulkDelete, openBulkMoveDialog } from './tagFlows.js';

/** Hold a row this long to start selecting. Matches the post cards. */
export const LONG_PRESS_MS = 500;

/** Controls that act on their own; a press on one is never a row press. */
export const INTERACTIVE = 'input, button, a, select, label';

/** Tree rows carry .tm-row; list-view rows are the <tr class="tm-tag-row">. */
export const ROW_SELECTOR = '.tm-row, .tm-tag-row';

const rowId = row => parseInt(row.dataset.id, 10);

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * The tags "Select all" applies to.
 *
 * The tree shows everything, so it is everything; the list view hides rows its
 * filters exclude, and a hidden row must not end up in a bulk delete. Filtering
 * uses the same predicate the rows themselves were shown or hidden with
 * (_applyListFilter), so the two cannot drift apart.
 */
export function selectableTags(tags, view, listView) {
  if (view !== 'list') return tags;
  return tags.filter(t => matchesListFilter(t, listView));
}

/**
 * The select-all box for `selected` of `total`: ticked only when the selection
 * is everything, partial when it is some of it, and neither when it is empty —
 * an empty selection over an empty list is not "all selected".
 */
export function selectAllState(selected, total) {
  return {
    checked: selected > 0 && selected === total,
    indeterminate: selected > 0 && selected < total,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The toolbar shown while select mode is on. Unlike the posts list this sits in
 * the flow rather than overlaying a filter block — the tags tree has none.
 *
 * The page decides when to show it; this only says what it looks like.
 */
export function renderBulkToolbar() {
  return `
      <div class="tm-bulk-toolbar" id="tm-bulk-toolbar">
        <label class="select-all-label"><input type="checkbox" id="tm-select-all-cb"> Select all</label>
        <div class="tm-bulk-actions">
          <span id="tm-bulk-count">0 selected</span>
          <select id="tm-bulk-visibility-select" class="filter-select" aria-label="Visibility to apply">
            <option value="hidden">Hidden</option>
            <option value="visible">Visible</option>
          </select>
          <button id="tm-bulk-apply-btn" class="btn btn-sm" disabled title="Apply visibility">${CHECK_SVG}<span class="btn-label"> Apply</span></button>
          <button id="tm-bulk-move-btn" class="btn btn-sm" disabled title="Move under a parent…">Move…</button>
          <button id="tm-bulk-delete-btn" class="btn btn-sm btn-danger" disabled title="Delete tags">${TRASH_SVG}<span class="btn-label"> Delete</span></button>
          <!-- Deliberately not a .btn-label: this is the way out of select
               mode, so its text has to survive the icon-only collapse. -->
          <button id="tm-bulk-done-btn" class="btn btn-sm btn-secondary" title="Leave selection mode">Done</button>
        </div>
      </div>`;
}

// ── DOM sync ─────────────────────────────────────────────────────────────────

/** Show a tag as selected or not, on every row that tag owns. */
export function applyRowSelection(container, id, on) {
  container.querySelectorAll(`.tm-select-cb[data-id="${id}"]`).forEach(cb => {
    cb.checked = on;
  });
  container.querySelectorAll(`.tm-row[data-id="${id}"], .tm-tag-row[data-id="${id}"]`)
    .forEach(row => row.classList.toggle('is-selected', on));
}

/**
 * Bring the toolbar in line with the selection: the count, the three actions
 * that need at least one tag, and the tri-state select-all.
 *
 * Every lookup is guarded because this also runs while the toolbar is absent —
 * select mode can be off, and the page swaps the toolbar out with the rest of
 * the content on load and error.
 *
 * @param {object} opts
 * @param {number} opts.selected      Size of the selection.
 * @param {() => number} opts.total   How many tags are selectable. A function
 *   because only the select-all box needs it, and counting means running the
 *   list filter over every tag — on every tick of every checkbox.
 */
export function updateBulkToolbar(container, { selected, total }) {
  const count = container.querySelector('#tm-bulk-count');
  if (count) count.textContent = `${selected} selected`;

  ['#tm-bulk-apply-btn', '#tm-bulk-move-btn', '#tm-bulk-delete-btn'].forEach(sel => {
    const btn = container.querySelector(sel);
    if (btn) btn.disabled = selected === 0;
  });

  const selectAll = container.querySelector('#tm-select-all-cb');
  if (selectAll) {
    const { checked, indeterminate } = selectAllState(selected, total());
    selectAll.checked = checked;
    selectAll.indeterminate = indeterminate;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

/**
 * Touch shortcuts into select mode, mirroring the post cards: long-press a row
 * to start selecting, then tap rows to add and remove them.
 *
 * Bound only where the touch layout is active — the same breakpoint the swipe
 * gestures use — since a row is not a tap target on desktop; there the header's
 * Select button is the way in. Nothing is torn down: the rows these listeners
 * sit on are replaced wholesale by the next render.
 */
function bindRowGestures(container, { state, enterWith, toggleSelected }) {
  if (!window.matchMedia?.(SWIPE_BREAKPOINT).matches) return;

  container.querySelectorAll(ROW_SELECTOR).forEach(row => {
    const id = rowId(row);
    if (!Number.isInteger(id)) return;

    let timer = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

    row.addEventListener('pointerdown', e => {
      if (e.target.closest(INTERACTIVE)) return;
      if (state().selectMode) return;
      timer = setTimeout(() => {
        timer = null;
        enterWith(id);
      }, LONG_PRESS_MS);
    });
    row.addEventListener('pointerup', cancel);
    row.addEventListener('pointermove', cancel);
    row.addEventListener('pointercancel', cancel);

    row.addEventListener('click', e => {
      if (!state().selectMode) return;
      if (e.target.closest(INTERACTIVE)) return;
      toggleSelected(id);
    });
  });
}

/**
 * Wire select mode inside `container` and return the handle the page keeps.
 *
 * @param {Element} container
 * @param {object}  opts
 * @param {() => {selectMode:boolean, selectedIds:Set<number>, tags:object[],
 *                view:string, listView:object}} opts.state
 *   Read fresh on every event, never captured — see the file header.
 * @param {(selectMode:boolean, selectedIds:Set<number>) => void} opts.onModeChange
 *   Entering or leaving select mode; the page turns this into a re-render.
 * @param {() => void} opts.onBulkDone   After a bulk run, failures included.
 * @param {Function}   opts.confirm      The page's ConfirmDialog plumbing.
 * @returns {{selectBySwipe: Function, setSelected: Function,
 *            toggleSelected: Function, update: Function}}
 */
export function setupSelectMode(container, { state, onModeChange, onBulkDone, confirm }) {
  const update = () => {
    const { selectedIds, tags, view, listView } = state();
    updateBulkToolbar(container, {
      selected: selectedIds.size,
      total: () => selectableTags(tags, view, listView).length,
    });
  };

  /**
   * Select or deselect one tag, in place — see the file header on why this
   * never goes through the page's setState.
   */
  const setSelected = (id, on) => {
    const { selectedIds } = state();
    if (on) selectedIds.add(id); else selectedIds.delete(id);
    applyRowSelection(container, id, on);
    update();
  };

  const toggleSelected = id => setSelected(id, !state().selectedIds.has(id));

  /** Enter select mode with one tag already picked — the touch way in. */
  const enterWith = id => onModeChange(true, new Set([id]));

  /** Swipe-right on a row: start selecting, or add/remove it if already on. */
  const selectBySwipe = row => {
    const id = rowId(row);
    if (!Number.isInteger(id)) return;
    if (!state().selectMode) enterWith(id);
    else toggleSelected(id);
  };

  const handle = { selectBySwipe, setSelected, toggleSelected, update };

  container.querySelector('#tm-select-btn')?.addEventListener('click', () => {
    onModeChange(!state().selectMode, new Set());
  });

  bindRowGestures(container, { state, enterWith, toggleSelected });

  if (!state().selectMode) return handle;

  container.querySelectorAll('.tm-select-cb').forEach(cb => {
    cb.addEventListener('change', e => {
      // Belt and braces, kept from the original: nothing above a row listens
      // for `change`, and the tap that ticked the box is already ignored by the
      // row's click handler (an input matches INTERACTIVE). Removing it changes
      // nothing measurable — which is exactly why it is cheap to keep.
      e.stopPropagation();
      setSelected(rowId(cb), cb.checked);
    });
  });

  container.querySelector('#tm-select-all-cb')?.addEventListener('change', e => {
    const selectedIds = new Set();
    const { tags, view, listView } = state();
    if (e.target.checked) selectableTags(tags, view, listView).forEach(t => selectedIds.add(t.id));
    onModeChange(true, selectedIds);
  });

  container.querySelector('#tm-bulk-apply-btn')
    ?.addEventListener('click', () => bulkVisibility({
      ids: [...state().selectedIds],
      hidden: container.querySelector('#tm-bulk-visibility-select').value === 'hidden',
      onDone: onBulkDone,
    }));
  container.querySelector('#tm-bulk-move-btn')
    ?.addEventListener('click', () => openBulkMoveDialog({
      tags: state().tags,
      ids: [...state().selectedIds],
      onDone: onBulkDone,
    }));
  container.querySelector('#tm-bulk-delete-btn')
    ?.addEventListener('click', () => bulkDelete({
      ids: [...state().selectedIds],
      confirm,
      onDone: onBulkDone,
    }));
  container.querySelector('#tm-bulk-done-btn')
    ?.addEventListener('click', () => onModeChange(false, new Set()));

  update();
  return handle;
}
