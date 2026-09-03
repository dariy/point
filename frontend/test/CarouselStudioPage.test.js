/**
 * CarouselStudioPage — the carousel plugin's admin shell at /light/carousel.
 *
 * The route is param-less (plugin admin routes are filtered on the /light
 * prefix and titled from their last segment), so the target post rides in
 * `?post=<id>`. These tests pin that contract: a valid id renders the studio
 * pointed at that post; a missing or junk id renders the empty state instead
 * of a broken link.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { setSettings, setUser } from '../src/store.js';

describe('CarouselStudioPage', () => {
  let dom, CarouselStudioPage, page;
  const settle = () => new Promise((r) => setImmediate(r));

  async function mount(query) {
    dom.location.pathname = '/light/carousel';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new CarouselStudioPage(el, { params: {}, query });
    page.mount();
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

  test('a valid ?post= renders the studio pointed at that post', async () => {
    const el = await mount({ post: '42' });
    const stage = el.querySelector('.carousel-studio');
    assert.ok(stage, 'studio section rendered');
    assert.equal(stage.dataset.postId, '42');
    const link = el.querySelector('.carousel-studio__lead a');
    assert.equal(link.getAttribute('href'), '/light/posts/42/edit');
    assert.ok(!el.querySelector('.carousel-studio--empty'), 'not the empty state');
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
    const el = await mount({ post: '1' });
    assert.equal(el.querySelector('.light-header h1')?.textContent.trim(), 'Carousel Studio');
  });
});
