/**
 * PublicHeader, mounted for real.
 *
 * The sibling header tests assert on `render()` output against a hand-stubbed
 * document. These mount the header into a linkedom document so afterRender
 * runs: the fold registration, the expandable search with its typeahead, and
 * the burger with its outside-click close.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, must } from './helpers/dom.ts';
import { jsonResponse } from './helpers/fetch.ts';
import { setSettings, setUser } from '../src/store.ts';
import { pluginHost } from '../src/core/pluginHost.ts';

const settle = () => new Promise<void>(r => setImmediate(r));

describe('PublicHeader (mounted)', () => {
  let dom: ReturnType<typeof setupDOM>;
  let PublicHeader: typeof import('../src/plugins/public-header/PublicHeader.ts').PublicHeader;
  let header: InstanceType<typeof PublicHeader>;
  let navigations: string[];

  beforeEach(async () => {
    dom = setupDOM();
    navigations = [];
    dom.window.addEventListener('app:navigate', e => navigations.push((e as CustomEvent<{ path: string }>).detail.path));
    globalThis.fetch = async url => {
      const path = String(url).split('?')[0];
      const payload = path === '/api/posts'
        ? { posts: [{ slug: 'harbour-lights', title: 'Harbour lights' }] }
        : { tags: [] };
      return jsonResponse({ ok: true, status: 200, body: payload });
    };
    setUser(null);
    setSettings({ blog_title: 'Test blog' });
    pluginHost.init([]);
    ({ PublicHeader } = await import('../src/plugins/public-header/PublicHeader.ts'));
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    header = new PublicHeader(el, { settings: { blog_title: 'Test blog' }, navTags: [], breadcrumb: [] });
    header.mount();
    await settle();
  });

  afterEach(() => {
    try { header?.unmount(); } catch { /* torn down mid-flight */ }
    dom.cleanup();
  });

  const q = (sel: string) => must(header.container.querySelector<HTMLElement>(sel));

  test('mount registers the fold controller and keeps the header group', () => {
    assert.ok(header._group, 'the header group is kept');
    assert.ok(header._fold, 'the fold controller exists after mount');
  });

  test('the search toggle opens the form, and an outside click closes it', () => {
    const form = q('#header-search');
    click(must(form.querySelector('.search-toggle-btn')));
    assert.ok(form.classList.contains('is-active'));
    click(dom.body);
    assert.ok(!form.classList.contains('is-active'));
  });

  test('a submitted search is saved to the recent searches', () => {
    const form = q('#header-search');
    const input = must(form.querySelector<HTMLInputElement>('input[type="search"]'));
    click(must(form.querySelector('.search-toggle-btn')));
    input.value = 'harbour';
    click(must(form.querySelector('.search-toggle-btn')));
    assert.deepStrictEqual(JSON.parse(localStorage.getItem('recentSearches') ?? 'null'), ['harbour']);
    assert.ok(!form.classList.contains('is-active'));
  });

  test('a typeahead post result navigates to its href', async () => {
    const input = must(header.container.querySelector<HTMLInputElement>('#header-search input[type="search"]'));
    await header._showTypeahead('harbour', input);
    const item = dom.document.querySelector('#search-typeahead-mount .typeahead-item.post-item');
    assert.ok(item, 'the post result is rendered');
    click(item);
    assert.deepStrictEqual(navigations, ['/posts/harbour-lights']);
  });

  test('the burger opens on its toggle and closes on an outside click', () => {
    const burger = q('#nav-burger');
    click(must(burger.querySelector('.burger-toggle')));
    assert.ok(burger.classList.contains('is-open'));
    click(dom.body);
    assert.ok(!burger.classList.contains('is-open'));
  });
});
