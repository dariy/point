/**
 * CarouselStudioPage — the carousel plugin's admin shell at /light/carousel.
 *
 * The route is param-less (plugin admin routes are filtered on the /light
 * prefix and titled from their last segment), so the target post rides in
 * `?post=<id>`. These tests pin that contract plus the C7 splitter shell: a
 * valid id loads the post and its carousel document; a missing or junk id
 * renders the empty state; an existing document restores the source, slide
 * count and aspect.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { setSettings, setUser } from '../src/store.js';

/** Route `fetch` by URL; unmatched paths 404. */
function installFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) {
        const res = typeof handler === 'function' ? handler(url, opts) : handler;
        return {
          status: res.status ?? 200,
          ok: (res.status ?? 200) < 400,
          headers: { get: () => 'application/json' },
          json: async () => res.body ?? null,
        };
      }
    }
    return {
      status: 404,
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: 'not found' }),
    };
  };
  return calls;
}

const POST = {
  id: 42,
  title: 'A post',
  slug: 'a-post',
  content: 'Some copy.',
  status: 'draft',
  type: 'post',
  formatter: 'markdown',
  tags: [],
};

describe('CarouselStudioPage', () => {
  let dom, CarouselStudioPage, page;
  const settle = () => new Promise((r) => setImmediate(r));

  async function mount(query, routes) {
    installFetch(
      routes || [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { status: 404, body: { message: 'no carousel' } }],
      ],
    );
    dom.location.pathname = '/light/carousel';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new CarouselStudioPage(el, { params: {}, query });
    page.mount();
    await settle();
    await settle();
    return el;
  }

  beforeEach(async () => {
    dom = setupDOM();
    setUser({ username: 'owner', is_admin: true });
    setSettings({ blog_title: 'Test blog' });
    ({ default: CarouselStudioPage } = await import(
      '../src/plugins/carousel/index.js'
    ));
  });

  afterEach(() => {
    page?.unmount();
    page = null;
    dom.cleanup();
  });

  test('a valid ?post= loads the post and shows the pick prompt', async () => {
    const el = await mount({ post: '42' });
    const studio = el.querySelector('.carousel-studio');
    assert.ok(studio, 'studio section rendered');
    assert.equal(studio.dataset.postId, '42');
    assert.equal(
      el.querySelector('.carousel-studio__lead a').getAttribute('href'),
      '/light/posts/42/edit',
    );
    assert.ok(el.querySelector('[data-action="pick-source"]'), 'pick prompt shown');
    assert.ok(!el.querySelector('.carousel-studio--empty'), 'not the empty state');
  });

  test('an existing carousel document restores source, slide count and aspect', async () => {
    const doc = {
      version: 1,
      aspect: '1:1',
      mode: 'split',
      slides: [
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s1.jpg' } },
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s2.jpg' } },
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s3.jpg' } },
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s4.jpg' } },
      ],
    };
    const el = await mount({ post: '42' }, [
      [/\/api\/posts\/42/, { body: POST }],
      [/\/api\/carousel/, { body: { post_id: 42, doc } }],
    ]);

    assert.ok(el.querySelector('.carousel-studio__builder'), 'builder shown');
    assert.equal(page.state.source, '/2026/08/wide.jpg');
    assert.equal(page.state.n, 4);
    assert.equal(page.state.aspect, '1:1');
    assert.equal(el.querySelectorAll('.carousel-studio__slide').length, 4, 'rendered slides shown');
    // 4 columns → 3 dividers.
    assert.equal(el.querySelectorAll('.carousel-studio__divider').length, 3);
  });

  test('changing the slide count re-renders the preview', async () => {
    const el = await mount({ post: '42' }, [
      [/\/api\/posts\/42/, { body: POST }],
      [/\/api\/carousel/, { body: { post_id: 42, doc: { slides: [{ source: '/2026/08/w.jpg' }, { source: '/2026/08/w.jpg' }] } } }],
    ]);
    assert.equal(el.querySelectorAll('.carousel-studio__frame').length, 2);

    const range = el.querySelector('#carousel-n');
    range.value = '5';
    range.dispatchEvent(new dom.window.Event('change'));
    await settle();

    assert.equal(page.state.n, 5);
    assert.equal(el.querySelectorAll('.carousel-studio__frame').length, 5);
  });

  test('no ?post= renders the empty state', async () => {
    const el = await mount(undefined);
    assert.ok(el.querySelector('.carousel-studio--empty'), 'empty state rendered');
    assert.ok(!el.querySelector('[data-post-id]'), 'no post-bound stage');
  });

  test('a non-numeric ?post= is rejected, not passed through', async () => {
    const el = await mount({ post: '7; drop table' });
    assert.ok(el.querySelector('.carousel-studio--empty'), 'falls back to empty state');
  });

  test('the page titles itself "Carousel Studio"', async () => {
    const el = await mount({ post: '42' });
    assert.equal(
      el.querySelector('.light-header h1')?.textContent.trim(),
      'Carousel Studio',
    );
  });
});
