// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// The blog title lives in the header, not the breadcrumbs plugin, so it (and
// its root-tag dropdown) survive that plugin being switched off.
describe('SiteCrumb', () => {
  let SiteCrumb;
  let store;
  let container;

  before(async () => {
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
      location: { pathname: '/', search: '', origin: 'http://localhost' },
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
    };
    global.localStorage = { getItem: () => null, setItem: () => {} };

    ({ store } = await import('../src/store.js'));
    ({ SiteCrumb } = await import('../src/components/public/SiteCrumb.js'));

    container = {
      querySelector: () => null,
      querySelectorAll: () => [],
      set innerHTML(val) { this._innerHTML = val; },
      get innerHTML() { return this._innerHTML || ''; },
      textContent: '',
    };
  });

  function renderWith(props = {}, rootTags = []) {
    store.set('rootTags', rootTags);
    return new SiteCrumb(container, {
      settings: { blog_title: 'Test Blog' },
      hasTrail: false,
      ...props,
    }).render();
  }

  test('renders the blog title as the home link', () => {
    const markup = renderWith();
    assert.ok(markup.includes('crumb-site'), 'Should render the site crumb');
    assert.ok(markup.includes('href="/"'), 'Should link to /');
    assert.ok(markup.includes('Test Blog'), 'Should show the blog title');
  });

  test('stands alone as the current crumb, or heads a trail with a separator', () => {
    const alone = renderWith({ hasTrail: false });
    assert.ok(alone.includes('breadcrumb-current'), 'Alone it is the current crumb');
    assert.ok(!alone.includes('breadcrumb-separator'), 'Alone it needs no separator');

    const heading = renderWith({ hasTrail: true });
    assert.ok(heading.includes('breadcrumb-link'), 'With a trail it is a link');
    assert.ok(heading.includes('breadcrumb-separator'), 'With a trail it draws a separator');
  });

  test('no dropdown without root tags', () => {
    const markup = renderWith({}, []);
    assert.ok(!markup.includes('has-dropdown'), 'Should not advertise a dropdown');
    assert.ok(!markup.includes('aria-haspopup'), 'Should not announce a popup');
  });

  test('root tags in the store give it a dropdown', () => {
    const markup = renderWith({}, [{ name: 'Travel', slug: 'travel', post_count: 10 }]);
    assert.ok(markup.includes('has-dropdown'), 'Should advertise a dropdown');
    assert.ok(markup.includes('aria-haspopup="true"'), 'Should announce a popup');
  });

  test('show_title_dropdown=false drops it even when root tags exist', () => {
    const tags = [{ name: 'Travel', slug: 'travel', post_count: 10 }];
    for (const value of [false, 'false']) {
      const markup = renderWith(
        { settings: { blog_title: 'Test Blog', show_title_dropdown: value } },
        tags,
      );
      assert.ok(markup.includes('Test Blog'), 'Title still renders');
      assert.ok(!markup.includes('has-dropdown'), `Dropdown off for ${JSON.stringify(value)}`);
    }
  });
});
