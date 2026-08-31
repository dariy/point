import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';
import { NavMenu } from '../src/plugins/nav-menu/NavMenu.js';

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
