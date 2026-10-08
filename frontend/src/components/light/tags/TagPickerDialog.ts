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

import { html, setHTML } from '../../../utils/helpers.ts';
import type { RawHtml } from '../../../utils/helpers.ts';

/**
 * Create an active modal overlay, append it to <body>, and wire the two
 * dismissals every dialog here shares: the × button (if the markup has one)
 * and a click on the backdrop itself.
 *
 * @param modalHtml  built with html``
 * Returns { overlay, close }. Callers wire their own buttons to `close`.
 */
export function openOverlay(modalHtml: RawHtml): { overlay: HTMLDivElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  setHTML(overlay, html`${modalHtml}`);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  return { overlay, close };
}

/** The options of openTagPickerDialog. */
export interface TagPickerOptions<T = unknown, E = unknown> {
  /** Header text. html`` output goes in as markup; a plain string is escaped. */
  title: RawHtml | string;
  /** Modal variant class. */
  modalClass: string;
  /** Choices, already filtered and ordered. */
  tags: T[];
  /** name= shared by the radio group. */
  radioName: string;
  /** tag => item markup from html`` (must carry itemClass/nameClass). */
  renderItem: (tag: T) => RawHtml;
  /** Selector the search box shows/hides. */
  itemClass: string;
  /** Element inside an item holding its searchable text. */
  nameClass: string;
  /** Wrapper around the items. */
  listClass: string;
  /** The search input. */
  searchClass: string;
  /** Markup above the search box. */
  beforeList?: RawHtml | '';
  /** Markup below the list. */
  afterList?: RawHtml | '';
  /** Cancel button id. */
  cancelId: string;
  /** Confirm button id. */
  confirmId: string;
  /** Confirm button text. */
  confirmLabel: string;
  /** (overlay) => extras, read BEFORE the close. */
  collect?: (overlay: HTMLDivElement) => E;
  /** (selectedId, extras) => void, run AFTER the close. */
  onConfirm: (selectedId: number, extras: E | undefined) => unknown;
  /** Called instead when nothing is selected. */
  onEmpty: () => void;
  /** (overlay, close) => void, for extra controls. */
  onMount?: (overlay: HTMLDivElement, close: () => void) => void;
}

/**
 * A searchable single-choice list of tags in a modal.
 *
 * @param opts  See TagPickerOptions.
 */
export function openTagPickerDialog<T, E = unknown>({
  title, modalClass, tags, radioName, renderItem,
  itemClass, nameClass, listClass, searchClass,
  beforeList = '', afterList = '',
  cancelId, confirmId, confirmLabel,
  collect, onConfirm, onEmpty, onMount,
}: TagPickerOptions<T, E>): { overlay: HTMLDivElement; close: () => void } {
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

  overlay.querySelector(`#${cancelId}`)!.addEventListener('click', close);

  overlay.querySelector(`.${searchClass}`)!.addEventListener('input', e => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    overlay.querySelectorAll(`.${itemClass}`).forEach(item => {
      const name = item.querySelector(`.${nameClass}`)?.textContent.toLowerCase() || '';
      item.classList.toggle('hidden', q !== '' && !name.includes(q));
    });
  });

  overlay.querySelector(`#${confirmId}`)!.addEventListener('click', async () => {
    const radio = overlay.querySelector(`input[name="${radioName}"]:checked`) as HTMLInputElement | null;
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
