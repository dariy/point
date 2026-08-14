import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * The paginator normally runs 1…pages. The owner's home feed lowers its left
 * edge into the scheduled queue (page 0, then -1, …), so the range, the
 * ellipsis math and the disabled prev arrow all have to key off `minPage`
 * rather than a hard-coded 1.
 */
describe('Pagination', () => {
  let Pagination;

  before(async () => {
    ({ Pagination } = await import('../src/components/shared/Pagination.js'));
  });

  const html = (props) => new Pagination(null, props).render();
  /** The page numbers the paginator offers, in order. */
  const items = (props) =>
    [...html(props).matchAll(/data-page="(-?\d+)"[^>]*>(-?\d+)</g)].map((m) => Number(m[2]));

  test('a plain feed still runs 1…pages', () => {
    assert.deepEqual(items({ page: 1, pages: 3, total: 30 }), [1, 2, 3]);
  });

  test('one page and no queue renders nothing', () => {
    assert.strictEqual(html({ page: 1, pages: 1, total: 4 }), '');
  });

  test('one published page plus a queue page is still worth a paginator', () => {
    assert.deepEqual(items({ page: 0, pages: 1, minPage: 0, total: 4 }), [0, 1]);
  });

  test('the queue extends the range to the left', () => {
    assert.deepEqual(items({ page: 1, pages: 3, minPage: -2, total: 30 }), [-2, -1, 0, 1, 2, 3]);
  });

  test('a long range still collapses around the current page', () => {
    // minPage … ellipsis … page-1, page, page+1 … ellipsis … pages
    assert.deepEqual(items({ page: 4, pages: 9, minPage: -1, total: 90 }), [-1, 3, 4, 5, 9]);
    assert.match(html({ page: 4, pages: 9, minPage: -1, total: 90 }), /page-ellipsis/);
  });

  test('prev is disabled at the left edge, wherever that is', () => {
    const atQueueEnd = html({ page: -1, pages: 3, minPage: -1, total: 30 });
    assert.match(atQueueEnd, /class="page-btn page-prev"[^>]*disabled/);

    // Page 1 is no longer the left edge once a queue exists behind it.
    const atPageOne = html({ page: 1, pages: 3, minPage: -1, total: 30 });
    assert.ok(!/page-prev"[^>]*disabled/.test(atPageOne), 'the queue is still reachable');
  });

  test('queue pages are marked so they read as unpublished', () => {
    const out = html({ page: 1, pages: 2, minPage: -1, total: 20 });
    for (const p of [-1, 0]) {
      assert.match(out, new RegExp(`class="page-btn page-scheduled"[^>]*data-page="${p}"`));
    }
    assert.ok(!/class="page-btn page-scheduled"[^>]*data-page="1"/.test(out),
      'a published page is never marked scheduled');
  });
});
