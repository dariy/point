/**
 * tagListFilters — the list view's DOM wiring: sortable headers, the search
 * box, parent-filter and quick-filter buttons, and the clear button.
 *
 * Mirrors tagSelection.ts::setupSelectMode: filter state and its DOM sync
 * (_applyListFilter, _updateFilterChips, _syncClearBtn) stay on the page;
 * this only wires the events that ask the page to change that state.
 */

/** The options of setupListFilters. */
export interface ListFilterOptions {
  state: () => { listFilterFlags: string[] };
  onSort: (field: string) => void;
  onSearch: (value: string) => void;
  onParentFilter: (parent: { id: number; name: string }) => void;
  onQuickFilter: (key: string) => void;
  onClear: () => void;
}

/**
 * @param container
 * @param opts
 * @param opts.state
 *   Read fresh on every quick-filter click, to paint the button before the
 *   page's callback flips the flag.
 * @param opts.onSort
 * @param opts.onSearch
 * @param opts.onParentFilter
 * @param opts.onQuickFilter
 * @param opts.onClear
 */
export function setupListFilters(
  container: Element,
  { state, onSort, onSearch, onParentFilter, onQuickFilter, onClear }: ListFilterOptions,
): void {
  container.querySelectorAll<HTMLElement>('.tm-sortable-header').forEach(th => {
    th.addEventListener('click', () => onSort(th.dataset.field));
  });

  const searchInput = (container.querySelector('.tm-list-search') as HTMLInputElement|null);
  if (searchInput) {
    searchInput.focus();
    const len = searchInput.value.length;
    searchInput.setSelectionRange(len, len);
    searchInput.addEventListener('input', e => onSearch((e.target as HTMLInputElement).value));
  }

  container.querySelectorAll<HTMLElement>('.tm-parent-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => onParentFilter({
      id: parseInt(btn.dataset.parentId, 10),
      name: btn.dataset.parentName
    }));
  });

  container.querySelectorAll<HTMLElement>('.tm-quick-filter-btn').forEach(btn => {
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
