import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('Breadcrumbs plugin', () => {
  let BreadcrumbsComponent;
  let setRoute;
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

    ({ setRoute } = await import('../src/store.js'));

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

  // Helper: render the trail with given props and a given route
  function renderWith(routeOverride, propsOverride = {}) {
    setRoute(routeOverride);
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

  test('the blog title is not rendered here', () => {
    // It is the header's SiteCrumb (see components/public/SiteCrumb.js) so that
    // switching this plugin off leaves the site identity — and its root-tag
    // dropdown — standing. This component starts at the first tag crumb.
    const markup = renderWith(
      { pathname: '/', query: {} },
      { breadcrumb: [{ name: 'Travel', slug: 'travel' }] },
    );
    assert.ok(!markup.includes('crumb-site'), 'Should not render the site crumb');
    assert.ok(!markup.includes('Test Blog'), 'Should not render the blog title');
    assert.ok(markup.includes('Travel'), 'Should render the tag crumb');
  });

  // ── Crumb hrefs ───────────────────────────────────────────────────────────

  // A crumb's href comes from tag.url, which the owner sets in the tags manager
  // — and the trail renders on every public page. It used to be interpolated
  // with escapeHtml (which leaves `javascript:` intact) on the last crumb, and
  // with nothing at all on the others, so a quote in it closed the attribute
  // and everything after it became live attributes on the <a>.
  test('a hostile crumb href cannot escape the attribute or run a protocol', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>x</script>', '//evil.example/x']) {
      const markup = String(renderWith(
        { pathname: '/', query: {} },
        { breadcrumb: [{ name: 'A', slug: 'a', href }] },
      ));
      assert.match(markup, /href="#"/, href);
      assert.ok(!markup.includes(href), 'the raw value never reaches the attribute: ' + href);
    }
  });

  test('a quote in a non-terminal crumb href stays inside the attribute', () => {
    const markup = String(renderWith(
      { pathname: '/', query: {} },
      { breadcrumb: [{ name: 'A', slug: 'a', href: '/x" onmouseover="alert(1)' },
                     { name: 'B', slug: 'b' }] },
    ));
    // The text is still there, but entity-escaped inside the value rather than
    // sitting between two real quotes where the parser would read an attribute.
    assert.ok(!markup.includes('" onmouseover="'), 'no attribute broke out of the href');
    assert.match(markup, /&quot; onmouseover=&quot;/, 'the quotes are escaped in place');
  });

  test('an ordinary crumb href is left alone', () => {
    const markup = String(renderWith(
      { pathname: '/', query: {} },
      { breadcrumb: [{ name: 'A', slug: 'a', href: '/tags/a?x=1&y=2' }] },
    ));
    assert.match(markup, /href="\/tags\/a\?x=1&amp;y=2"/);
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
