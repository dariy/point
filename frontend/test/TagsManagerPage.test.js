import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// These assertions target the extracted modules directly rather than through
// the page — the page no longer wraps them.
import { buildTagTree, renderTagForest, renderTagNode, renderRowBadges } from '../src/components/light/tags/TagTreeView.js';
import { matchesListFilter, renderFilterChips } from '../src/components/light/tags/TagListView.js';

/** The view descriptor the TagTreeView renderers take in place of page state. */
const treeView = (over = {}) => ({
  expanded: new Set(), unfiledExpanded: false, selectMode: false, selectedIds: new Set(), ...over,
});

describe('TagsManagerPage', () => {
  let TagsManagerPage;

  before(async () => {
    global.document = {
      createElement: () => ({
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => []
    };
    global.window = {
      location: { pathname: '', search: '' },
      history: { replaceState: () => {}, pushState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    const storeMod = await import('../src/store.js');
    global.store = storeMod.store;

    const mod = await import('../src/pages/light/TagsManagerPage.js');
    TagsManagerPage = mod.default;
  });

  test('should render descriptive map link in list view when tag has location', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'list';
    page.state.tags = [
      { id: 1, name: 'Paris', slug: 'paris', locations: [{ latitude: 48, longitude: 2 }], post_count: 5 }
    ];

    const html = page.render();
    assert.ok(html.includes('/map?tag=paris'), 'Link to map should be present');
    assert.ok(html.includes('tm-flag-link'), 'tm-flag-link class should be present');
    assert.ok(html.includes('Map</span>'), 'Map label should be present');
  });

  test('should render static map icon in list view when tag has NO location', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'list';
    page.state.tags = [
      { id: 2, name: 'NoLoc', slug: 'noloc', locations: [], post_count: 0 }
    ];

    const html = page.render();
    assert.ok(!html.includes('/map?tag=noloc'), 'Link to map should NOT be present');
    assert.ok(html.includes('tm-flag-static'), 'tm-flag-static class should be present');
    assert.ok(!html.includes('Map</span>'), 'Map label should NOT be present');
  });

  test('list view wraps actions in a swipe panel and tags the collapsible columns', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'list';
    page.state.tags = [
      { id: 1, name: 'Paris', slug: 'paris', locations: [], post_count: 5, parents: [] }
    ];

    const html = page.render();
    // The mobile drawer is positioned against the row, so the buttons need a
    // wrapper inside the cell rather than living on the <td> itself.
    assert.ok(html.includes('<td class="tm-actions-cell">'), 'actions cell should carry tm-actions-cell');
    assert.ok(/tm-actions-cell">\s*<div class="tm-actions">/.test(html), 'actions should be wrapped in .tm-actions');
    // Columns the mobile layout drops so the row fits without horizontal scroll
    assert.ok(html.includes('tm-col-slug'), 'slug column should be tagged');
    assert.ok(html.includes('tm-col-coords'), 'coordinates column should be tagged');
    assert.ok(html.includes('tm-col-parents'), 'parents column should be tagged');
  });

  test('select mode adds checkboxes and a bulk toolbar in list view', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'list';
    page.state.tags = [
      { id: 1, name: 'Paris', slug: 'paris', locations: [], post_count: 5, parents: [] },
      { id: 2, name: 'Lyon', slug: 'lyon', locations: [], post_count: 1, parents: [] }
    ];

    assert.ok(!page.render().includes('tm-bulk-toolbar'), 'no toolbar when select mode is off');

    page.state.selectMode = true;
    page.state.selectedIds = new Set([2]);
    const html = page.render();
    assert.ok(html.includes('tm-bulk-toolbar'), 'bulk toolbar should be rendered');
    assert.ok(html.includes('tm-select-all-cb'), 'select-all checkbox should be present');
    assert.ok(html.includes('<td class="tm-check-col">'), 'rows get a checkbox cell');
    assert.ok(/data-id="2"[^>]* checked/.test(html), 'the selected row is checked');
    assert.ok(html.includes('is-selected'), 'the selected row is marked');
  });

  test('select mode adds checkboxes and suspends drag in tree view', () => {
    const container = {};
    const node = { id: 1, name: 'Travel', slug: 'travel', parents: [], childrenNodes: [], post_count: 3 };

    const html = renderTagNode(node, 0, null, treeView({ selectMode: true, selectedIds: new Set([1]) }));
    assert.ok(html.includes('tm-select-cb'), 'tree row gets a checkbox');
    assert.ok(html.includes('draggable="false"'), 'drag is suspended while selecting');
    assert.ok(html.includes('is-selected'), 'selected row is marked');
  });

  test('list filter predicate matches name, slug and parent name', () => {
    const container = {};
    const tag = { id: 1, name: 'Kyoto', slug: 'kyoto-jp', parents: [{ id: 9, name: 'Japan' }] };

    assert.ok(matchesListFilter(tag, { search: 'kyo' }), 'matches on name');
    assert.ok(matchesListFilter(tag, { search: 'jp' }), 'matches on slug');
    assert.ok(matchesListFilter(tag, { search: 'japan' }), 'matches on parent name');
    assert.ok(!matchesListFilter(tag, { search: 'lisbon' }), 'rejects a non-match');

    assert.ok(matchesListFilter(tag, { filterParents: [{ id: 9, name: 'Japan' }] }), 'matches an active parent chip');
    assert.ok(!matchesListFilter(tag, { filterParents: [{ id: 7, name: 'Peru' }] }), 'rejects a parent chip it lacks')
  });

  test('re-rendered chips keep the shape renderTagList painted', () => {
    const chipsEl = { innerHTML: '', querySelectorAll: () => [] };
    const container = { querySelector: sel => (sel === '#tm-filter-chips' ? chipsEl : null) };
    const page = new TagsManagerPage(container);
    page._listFilterParents = [{ id: 9, name: 'Japan' }];

    page._updateFilterChips();
    assert.equal(chipsEl.innerHTML, renderFilterChips(page._listFilterParents));
    assert.match(String(chipsEl.innerHTML), /<svg/, 'the × icon survives a re-render');
  });

  test('should render tree with nav root when tag has nav_order', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'tree';
    page.state.tags = [
      { id: 1, name: 'Travel', slug: 'travel', nav_order: 1, parents: [], children: [], post_count: 3 },
    ];

    const { navRoots, otherRoots, unfiled } = buildTagTree(page.state.tags);
    assert.equal(navRoots.length, 1, 'nav tag should appear as nav root');
    assert.equal(otherRoots.length, 0);
    assert.equal(unfiled.length, 0);

    const html = renderTagForest({ navRoots, otherRoots, unfiled }, treeView());
    assert.ok(html.includes('Travel'), 'Tag name should appear in tree');
    assert.ok(html.includes('tm-badge-nav'), 'Nav badge should be present');
    assert.ok(html.includes('⌂ nav'), 'Nav badge text should be present');
  });

  test('should show unfiled group for parentless non-nav tags with no children', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.tags = [
      { id: 1, name: 'Orphan', slug: 'orphan', parents: [], children: [], post_count: 0 },
    ];

    const { navRoots, otherRoots, unfiled } = buildTagTree(page.state.tags);
    assert.equal(navRoots.length, 0);
    assert.equal(otherRoots.length, 0);
    assert.equal(unfiled.length, 1, 'parentless non-nav tag should appear in unfiled');
    assert.equal(unfiled[0].slug, 'orphan');
  });

  test('should show parentless tag with children as other root (not unfiled)', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.tags = [
      { id: 1, name: 'Root', slug: 'root', parents: [], children: [{ id: 2, name: 'Child', slug: 'child' }], post_count: 0 },
      { id: 2, name: 'Child', slug: 'child', parents: [{ id: 1, name: 'Root', slug: 'root' }], children: [], post_count: 0 },
    ];

    const { navRoots, otherRoots, unfiled } = buildTagTree(page.state.tags);
    assert.equal(navRoots.length, 0);
    assert.equal(otherRoots.length, 1, 'parentless tag with children should be other root');
    assert.equal(unfiled.length, 0, 'tag with children should not appear in unfiled');
  });

  test('should render nav badge for tag with nav_order in tree', () => {
    const node = { id: 1, name: 'Nav', slug: 'nav', nav_order: 2, parents: [], children: [], childrenNodes: [], post_count: 0 };
    const badges = renderRowBadges(node);
    assert.ok(badges.includes('tm-badge-nav'), 'Should have nav badge class');
    assert.ok(badges.includes('⌂ nav'), 'Should have nav badge text');
  });

  test('should render hidden badge for tag with hidden=true', () => {
    const node = { id: 1, name: 'Secret', slug: 'secret', hidden: true, parents: [], childrenNodes: [], post_count: 0 };
    const badges = renderRowBadges(node);
    assert.ok(badges.includes('tm-badge-hidden'), 'Should have hidden badge class');
    assert.ok(badges.includes('🚫 hidden'), 'Should have hidden badge text');
  });

  test('should render inherited badge for effectively hidden tag when not directly hidden', () => {
    const node = { id: 2, name: 'Child', slug: 'child', hidden: false, effective_hidden: true, hidden_via: 1, parents: [{ id: 1 }], childrenNodes: [], post_count: 0 };
    const badges = renderRowBadges(node);
    assert.ok(badges.includes('tm-badge-inherited'), 'Should have inherited badge class');
    assert.ok(!badges.includes('tm-badge-hidden'), 'Should not have direct hidden badge');
  });

  test('should render year badge for kind=year tag', () => {
    const node = { id: 1, name: '2023', slug: '2023', kind: 'year', parents: [], childrenNodes: [], post_count: 5 };
    const badges = renderRowBadges(node);
    assert.ok(badges.includes('tm-badge-year'), 'Should have year badge class');
    assert.ok(badges.includes('📅 year'), 'Should have year badge text');
  });

  test('should render coordinates badge for tag with location in tree', () => {
    const node = { id: 1, name: 'Paris', slug: 'paris', locations: [{ latitude: 48, longitude: 2 }], parents: [], childrenNodes: [], post_count: 0 };
    const badges = renderRowBadges(node);
    assert.ok(badges.includes('tm-badge-coords'), 'Should have coords badge class');
    assert.ok(badges.includes('/map?tag=paris'), 'Should link to map');
  });

  test('should render multi-parent badge when tag has multiple parents', () => {
    const node = {
      id: 3, name: 'Multi', slug: 'multi',
      parents: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
      childrenNodes: [], post_count: 0
    };
    const badges = renderRowBadges(node);
    assert.ok(badges.includes('tm-badge-multi'), 'Should have multi-parent badge class');
    assert.ok(badges.includes('⎇'), 'Should have multi-parent symbol');
  });
});
