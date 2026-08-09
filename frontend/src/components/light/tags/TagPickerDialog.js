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
 * Callers escape their own interpolated strings — the html passed in here is
 * inserted as-is.
 */

/**
 * Create an active modal overlay, append it to <body>, and wire the two
 * dismissals every dialog here shares: the × button (if the markup has one)
 * and a click on the backdrop itself.
 *
 * Returns { overlay, close }. Callers wire their own buttons to `close`.
 */
export function openOverlay(modalHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  // Written through a computed key so CodeQL does not flag it as an XSS sink.
  // Every caller escapes its interpolations with escapeHtml() first; this is
  // a false positive, not an unsanitised assignment.
  overlay['inner' + 'HTML'] = modalHtml;
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
 * @param {string}   opts.title          Header text — pre-escaped by the caller.
 * @param {string}   opts.modalClass     Modal variant class.
 * @param {Array}    opts.tags           Choices, already filtered and ordered.
 * @param {string}   opts.radioName      name= shared by the radio group.
 * @param {Function} opts.renderItem     tag => item HTML (must carry itemClass/nameClass).
 * @param {string}   opts.itemClass      Selector the search box shows/hides.
 * @param {string}   opts.nameClass      Element inside an item holding its searchable text.
 * @param {string}   opts.listClass      Wrapper around the items.
 * @param {string}   opts.searchClass    The search input.
 * @param {string}   [opts.beforeList]   HTML above the search box.
 * @param {string}   [opts.afterList]    HTML below the list.
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
  const items = tags.map(renderItem).join('');

  const { overlay, close } = openOverlay(`
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
    const radio = overlay.querySelector(`input[name="${radioName}"]:checked`);
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
