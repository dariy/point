/**
 * The editor's overflow menu gains a "Carousel Studio" item, gated exactly like
 * the "Analyze media" item: present only when the `carousel` plugin is enabled,
 * and only for a saved post (the studio needs a post id to build slides for).
 * Choosing it navigates to the plugin's param-less route with the post id in
 * the query string.
 */

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { pluginHost } from '../src/core/pluginHost.js';

describe('PostEditPage — Carousel Studio menu item', () => {
  let PostEditPage;

  before(async () => {
    global.customElements = { define: () => {} };
    global.HTMLElement = class {
      constructor() { this.attachShadow = () => ({ innerHTML: '' }); }
      get clientHeight() { return 800; }
      get offsetHeight() { return 50; }
    };
    global.document = {
      createElement: () => ({
        appendChild: () => {}, remove: () => {}, style: {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {}, removeEventListener: () => {},
        setAttribute: () => {}, querySelector: () => null, querySelectorAll: () => [],
      }),
      body: { appendChild: () => {}, remove: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
      activeElement: {}, addEventListener: () => {}, removeEventListener: () => {},
      querySelector: () => null, querySelectorAll: () => [],
    };
    global.window = {
      Point: { emit: () => {}, on: () => {} },
      location: { pathname: '' },
      history: { replaceState: () => {} },
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
    };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    ({ default: PostEditPage } = await import('../src/pages/light/PostEditPage.js'));
  });

  const makePage = (params) => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params });
    page.state.loading = false;
    page.state.isNew = !params.id;
    page.state.post = params.id ? { id: Number(params.id), title: 'Test' } : null;
    return page;
  };

  afterEach(() => {
    // Leave the host in a known state for the next test.
    pluginHost.init([]);
  });

  test('absent when the carousel plugin is disabled', () => {
    pluginHost.init([{ id: 'ai-analysis', type: 'service' }]);
    const html = String(makePage({ id: '7' }).render());
    assert.ok(!html.includes('data-action="carousel-studio"'), 'no studio item');
  });

  test('present for a saved post when the plugin is enabled', () => {
    pluginHost.init([{ id: 'carousel', type: 'route', routes: ['/light/carousel', '/api/carousel'] }]);
    const html = String(makePage({ id: '7' }).render());
    assert.ok(html.includes('data-action="carousel-studio"'), 'studio item shown');
    assert.ok(html.includes('id="carousel-studio-btn"'));
  });

  test('absent for a brand-new (unsaved) post even when enabled', () => {
    pluginHost.init([{ id: 'carousel', type: 'route', routes: ['/light/carousel'] }]);
    const html = String(makePage({}).render());
    assert.ok(!html.includes('data-action="carousel-studio"'), 'nothing to build slides for yet');
  });

  test('the action navigates to the param-less route with ?post=', () => {
    pluginHost.init([{ id: 'carousel', type: 'route', routes: ['/light/carousel'] }]);
    const page = makePage({ id: '7' });
    const seen = [];
    global.window.dispatchEvent = (e) => { if (e.type === 'app:navigate') seen.push(e.detail.path); };
    page.actions['carousel-studio'].call(page);
    assert.deepStrictEqual(seen, ['/light/carousel?post=7']);
  });
});
