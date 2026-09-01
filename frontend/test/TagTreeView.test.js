import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  buildTagTree,
  renderTagForest as _renderTagForest,
  renderTagTree as _renderTagTree,
  renderTagNode as _renderTagNode,
  renderSelectCheckbox as _renderSelectCheckbox,
  renderRowBadges as _renderRowBadges,
  renderUnfiledGroup as _renderUnfiledGroup,
} from '../src/components/light/tags/TagTreeView.js';

// The renderers return the RawHtml html`` produces — a String object, which
// assert.match and friends will not take. Every assertion below wants the
// primitive, so the wrappers do that once here rather than at each call.
const renderTagForest = (...a) => String(_renderTagForest(...a));
const renderTagTree = (...a) => String(_renderTagTree(...a));
const renderTagNode = (...a) => String(_renderTagNode(...a));
const renderSelectCheckbox = (...a) => String(_renderSelectCheckbox(...a));
const renderRowBadges = (...a) => String(_renderRowBadges(...a));
const renderUnfiledGroup = (...a) => String(_renderUnfiledGroup(...a));

// No DOM stubs: TagTreeView is pure string rendering, which is the point of
// having it out of the page.
const view = (over = {}) => ({
  expanded: new Set(),
  unfiledExpanded: false,
  selectMode: false,
  selectedIds: new Set(),
  ...over,
});

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), post_count: 0, parents: [], ...over,
});

describe('buildTagTree', () => {
  test('splits parentless tags into nav roots, filed roots and unfiled', () => {
    const { navRoots, otherRoots, unfiled } = buildTagTree([
      tag(1, 'Travel', { nav_order: 0 }),
      tag(2, 'Art'),
      tag(3, 'France', { parents: [{ id: 2, name: 'Art' }] }),
      tag(4, 'Loose'),
    ]);

    assert.deepEqual(navRoots.map(t => t.id), [1], 'nav_order tag is a nav root');
    assert.deepEqual(otherRoots.map(t => t.id), [2], 'parentless tag with children is a filed root');
    assert.deepEqual(unfiled.map(t => t.id), [4], 'parentless and childless is unfiled');
  });

  test('orders nav roots by nav_order, not by name', () => {
    const { navRoots } = buildTagTree([
      tag(1, 'Zebra', { nav_order: 0 }),
      tag(2, 'Apple', { nav_order: 5 }),
      tag(3, 'Mango', { nav_order: 2 }),
    ]);
    assert.deepEqual(navRoots.map(t => t.name), ['Zebra', 'Mango', 'Apple']);
  });

  test('nav_order 0 is a nav root, not unfiled', () => {
    // `nav_order != null` rather than a truthiness check — 0 is a real position.
    const { navRoots, unfiled } = buildTagTree([tag(1, 'First', { nav_order: 0 })]);
    assert.deepEqual(navRoots.map(t => t.id), [1]);
    assert.equal(unfiled.length, 0);
  });

  test('sorts children by sort_order, falling back to name on ties', () => {
    const parent = { id: 1, name: 'Travel' };
    const { otherRoots } = buildTagTree([
      tag(1, 'Travel'),
      tag(2, 'Zulu', { parents: [parent], sort_order: 1 }),
      tag(3, 'Alpha', { parents: [parent], sort_order: 1 }),
      tag(4, 'Beta', { parents: [parent], sort_order: 0 }),
      tag(5, 'NoOrder', { parents: [parent] }),
    ]);
    // sort_order 0, then the 1s alphabetically, then the undefined (Infinity) last.
    assert.deepEqual(
      otherRoots[0].childrenNodes.map(c => c.name),
      ['Beta', 'Alpha', 'Zulu', 'NoOrder'],
    );
  });

  test('a multi-parent tag is nested under each of its parents', () => {
    const { otherRoots } = buildTagTree([
      tag(1, 'Travel'),
      tag(2, 'Art'),
      tag(3, 'Paris', { parents: [{ id: 1, name: 'Travel' }, { id: 2, name: 'Art' }] }),
    ]);
    const under = Object.fromEntries(
      otherRoots.map(r => [r.name, r.childrenNodes.map(c => c.name)]),
    );
    assert.deepEqual(under, { Art: ['Paris'], Travel: ['Paris'] });
  });

  test('a parent cycle terminates instead of recursing forever', () => {
    const { navRoots } = buildTagTree([
      tag(1, 'A', { nav_order: 0, parents: [] }),
      tag(2, 'B', { parents: [{ id: 1, name: 'A' }] }),
      tag(3, 'C', { parents: [{ id: 2, name: 'B' }] }),
      // C is also declared a parent of B — B must not be re-expanded under C.
      tag(4, 'B2', { parents: [{ id: 3, name: 'C' }] }),
    ]);
    const depth = n => 1 + Math.max(0, ...n.childrenNodes.map(depth));
    assert.equal(depth(navRoots[0]), 4);
  });

  test('a self-referencing tag does not become its own child', () => {
    const { navRoots } = buildTagTree([tag(1, 'Self', { nav_order: 0, parents: [{ id: 1, name: 'Self' }] })]);
    // It has a parent, so it is not parentless — nothing is rendered as a root.
    assert.equal(navRoots.length, 0);
  });

  test('ignores parent references to tags that are not in the list', () => {
    const { navRoots, otherRoots, unfiled } = buildTagTree([
      tag(1, 'Orphan', { parents: [{ id: 999, name: 'Gone' }] }),
    ]);
    // Still has a parents entry, so it is not top-level anywhere.
    assert.deepEqual([navRoots.length, otherRoots.length, unfiled.length], [0, 0, 0]);
  });

  test('handles a tag with no parents key at all', () => {
    const { unfiled } = buildTagTree([{ id: 1, name: 'Bare', slug: 'bare' }]);
    assert.deepEqual(unfiled.map(t => t.id), [1]);
  });

  test('returns empty buckets for an empty tag list', () => {
    assert.deepEqual(buildTagTree([]), { navRoots: [], otherRoots: [], unfiled: [] });
  });
});

describe('renderRowBadges', () => {
  test('renders the nav badge with its position', () => {
    const html = renderRowBadges(tag(1, 'Travel', { nav_order: 3 }));
    assert.match(html, /tm-badge-nav/);
    assert.match(html, /position 3/);
  });

  test('an explicitly hidden tag wins over an inherited one', () => {
    const html = renderRowBadges(tag(1, 'X', { hidden: true, effective_hidden: true, hidden_via: 9 }));
    assert.match(html, /tm-badge-hidden/);
    assert.doesNotMatch(html, /tm-badge-inherited/);
  });

  test('inherited hidden links back to the ancestor that caused it', () => {
    const html = renderRowBadges(tag(1, 'X', { effective_hidden: true, hidden_via: 9 }));
    assert.match(html, /tm-badge-inherited/);
    assert.match(html, /data-open-tag-id="9"/);
  });

  test('inherited hidden without a known ancestor has no button', () => {
    const html = renderRowBadges(tag(1, 'X', { effective_hidden: true }));
    assert.match(html, /tm-badge-inherited/);
    assert.doesNotMatch(html, /tm-badge-via-btn/);
  });

  test('year and location badges render', () => {
    assert.match(renderRowBadges(tag(1, 'Y', { kind: 'year' })), /tm-badge-year/);
    assert.match(renderRowBadges(tag(1, 'P', { locations: [{ latitude: 1, longitude: 2 }] })), /tm-badge-coords/);
  });

  test('no location badge for an empty locations array', () => {
    assert.doesNotMatch(renderRowBadges(tag(1, 'P', { locations: [] })), /tm-badge-coords/);
  });

  test('multi-parent badge counts parents and names the extras', () => {
    const html = renderRowBadges(tag(1, 'Paris', {
      parents: [{ id: 2, name: 'Travel' }, { id: 3, name: 'Art' }, { id: 4, name: 'Food' }],
    }));
    assert.match(html, /3 parents/);
    assert.match(html, /Also under: Art, Food/, 'lists every parent but the first');
  });

  test('a single parent gets no multi-parent badge', () => {
    assert.doesNotMatch(renderRowBadges(tag(1, 'X', { parents: [{ id: 2, name: 'T' }] })), /tm-badge-multi/);
  });

  test('a plain tag gets no badges', () => {
    assert.equal(renderRowBadges(tag(1, 'Plain')), '');
  });

  test('escapes parent names in the multi-parent tooltip', () => {
    const html = renderRowBadges(tag(1, 'X', {
      parents: [{ id: 2, name: 'ok' }, { id: 3, name: '"><script>alert(1)</script>' }],
    }));
    assert.doesNotMatch(html, /<script>/i);
    assert.match(html, /&lt;script&gt;/i);
  });
});

describe('renderSelectCheckbox', () => {
  test('renders nothing outside select mode', () => {
    assert.equal(renderSelectCheckbox(tag(1, 'X'), false, false), '');
  });

  test('reflects the checked state and labels the tag', () => {
    const on = renderSelectCheckbox(tag(1, 'Travel'), true, true);
    assert.match(on, / checked/);
    assert.match(on, /aria-label="Select Travel"/);
    assert.doesNotMatch(renderSelectCheckbox(tag(1, 'Travel'), true, false), / checked/);
  });

  test('escapes the tag name in the aria-label', () => {
    const html = renderSelectCheckbox(tag(1, '"evil"'), true, false);
    assert.doesNotMatch(html, /aria-label="Select "evil""/);
    assert.match(html, /&quot;evil&quot;/);
  });
});

describe('renderTagNode', () => {
  const node = (over = {}) => ({ ...tag(1, 'Travel'), childrenNodes: [], ...over });

  test('a childless node gets a spacer, not a toggle', () => {
    const html = renderTagNode(node(), 0, null, view());
    assert.doesNotMatch(html, /tm-toggle"/);
    assert.match(html, /tm-toggle-spacer/);
  });

  test('a node with children gets a toggle button', () => {
    const html = renderTagNode(node({ childrenNodes: [node({ id: 2, name: 'Paris' })] }), 0, null, view());
    assert.match(html, /class="tm-toggle" data-id="1"/);
  });

  test('children are only rendered while expanded', () => {
    const parent = node({ childrenNodes: [node({ id: 2, name: 'Paris' })] });
    assert.doesNotMatch(renderTagNode(parent, 0, null, view()), /Paris/);
    assert.match(renderTagNode(parent, 0, null, view({ expanded: new Set([1]) })), /Paris/);
  });

  test('expanding a childless node renders no child list', () => {
    assert.doesNotMatch(renderTagNode(node(), 0, null, view({ expanded: new Set([1]) })), /<ul/);
  });

  test('rows are draggable normally and locked down in select mode', () => {
    assert.match(renderTagNode(node(), 0, null, view()), /draggable="true"/);
    assert.match(renderTagNode(node(), 0, null, view({ selectMode: true })), /draggable="false"/);
  });

  test('a selected row is marked', () => {
    const html = renderTagNode(node(), 0, null, view({ selectMode: true, selectedIds: new Set([1]) }));
    assert.match(html, /tm-row is-selected/);
  });

  test('a null parent renders an empty data-parent-id', () => {
    assert.match(renderTagNode(node(), 0, null, view()), /data-parent-id=""/);
  });

  test('a parent id is carried onto the row and the move button', () => {
    const html = renderTagNode(node(), 1, 7, view());
    assert.match(html, /class="tm-row" draggable="true" data-id="1" data-parent-id="7"/);
    assert.match(html, /move-tag-btn"\s+data-id="1" data-parent-id="7"/);
  });

  test('parent id 0 is preserved rather than blanked', () => {
    assert.match(renderTagNode(node(), 1, 0, view()), /data-parent-id="0"/);
  });

  test('escapes the tag name and url-encodes the slug', () => {
    const html = renderTagNode(node({ name: '<b>x</b>', slug: 'a b&c' }), 0, null, view());
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /search=a%20b%26c/);
  });

  test('a missing post_count renders as 0', () => {
    assert.match(renderTagNode(node({ post_count: undefined }), 0, null, view()), />0<\/a>/);
  });
});

describe('renderTagTree', () => {
  test('an empty top level reports the empty state', () => {
    assert.match(renderTagTree([], 0, null, view()), /No tags found/);
  });

  test('an empty nested level renders nothing', () => {
    assert.equal(renderTagTree([], 2, 5, view()), '');
  });

  test('carries the level and parent id onto the list', () => {
    const nodes = [{ ...tag(1, 'A'), childrenNodes: [] }];
    assert.match(renderTagTree(nodes, 2, 9, view()), /class="tm-tree level-2" data-parent-id="9"/);
  });

  test('a null parent id renders empty', () => {
    const nodes = [{ ...tag(1, 'A'), childrenNodes: [] }];
    assert.match(renderTagTree(nodes, 0, null, view()), /data-parent-id=""/);
  });
});

describe('renderUnfiledGroup', () => {
  const tags = [tag(1, 'Alpha'), tag(2, 'Beta')];

  test('shows the count and stays collapsed by default', () => {
    const html = renderUnfiledGroup(tags, view());
    assert.match(html, /\(2\)/);
    assert.doesNotMatch(html, /tm-unfiled-list/, 'rows are not rendered while collapsed');
  });

  test('renders rows once expanded', () => {
    const html = renderUnfiledGroup(tags, view({ unfiledExpanded: true }));
    assert.match(html, /tm-unfiled-list/);
    assert.match(html, /Alpha/);
    assert.match(html, /Beta/);
  });

  test('unfiled rows carry an empty parent id and no add-child action', () => {
    const html = renderUnfiledGroup([tag(1, 'Alpha')], view({ unfiledExpanded: true }));
    assert.match(html, /data-parent-id=""/);
    assert.doesNotMatch(html, /add-child-btn/, 'unfiled rows cannot take children');
  });

  test('honours select mode', () => {
    const html = renderUnfiledGroup(tags, view({ unfiledExpanded: true, selectMode: true, selectedIds: new Set([2]) }));
    assert.match(html, /tm-select-cb/);
    assert.match(html, /draggable="false"/);
    assert.equal((html.match(/is-selected/g) || []).length, 1);
  });

  test('escapes name and slug', () => {
    const html = renderUnfiledGroup([tag(1, 'X', { name: '<i>x</i>', slug: '<s>' })], view({ unfiledExpanded: true }));
    assert.doesNotMatch(html, /<i>x<\/i>/);
    assert.match(html, /&lt;s&gt;/);
  });
});

describe('renderTagForest', () => {
  test('reports the empty state when every bucket is empty', () => {
    assert.match(renderTagForest({ navRoots: [], otherRoots: [], unfiled: [] }, view()), /No tags found/);
  });

  test('renders nav roots and filed roots as separate top-level lists', () => {
    const forest = buildTagTree([
      tag(1, 'Travel', { nav_order: 0 }),
      tag(2, 'Art'),
      tag(3, 'Paris', { parents: [{ id: 2, name: 'Art' }] }),
    ]);
    const html = renderTagForest(forest, view());
    assert.equal((html.match(/class="tm-tree level-0"/g) || []).length, 2);
    assert.match(html, /tm-tree-root/);
  });

  test('appends the unfiled group only when something is unfiled', () => {
    const withUnfiled = buildTagTree([tag(1, 'Travel', { nav_order: 0 }), tag(2, 'Loose')]);
    assert.match(renderTagForest(withUnfiled, view()), /tm-unfiled-group/);

    const without = buildTagTree([tag(1, 'Travel', { nav_order: 0 })]);
    assert.doesNotMatch(renderTagForest(without, view()), /tm-unfiled-group/);
  });

  test('a forest of only unfiled tags still renders', () => {
    const forest = buildTagTree([tag(1, 'Loose'), tag(2, 'Also')]);
    const html = renderTagForest(forest, view({ unfiledExpanded: true }));
    assert.doesNotMatch(html, /No tags found/);
    assert.match(html, /Loose/);
  });
});
