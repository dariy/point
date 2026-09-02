import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * The pure logic in src/utils/tagLinks.js: how a tag becomes a URL, a colour
 * bucket, an <a>, and how the nav payload becomes the index the flyout walks
 * for ancestors.
 *
 * Every public surface that shows a tag goes through these — the pills, the
 * strip, the Atlas cloud, the graph, the breadcrumb — so a change here is a
 * change everywhere at once. parseTagUrl and renderTagStrip have their own
 * files (parseTagUrl.test.js, tagStrip.test.js); this covers the rest.
 */

let tagHref, tagKind, renderTagLink, buildTagIndex, getTagAncestors;

before(async () => {
  globalThis.window = { location: { origin: 'https://example.com' } };
  ({ tagHref, tagKind, renderTagLink, buildTagIndex, getTagAncestors } =
    await import('../src/utils/tagLinks.js'));
});

// ── tagHref ──────────────────────────────────────────────────────────────────

/**
 * A tag link carries the ancestor chain the user drilled through as ?path=, so
 * the destination page can render a breadcrumb for the route actually taken
 * rather than guessing one. No chain means no query at all — a bare
 * /tags/<slug> is the canonical, shareable form.
 */
describe('tagHref', () => {
  test('bare slug when there is no trail', () => {
    assert.strictEqual(tagHref('mountains'), '/tags/mountains');
  });

  test('joins the ancestor chain root-first', () => {
    assert.strictEqual(
      tagHref('city', ['location', 'canada']),
      '/tags/city?path=location/canada',
    );
  });

  test('an empty chain is the same as none', () => {
    assert.strictEqual(tagHref('mountains', []), '/tags/mountains');
  });

  test('drops empty segments rather than emitting //', () => {
    assert.strictEqual(tagHref('city', ['location', '', 'canada']), '/tags/city?path=location/canada');
  });

  test('a chain of nothing but empties collapses to the bare form', () => {
    assert.strictEqual(tagHref('city', ['', null, undefined]), '/tags/city');
  });

  test('a null chain is tolerated', () => {
    assert.strictEqual(tagHref('city', null), '/tags/city');
  });
});

// ── tagKind ──────────────────────────────────────────────────────────────────

/**
 * The colour bucket, and the single source of truth for it: the pills, the
 * Atlas cloud and the tags graph all call this so they cannot disagree about
 * what a tag *is*. Buckets are 'year', 'geo' (carries coordinates) and 'tag'.
 */
describe('tagKind', () => {
  test('an explicit year tag is a year', () => {
    assert.strictEqual(tagKind({ kind: 'year', name: '2026' }), 'year');
  });

  test('numeric coordinates make a tag geo', () => {
    assert.strictEqual(tagKind({ name: 'Montréal', latitude: 45.5, longitude: -73.5 }), 'geo');
  });

  test('zero coordinates are still coordinates', () => {
    // Null Island is a real point; a truthiness test here would misfile it.
    assert.strictEqual(tagKind({ name: 'origin', latitude: 0, longitude: 0 }), 'geo');
  });

  test('kind wins over coordinates', () => {
    assert.strictEqual(tagKind({ kind: 'year', latitude: 1, longitude: 2 }), 'year');
  });

  test('half a coordinate pair is not geo', () => {
    assert.strictEqual(tagKind({ name: 'partial', latitude: 45.5 }), 'tag');
    assert.strictEqual(tagKind({ name: 'partial', longitude: -73.5 }), 'tag');
  });

  test('coordinates arriving as strings are not geo', () => {
    // The API sends numbers; a string here means something upstream stringified
    // the row, and drawing it on the map would place it at NaN.
    assert.strictEqual(tagKind({ latitude: '45.5', longitude: '-73.5' }), 'tag');
  });

  test('a bare string tag has no bucket of its own', () => {
    assert.strictEqual(tagKind('mountains'), 'tag');
  });

  test('null and undefined fall back to plain', () => {
    assert.strictEqual(tagKind(null), 'tag');
    assert.strictEqual(tagKind(undefined), 'tag');
  });
});

// ── renderTagLink ────────────────────────────────────────────────────────────

/**
 * The one <a> builder for public tag links. It takes either a bare slug string
 * or a tag object, and everything user-supplied that reaches the markup — the
 * name and the href — is escaped, because tag names are author input.
 */
describe('renderTagLink', () => {
  test('a bare string is used as both name and slug', () => {
    const html = renderTagLink('mountains');
    assert.ok(html.includes('href="/tags/mountains"'));
    assert.ok(html.includes('>mountains</a>'));
  });

  test('an object uses its name for the label and its slug for the url', () => {
    const html = renderTagLink({ name: 'Montréal', slug: 'montreal' });
    assert.ok(html.includes('href="/tags/montreal"'));
    assert.ok(html.includes('>Montréal</a>'));
  });

  test('carries the kind as a class so CSS can colour it', () => {
    assert.ok(renderTagLink({ name: '2026', slug: '2026', kind: 'year' }).includes('tag-kind-year'));
    assert.ok(renderTagLink({ name: 'Paris', slug: 'paris', latitude: 48, longitude: 2 }).includes('tag-kind-geo'));
    assert.ok(renderTagLink('fern').includes('tag-kind-tag'));
  });

  test('active adds the active class, plain does not', () => {
    assert.ok(renderTagLink('fern', { active: true }).includes('active'));
    assert.ok(!renderTagLink('fern').includes('active'));
  });

  test('extra classes, prefix and suffix are placed around the name', () => {
    const html = renderTagLink('fern', { extra: 'big', prefix: '<b>', suffix: '</b>' });
    assert.ok(html.includes('big'));
    assert.ok(html.includes('<b>fern</b>'));
  });

  test('an explicit url overrides the derived one', () => {
    const html = renderTagLink({ name: 'About', slug: 'about', url: '/pages/about' });
    assert.ok(html.includes('href="/pages/about"'));
  });

  test('an absolute url opens in a new tab, safely', () => {
    const html = renderTagLink({ name: 'Elsewhere', slug: 'x', url: 'https://example.com/t' });
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('rel="noopener noreferrer"'), 'reverse tabnabbing guard');
  });

  test('an internal url stays in the tab', () => {
    const html = renderTagLink({ name: 'About', slug: 'about', url: '/pages/about' });
    assert.ok(!html.includes('target="_blank"'));
  });

  test('a tag name cannot inject markup', () => {
    const html = renderTagLink({ name: '<img src=x onerror=alert(1)>', slug: 'x' });
    assert.ok(!html.includes('<img'), 'author-supplied name must be escaped');
    assert.ok(html.includes('&lt;img'));
  });

  test('a url cannot break out of the href attribute', () => {
    const html = renderTagLink({ name: 'x', slug: 'x', url: '/t" onmouseover="alert(1)' });
    // The payload survives as text — what matters is that its quotes are
    // escaped, so it stays inside href and never becomes a second attribute.
    const href = /href="([^"]*)"/.exec(html)[1];
    assert.ok(!href.includes('"'), 'href value must contain no raw quote');
    assert.ok(href.includes('&quot;'), 'the quote should be escaped, not stripped');
    // The payload text (onmouseover=…) still appears — escaped, inside the
    // href value. That is the point: it is data, not a second attribute.
    assert.ok(html.startsWith(`<a href="${href}" class=`), 'href must be the only attribute it produced');
  });

  test('no class list is left with stray gaps', () => {
    // Empty options used to leave 'tag-link  tag-kind-tag  ' behind.
    const cls = /class="([^"]*)"/.exec(renderTagLink('fern'))[1];
    assert.strictEqual(cls, cls.trim());
    assert.ok(!cls.includes('  '), `double space in class list: ${cls}`);
  });
});

// ── buildTagIndex ────────────────────────────────────────────────────────────

/**
 * The nav payload arrives as a tree; the flyout needs random access by slug
 * plus a parent pointer to walk upward. buildTagIndex flattens one into the
 * other, recursing through children and remembering who each tag came from.
 */
describe('buildTagIndex', () => {
  const nav = [
    {
      name: 'Location', slug: 'location', post_count: 40,
      children: [
        {
          name: 'Canada', slug: 'canada', post_count: 30,
          children: [{ name: 'Montréal', slug: 'montreal', post_count: 12 }],
        },
      ],
    },
    { name: 'Fern', slug: 'fern', post_count: 3 },
  ];

  test('every tag at every depth is indexed', () => {
    const index = buildTagIndex(nav);
    assert.deepStrictEqual(
      [...index.keys()].sort(),
      ['canada', 'fern', 'location', 'montreal'],
    );
  });

  test('post_count is exposed as count', () => {
    assert.strictEqual(buildTagIndex(nav).get('canada').tag.count, 30);
  });

  test('each entry remembers its parent, roots have none', () => {
    const index = buildTagIndex(nav);
    assert.strictEqual(index.get('location').parentSlug, null);
    assert.strictEqual(index.get('canada').parentSlug, 'location');
    assert.strictEqual(index.get('montreal').parentSlug, 'canada');
  });

  test('isLeaf marks the tags with nowhere further to drill', () => {
    const index = buildTagIndex(nav);
    assert.strictEqual(index.get('location').isLeaf, false);
    assert.strictEqual(index.get('montreal').isLeaf, true);
    assert.strictEqual(index.get('fern').isLeaf, true);
  });

  test('children are flattened to what the flyout renders', () => {
    assert.deepStrictEqual(
      buildTagIndex(nav).get('location').children,
      [{ name: 'Canada', slug: 'canada', count: 30 }],
    );
  });

  test('showInAncestors defaults to true and only an explicit false turns it off', () => {
    const index = buildTagIndex([
      { name: 'Shown', slug: 'shown', post_count: 1 },
      { name: 'Hidden', slug: 'hidden', post_count: 1, show_in_ancestors: false },
      { name: 'Null', slug: 'nul', post_count: 1, show_in_ancestors: null },
    ]);
    assert.strictEqual(index.get('shown').showInAncestors, true);
    assert.strictEqual(index.get('hidden').showInAncestors, false);
    assert.strictEqual(index.get('nul').showInAncestors, true);
  });

  test('an empty payload gives an empty index', () => {
    assert.strictEqual(buildTagIndex([]).size, 0);
  });
});

// ── getTagAncestors ──────────────────────────────────────────────────────────

/**
 * Walks the index upward from a slug to build the breadcrumb trail. Two tags
 * never appear in it: internal tags (leading underscore) and tags the author
 * marked show_in_ancestors=false — both are organisational containers that
 * would otherwise clutter every trail beneath them.
 *
 * The walk is guarded against cycles. The tag graph is supposed to be acyclic
 * and the backend rejects new edges that would close a loop, but a trail that
 * hangs the page is a far worse failure than one that stops early.
 */
describe('getTagAncestors', () => {
  const index = buildTagIndexFixture();

  function buildTagIndexFixture() {
    return new Map([
      ['location', { tag: { name: 'Location', slug: 'location', count: 40 }, parentSlug: null, showInAncestors: true }],
      ['canada', { tag: { name: 'Canada', slug: 'canada', count: 30 }, parentSlug: 'location', showInAncestors: true }],
      ['montreal', { tag: { name: 'Montréal', slug: 'montreal', count: 12 }, parentSlug: 'canada', showInAncestors: true }],
      ['_internal', { tag: { name: 'Internal', slug: '_internal', count: 0 }, parentSlug: 'location', showInAncestors: true }],
      ['quiet', { tag: { name: 'Quiet', slug: 'quiet', count: 5 }, parentSlug: 'location', showInAncestors: false }],
      ['under-internal', { tag: { name: 'Deep', slug: 'under-internal', count: 1 }, parentSlug: '_internal', showInAncestors: true }],
      ['under-quiet', { tag: { name: 'Deeper', slug: 'under-quiet', count: 1 }, parentSlug: 'quiet', showInAncestors: true }],
    ]);
  }

  test('returns the trail root-first', () => {
    assert.deepStrictEqual(
      getTagAncestors('montreal', index).map((t) => t.slug),
      ['location', 'canada'],
    );
  });

  test('the tag itself is not part of its own trail', () => {
    assert.ok(!getTagAncestors('montreal', index).some((t) => t.slug === 'montreal'));
  });

  test('a root tag has an empty trail', () => {
    assert.deepStrictEqual(getTagAncestors('location', index), []);
  });

  test('an unknown slug yields an empty trail rather than throwing', () => {
    assert.deepStrictEqual(getTagAncestors('nope', index), []);
  });

  test('underscore-prefixed containers are skipped but still walked through', () => {
    assert.deepStrictEqual(
      getTagAncestors('under-internal', index).map((t) => t.slug),
      ['location'],
      '_internal is hidden, but its own parent must still surface',
    );
  });

  test('show_in_ancestors=false is skipped but still walked through', () => {
    assert.deepStrictEqual(
      getTagAncestors('under-quiet', index).map((t) => t.slug),
      ['location'],
    );
  });

  test('a cycle terminates instead of hanging', () => {
    const cyclic = new Map([
      ['a', { tag: { name: 'A', slug: 'a' }, parentSlug: 'b', showInAncestors: true }],
      ['b', { tag: { name: 'B', slug: 'b' }, parentSlug: 'a', showInAncestors: true }],
    ]);
    assert.deepStrictEqual(getTagAncestors('a', cyclic).map((t) => t.slug), ['b']);
  });

  test('a tag parented to itself terminates', () => {
    const selfLoop = new Map([
      ['a', { tag: { name: 'A', slug: 'a' }, parentSlug: 'a', showInAncestors: true }],
    ]);
    assert.deepStrictEqual(getTagAncestors('a', selfLoop), []);
  });

  test('a parent missing from the index stops the walk', () => {
    const orphan = new Map([
      ['a', { tag: { name: 'A', slug: 'a' }, parentSlug: 'gone', showInAncestors: true }],
    ]);
    assert.deepStrictEqual(getTagAncestors('a', orphan), []);
  });
});
