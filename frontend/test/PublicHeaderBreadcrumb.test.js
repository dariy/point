import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('Breadcrumbs plugin', () => {
  let BreadcrumbsComponent;
  let store;
  let container;

  before(async () => {
    // Minimal DOM shim required by Component, store, and ViewContext
    global.document = {
      createElement: () => ({
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        innerHTML: '',
        textContent: '',
        style: {},
      }),
      head: { appendChild: () => {} },
      body: { classList: { remove: () => {}, add: () => {} } },
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
    };
    global.window = {
      location: { pathname: '/', search: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
    };
    global.localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };

    const storeMod = await import('../src/store.js');
    store = storeMod.store;

    const mod = await import('../src/plugins/breadcrumbs/Breadcrumbs.js');
    BreadcrumbsComponent = mod.Breadcrumbs;

    container = {
      querySelector: () => null,
      querySelectorAll: () => [],
      set innerHTML(val) { this._innerHTML = val; },
      get innerHTML() { return this._innerHTML || ''; },
      textContent: '',
    };
  });

  // Helper: render the header with given props and a given route.
  // `rootTags` lives in the store (published by the shared nav loader), not in
  // the props, so it is set per render here.
  function renderWith(routeOverride, propsOverride = {}, rootTags = []) {
    store.set('route', routeOverride);
    store.set('rootTags', rootTags);
    const header = new BreadcrumbsComponent(container, {
      settings: { blog_title: 'Test Blog' },
      navTags: [],
      breadcrumb: [],
      total: 0,
      timelineVisible: false,
      ...propsOverride,
    });
    return header.render();
  }

  // ── Year crumb ────────────────────────────────────────────────────────────

  test('year crumb is visible when timelineVisible is false and years are set', () => {
    const markup = renderWith(
      { pathname: '/', query: { timeline: '2020-2021' } },
      { timelineVisible: false },
    );
    assert.ok(markup.includes('2020'), 'Should include 2020');
    assert.ok(markup.includes('2021'), 'Should include 2021');
    assert.ok(markup.includes('breadcrumb-year'), 'Should have breadcrumb-year class');
  });

  test('year crumb is suppressed when timelineVisible is true', () => {
    const markup = renderWith(
      { pathname: '/', query: { timeline: '2020-2021' } },
      { timelineVisible: true },
    );
    assert.ok(!markup.includes('breadcrumb-year'), 'Should NOT render year crumb when timelineVisible');
    // Years should not appear as a facet crumb (they may still appear inside aria-live text if any)
    // but no breadcrumb-year span should exist
  });

  test('single-year range renders without dash', () => {
    const markup = renderWith(
      { pathname: '/', query: { timeline: '2019-2019' } },
      { timelineVisible: false },
    );
    assert.ok(markup.includes('2019'), 'Should include year');
    // Should NOT include a dash between the same year
    assert.ok(!markup.includes('2019–2019'), 'Should not render a dash for single year');
  });

  test('multi-year range renders with en-dash', () => {
    const markup = renderWith(
      { pathname: '/', query: { timeline: '2018-2022' } },
      { timelineVisible: false },
    );
    // en-dash = U+2013
    assert.ok(markup.includes('2018–2022'), 'Should render en-dash between year range');
  });

  // ── Query crumb ───────────────────────────────────────────────────────────

  test('query crumb rendered when vc.query is set', () => {
    const markup = renderWith(
      { pathname: '/search', query: { q: 'beach' } },
      { breadcrumb: [{ name: 'search' }] },
    );
    assert.ok(markup.includes('breadcrumb-query'), 'Should have breadcrumb-query class');
    assert.ok(markup.includes('beach'), 'Should include query text');
  });

  test('query crumb not rendered when no query', () => {
    const markup = renderWith(
      { pathname: '/', query: {} },
    );
    assert.ok(!markup.includes('breadcrumb-query'), 'Should not have breadcrumb-query when no query');
  });

  // ── Root "site" crumb ─────────────────────────────────────────────────────

  test('root site crumb always present', () => {
    const markup = renderWith({ pathname: '/', query: {} });
    assert.ok(markup.includes('crumb-site'), 'Should always render site crumb');
    assert.ok(markup.includes('href="/"'), 'Site crumb should link to /');
    assert.ok(markup.includes('Test Blog'), 'Site crumb should display blog title');
  });

  test('site crumb is a plain home link when there are no root tags', () => {
    const markup = renderWith(
      { pathname: '/', query: {} },
      { navTags: [{ name: 'Links', slug: '', url: '/about' }] },
    );
    assert.ok(!markup.includes('has-dropdown'), 'Site crumb should not render a dropdown');
    assert.ok(!markup.includes('aria-haspopup'), 'Site crumb should not announce a popup');
  });

  test('site crumb gets a root-tag dropdown when the store has root tags', () => {
    const markup = renderWith(
      { pathname: '/', query: {} },
      {},
      [{ name: 'Travel', slug: 'travel', post_count: 10 }],
    );
    assert.ok(markup.includes('crumb-site'), 'Should still render the site crumb');
    assert.ok(markup.includes('has-dropdown'), 'Site crumb should advertise a dropdown');
    assert.ok(markup.includes('aria-haspopup="true"'), 'Site crumb should announce a popup');
  });

  test('site crumb dropdown is independent of the menu (custom-mode case)', () => {
    // Custom mode: navTags holds authored links, so the root tags reach the
    // header only through the store — and only through this dropdown.
    const markup = renderWith(
      { pathname: '/tags/travel', query: {} },
      {
        navTags: [{ name: 'About', slug: '', url: '/about' }],
        breadcrumb: [{ name: 'Travel', slug: 'travel' }],
      },
      [{ name: 'Travel', slug: 'travel', post_count: 10 }],
    );
    assert.ok(markup.includes('crumb-site has-dropdown'), 'Site crumb should carry the dropdown');
  });

  // ── Aria-live announcement ────────────────────────────────────────────────

  test('aria-live text included when active facets exist', () => {
    const markup = renderWith(
      { pathname: '/tags/travel', query: { timeline: '2020-2021' } },
      { total: 5, breadcrumb: [{ name: 'travel', slug: 'travel' }], timelineVisible: false },
    );
    assert.ok(markup.includes('aria-live="polite"'), 'Should have aria-live');
    assert.ok(markup.includes('Showing'), 'Should include Showing text');
    assert.ok(markup.includes('5 posts'), 'Should include post count in aria-live');
  });
});
