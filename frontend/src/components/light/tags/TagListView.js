/**
 * TagListView — the tabular half of the tags manager, as pure functions.
 *
 * Same contract as TagTreeView: no DOM, no page state. The caller passes a
 * `view` descriptor ({ sortField, sortOrder, selectMode, selectedIds, search,
 * filterParents }) and gets HTML — or, for matchesListFilter/sortTagsForList,
 * a plain answer — back.
 *
 * The DOM-side filter wiring (chips, the clear button, row hiding) stays on
 * the page; only the predicate it applies lives here, so that the page and
 * "Select all" cannot drift apart on what "filtered" means.
 *
 * All markup is built with the html`` tag, which escapes every interpolation.
 */

import { html, raw } from '../../../utils/helpers.js';
import { EDIT_SVG, X_SVG, MAP_SVG } from '../../../utils/icons.js';

/**
 * Does this tag survive the list view's search box and parent chips?
 * Shared with "Select all" so the selection can never reach past what the
 * filters are showing.
 */
export function matchesListFilter(tag, { search = '', filterParents = [] } = {}) {
  const q = (search || '').trim().toLowerCase();
  const parents = tag.parents || [];
  const textMatch = !q ||
    tag.name.toLowerCase().includes(q) ||
    tag.slug.toLowerCase().includes(q) ||
    parents.some(p => p.name.toLowerCase().includes(q));

  const parentIds = parents.map(p => p.id);
  const parentMatch = filterParents.every(f => parentIds.includes(f.id));
  return textMatch && parentMatch;
}

/** Sort a copy of `tags` by the list view's active column. */
export function sortTagsForList(tags, sortField, sortOrder) {
  const dir = sortOrder === 'asc' ? 1 : -1;

  return [...tags].sort((a, b) => {
    let valA, valB;
    switch (sortField) {
      case 'name':        valA = a.name.toLowerCase();      valB = b.name.toLowerCase();      break;
      case 'slug':        valA = a.slug.toLowerCase();      valB = b.slug.toLowerCase();      break;
      case 'post_count':  valA = a.post_count || 0;         valB = b.post_count || 0;         break;
      case 'locations':   valA = (a.locations?.length > 0) ? 1 : 0; valB = (b.locations?.length > 0) ? 1 : 0; break;
      case 'parents':     valA = a.parents?.length || 0;    valB = b.parents?.length || 0;    break;
      default:
        valA = a.nav_order ?? Infinity; valB = b.nav_order ?? Infinity;
        if (valA === valB) { valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); }
    }
    if (valA < valB) return -1 * dir;
    if (valA > valB) return 1 * dir;
    return 0;
  });
}

/**
 * The active parent-filter chips.
 *
 * Exported because the page re-renders this row on its own whenever a chip is
 * added or removed, without going through renderTagList. Two hand-rolled copies
 * of the markup drifted once already — the second one had a bare "×" where this
 * has the icon, so a chip changed shape the moment anything touched the row.
 */
export function renderFilterChips(filterParents = []) {
  const chips = filterParents.map(p =>
    html`<button type="button" class="tm-filter-chip" data-remove-id="${p.id}">${p.name} <span class="tm-chip-remove">${raw(X_SVG)}</span></button>`
  );
  // Falsy when there are none: renderTagList gates the wrapper on this, and
  // html`` yields a String object, which is truthy even when blank.
  return chips.length ? html`${chips}` : '';
}

export function renderSortHeader(field, label, className = '', title = '',
  /** @type {{ sortField?: string, sortOrder?: string }} */ { sortField, sortOrder } = {}) {
  const isActive = sortField === field;
  const icon = isActive ? (sortOrder === 'asc' ? ' ▴' : ' ▾') : '';

  return html`
      <th class="tm-sortable-header ${className} ${isActive ? 'active' : ''}"
          data-field="${field}"
          title="${title || 'Sort by ' + label}">
        <div class="tm-header-content">
          <span>${label}</span>
          <span class="tm-sort-icon">${icon}</span>
        </div>
      </th>`;
}

export function renderTagList(tags, view) {
  if (!tags.length) return html`<p class="empty-state">No tags found.</p>`;

  const { sortField, sortOrder, selectMode, selectedIds, search, filterParents } = view;
  const sorted = sortTagsForList(tags, sortField, sortOrder);

  const rows = sorted.map(tag => {
    const parentBadges = (tag.parents || [])
      .map(p => html`<button type="button" class="tm-parent-filter-btn tm-rel-badge" data-parent-id="${p.id}" data-parent-name="${p.name}" title="Filter by ${p.name}">${p.name}</button>`);

    const hasLocation = tag.locations?.length > 0;
    const isSelected = selectedIds.has(tag.id);

    return html`
        <tr class="tm-tag-row${isSelected ? ' is-selected' : ''}" data-id="${tag.id}">
          ${selectMode ? html`<td class="tm-check-col"><input type="checkbox" class="tm-select-cb" data-id="${tag.id}"${isSelected ? raw(' checked') : ''} aria-label="Select ${tag.name}"></td>` : ''}
          <td class="tm-col-name"><span class="tm-tag-name">${tag.name}</span></td>
          <td class="tm-col-slug"><code class="tm-slug">${tag.slug}</code></td>
          <td class="text-center tm-col-count"><a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(tag.slug)}" title="View posts tagged ${tag.slug}">${tag.post_count || 0}</a></td>
          <td class="text-center tm-col-coords">
            ${hasLocation ? html`
              <a href="/map?tag=${encodeURIComponent(tag.slug)}" class="btn btn-sm tm-flag-link active tm-flag-location" title="View on map">
                ${raw(MAP_SVG)}<span class="btn-label"> Map</span>
              </a>` : html`
              <span class="tm-flag-static tm-flag-location" title="No coordinates">${raw(MAP_SVG)}</span>
            `}
          </td>
          <td class="tm-col-parents"><div class="tm-parents-cell">${parentBadges.length ? parentBadges : html`<span class="text-muted">—</span>`}</div></td>
          <td class="tm-actions-cell">
            <div class="tm-actions">
              <button class="btn btn-sm edit-tag-btn"   data-id="${tag.id}" title="Edit">${raw(EDIT_SVG)}</button>
              <button class="btn btn-sm merge-tag-btn"  data-id="${tag.id}" title="Merge into…">Merge…</button>
              <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${tag.id}" title="Delete">${raw(X_SVG)}</button>
            </div>
          </td>
        </tr>`;
  });

  const chips = renderFilterChips(filterParents);
  const hasFilters = search || filterParents.length > 0;

  return html`
      <div class="tm-list-filter-bar">
        <div class="tm-list-search-row">
          <input type="text" class="form-input tm-list-search" placeholder="Search name, slug, parents…" value="${search || ''}">
          ${hasFilters ? html`<button type="button" class="btn btn-sm btn-secondary tm-clear-filters">Clear</button>` : ''}
        </div>
        ${chips ? html`<div class="tm-filter-chips" id="tm-filter-chips">${chips}</div>` : html`<div class="tm-filter-chips" id="tm-filter-chips"></div>`}
      </div>
      <div class="table-container">
        <table class="table tm-tags-table">
          <thead>
            <tr>
              ${selectMode ? html`<th class="tm-check-col"></th>` : ''}
              ${renderSortHeader('name', 'Name', 'tm-col-name', '', view)}
              ${renderSortHeader('slug', 'Slug', 'tm-col-slug', '', view)}
              ${renderSortHeader('post_count', 'Posts', 'text-center tm-col-count', '', view)}
              ${renderSortHeader('locations', '📍', 'text-center tm-col-coords', 'Coordinates', view)}
              ${renderSortHeader('parents', 'Parents', 'tm-col-parents', '', view)}
              <th class="tm-actions-cell">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}
