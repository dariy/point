import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click } from './helpers/dom.js';

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

  // render() returns the RawHtml html`` produces; String() for assert equality.
  const html = (props) => String(new Pagination(null, props).render());
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

  // ── Navigation ────────────────────────────────────────────────────────────

  describe('mounted', () => {
    let dom;
    beforeEach(() => { dom = setupDOM(); });
    afterEach(() => { dom.cleanup(); });

    /** Mount a paginator and return it with the pages it reported. */
    const mount = (props) => {
      const el = dom.document.createElement('div');
      dom.document.body.appendChild(el);
      const asked = [];
      const c = new Pagination(el, { ...props, onPage: (p) => asked.push(p) });
      c.mount();
      return { c, asked };
    };

    test('clicking a page number reports it', () => {
      const { c, asked } = mount({ page: 1, pages: 3, total: 30 });
      click(c.$('[data-page="3"]'));
      assert.deepEqual(asked, [3]);
    });

    test('the arrows step either way', () => {
      const { c, asked } = mount({ page: 2, pages: 3, total: 30 });
      click(c.$('.page-next'));
      click(c.$('.page-prev'));
      assert.deepEqual(asked, [3, 1]);
    });

    test('a page outside the range is not reported', () => {
      // page 0 with minPage 1: the prev arrow renders disabled, and its target
      // is below the left edge either way.
      const { c, asked } = mount({ page: 1, pages: 3, total: 30 });
      click(c.$('.page-prev'));
      assert.deepEqual(asked, []);
    });

    test('the wiring survives a re-render, having never been re-attached', () => {
      const { c, asked } = mount({ page: 1, pages: 5, total: 50 });
      c.setProps({ page: 2 });
      c.setProps({ page: 3 });
      click(c.$('.page-next'));
      assert.deepEqual(asked, [4], 'exactly once — not once per render');
    });

    test('unmounting releases the delegate', () => {
      const { c, asked } = mount({ page: 1, pages: 3, total: 30 });
      c.unmount();

      // The container outlives unmount — only its contents are cleared — so an
      // event on it is exactly what a leaked delegate would still answer.
      const btn = dom.document.createElement('button');
      btn.setAttribute('data-action', 'page');
      btn.setAttribute('data-page', '2');
      c.container.appendChild(btn);
      click(btn);

      assert.deepEqual(asked, []);
    });
  });
});
