import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  renderTagEditorForm,
  renderVisibilitySection,
  renderTagToggles,
  slugifyTagName,
  tagEditorSelection,
} from '../src/components/light/tags/TagEditorForm.js';

// Pure module — no DOM stubs.
const tag = (id, name, over = {}) => ({ id, name, slug: name.toLowerCase(), parents: [], ...over });

describe('slugifyTagName', () => {
  test('lowercases and hyphenates', () => {
    assert.equal(slugifyTagName('Hello World'), 'hello-world');
  });

  test('drops punctuation but keeps existing hyphens', () => {
    assert.equal(slugifyTagName("Foo's Bar!"), 'foos-bar');
    assert.equal(slugifyTagName('already-good'), 'already-good');
  });

  test('collapses runs of spaces and underscores', () => {
    assert.equal(slugifyTagName('a   b'), 'a-b');
    assert.equal(slugifyTagName('a___b'), 'a-b');
    assert.equal(slugifyTagName('a _ b'), 'a-b');
  });

  test('trims leading and trailing hyphens', () => {
    assert.equal(slugifyTagName('  spaced  '), 'spaced');
    assert.equal(slugifyTagName('---x---'), 'x');
  });

  test('an all-punctuation name slugifies to empty', () => {
    assert.equal(slugifyTagName('!!!'), '');
  });

  test('keeps digits', () => {
    assert.equal(slugifyTagName('2024 Trip'), '2024-trip');
  });
});

describe('tagEditorSelection', () => {
  test('editing starts from the tag\'s own relations', () => {
    const t = tag(1, 'X', { parents: [{ id: 2 }, { id: 3 }], children: [{ id: 4 }] });
    assert.deepEqual(tagEditorSelection(t, null), { selParents: [2, 3], selChildren: [4] });
  });

  test('creating under a row preselects that row as the parent', () => {
    assert.deepEqual(tagEditorSelection(null, 7), { selParents: [7], selChildren: [] });
  });

  test('creating from the top selects nothing', () => {
    assert.deepEqual(tagEditorSelection(null, null), { selParents: [], selChildren: [] });
  });

  test('an explicit parent is ignored when editing', () => {
    const t = tag(1, 'X', { parents: [{ id: 2 }] });
    assert.deepEqual(tagEditorSelection(t, 9).selParents, [2], 'the tag\'s own parents win');
  });

  test('handles a tag with no parents or children keys', () => {
    assert.deepEqual(tagEditorSelection({ id: 1, name: 'Bare' }, null), { selParents: [], selChildren: [] });
  });
});

describe('renderVisibilitySection', () => {
  test('reflects the hidden and hides_posts flags', () => {
    const on = renderVisibilitySection({ hidden: true, hides_posts: true });
    assert.equal((on.match(/ checked/g) || []).length, 2);
    assert.doesNotMatch(renderVisibilitySection({}), / checked/);
  });

  test('an explicitly hidden tag shows no inherited chip', () => {
    const html = renderVisibilitySection({ hidden: true, effective_hidden: true, hidden_via: 5 });
    assert.doesNotMatch(html, /tm-inherited-chip/);
  });

  test('inherited hiding offers a jump to the ancestor', () => {
    const html = renderVisibilitySection({ effective_hidden: true, hidden_via: 5 });
    assert.match(html, /tm-inherited-chip/);
    assert.match(html, /data-open-tag-id="5"/);
    assert.match(html, /change at ancestor/);
  });

  test('inherited hiding with no known ancestor is stated but not linked', () => {
    const html = renderVisibilitySection({ effective_hidden: true });
    assert.match(html, /inherited from ancestor/);
    assert.doesNotMatch(html, /tm-badge-via-btn/);
  });
});

describe('renderTagToggles', () => {
  const tags = [
    tag(1, 'Travel', { nav_order: 0 }),
    tag(2, 'France', { parents: [{ id: 1, name: 'Travel' }] }),
    tag(3, 'Japan', { parents: [{ id: 1, name: 'Travel' }] }),
    tag(4, 'Paris', { parents: [{ id: 2, name: 'France' }] }),
    tag(5, 'Loose'),
  ];

  test('excludes the tag being edited from its own picker', () => {
    const html = renderTagToggles('parent_ids', tags, 1, []);
    assert.doesNotMatch(html, /value="1"/);
    assert.match(html, /value="2"/);
  });

  test('reports when there is nothing to choose', () => {
    assert.match(renderTagToggles('parent_ids', [tag(1, 'Only')], 1, []), /No other tags available/);
    assert.match(renderTagToggles('parent_ids', [], null, []), /No other tags available/);
  });

  test('checks exactly the selected ids', () => {
    const html = renderTagToggles('parent_ids', tags, null, [2, 4]);
    assert.equal((html.match(/ checked/g) || []).length, 2);
    assert.match(html, /value="2" checked/);
    assert.match(html, /value="4" checked/);
  });

  test('names every input for the requested field', () => {
    assert.match(renderTagToggles('child_ids', tags, null, []), /name="child_ids"/);
    assert.doesNotMatch(renderTagToggles('child_ids', tags, null, []), /name="parent_ids"/);
  });

  test('nests children under their parent', () => {
    const html = renderTagToggles('parent_ids', tags, null, []);
    assert.match(html, /tag-toggle-tree level-0/);
    assert.match(html, /tag-toggle-tree level-1/);
    assert.match(html, /tag-toggle-tree level-2/, 'Paris sits two levels down');
  });

  test('a branch is pre-expanded only when it contains a checked descendant', () => {
    const collapsed = renderTagToggles('parent_ids', tags, null, []);
    assert.doesNotMatch(collapsed, /aria-expanded="true"/);

    // Paris (4) is checked, so Travel and France must be open to reveal it.
    const expanded = renderTagToggles('parent_ids', tags, null, [4]);
    assert.equal((expanded.match(/aria-expanded="true"/g) || []).length, 2);
  });

  test('a checked node does not force itself open', () => {
    // Travel is checked but has no checked descendant — no need to expand it.
    const html = renderTagToggles('parent_ids', tags, null, [1]);
    assert.doesNotMatch(html, /aria-expanded="true"/);
  });

  test('childless nodes get a spacer instead of a toggle', () => {
    const html = renderTagToggles('parent_ids', [tag(1, 'Solo'), tag(2, 'Other')], null, []);
    assert.match(html, /tag-toggle-btn-spacer/);
    assert.doesNotMatch(html, /tag-toggle-btn"/);
  });

  test('roots are ordered by nav_order then name', () => {
    const roots = [tag(1, 'Zebra', { nav_order: 1 }), tag(2, 'apple'), tag(3, 'Mango', { nav_order: 0 })];
    const html = renderTagToggles('parent_ids', roots, null, []);
    const order = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(order, ['Mango', 'Zebra', 'apple'], 'nav_order first, then the unordered by name');
  });

  test('children are ordered by sort_order then name', () => {
    const t = [
      tag(1, 'Root'),
      tag(2, 'Zulu', { parents: [{ id: 1 }], sort_order: 0 }),
      tag(3, 'Alpha', { parents: [{ id: 1 }], sort_order: 1 }),
    ];
    const html = renderTagToggles('parent_ids', t, null, []);
    const order = [...html.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1]);
    assert.deepEqual(order, ['Root', 'Zulu', 'Alpha'], 'sort_order beats alphabetical');
  });

  test('renders each tag once even when it has several parents', () => {
    const t = [
      tag(1, 'Travel'), tag(2, 'Art'),
      tag(3, 'Paris', { parents: [{ id: 1 }, { id: 2 }] }),
    ];
    const html = renderTagToggles('parent_ids', t, null, []);
    assert.equal((html.match(/value="3"/g) || []).length, 1, 'no duplicate checkbox for the same tag');
  });

  test('a parent cycle terminates', () => {
    const t = [tag(1, 'A', { parents: [{ id: 2 }] }), tag(2, 'B', { parents: [{ id: 1 }] })];
    // Neither is a root (each has a resolvable parent), so nothing renders —
    // but it must not hang or blow the stack getting there.
    assert.match(renderTagToggles('parent_ids', t, null, []), /No other tags available/);
  });

  test('a cycle reachable from a real root still terminates', () => {
    const t = [
      tag(1, 'Root'),
      tag(2, 'A', { parents: [{ id: 1 }, { id: 3 }] }),
      tag(3, 'B', { parents: [{ id: 2 }] }),
    ];
    const html = renderTagToggles('parent_ids', t, null, [3]);
    assert.match(html, /value="3"/);
  });

  test('parent references outside the list do not hide a tag', () => {
    const t = [tag(1, 'Orphan', { parents: [{ id: 999, name: 'Gone' }] })];
    assert.match(renderTagToggles('parent_ids', t, null, []), /value="1"/, 'it is treated as a root');
  });

  test('escapes tag names', () => {
    const html = renderTagToggles('parent_ids', [tag(1, '<script>x</script>'), tag(2, 'b')], null, []);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('renderTagEditorForm', () => {
  const allTags = [tag(1, 'Travel', { nav_order: 0 }), tag(2, 'France', { parents: [{ id: 1 }] })];

  test('a new tag gets the create affordances', () => {
    const html = renderTagEditorForm({ allTags });
    assert.match(html, /New Tag/);
    assert.match(html, /Create Tag/);
    assert.match(html, />Parse</, 'no geocode option before the tag exists');
    assert.doesNotMatch(html, /Parse \/ Geocode/);
  });

  test('an existing tag gets the edit affordances and its post count', () => {
    const t = tag(3, 'Kyoto', { post_count: 12 });
    const html = renderTagEditorForm({ tag: t, allTags });
    assert.match(html, /Edit: Kyoto/);
    assert.match(html, /Save Changes/);
    assert.match(html, /Parse \/ Geocode/);
    assert.match(html, /search=kyoto[^>]*>12</);
  });

  test('renders with no arguments at all', () => {
    assert.match(renderTagEditorForm(), /New Tag/);
  });

  test('prefills name, slug and description', () => {
    const t = tag(3, 'Kyoto', { description: 'Old capital' });
    const html = renderTagEditorForm({ tag: t, allTags });
    assert.match(html, /name="name"[^>]*value="Kyoto"/);
    assert.match(html, /id="modal-slug"[^>]*value="kyoto"/);
    assert.match(html, /Old capital<\/textarea>/);
  });

  test('nav position is shown only when the tag is in the nav', () => {
    const inNav = renderTagEditorForm({ tag: tag(3, 'X', { nav_order: 2 }), allTags });
    assert.match(inNav, /id="in-nav-check" checked/);
    assert.match(inNav, /id="nav-order-row"/);
    assert.doesNotMatch(inNav, /tm-nav-order-row hidden/);
    assert.match(inNav, /name="nav_order"[^>]*value="2"/);

    const out = renderTagEditorForm({ tag: tag(3, 'X'), allTags });
    assert.match(out, /tm-nav-order-row hidden/);
  });

  test('nav_order 0 counts as being in the nav', () => {
    const html = renderTagEditorForm({ tag: tag(3, 'X', { nav_order: 0 }), allTags });
    assert.match(html, /id="in-nav-check" checked/);
  });

  test('"show in ancestor flyout" defaults on for new tags, off for edits that lack it', () => {
    assert.match(renderTagEditorForm({ allTags }), /name="in_ancestor_flyout" checked/);
    assert.doesNotMatch(
      renderTagEditorForm({ tag: tag(3, 'X'), allTags }),
      /name="in_ancestor_flyout" checked/,
    );
    assert.match(
      renderTagEditorForm({ tag: tag(3, 'X', { in_ancestor_flyout: true }), allTags }),
      /name="in_ancestor_flyout" checked/,
    );
  });

  test('kind defaults to topic and reflects year', () => {
    assert.match(renderTagEditorForm({ allTags }), /value="topic" checked/);
    const year = renderTagEditorForm({ tag: tag(3, '2024', { kind: 'year' }), allTags });
    assert.match(year, /value="year" checked/);
    assert.doesNotMatch(year, /value="topic" checked/);
  });

  test('coordinates come from the flat fields or from locations[0]', () => {
    const flat = renderTagEditorForm({ tag: tag(3, 'X', { latitude: 48.85, longitude: 2.35 }), allTags });
    assert.match(flat, /id="coord-lat"[^>]*value="48.85"/);

    const nested = renderTagEditorForm({ tag: tag(3, 'X', { locations: [{ latitude: 35.6, longitude: 139.7 }] }), allTags });
    assert.match(nested, /id="coord-lat"[^>]*value="35.6"/);
    assert.match(nested, /id="coord-lng"[^>]*value="139.7"/);

    const none = renderTagEditorForm({ tag: tag(3, 'X'), allTags });
    assert.match(none, /id="coord-lat"[^>]*value=""/);
  });

  test('latitude 0 is kept, not treated as missing', () => {
    const html = renderTagEditorForm({ tag: tag(3, 'X', { latitude: 0, longitude: 0 }), allTags });
    assert.match(html, /id="coord-lat"[^>]*value="0"/);
    assert.match(html, /📍/, 'and the section still flags that coordinates exist');
  });

  test('section summary chips reflect the tag', () => {
    const html = renderTagEditorForm({
      tag: tag(3, 'X', { hidden: true, nav_order: 1, kind: 'year', latitude: 1, longitude: 2, parents: [{ id: 1 }] }),
      allTags,
    });
    for (const chip of ['🚫', '⌂', 'year', '📍', '1 parents']) {
      assert.ok(html.includes(chip), `expected the ${chip} summary chip`);
    }
  });

  test('creating under a parent preselects it in the structure picker', () => {
    const html = renderTagEditorForm({ parentId: 1, allTags });
    assert.match(html, /name="parent_ids" value="1" checked/);
  });

  test('escapes a hostile name everywhere it appears', () => {
    const t = tag(3, 'x', { name: '"><script>alert(1)</script>', slug: 'a"b', description: '</textarea><b>' });
    const html = renderTagEditorForm({ tag: t, allTags });
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<\/textarea><b>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;b/, 'the slug attribute is escaped too');
  });
});
