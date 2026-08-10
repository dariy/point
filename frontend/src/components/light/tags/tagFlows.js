/**
 * tagFlows — the tags manager's mutating flows: Move…, Merge…, the confirm
 * shown when one tag is dragged onto another, and the bulk operations behind
 * select mode.
 *
 * These are the paths that change the hierarchy, and they are the ones where a
 * wrong decision is invisible: re-filing a tag under a new parent silently
 * drops the old ones unless something adds them back, and a bulk run that
 * fails halfway still reloads the list, so the toast is the user's only
 * evidence of what actually happened.
 *
 * Those decisions are exported as pure functions — which tags a flow may
 * target, the parent set an "also file under" produces, the sibling positions
 * on offer, and what a finished bulk run reports — and tested directly. The
 * dialog openers and the bulk runner below are the plumbing around them, and
 * hold no page state: the tag list comes in as an argument and everything a
 * caller must react to goes out through `onDone`.
 *
 * All user-supplied strings are escaped with escapeHtml() before interpolation;
 * openTagPickerDialog and openOverlay insert what they are given as-is.
 */

import { store } from '../../../store.js';
import { escapeHtml } from '../../../utils/helpers.js';
import { setTagParents, deleteTag, patchTag, moveTag, mergeTags } from '../../../api/tags.js';
import { openTagPickerDialog, openOverlay } from './TagPickerDialog.js';
import { getChildrenOf } from './tagOrdering.js';

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * The tags a flow may target — everything except the ones it is acting on,
 * ordered by name.
 *
 * Each of the three pickers excludes a different set (the tag being moved, the
 * tag being merged away, every tag in a bulk selection) but all three exclude
 * for the same reason: a tag cannot be its own parent, and merging a tag into
 * itself is not a merge. Sorting is on the filtered copy, never the caller's
 * array.
 */
export function candidateTags(tags, excludeIds) {
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  return tags
    .filter(t => !excluded.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The parent set for "file under this as well, keeping the others", or null
 * when the tag is already filed there and no request is needed.
 *
 * Null rather than the unchanged array so callers cannot accidentally rewrite
 * a hierarchy with a set identical to the one already stored — setTagParents
 * replaces wholesale, and a no-op write still bumps the server's ordering.
 */
export function parentsWith(tag, parentId) {
  const current = (tag.parents || []).map(p => p.id);
  return current.includes(parentId) ? null : [...current, parentId];
}

/**
 * The Position select's options: the front of the sibling group, then each
 * existing sibling to sit after.
 *
 * An empty value means "at the beginning" — moveTag reads `after_id: null`
 * that way — and the moving tag is never offered as its own anchor.
 */
export function positionOptions(tags, parentId, movingId) {
  return [
    `<option value="">At beginning</option>`,
    ...getChildrenOf(tags, parentId)
      .filter(t => t.id !== movingId)
      .map(s => `<option value="${s.id}">After "${escapeHtml(s.name)}"</option>`),
  ].join('');
}

/**
 * What a finished bulk run tells the user.
 *
 * Partial failure is reported as an error carrying both counts rather than the
 * success message, because the list reloads either way: "12 tags deleted" over
 * a run where four calls 4xx'd is the only thing the user would ever see, and
 * nothing later corrects it.
 */
export function bulkOutcome(done, total, successMessage) {
  const failed = total - done;
  return failed === 0
    ? { message: successMessage(done), type: 'success' }
    : { message: `${done} of ${total} done. ${failed} failed.`, type: 'error' };
}

/** "1 tag" / "3 tags" — the plural these flows repeat in every message. */
export function pluralTags(n) {
  return `${n} tag${n === 1 ? '' : 's'}`;
}

// ── Bulk operations ──────────────────────────────────────────────────────────

/**
 * Apply `op` to every selected tag, reporting partial failure rather than
 * stopping at the first one.
 *
 * Sequential on purpose: these all touch the same hierarchy, and the server
 * serialises the writes anyway. A failure is counted and logged, never
 * rethrown — the point of the flow is that one bad id does not abandon the
 * rest of the selection.
 *
 * @param {number[]} ids
 * @param {(id:number)=>Promise} op
 * @param {(count:number)=>string} successMessage  Called with the done count.
 * @param {{onDone?: Function}} [opts]  Run after the toast, failures included.
 */
export async function runBulk(ids, op, successMessage, { onDone } = {}) {
  let done = 0;
  for (const id of ids) {
    try {
      await op(id);
      done++;
    } catch (err) {
      console.error(`[tagFlows] bulk operation failed for tag ${id}:`, err);
    }
  }

  store.set('toast', bulkOutcome(done, ids.length, successMessage));
  onDone?.();
}

/** Bulk visibility: mark every selected tag hidden or visible. */
export function bulkVisibility({ ids, hidden, onDone }) {
  return runBulk(
    ids,
    id => patchTag(id, { hidden }),
    n => `${pluralTags(n)} marked ${hidden ? 'hidden' : 'visible'}.`,
    { onDone },
  );
}

/**
 * Bulk delete, behind a confirm.
 *
 * `confirm` is the caller's ConfirmDialog plumbing, in its existing positional
 * shape — the dialog itself is generic and not part of this flow.
 */
export function bulkDelete({ ids, confirm, onDone }) {
  confirm(
    'Delete tags',
    `Delete ${pluralTags(ids.length)}? Posts will NOT be deleted.`,
    'Delete',
    'danger',
    () => runBulk(ids, id => deleteTag(id), n => `${pluralTags(n)} deleted.`, { onDone }),
  );
}

/**
 * Bulk Move…: pick one parent, then re-file every selected tag under it.
 *
 * Unlike the single-tag Move… this REPLACES the parents rather than adding to
 * them, which the dialog says in as many words — one parent chosen for a whole
 * selection cannot preserve each tag's own set without asking per tag.
 */
export function openBulkMoveDialog({ tags, ids, onDone }) {
  if (!ids.length) return null;

  const available = candidateTags(tags, ids);
  if (!available.length) {
    store.set('toast', { message: 'No tag left to move these under.', type: 'error' });
    return null;
  }

  return openTagPickerDialog({
    title: `Move ${pluralTags(ids.length)} under…`,
    modalClass: 'tm-picker-modal',
    tags: available,
    radioName: 'tm-bulk-parent',
    renderItem: t => `
      <label class="tm-picker-item">
        <input type="radio" name="tm-bulk-parent" value="${t.id}">
        <span class="tm-picker-name">${escapeHtml(t.name)}</span>
      </label>`,
    itemClass: 'tm-picker-item',
    nameClass: 'tm-picker-name',
    listClass: 'tm-picker-list',
    searchClass: 'tm-picker-search',
    afterList: '<p class="form-hint">Replaces any parents these tags already have.</p>',
    cancelId: 'tm-bulk-move-cancel-btn',
    confirmId: 'tm-bulk-move-confirm-btn',
    confirmLabel: 'Move',
    onEmpty: () => store.set('toast', { message: 'Select a parent first.', type: 'error' }),
    onConfirm: parentId => runBulk(
      ids,
      id => setTagParents(id, [parentId]),
      n => `${pluralTags(n)} moved.`,
      { onDone },
    ),
  });
}

// ── Single-tag flows ─────────────────────────────────────────────────────────

/**
 * Merge… — pick the tag to merge this one into.
 *
 * The loser is deleted server-side, so the dialog spells out all three effects
 * before confirming. The redirect checkbox is sent but not yet honoured by the
 * backend; its label says so.
 */
export function openMergeDialog({ tags, loserId, onDone }) {
  const loser = tags.find(t => t.id === loserId);
  if (!loser) return null;

  return openTagPickerDialog({
    title: `Merge "${escapeHtml(loser.name)}" into…`,
    modalClass: 'tm-picker-modal',
    tags: candidateTags(tags, [loserId]),
    radioName: 'tm-merge-winner',
    renderItem: t => `
      <label class="tm-picker-item">
        <input type="radio" name="tm-merge-winner" value="${t.id}">
        <div class="tm-picker-item-info">
          <span class="tm-picker-name">${escapeHtml(t.name)}</span>
          ${t.name_path ? `<span class="tm-picker-path">${escapeHtml(t.name_path)}</span>` : ''}
        </div>
      </label>`,
    itemClass: 'tm-picker-item',
    nameClass: 'tm-picker-name',
    listClass: 'tm-picker-list',
    searchClass: 'tm-picker-search',
    beforeList: '<p class="tm-section-label">Select destination tag</p>',
    afterList: `
          <p class="form-hint" style="margin-top:var(--spacing-md)">
            Posts tagged <strong>${escapeHtml(loser.name)}</strong> will be re-tagged.
            Hierarchy will be moved. <strong>${escapeHtml(loser.name)}</strong> will be deleted.
          </p>
          <label class="tm-flag-row" style="margin-top:var(--spacing-sm)">
            <input type="checkbox" id="tm-merge-redirect" checked> Keep redirect (not yet implemented)
          </label>`,
    cancelId: 'tm-merge-cancel-btn',
    confirmId: 'tm-merge-confirm-btn',
    confirmLabel: 'Merge Tags',
    onEmpty: () => store.set('toast', { message: 'Select a destination tag first.', type: 'error' }),
    collect: overlay => overlay.querySelector('#tm-merge-redirect').checked,
    onConfirm: async (winnerId, keepRedirect) => {
      try {
        await mergeTags(loserId, { winner_id: winnerId, keep_redirect: keepRedirect });
        onDone?.();
        store.set('toast', { message: 'Tags merged successfully.', type: 'success' });
      } catch (err) {
        store.set('toast', { message: err.message || 'Merge failed.', type: 'error' });
      }
    },
  });
}

/**
 * Move… — touch parity for drag: pick a parent and a position under it.
 *
 * Two calls, in this order and for different reasons: setTagParents makes the
 * chosen parent one of the tag's parents (skipped when it already is, see
 * parentsWith), and moveTag then orders it within that parent's children.
 * moveTag alone would order a tag into a group it does not belong to.
 *
 * @param {number} contextParentId  The parent whose branch the user clicked
 *   Move… under; preselected, and the group whose positions are offered first.
 */
export function openMoveDialog({ tags, tagId, contextParentId, onDone }) {
  const tag = tags.find(t => t.id === tagId);
  if (!tag) return null;

  return openTagPickerDialog({
    title: `Move "${escapeHtml(tag.name)}"`,
    modalClass: 'tm-picker-modal',
    tags: candidateTags(tags, [tagId]),
    radioName: 'tm-move-parent',
    renderItem: t => `
      <label class="tm-picker-item">
        <input type="radio" name="tm-move-parent" value="${t.id}"${t.id === contextParentId ? ' checked' : ''}>
        <span class="tm-picker-name">${escapeHtml(t.name)}</span>
      </label>`,
    itemClass: 'tm-picker-item',
    nameClass: 'tm-picker-name',
    listClass: 'tm-picker-list',
    searchClass: 'tm-picker-search',
    beforeList: '<p class="tm-section-label">Under parent</p>',
    afterList: `
          <p class="tm-section-label" style="margin-top:var(--spacing-md)">Position</p>
          <select class="form-input tm-move-position-select">${positionOptions(tags, contextParentId, tagId)}</select>`,
    cancelId: 'tm-move-cancel-btn',
    confirmId: 'tm-move-confirm-btn',
    confirmLabel: 'Move',
    onEmpty: () => store.set('toast', { message: 'Select a parent first.', type: 'error' }),
    onMount: overlay => {
      // Re-offer positions whenever the chosen parent changes.
      overlay.querySelector('.tm-picker-list').addEventListener('change', e => {
        if (e.target.name === 'tm-move-parent') {
          overlay.querySelector('.tm-move-position-select').innerHTML =
            positionOptions(tags, parseInt(e.target.value, 10), tagId);
        }
      });
    },
    collect: overlay => {
      const raw = overlay.querySelector('.tm-move-position-select').value;
      return raw ? parseInt(raw, 10) : null;
    },
    onConfirm: async (parentId, afterId) => {
      try {
        const nextParents = parentsWith(tag, parentId);
        if (nextParents) await setTagParents(tagId, nextParents);
        await moveTag(tagId, { parent_id: parentId, after_id: afterId });
        onDone?.();
        store.set('toast', { message: 'Tag moved.', type: 'success' });
      } catch (err) {
        store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
      }
    },
  });
}

/**
 * The confirm shown when one tag is dropped onto another.
 *
 * A drop is ambiguous in a graph where a tag may have several parents, so the
 * dialog asks rather than guessing: replace the parents, or add this one to
 * them. Both options say which they are in the button itself — this is the one
 * place a user can lose a filing they cannot see on screen.
 */
export function openDropOnConfirm({ tags, dragId, targetId, onDone }) {
  const drag   = tags.find(t => t.id === dragId);
  const target = tags.find(t => t.id === targetId);
  if (!drag || !target) return null;

  const { overlay, close } = openOverlay(`
      <div class="modal" role="dialog" aria-modal="true" style="max-width:28rem">
        <div class="modal-header">
          <h3>Move "${escapeHtml(drag.name)}" under "${escapeHtml(target.name)}"?</h3>
        </div>
        <div class="modal-body">
          <p style="font-size:var(--font-size-sm);color:var(--text-secondary);margin:0">
            Choose how to place <strong>${escapeHtml(drag.name)}</strong>:
          </p>
        </div>
        <div class="modal-footer tm-drop-confirm-footer">
          <button class="btn btn-primary" id="drop-move-btn">
            Move under "${escapeHtml(target.name)}" — replaces other parents
          </button>
          <button class="btn btn-secondary" id="drop-also-btn">
            Also file under "${escapeHtml(target.name)}" — keeps other parents
          </button>
          <button class="btn btn-secondary" id="drop-cancel-btn">Cancel</button>
        </div>
      </div>`);

  overlay.querySelector('#drop-cancel-btn').addEventListener('click', close);

  overlay.querySelector('#drop-move-btn').addEventListener('click', async () => {
    close();
    try {
      await setTagParents(dragId, [targetId]);
      onDone?.();
    } catch (err) {
      store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
    }
  });

  overlay.querySelector('#drop-also-btn').addEventListener('click', async () => {
    close();
    try {
      const nextParents = parentsWith(drag, targetId);
      if (nextParents) await setTagParents(dragId, nextParents);
      onDone?.();
    } catch (err) {
      store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
    }
  });

  return { overlay, close };
}
