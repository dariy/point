import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  matchesListFilter,
  sortTagsForList,
  renderSortHeader,
  renderTagList,
  renderFilterChips,
} from '../src/components/light/tags/TagListView.js';

// No DOM stubs: TagListView is pure, same as TagTreeView.
const view = (over = {}) => ({
  sortField: 'sort_order',
  sortOrder: 'asc',
  selectMode: false,
  selectedIds: new Set(),
  search: '',
  filterParents: [],
  ...over,
});

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), post_count: 0, parents: [], ...over,
});

describe('matchesListFilter', () => {
  const kyoto = tag(1, 'Kyoto', { slug: 'jp-kyoto', parents: [{ id: 9, name: 'Japan' }] });

  test('an empty filter matches everything', () => {
    assert.equal(matchesListFilter(kyoto, view()), true);
    assert.equal(matchesListFilter(kyoto, {}), true, 'and defaults when given nothing');
  });

  test('searches name, slug and parent names', () => {
    assert.equal(matchesListFilter(kyoto, view({ search: 'kyo' })), true);
    assert.equal(matchesListFilter(kyoto, view({ search: 'jp-' })), true);
    assert.equal(matchesListFilter(kyoto, view({ search: 'japan' })), true);
    assert.equal(matchesListFilter(kyoto, view({ search: 'lisbon' })), false);
  });

  test('search is case-insensitive and trimmed', () => {
    assert.equal(matchesListFilter(kyoto, view({ search: '  KYOTO  ' })), true);
  });

  test('a whitespace-only search is treated as empty', () => {
    assert.equal(matchesListFilter(tag(1, 'Anything'), view({ search: '   ' })), true);
  });

  test('parent chips are ANDed, not ORed', () => {
    const multi = tag(1, 'Paris', { parents: [{ id: 2, name: 'Travel' }, { id: 3, name: 'Art' }] });
    assert.equal(matchesListFilter(multi, view({ filterParents: [{ id: 2 }] })), true);
    assert.equal(matchesListFilter(multi, view({ filterParents: [{ id: 2 }, { id: 3 }] })), true);
    assert.equal(matchesListFilter(multi, view({ filterParents: [{ id: 2 }, { id: 4 }] })), false,
      'a tag missing any one chip is filtered out');
  });

  test('search and chips must both pass', () => {
    assert.equal(matchesListFilter(kyoto, view({ search: 'kyo', filterParents: [{ id: 9 }] })), true);
    assert.equal(matchesListFilter(kyoto, view({ search: 'nope', filterParents: [{ id: 9 }] })), false);
    assert.equal(matchesListFilter(kyoto, view({ search: 'kyo', filterParents: [{ id: 1 }] })), false);
  });

  test('a tag with no parents survives an empty chip list but no chip', () => {
    const loose = tag(1, 'Loose');
    assert.equal(matchesListFilter(loose, view()), true);
    assert.equal(matchesListFilter(loose, view({ filterParents: [{ id: 2 }] })), false);
  });

  test('handles a tag with no parents key', () => {
    assert.equal(matchesListFilter({ id: 1, name: 'Bare', slug: 'bare' }, view({ search: 'bar' })), true);
  });
});

describe('sortTagsForList', () => {
  const tags = [
    tag(1, 'Zebra', { post_count: 5, nav_order: 2, parents: [{ id: 9, name: 'P' }] }),
    tag(2, 'apple', { post_count: 50, locations: [{ latitude: 1, longitude: 2 }] }),
    tag(3, 'Mango', { post_count: 1, nav_order: 1, parents: [{ id: 9, name: 'P' }, { id: 8, name: 'Q' }] }),
  ];

  test('does not mutate the input array', () => {
    const input = [...tags];
    sortTagsForList(input, 'name', 'asc');
    assert.deepEqual(input.map(t => t.id), tags.map(t => t.id));
  });

  test('sorts by name case-insensitively', () => {
    assert.deepEqual(sortTagsForList(tags, 'name', 'asc').map(t => t.name), ['apple', 'Mango', 'Zebra']);
    assert.deepEqual(sortTagsForList(tags, 'name', 'desc').map(t => t.name), ['Zebra', 'Mango', 'apple']);
  });

  test('sorts by slug, post_count, locations and parent count', () => {
    assert.deepEqual(sortTagsForList(tags, 'slug', 'asc').map(t => t.id), [2, 3, 1]);
    assert.deepEqual(sortTagsForList(tags, 'post_count', 'asc').map(t => t.id), [3, 1, 2]);
    // locations is a has/hasn't flag, not a count
    assert.equal(sortTagsForList(tags, 'locations', 'desc')[0].id, 2);
    assert.deepEqual(sortTagsForList(tags, 'parents', 'asc').map(t => t.id), [2, 1, 3]);
  });

  test('default sort puts nav_order first and falls back to name', () => {
    // Tag 2 has no nav_order (Infinity) so it sorts last despite the name.
    assert.deepEqual(sortTagsForList(tags, 'sort_order', 'asc').map(t => t.id), [3, 1, 2]);
  });

  test('default sort breaks nav_order ties by name', () => {
    const tied = [tag(1, 'Zebra'), tag(2, 'apple'), tag(3, 'Mango')];
    assert.deepEqual(sortTagsForList(tied, 'sort_order', 'asc').map(t => t.name), ['apple', 'Mango', 'Zebra']);
  });

  test('an unknown sort field falls through to the default', () => {
    assert.deepEqual(
      sortTagsForList(tags, 'nonsense', 'asc').map(t => t.id),
      sortTagsForList(tags, 'sort_order', 'asc').map(t => t.id),
    );
  });

  test('missing post_count counts as 0', () => {
    const t = [tag(1, 'A', { post_count: undefined }), tag(2, 'B', { post_count: 3 })];
    assert.deepEqual(sortTagsForList(t, 'post_count', 'asc').map(t => t.id), [1, 2]);
  });

  test('sorting an empty list is safe', () => {
    assert.deepEqual(sortTagsForList([], 'name', 'asc'), []);
  });
});

describe('renderSortHeader', () => {
  test('marks the active column and shows a direction arrow', () => {
    const asc = renderSortHeader('name', 'Name', 'c', '', view({ sortField: 'name', sortOrder: 'asc' }));
    assert.match(asc, /active/);
    assert.match(asc, /▴/);

    const desc = renderSortHeader('name', 'Name', 'c', '', view({ sortField: 'name', sortOrder: 'desc' }));
    assert.match(desc, /▾/);
  });

  test('an inactive column has no arrow', () => {
    const html = renderSortHeader('slug', 'Slug', '', '', view({ sortField: 'name' }));
    assert.doesNotMatch(html, /▴|▾/);
    assert.doesNotMatch(html, /active/);
  });

  test('defaults the tooltip to "Sort by <label>" and honours an override', () => {
    assert.match(renderSortHeader('name', 'Name', '', '', view()), /title="Sort by Name"/);
    assert.match(renderSortHeader('locations', '📍', '', 'Coordinates', view()), /title="Coordinates"/);
  });

  test('carries the field for the click handler', () => {
    assert.match(renderSortHeader('post_count', 'Posts', '', '', view()), /data-field="post_count"/);
  });
});

describe('renderTagList', () => {
  const tags = [
    tag(1, 'Kyoto', { post_count: 4, parents: [{ id: 9, name: 'Japan' }] }),
    tag(2, 'Lisbon', { locations: [{ latitude: 38, longitude: -9 }] }),
  ];

  test('reports the empty state for no tags', () => {
    assert.match(renderTagList([], view()), /No tags found/);
  });

  test('renders one row per tag', () => {
    const html = renderTagList(tags, view());
    assert.equal((html.match(/class="tm-tag-row/g) || []).length, 2);
  });

  test('a tag with a location links to the map; one without does not', () => {
    const html = renderTagList(tags, view());
    assert.match(html, /\/map\?tag=lisbon/);
    assert.match(html, /tm-flag-static/, 'Kyoto has no coordinates');
    assert.doesNotMatch(html, /\/map\?tag=kyoto/);
  });

  test('parents render as filter buttons, and an em dash when there are none', () => {
    const html = renderTagList(tags, view());
    assert.match(html, /tm-parent-filter-btn[^>]*data-parent-id="9"[^>]*data-parent-name="Japan"/);
    assert.match(html, /<span class="text-muted">—<\/span>/);
  });

  test('select mode adds the checkbox column and header cell', () => {
    const off = renderTagList(tags, view());
    assert.doesNotMatch(off, /tm-check-col/);

    const on = renderTagList(tags, view({ selectMode: true, selectedIds: new Set([2]) }));
    assert.match(on, /<th class="tm-check-col">/);
    assert.equal((on.match(/tm-select-cb/g) || []).length, 2);
    assert.equal((on.match(/is-selected/g) || []).length, 1);
  });

  test('the search box is prefilled and the clear button appears only with filters', () => {
    const none = renderTagList(tags, view());
    assert.doesNotMatch(none, /tm-clear-filters/);

    const searched = renderTagList(tags, view({ search: 'kyo' }));
    assert.match(searched, /value="kyo"/);
    assert.match(searched, /tm-clear-filters/);

    const chipped = renderTagList(tags, view({ filterParents: [{ id: 9, name: 'Japan' }] }));
    assert.match(chipped, /tm-clear-filters/, 'chips alone are enough');
  });

  test('active parent chips render with a remove target', () => {
    const html = renderTagList(tags, view({ filterParents: [{ id: 9, name: 'Japan' }] }));
    assert.match(html, /tm-filter-chip" data-remove-id="9"/);
  });

  test('the list embeds the same chips the page re-renders with', () => {
    const filterParents = [{ id: 9, name: 'Japan' }, { id: 4, name: 'Peru' }];
    const chips = renderFilterChips(filterParents);

    assert.match(chips, /<svg/, 'the remove target is the icon, not a bare ×');
    assert.ok(
      renderTagList(tags, view({ filterParents })).includes(chips),
      'a chip must not change shape between first paint and a re-render',
    );
  });

  test('chip names are escaped', () => {
    assert.match(renderFilterChips([{ id: 1, name: '<img src=x>' }]), /&lt;img src=x&gt;/);
  });

  test('the chips container is always present, even when empty', () => {
    assert.match(renderTagList(tags, view()), /<div class="tm-filter-chips" id="tm-filter-chips"><\/div>/);
  });

  test('rows follow the requested sort', () => {
    const html = renderTagList(tags, view({ sortField: 'name', sortOrder: 'desc' }));
    assert.ok(html.indexOf('Lisbon') < html.indexOf('Kyoto'));
  });

  test('escapes names, slugs and parent names', () => {
    const nasty = [tag(1, 'x', { name: '<script>a</script>', slug: 'a b&c', parents: [{ id: 2, name: '"><img src=x>' }] })];
    const html = renderTagList(nasty, view({ search: '<script>' }));
    assert.doesNotMatch(html, /<script>a<\/script>/);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /search=a%20b%26c/, 'slug is url-encoded in the posts link');
    assert.match(html, /value="&lt;script&gt;"/, 'and the search box value is escaped');
  });
});
