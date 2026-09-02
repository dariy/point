import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';
import { NavMenu } from '../src/plugins/nav-menu/NavMenu.js';
import { setUser, store } from '../src/store.js';
import { pluginHost } from '../src/core/pluginHost.js';

// The More ▾ panel renders admin-authored menu items into the PUBLIC header.
// It used to be built with a bare template literal wrapped in raw(), which put
// both the name and the href outside the escaping helper entirely.
describe('NavMenu More panel escaping', () => {
  let dom;
  let navItemsEl;
  let menu;

  beforeEach(() => {
    dom = setupDOM();
    navItemsEl = dom.document.createElement('div');
    navItemsEl.innerHTML = '<div class="nav-more"><div class="nav-more-panel"></div></div>';
    dom.document.body.appendChild(navItemsEl);
    menu = new NavMenu({
      navItemsEl,
      burgerTagsEl: dom.document.createElement('div'),
      burgerSitemapEl: dom.document.createElement('div'),
      ctx: {},
    });
    menu._inline = [];
  });

  afterEach(() => {
    dom.cleanup();
  });

  /** Populate the panel from config-overflow items only (nothing folded). */
  const syncWith = (items) => {
    menu._configOverflow = items;
    menu._syncMore();
    return navItemsEl.querySelector('.nav-more-item');
  };

  test('a script tag in an item name renders as text, not as an element', () => {
    const link = syncWith([
      { name: '<script>alert(1)</script>', href: '/ok', children: [] },
    ]);

    assert.strictEqual(navItemsEl.querySelector('script'), null);
    assert.strictEqual(link.textContent, '<script>alert(1)</script>');
    assert.ok(navItemsEl.innerHTML.includes('&lt;script&gt;'));
  });

  test('a javascript: href is neutralised to #', () => {
    const link = syncWith([
      { name: 'Evil', href: 'javascript:alert(1)', children: [] },
    ]);

    assert.strictEqual(link.getAttribute('href'), '#');
  });

  test('an attribute-breakout href cannot escape the quoted attribute', () => {
    const link = syncWith([
      { name: 'Evil', href: '/ok" onmouseover="alert(1)', children: [] },
    ]);

    // Not http/https/root-relative once the quote is in it — safeUrl rejects
    // the whole string rather than emitting a second attribute.
    assert.strictEqual(link.getAttribute('onmouseover'), null);
    assert.ok(!navItemsEl.innerHTML.includes('onmouseover="'));
  });

  test('an ordinary item still renders its name and href', () => {
    const link = syncWith([
      { name: 'About', href: '/about', children: [] },
    ]);

    assert.strictEqual(link.getAttribute('href'), '/about');
    assert.strictEqual(link.textContent, 'About');
  });

  test('a parent item keeps its caret and has-children class', () => {
    const link = syncWith([
      { name: 'Travel', href: '/travel', children: [{ name: 'Peru', href: '/travel/peru' }] },
    ]);

    assert.ok(link.classList.contains('has-children'));
    assert.ok(link.querySelector('.nav-more-item-caret'));
  });
});

// The nav reads four settings out of a key that holds every public setting and
// is rewritten by every page fetch. Subscribing to the whole key meant any
// save — a blog title, a posts-per-page — rebuilt the menu and closed whatever
// dropdown was open in it.
describe('NavMenu settings subscription', () => {
  let dom;
  let menu;
  let renders;

  beforeEach(() => {
    dom = setupDOM();
    store.set('settings', { blog_title: 'Point', nav_menu_mode: 'tags', nav_inline_max: '4' });
    renders = 0;
    menu = new NavMenu({
      navItemsEl: dom.document.createElement('div'),
      burgerTagsEl: dom.document.createElement('div'),
      burgerSitemapEl: dom.document.createElement('div'),
      ctx: {},
    });
    menu.render = () => { renders++; };
    menu.mount();
    renders = 0;  // mount() renders once; count only what the store causes.
  });

  afterEach(() => {
    menu.unmount();
    dom.cleanup();
  });

  test('a settings write the menu does not read costs no render', () => {
    store.merge('settings', { blog_title: 'Somewhere else' });
    assert.strictEqual(renders, 0);
  });

  test('a re-fetch of identical settings costs no render', () => {
    store.merge('settings', { nav_menu_mode: 'tags', nav_inline_max: '4' });
    assert.strictEqual(renders, 0);
  });

  test('a settings write the menu does read renders once', () => {
    store.merge('settings', { nav_inline_max: '2' });
    assert.strictEqual(renders, 1);
  });

  test('unmount stops the subscription', () => {
    menu.unmount();
    store.merge('settings', { nav_more_title: 'Plus' });
    assert.strictEqual(renders, 0);
    menu.unmount = () => {};  // afterEach must not unmount twice.
  });
});

// Two vizzes, two paths: the graph owns /tags and a map owns /map, so the
// header shows up to two independent icon buttons — one single "active viz"
// icon could only ever point at one of them.
describe('NavMenu viz buttons', () => {
  let dom;
  let navItemsEl;
  let burgerSitemapEl;
  let menu;

  /**
   * Render the nav with `enabled` plugin ids in the manifest.
   * @param {string[]} enabled
   * @param {object} [opts] {visibility, user, currentPath}
   */
  const renderWith = (enabled, opts = {}) => {
    pluginHost.init(enabled.map((id) => ({ id, entry: `/assets/js/p/${id}.js` })));
    store.set('settings', { tags_visibility: opts.visibility || 'all', nav_menu_mode: 'none' });
    setUser(opts.user || null);
    menu = new NavMenu({
      navItemsEl,
      burgerTagsEl: dom.document.createElement('div'),
      burgerSitemapEl,
      ctx: { currentPath: opts.currentPath || '/' },
    });
    menu.render();
    return [...navItemsEl.querySelectorAll('.header-action-btn')];
  };

  beforeEach(() => {
    dom = setupDOM();
    navItemsEl = dom.document.createElement('div');
    burgerSitemapEl = dom.document.createElement('div');
    dom.document.body.append(navItemsEl, burgerSitemapEl);
  });

  afterEach(() => {
    pluginHost.init([]);
    setUser(null);
    dom.cleanup();
  });

  test('graph and map enabled together render one button each', () => {
    const btns = renderWith(['tags-graph', 'tags-atlas']);

    assert.deepStrictEqual(btns.map((b) => b.getAttribute('href')), ['/tags', '/map']);
    assert.deepStrictEqual(btns.map((b) => b.getAttribute('title')), ['All tags', 'Atlas']);
  });

  test('the graph alone renders only the /tags button', () => {
    const btns = renderWith(['tags-graph']);

    assert.deepStrictEqual(btns.map((b) => b.getAttribute('href')), ['/tags']);
  });

  test('a map alone renders only the /map button, with its own icon and label', () => {
    const btns = renderWith(['tags-map']);

    assert.deepStrictEqual(btns.map((b) => b.getAttribute('href')), ['/map']);
    assert.strictEqual(btns[0].getAttribute('aria-label'), 'Map');
  });

  test('no viz enabled renders no buttons', () => {
    assert.deepStrictEqual(renderWith([]), []);
  });

  test('a guest under tags_visibility=hidden gets no buttons', () => {
    const btns = renderWith(['tags-graph', 'tags-atlas'], { visibility: 'hidden' });

    assert.deepStrictEqual(btns, []);
    assert.strictEqual(burgerSitemapEl.querySelector('a[href="/tags"]'), null);
    assert.strictEqual(burgerSitemapEl.querySelector('a[href="/map"]'), null);
  });

  test('an admin sees them even under tags_visibility=hidden', () => {
    const btns = renderWith(['tags-graph', 'tags-atlas'], { visibility: 'hidden', user: { id: 1 } });

    assert.deepStrictEqual(btns.map((b) => b.getAttribute('href')), ['/tags', '/map']);
  });

  test('each button marks itself active on its own path only', () => {
    const onMap = renderWith(['tags-graph', 'tags-atlas'], { currentPath: '/map' });

    assert.ok(!onMap[0].classList.contains('active'));
    assert.ok(onMap[1].classList.contains('active'));

    const onTags = renderWith(['tags-graph', 'tags-atlas'], { currentPath: '/tags' });

    assert.ok(onTags[0].classList.contains('active'));
    assert.ok(!onTags[1].classList.contains('active'));
  });

  test('the burger sitemap lists one link per enabled viz', () => {
    renderWith(['tags-graph', 'tags-map']);

    const links = [...burgerSitemapEl.querySelectorAll('.burger-link')];
    assert.deepStrictEqual(
      links.map((a) => [a.getAttribute('href'), a.textContent]),
      [['/tags', 'All tags'], ['/map', 'Map'], ['/light', 'About']],
    );
  });
});
