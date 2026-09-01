/**
 * TagTreeView — the tree half of the tags manager, as pure functions.
 *
 * buildTagTree() turns the flat tag list into { navRoots, otherRoots, unfiled };
 * the render* functions turn that forest into HTML. Nothing here touches the
 * DOM or the page's state object — the caller passes a `view` descriptor
 * ({ expanded, unfiledExpanded, selectMode, selectedIds }) and gets a string
 * back, which is what makes this half testable without a DOM harness.
 *
 * All markup is built with the html`` tag, which escapes every interpolation.
 */

import { html, raw } from '../../../utils/helpers.js';
import { EDIT_SVG, X_SVG, CHEVRON_SVG, CHEVRON_RIGHT_SVG } from '../../../utils/icons.js';

/**
 * Build tree structure from flat tag list.
 * Returns { navRoots, otherRoots, unfiled } for the forest renderer.
 * Multi-parent tags appear under each parent (DAG).
 */
export function buildTagTree(tags) {
  const tagById = new Map(tags.map(t => [t.id, t]));
  const childrenOf = new Map();
  tags.forEach(t => {
    (t.parents || []).forEach(p => {
      if (tagById.has(p.id)) {
        if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
        childrenOf.get(p.id).push(t);
      }
    });
  });

  const sortFn = (a, b) => {
    const ao = a.sort_order ?? Infinity;
    const bo = b.sort_order ?? Infinity;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  };

  const makeNode = (tag, ancestorIds) => {
    const kids = (childrenOf.get(tag.id) || []).filter(c => !ancestorIds.has(c.id));
    kids.sort(sortFn);
    return {
      ...tag,
      childrenNodes: kids.map(c => makeNode(c, new Set([...ancestorIds, c.id]))),
    };
  };

  // Parentless tags are top-level
  const parentless = tags.filter(t => (t.parents || []).length === 0);

  // Nav roots: explicitly placed in navigation
  const navRoots = parentless
    .filter(t => t.nav_order != null)
    .sort((a, b) => a.nav_order - b.nav_order)
    .map(t => makeNode(t, new Set([t.id])));

  // Other filed roots: no nav_order but have children (intentional hierarchy roots)
  const otherRoots = parentless
    .filter(t => t.nav_order == null && (childrenOf.get(t.id) || []).length > 0)
    .sort(sortFn)
    .map(t => makeNode(t, new Set([t.id])));

  // Unfiled: no parents, no children, not in nav
  const unfiled = parentless
    .filter(t => t.nav_order == null && (childrenOf.get(t.id) || []).length === 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { navRoots, otherRoots, unfiled };
}

export function renderTagForest({ navRoots, otherRoots, unfiled }, view) {
  const total = navRoots.length + otherRoots.length + unfiled.length;
  if (!total) return html`<p class="empty-state">No tags found.</p>`;

  // Collected rather than concatenated: `+=` would drop html`` output back to a
  // plain string, and the caller interpolates the result as markup.
  const parts = [];

  if (navRoots.length) {
    parts.push(html`<ul class="tm-tree level-0">${navRoots.map(n => renderTagNode(n, 0, null, view))}</ul>`);
  }

  if (otherRoots.length) {
    parts.push(html`<ul class="tm-tree level-0">${otherRoots.map(n => renderTagNode(n, 0, null, view))}</ul>`);
  }

  if (unfiled.length) {
    parts.push(renderUnfiledGroup(unfiled, view));
  }

  return html`<div class="tm-tree-root">${parts}</div>`;
}

export function renderTagTree(nodes, level = 0, parentId = null, view) {
  if (!nodes.length) return level === 0 ? html`<p class="empty-state">No tags found.</p>` : '';
  return html`<ul class="tm-tree level-${level}" data-parent-id="${parentId ?? ''}">${nodes.map(n => renderTagNode(n, level, parentId, view))}</ul>`;
}

export function renderTagNode(node, level, parentId, view) {
  const isExpanded = view.expanded.has(node.id);
  const hasChildren = node.childrenNodes.length > 0;

  const toggle = hasChildren
    ? html`<button class="tm-toggle" data-id="${node.id}">${raw(isExpanded ? CHEVRON_SVG : CHEVRON_RIGHT_SVG)}</button>`
    : html`<span class="tm-toggle-spacer"></span>`;

  const badges = renderRowBadges(node);
  const parentAttr = parentId != null ? parentId : '';
  const { selectMode } = view;
  const isSelected = view.selectedIds.has(node.id);

  return html`
      <li class="tm-node" data-id="${node.id}">
        <div class="tm-row${isSelected ? ' is-selected' : ''}" draggable="${selectMode ? 'false' : 'true'}" data-id="${node.id}" data-parent-id="${parentAttr}">
          <span class="tm-drag-handle" title="Drag to reorder">⋮⋮</span>
          ${renderSelectCheckbox(node, selectMode, isSelected)}
          ${toggle}
          <div class="tm-node-body">
            <span class="tm-tag-name">${node.name}</span>
            ${badges ? html`<span class="tm-badges-row">${badges}</span>` : ''}
          </div>
          <span class="tm-row-meta">
            <a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(node.slug)}" title="View posts tagged ${node.slug}">${node.post_count || 0}</a>
          </span>
          <div class="tm-actions">
            <button class="btn btn-sm edit-tag-btn"    data-id="${node.id}" title="Edit" aria-label="Edit tag">${raw(EDIT_SVG)}</button>
            <button class="btn btn-sm merge-tag-btn"   data-id="${node.id}" title="Merge into…" aria-label="Merge into another tag">Merge…</button>
            <button class="btn btn-sm move-tag-btn"    data-id="${node.id}" data-parent-id="${parentAttr}" title="Move to parent…" aria-label="Move to new parent">Move…</button>
            <button class="btn btn-sm add-child-btn"   data-id="${node.id}" title="Add child" aria-label="Add child tag">+</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${node.id}" title="Delete" aria-label="Delete tag">${raw(X_SVG)}</button>
          </div>
        </div>
        ${isExpanded && hasChildren ? renderTagTree(node.childrenNodes, level + 1, node.id, view) : ''}
      </li>`;
}

export function renderSelectCheckbox(tag, selectMode, isSelected) {
  if (!selectMode) return '';
  return html`<input type="checkbox" class="tm-select-cb" data-id="${tag.id}"${isSelected ? raw(' checked') : ''} aria-label="Select ${tag.name}">`;
}

export function renderRowBadges(node) {
  const parts = [];

  if (node.nav_order != null) {
    parts.push(html`<span class="tm-badge tm-badge-nav" title="In public navigation (position ${node.nav_order})">⌂ nav</span>`);
  }

  if (node.hidden) {
    parts.push(html`<span class="tm-badge tm-badge-hidden" title="Hidden from public">🚫 hidden</span>`);
  } else if (node.effective_hidden) {
    const via = node.hidden_via
      ? html` <button type="button" class="tm-badge-via-btn" data-open-tag-id="${node.hidden_via}" title="Open ancestor tag">inh.</button>`
      : ' inh.';
    parts.push(html`<span class="tm-badge tm-badge-inherited" title="Hidden via ancestor">🚫${via}</span>`);
  }

  if (node.kind === 'year') {
    parts.push(html`<span class="tm-badge tm-badge-year" title="Year tag">📅 year</span>`);
  }

  if (node.locations?.length > 0) {
    parts.push(html`<a href="/map?tag=${encodeURIComponent(node.slug)}" class="tm-badge tm-badge-coords" title="View on map">📍</a>`);
  }

  const allParents = node.parents || [];
  if (allParents.length > 1) {
    const extras = allParents.slice(1).map(p => p.name).join(', ');
    parts.push(html`<span class="tm-badge tm-badge-multi" title="Also under: ${extras}">⎇ ${allParents.length} parents</span>`);
  }

  // Falsy when there are none: the caller gates the wrapper span on this, and
  // html`` yields a String object, which is truthy even when blank.
  return parts.length ? html`${parts}` : '';
}

export function renderUnfiledGroup(unfiledTags, view) {
  const { unfiledExpanded, selectMode } = view;
  const n = unfiledTags.length;
  const rows = unfiledTags.map(tag => html`
      <li class="tm-node tm-unfiled-node" data-id="${tag.id}">
        <div class="tm-row${view.selectedIds.has(tag.id) ? ' is-selected' : ''}" draggable="${selectMode ? 'false' : 'true'}" data-id="${tag.id}" data-parent-id="">
          <span class="tm-toggle-spacer"></span>
          ${renderSelectCheckbox(tag, selectMode, view.selectedIds.has(tag.id))}
          <span class="tm-toggle-spacer"></span>
          <div class="tm-node-body">
            <span class="tm-tag-name">${tag.name}</span>
            <code class="tm-slug-inline">${tag.slug}</code>
          </div>
          <span class="tm-row-meta">
            <a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(tag.slug)}" title="View posts tagged ${tag.slug}">${tag.post_count || 0}</a>
          </span>
          <div class="tm-actions">
            <button class="btn btn-sm edit-tag-btn" data-id="${tag.id}" title="Edit">${raw(EDIT_SVG)}</button>
            <button class="btn btn-sm merge-tag-btn" data-id="${tag.id}" title="Merge into…">Merge…</button>
            <button class="btn btn-sm move-tag-btn" data-id="${tag.id}" data-parent-id="" title="Move to parent…">Move…</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${tag.id}" title="Delete">${raw(X_SVG)}</button>
          </div>
        </div>
      </li>`);

  return html`
      <div class="tm-unfiled-group">
        <button type="button" class="tm-unfiled-toggle" id="unfiled-toggle-btn">
          ${raw(unfiledExpanded ? CHEVRON_SVG : CHEVRON_RIGHT_SVG)}
          <span class="tm-unfiled-label">Unfiled <span class="tm-unfiled-count">(${n})</span></span>
        </button>
        ${unfiledExpanded ? html`<ul class="tm-tree level-0 tm-unfiled-list">${rows}</ul>` : ''}
      </div>`;
}
