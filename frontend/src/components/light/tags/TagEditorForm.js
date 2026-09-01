/**
 * TagEditorForm — the markup of the tags manager's Edit/New Tag modal.
 *
 * Pure: builds the form's HTML from a tag and the full tag list, and nothing
 * else. The modal's wiring — auto-slug, collapsible sections, geocode, save,
 * Escape — stays on the page; only the template and the two tree/section
 * renderers it calls live here.
 *
 * All markup is built with the html`` tag, which escapes every interpolation.
 */

import { html, raw } from '../../../utils/helpers.js';

/** The tag's slug rule: lowercase, punctuation dropped, spaces to dashes. */
export function slugifyTagName(text) {
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}


/**
 * Which parents/children the form should open with.
 *
 * Editing starts from the tag's own relations; creating starts from the row
 * the "+" was clicked on, if any. The page keeps a copy to diff against on
 * save, which is why this is separate from the rendering.
 */
export function tagEditorSelection(tag, parentId) {
  const isEdit = !!tag;
  const f = tag || {};
  return {
    selParents: isEdit ? (f.parents || []).map(p => p.id) : (parentId ? [parentId] : []),
    selChildren: isEdit ? (f.children || []).map(c => c.id) : [],
  };
}

/** The whole modal, as a string. `allTags` populates the structure pickers. */
export function renderTagEditorForm({ tag = null, parentId = null, allTags = [] } = {}) {
  const isEdit = !!tag;
  const f = tag || {};
  const selfId = isEdit ? f.id : null;
  const { selParents, selChildren } = tagEditorSelection(tag, parentId);

  const existingLat = f.latitude ?? (f.locations?.[0]?.latitude ?? null);
  const existingLng = f.longitude ?? (f.locations?.[0]?.longitude ?? null);

  const inNav     = f.nav_order != null;
  const navOrder  = f.nav_order ?? '';
  const kind      = f.kind || 'topic';

const _html = [
  '<div class="modal tag-editor-modal" role="dialog" aria-modal="true">',
  '  <button class="modal-close" aria-label="Close">×</button>',
  '  <div class="modal-header">',
  html`    <h3>${isEdit ? html`Edit: ${f.name}` : 'New Tag'}${isEdit ? html` <a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(f.slug || '')}" title="View posts tagged ${f.slug || ''}">${f.post_count || 0}</a>` : ''}</h3>`,
  '  </div>',
  '  <form id="tag-editor-form">',
  '    <div class="modal-body">',

  // — Identity —
  '      <div class="title-row">',
  html`        <input type="text" name="name" class="form-input editor-title" placeholder="Tag name" value="${f.name || ''}" required>`,
  '      </div>',
  '      <div class="slug-row">',
  '        <span class="slug-prefix">/tags/</span>',
  html`        <input type="text" name="slug" id="modal-slug" class="form-input editor-slug" placeholder="tag-slug" value="${f.slug || ''}" spellcheck="false">`,
  '      </div>',
  '      <div class="form-group">',
  html`        <textarea name="description" class="form-input editor-excerpt" rows="2" placeholder="Tag description…">${f.description || ''}</textarea>`,
  '      </div>',

  // — Visibility —
  '      <div class="tm-collapsible-section">',
  '        <button type="button" class="tm-section-toggle" data-target="visibility-body">',
  '          <span class="tm-section-arrow">▶</span> Visibility',
  `          <span class="tm-section-count">${(f.hidden || f.effective_hidden) ? '🚫' : ''}</span>`,
  '        </button>',
  '        <div class="tm-section-body hidden" id="visibility-body">',
  renderVisibilitySection(f),
  '        </div>',
  '      </div>',

  // — Display —
  '      <div class="tm-collapsible-section">',
  '        <button type="button" class="tm-section-toggle" data-target="display-body">',
  '          <span class="tm-section-arrow">▶</span> Display',
  `          <span class="tm-section-count">${inNav ? '⌂' : ''}</span>`,
  '        </button>',
  '        <div class="tm-section-body hidden" id="display-body">',
  `          <label class="tm-flag-row">`,
  `            <input type="checkbox" name="in_nav" id="in-nav-check"${inNav ? ' checked' : ''}>`,
  `            In public navigation`,
  `          </label>`,
  `          <div class="tm-nav-order-row${inNav ? '' : ' hidden'}" id="nav-order-row">`,
  `            <span class="slug-prefix">Position</span>`,
  html`            <input type="number" name="nav_order" class="form-input editor-slug" min="0" step="1" value="${String(navOrder)}" placeholder="1, 2, 3…">`,
  `          </div>`,
  `          <label class="tm-flag-row">`,
  `            <input type="checkbox" name="in_breadcrumbs"${f.in_breadcrumbs ? ' checked' : ''}>`,
  `            In breadcrumbs`,
  `          </label>`,
  `          <label class="tm-flag-row">`,
  `            <input type="checkbox" name="show_related"${f.show_related ? ' checked' : ''}>`,
  `            Show related tags`,
  `          </label>`,
  `          <label class="tm-flag-row">`,
  `            <input type="checkbox" name="in_ancestor_flyout"${(isEdit ? f.in_ancestor_flyout : true) ? ' checked' : ''}>`,
  `            Show in ancestor flyout`,
  `          </label>`,
  '        </div>',
  '      </div>',

  // — Kind —
  '      <div class="tm-collapsible-section">',
  '        <button type="button" class="tm-section-toggle" data-target="kind-body">',
  '          <span class="tm-section-arrow">▶</span> Kind',
  `          <span class="tm-section-count">${kind !== 'topic' ? kind : ''}</span>`,
  '        </button>',
  '        <div class="tm-section-body hidden" id="kind-body">',
  `          <label class="tm-flag-row"><input type="radio" name="kind" value="topic"${kind === 'topic' ? ' checked' : ''}> Topic</label>`,
  `          <label class="tm-flag-row"><input type="radio" name="kind" value="year"${kind === 'year' ? ' checked' : ''}> Year <span class="form-hint">(slug must be a 4-digit year)</span></label>`,
  '        </div>',
  '      </div>',

  // — Structure —
  '      <div class="tm-collapsible-section">',
  '        <button type="button" class="tm-section-toggle" data-target="structure-body">',
  `          <span class="tm-section-arrow">▶</span> Structure`,
  `          <span class="tm-section-count">${selParents.length > 0 ? selParents.length + ' parents' : ''}</span>`,
  '        </button>',
  '        <div class="tm-section-body hidden" id="structure-body">',
  '          <p class="tm-section-label">Parents</p>',
  '          <input type="text" class="form-input tm-toggle-search" placeholder="Search tags…" autocomplete="off">',
  '          <div class="tag-toggles-container">',
  renderTagToggles('parent_ids', allTags, selfId, selParents),
  '          </div>',
  '          <p class="tm-section-label">Children</p>',
  '          <input type="text" class="form-input tm-toggle-search" placeholder="Search tags…" autocomplete="off">',
  '          <div class="tag-toggles-container">',
  renderTagToggles('child_ids', allTags, selfId, selChildren),
  '          </div>',
  '        </div>',
  '      </div>',

  // — Coordinates —
  '      <div class="tm-collapsible-section">',
  '        <button type="button" class="tm-section-toggle" data-target="coords-body">',
  `          <span class="tm-section-arrow">▶</span> Coordinates`,
  `          <span class="tm-section-count">${existingLat != null ? '📍' : ''}</span>`,
  '        </button>',
  '        <div class="tm-section-body hidden" id="coords-body">',
  '          <div class="input-with-btn">',
  `            <input type="text" id="coordinates-input" class="form-input" placeholder="Paste a Maps link, “45.507° N, 73.554° W”, or leave blank to geocode by name">`,
  `            <button type="button" id="gmaps-parse-btn" class="btn btn-secondary">${isEdit ? 'Parse / Geocode' : 'Parse'}</button>`,
  '          </div>',
  '          <div class="slug-row">',
  '            <span class="slug-prefix">Lat</span>',
  `            <input type="number" name="latitude" id="coord-lat" class="form-input editor-slug" step="any" value="${existingLat != null ? existingLat : ''}" placeholder="e.g. 48.8566">`,
  '          </div>',
  '          <div class="slug-row">',
  '            <span class="slug-prefix">Lng</span>',
  `            <input type="number" name="longitude" id="coord-lng" class="form-input editor-slug" step="any" value="${existingLng != null ? existingLng : ''}" placeholder="e.g. 2.3522">`,
  '          </div>',
  '          <p class="form-hint">Leave blank to remove coordinates.</p>',
  '        </div>',
  '      </div>',

  '    </div>',
  '    <div class="modal-footer">',
  '      <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>',
  `      <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Tag'}</button>`,
  '    </div>',
  '  </form>',
  '</div>',
];

  // Every line is html`` output; raw() covers only the join that turns the
  // array back into one string, so the caller gets markup, not a bare string.
  // Every line is html`` output; raw() covers only the join that turns the
  // array back into one string.
  // eslint-disable-next-line no-restricted-syntax
  return raw(_html.join('\n'));
}

export function renderVisibilitySection(f) {
  const isEffectivelyHidden = f.effective_hidden && !f.hidden;
  const hiddenViaAncestor = isEffectivelyHidden && f.hidden_via
    ? html`<span class="tm-inherited-chip">inherited — <button type="button" class="tm-badge-via-btn" data-open-tag-id="${f.hidden_via}">change at ancestor</button></span>`
    : (isEffectivelyHidden ? html`<span class="tm-inherited-chip">inherited from ancestor</span>` : '');

  // Every line is html`` output; raw() covers only the join below.
  // eslint-disable-next-line no-restricted-syntax
  return raw([
    html`<label class="tm-flag-row">`,
    html`  <input type="checkbox" name="hidden"${f.hidden ? raw(' checked') : ''}>`,
    html`  Hidden (from public tag cloud and tag pages)`,
    html`</label>`,
    hiddenViaAncestor,
    html`<label class="tm-flag-row">`,
    html`  <input type="checkbox" name="hides_posts"${f.hides_posts ? raw(' checked') : ''}>`,
    html`  Hide posts (all posts with this tag are hidden from public)`,
    html`</label>`,
  ].join('\n'));
}


/** Render tag-badge toggle checkboxes for parent/children selection. */
export function renderTagToggles(inputName, allTags, selfId, selectedIds) {
  const available = allTags.filter(t => t.id !== selfId);
  if (!available.length) return '<span class="tag-toggles-empty">No other tags available.</span>';

  const selectedSet = new Set(selectedIds);
  const treeById = new Map(available.map(t => [t.id, t]));

  const childrenOf = new Map();
  available.forEach(t => {
    (t.parents || []).forEach(p => {
      if (treeById.has(p.id)) {
        if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
        childrenOf.get(p.id).push(t);
      }
    });
  });

  const roots = available
    .filter(t => !(t.parents || []).some(p => treeById.has(p.id)))
    .sort((a, b) => {
      const ao = a.nav_order ?? Infinity;
      const bo = b.nav_order ?? Infinity;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });

  const hasCheckedDesc = new Set();
  const visiting = new Set();
  const markDesc = (id) => {
    if (visiting.has(id)) return selectedSet.has(id);
    visiting.add(id);
    let anyChecked = selectedSet.has(id);
    for (const kid of (childrenOf.get(id) || [])) { if (markDesc(kid.id)) anyChecked = true; }
    if (anyChecked && !selectedSet.has(id)) hasCheckedDesc.add(id);
    return anyChecked;
  };
  roots.forEach(r => markDesc(r.id));

  const rendered = new Set();
  const renderNode = (t, level) => {
    if (rendered.has(t.id)) return '';
    rendered.add(t.id);
    const kids = (childrenOf.get(t.id) || [])
      .sort((a, b) => {
        const ao = a.sort_order ?? Infinity;
        const bo = b.sort_order ?? Infinity;
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      });
    const hasKids = kids.length > 0;
    const expanded = hasCheckedDesc.has(t.id);
    const nodeId = `tt-${inputName}-${t.id}`;
    const toggleBtn = hasKids
      ? html`<button type="button" class="tag-toggle-btn" data-tt-toggle="${nodeId}" aria-expanded="${expanded}">${expanded ? '▼' : '▶'}</button>`
      : html`<span class="tag-toggle-btn-spacer"></span>`;
    const childList = hasKids
      ? html`<ul class="tag-toggle-tree level-${level + 1}${expanded ? '' : ' hidden'}" id="${nodeId}">${kids.map(k => renderNode(k, level + 1))}</ul>`
      : '';
    // Indentation inside this literal is part of the emitted HTML — keep it
    // as-is rather than reflowing it to match the surrounding code.
    return html`<li class="tag-toggle-node">
        <div class="tag-toggle-row">
          ${toggleBtn}
          <label class="tag-toggle">
            <input type="checkbox" name="${inputName}" value="${t.id}"${selectedSet.has(t.id) ? raw(' checked') : ''}>
            <span>${t.name}</span>
          </label>
        </div>
        ${childList}
      </li>`;
  };

  const treeInner = roots.map(r => renderNode(r, 0));
  return treeInner.length
    ? html`<ul class="tag-toggle-tree level-0">${treeInner}</ul>`
    : html`<span class="tag-toggles-empty">No other tags available.</span>`;
}

