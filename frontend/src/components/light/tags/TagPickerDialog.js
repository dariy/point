/**
 * The modal overlay plumbing shared by the tags manager's dialogs.
 *
 * Three of them — Merge…, Move…, and bulk Move… — are the same dialog:
 * a searchable radio list of tags, Cancel, and a confirm button that refuses
 * an empty selection. They were three hand-rolled copies; openTagPickerDialog
 * is the one implementation, with the parts that genuinely differ (title,
 * labels, extra body controls) passed in.
 *
 * The fourth, the drop-confirm, is a different shape (fixed choices, no list)
 * and only shares the overlay boilerplate, which is why openOverlay is
 * exported separately.
 *
 * Every string that reaches this markup is escaped by the html`` tag that
 * builds it, here or in the caller — nothing relies on a caller remembering.
 */

import { html, setHTML } from '../../../utils/helpers.js';

/**
 * Create an active modal overlay, append it to <body>, and wire the two
 * dismissals every dialog here shares: the × button (if the markup has one)
 * and a click on the backdrop itself.
 *
 * @param {import('../../../utils/helpers.js').RawHtml} modalHtml  built with html``
 * Returns { overlay, close }. Callers wire their own buttons to `close`.
 */
export function openOverlay(modalHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  setHTML(overlay, html`${modalHtml}`);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  return { overlay, close };
}

/**
 * A searchable single-choice list of tags in a modal.
 *
 * @param {object}   opts
 * @param {import('../../../utils/helpers.js').RawHtml|string} opts.title
 *   Header text. html`` output goes in as markup; a plain string is escaped.
 * @param {string}   opts.modalClass     Modal variant class.
 * @param {Array}    opts.tags           Choices, already filtered and ordered.
 * @param {string}   opts.radioName      name= shared by the radio group.
 * @param {(tag: any) => import('../../../utils/helpers.js').RawHtml} opts.renderItem
 *   tag => item markup from html`` (must carry itemClass/nameClass).
 * @param {string}   opts.itemClass      Selector the search box shows/hides.
 * @param {string}   opts.nameClass      Element inside an item holding its searchable text.
 * @param {string}   opts.listClass      Wrapper around the items.
 * @param {string}   opts.searchClass    The search input.
 * @param {import('../../../utils/helpers.js').RawHtml} [opts.beforeList]  markup above the search box.
 * @param {import('../../../utils/helpers.js').RawHtml} [opts.afterList]   markup below the list.
 * @param {string}   opts.cancelId       Cancel button id.
 * @param {string}   opts.confirmId      Confirm button id.
 * @param {string}   opts.confirmLabel   Confirm button text.
 * @param {Function} [opts.collect]      (overlay) => extras, read BEFORE the close.
 * @param {Function} opts.onConfirm      (selectedId, extras) => void, run AFTER the close.
 * @param {Function} opts.onEmpty        Called instead when nothing is selected.
 * @param {Function} [opts.onMount]      (overlay, close) => void, for extra controls.
 * @returns {{overlay: Element, close: Function}}
 */
export function openTagPickerDialog({
  title, modalClass, tags, radioName, renderItem,
  itemClass, nameClass, listClass, searchClass,
  beforeList = '', afterList = '',
  cancelId, confirmId, confirmLabel,
  collect, onConfirm, onEmpty, onMount,
}) {
  const items = tags.map(renderItem);

  const { overlay, close } = openOverlay(html`
      <div class="modal ${modalClass}" role="dialog" aria-modal="true">
        <button class="modal-close" aria-label="Close">×</button>
        <div class="modal-header">
          <h3>${title}</h3>
        </div>
        <div class="modal-body">
          ${beforeList}
          <input type="text" class="form-input ${searchClass}" placeholder="Search tags…" autocomplete="off">
          <div class="${listClass}">${items}</div>
          ${afterList}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="${cancelId}">Cancel</button>
          <button type="button" class="btn btn-primary" id="${confirmId}">${confirmLabel}</button>
        </div>
      </div>`);

  overlay.querySelector(`#${cancelId}`).addEventListener('click', close);

  overlay.querySelector(`.${searchClass}`).addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    overlay.querySelectorAll(`.${itemClass}`).forEach(item => {
      const name = item.querySelector(`.${nameClass}`)?.textContent.toLowerCase() || '';
      item.classList.toggle('hidden', q !== '' && !name.includes(q));
    });
  });

  overlay.querySelector(`#${confirmId}`).addEventListener('click', async () => {
    const radio = /** @type {HTMLInputElement|null} */ (
      overlay.querySelector(`input[name="${radioName}"]:checked`));
    if (!radio) {
      onEmpty();
      return;
    }
    const selectedId = parseInt(radio.value, 10);
    // Order matters and is the same in all three callers: read the dialog's
    // other controls while they still exist, tear the dialog down, and only
    // then start the request. Closing first would lose the extras; awaiting
    // first would leave a dead modal on screen for the length of the call.
    const extras = collect?.(overlay);
    close();
    await onConfirm(selectedId, extras);
  });

  onMount?.(overlay, close);

  return { overlay, close };
}
