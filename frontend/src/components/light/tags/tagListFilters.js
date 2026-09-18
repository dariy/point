/**
 * tagListFilters — the list view's DOM wiring: sortable headers, the search
 * box, parent-filter and quick-filter buttons, and the clear button.
 *
 * Mirrors tagSelection.js::setupSelectMode: filter state and its DOM sync
 * (_applyListFilter, _updateFilterChips, _syncClearBtn) stay on the page;
 * this only wires the events that ask the page to change that state.
 */

/**
 * @param {Element} container
 * @param {object} opts
 * @param {() => {listFilterFlags: string[]}} opts.state
 *   Read fresh on every quick-filter click, to paint the button before the
 *   page's callback flips the flag.
 * @param {(field: string) => void} opts.onSort
 * @param {(value: string) => void} opts.onSearch
 * @param {(parent: {id: number, name: string}) => void} opts.onParentFilter
 * @param {(key: string) => void} opts.onQuickFilter
 * @param {() => void} opts.onClear
 */
export function setupListFilters(container, { state, onSort, onSearch, onParentFilter, onQuickFilter, onClear }) {
  container.querySelectorAll('.tm-sortable-header').forEach((/** @type {HTMLElement} */ th) => {
    th.addEventListener('click', () => onSort(th.dataset.field));
  });

  const searchInput = /** @type {HTMLInputElement|null} */ (container.querySelector('.tm-list-search'));
  if (searchInput) {
    searchInput.focus();
    const len = searchInput.value.length;
    searchInput.setSelectionRange(len, len);
    searchInput.addEventListener('input', e => onSearch(/** @type {HTMLInputElement} */ (e.target).value));
  }

  container.querySelectorAll('.tm-parent-filter-btn').forEach((/** @type {HTMLElement} */ btn) => {
    btn.addEventListener('click', () => onParentFilter({
      id: parseInt(btn.dataset.parentId, 10),
      name: btn.dataset.parentName
    }));
  });

  container.querySelectorAll('.tm-quick-filter-btn').forEach((/** @type {HTMLElement} */ btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.flag;
      const active = state().listFilterFlags.includes(key);
      btn.classList.toggle('btn-primary', !active);
      btn.classList.toggle('btn-secondary', active);
      onQuickFilter(key);
    });
  });

  container.querySelector('.tm-clear-filters')?.addEventListener('click', () => onClear());
}
