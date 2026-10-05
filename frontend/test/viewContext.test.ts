import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';
import type { ViewContext as ViewContextClass } from '../src/utils/viewContext.ts';

// ViewContext serializes { tag, years, query, page, postSlug } back to a URL.
// The cases that matter here are the ones where a search has to *leave* the
// view it was issued from — the /tags module and an open post both used to
// short-circuit toUrl() before the search branch could run.
describe('ViewContext.toUrl', () => {
  let ViewContext: typeof ViewContextClass;

  before(async () => {
    global.window = mock<typeof window>({ location: mock<Location>({ pathname: '/', search: '' }) });
    ({ ViewContext } = await import('../src/utils/viewContext.ts'));
  });

  const url = (pathname: string, query: Record<string, string> = {}) => new ViewContext(pathname, query).toUrl();

  test('search from the home view', () => {
    assert.strictEqual(url('/', { q: 'ukraine' }), '/search?q=ukraine');
  });

  test('search from the tags module (cloud / map / atlas)', () => {
    assert.strictEqual(url('/tags', { q: 'ukraine' }), '/search?q=ukraine');
    assert.strictEqual(url('/tags/', { q: 'ukraine' }), '/search?q=ukraine');
  });

  test('tags module without a query still serializes to /tags', () => {
    assert.strictEqual(url('/tags'), '/tags');
    assert.strictEqual(url('/tags', { timeline: '2019-2024' }), '/tags?timeline=2019-2024');
  });

  test('map keeps its path and the timeline range', () => {
    assert.strictEqual(url('/map'), '/map');
    assert.strictEqual(url('/map', { timeline: '2019-2023' }), '/map?timeline=2019-2023');
    assert.strictEqual(url('/map/', { timeline: '2019-2023' }), '/map?timeline=2019-2023');
    assert.strictEqual(url('/map', { q: 'ukraine' }), '/search?q=ukraine');
  });

  test('search from an open post drops the post slug', () => {
    assert.strictEqual(url('/posts/some-post', { q: 'ukraine' }), '/search?q=ukraine');
  });

  test('search from a post opened inside a tag keeps the tag scope', () => {
    assert.strictEqual(
      url('/tags/kyiv', { slug: 'some-post', q: 'ukraine' }),
      '/search?q=ukraine&tag=kyiv',
    );
  });

  test('search scoped to a tag', () => {
    assert.strictEqual(url('/tags/kyiv', { q: 'ukraine' }), '/search?q=ukraine&tag=kyiv');
  });

  test('post view without a query is unaffected', () => {
    assert.strictEqual(url('/posts/some-post'), '/posts/some-post');
    assert.strictEqual(url('/tags/kyiv', { slug: 'some-post' }), '/tags/kyiv?slug=some-post');
  });

  // The owner's feed runs 0, -1, -2 … to the left of page 1 (the scheduled
  // queue), so page has to survive a round trip as a signed integer. Read
  // through `|| 1` and through `page > 1`, both of those collapse to page 1.
  test('scheduled pages survive the round trip', () => {
    assert.strictEqual(new ViewContext('/', { page: '0' }).page, 0);
    assert.strictEqual(new ViewContext('/', { page: '-2' }).page, -2);
    assert.strictEqual(url('/', { page: '0' }), '/?page=0');
    assert.strictEqual(url('/', { page: '-2' }), '/?page=-2');
  });

  test('page 1 and a missing page both stay out of the URL', () => {
    assert.strictEqual(new ViewContext('/', {}).page, 1);
    assert.strictEqual(new ViewContext('/', { page: 'nonsense' }).page, 1);
    assert.strictEqual(url('/', { page: '1' }), '/');
    assert.strictEqual(url('/'), '/');
  });
});
