import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock, memoryStorage, nodeList } from './helpers/mock.ts';
import type { SiteCrumbProps } from '../src/components/public/SiteCrumb.ts';

// The blog title lives in the header, not the breadcrumbs plugin, so it (and
// its root-tag dropdown) survive that plugin being switched off.
type RootTag = ReturnType<typeof import('../src/store.ts').getRootTags>[number];

describe('SiteCrumb', () => {
  let SiteCrumb: typeof import('../src/components/public/SiteCrumb.ts').SiteCrumb;
  let setRootTags: typeof import('../src/store.ts').setRootTags;
  let container: HTMLElement;

  before(async () => {
    globalThis.document = mock<Document>({
      createElement: () => mock<HTMLElement>({
        appendChild: <T extends Node>(n: T) => n,
        remove: () => {},
        classList: mock<DOMTokenList>({ add: () => {}, remove: () => {} }),
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => nodeList<Element>([]),
        innerHTML: '',
        textContent: '',
        style: mock<CSSStyleDeclaration>({}),
      }),
      head: mock<HTMLHeadElement>({ appendChild: <T extends Node>(n: T) => n }),
      body: mock<HTMLElement>({ classList: mock<DOMTokenList>({ remove: () => {}, add: () => {} }) }),
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => nodeList<Element>([]),
    });
    globalThis.window = mock<typeof window>({
      location: mock<Location>({ pathname: '/', search: '', origin: 'http://localhost' }),
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
    });
    globalThis.localStorage = memoryStorage();

    ({ setRootTags } = await import('../src/store.ts'));
    ({ SiteCrumb } = await import('../src/components/public/SiteCrumb.ts'));

    let innerHTML = '';
    container = mock<HTMLElement>({
      querySelector: () => null,
      querySelectorAll: () => nodeList<Element>([]),
      set innerHTML(val: string) { innerHTML = val; },
      get innerHTML() { return innerHTML; },
      textContent: '',
    });
  });

  function renderWith(props: SiteCrumbProps = {}, rootTags: RootTag[] = []) {
    setRootTags(rootTags);
    return new SiteCrumb(container, {
      settings: { blog_title: 'Test Blog' },
      hasTrail: false,
      ...props,
    }).render().toString();
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
    const markup = renderWith({}, [mock<RootTag>({ name: 'Travel', slug: 'travel', post_count: 10 })]);
    assert.ok(markup.includes('has-dropdown'), 'Should advertise a dropdown');
    assert.ok(markup.includes('aria-haspopup="true"'), 'Should announce a popup');
  });

  test('show_title_dropdown=false drops it even when root tags exist', () => {
    const tags = [mock<RootTag>({ name: 'Travel', slug: 'travel', post_count: 10 })];
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
