import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  hideFlyout,
  flyoutEl,
  hideFlyoutWithin,
  showCrumbDropdown,
  attachFlyoutTrigger,
  setupTagFlyout,
  createHotZone
} from '../src/utils/tagFlyout.js';
import { setupScrollableStrip, setupTagStrip } from '../src/utils/tagStrip.js';

describe('tags flyout and UI', () => {
  let anchorEl, excludeEl, navigateFn;

  beforeEach(() => {
    // Basic DOM mocking for these tests
    global.window = {
      location: { origin: 'https://example.com' },
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const createEl = (tag) => {
      const e = {
        tagName: tag.toUpperCase(),
        className: '',
        classList: {
          add: (c) => e.className += ` ${c}`,
          remove: (c) => e.className = e.className.replace(new RegExp(`\\b${c}\\b`, 'g'), '').trim(),
          contains: (c) => e.className.includes(c),
          toggle: (c, state) => {
            const has = e.classList.contains(c);
            if (state === undefined) state = !has;
            if (state && !has) e.classList.add(c);
            if (!state && has) e.classList.remove(c);
            return state;
          }
        },
        style: {},
        appendChild: () => {},
        removeChild: () => {},
        firstChild: null,
        innerHTML: '',
        href: '',
        pathname: '',
        search: '',
        hash: '',
        getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 100, right: 200, width: 100, height: 20 }),
        addEventListener: () => {},
        removeEventListener: () => {},
        contains: () => false,
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getAttribute: () => null,
      };
      return e;
    };

    global.document = {
      createElement: createEl,
      body: createEl('body'),
      documentElement: createEl('html'),
      head: createEl('head'),
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    anchorEl = document.createElement('div');
    excludeEl = document.createElement('div');
    navigateFn = () => {};
    
    // reset flyout state
    hideFlyout();
  });

  afterEach(() => {
    hideFlyout();
  });

  test('flyoutEl returns the singleton', () => {
    const el = flyoutEl();
    assert.strictEqual(el, null); // since it hasn't been created yet
    // showCrumbDropdown will create it
    showCrumbDropdown(anchorEl, [{ name: 'Test', slug: 'test' }], navigateFn);
    assert.ok(flyoutEl() !== null);
    assert.ok(flyoutEl().className.includes('tag-family-flyout'));
  });

  test('hideFlyout hides the flyout', () => {
    showCrumbDropdown(anchorEl, [{ name: 'Test', slug: 'test' }], navigateFn);
    assert.ok(!flyoutEl().classList.contains('hidden'));
    hideFlyout();
    assert.ok(flyoutEl().classList.contains('hidden'));
    assert.ok(!anchorEl.classList.contains('is-flyout-open'));
  });

  test('hideFlyoutWithin hides if trigger is inside root', () => {
    showCrumbDropdown(anchorEl, [{ name: 'Test', slug: 'test' }], navigateFn);
    
    const root = document.createElement('div');
    root.contains = (el) => el === anchorEl;
    
    hideFlyoutWithin(root);
    assert.ok(flyoutEl().classList.contains('hidden'));
  });
  
  test('hideFlyoutWithin ignores if trigger is not inside root', () => {
    showCrumbDropdown(anchorEl, [{ name: 'Test', slug: 'test' }], navigateFn);
    
    const root = document.createElement('div');
    root.contains = () => false;
    
    hideFlyoutWithin(root);
    assert.ok(!flyoutEl().classList.contains('hidden'));
  });

  test('showCrumbDropdown flat list', () => {
    showCrumbDropdown(anchorEl, [{ name: 'Test', slug: 'test', count: 5 }], navigateFn);
    const flyout = flyoutEl();
    assert.ok(!flyout.classList.contains('hidden'));
    assert.ok(anchorEl.classList.contains('is-flyout-open'));
  });

  test('showCrumbDropdown structured list with locks and counts', () => {
    showCrumbDropdown(anchorEl, { 
      path: [
        { name: 'Parent', href: '/tags/parent', is_hidden: false, current: false },
        { name: 'HiddenParent', href: '/tags/hidden', is_hidden: true, current: true }
      ],
      children: [
        { name: 'Test', slug: 'test', count: 5, is_hidden: true },
        { name: 'NoCount', slug: 'nocount', is_hidden: false } // no count property
      ]
    }, navigateFn);
    
    const flyout = flyoutEl();
    assert.ok(!flyout.classList.contains('hidden'));
    assert.ok(anchorEl.classList.contains('is-flyout-open'));
  });

  test('attachFlyoutTrigger attaches hover/click listeners', () => {
    let listeners = {};
    anchorEl.addEventListener = (event, fn) => { listeners[event] = fn; };
    attachFlyoutTrigger(anchorEl, () => [], navigateFn);
    
    assert.ok(listeners['pointerenter']);
    assert.ok(listeners['pointerleave']);
    assert.ok(listeners['click']);
  });

  test('setupTagFlyout binds handlers', () => {
    const container = document.createElement('div');
    const link = document.createElement('a');
    link.getAttribute = () => '/tags/foo';
    container.querySelectorAll = () => [link];
    
    const index = new Map([['foo', { tag: { name: 'Foo', slug: 'foo', count: 1 } }]]);
    const cleanup = setupTagFlyout(container, index, navigateFn);
    
    assert.strictEqual(typeof cleanup, 'function');
    cleanup();
  });

  test('setupScrollableStrip', () => {
    const trackEl = document.createElement('div');
    const scrollEl = document.createElement('div');
    
    trackEl.querySelector = () => document.createElement('button');
    
    let observed = false;
    global.ResizeObserver = class {
      observe() { observed = true; }
      disconnect() {}
    };
    
    global.requestAnimationFrame = (fn) => fn();
    
    const cleanup = setupScrollableStrip(trackEl, scrollEl);
    assert.ok(observed);
    assert.strictEqual(typeof cleanup, 'function');
    cleanup();
  });

  test('setupTagStrip', () => {
    const container = document.createElement('div');
    const track = document.createElement('div');
    const scroll = document.createElement('div');
    
    container.querySelector = (sel) => {
      if (sel === '.tag-strip-track') return track;
      if (sel === '.tag-strip-scroll') return scroll;
      return null;
    };
    
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    global.requestAnimationFrame = (fn) => fn();
    
    const cleanup = setupTagStrip(container, new Map(), navigateFn);
    assert.strictEqual(typeof cleanup, 'function');
    cleanup();
  });

  test('createHotZone tracks mousemove', () => {
    let listener = null;
    document.addEventListener = (e, fn) => { listener = fn; };
    document.removeEventListener = () => { listener = null; };
    
    let left = false;
    const hz = createHotZone(() => [anchorEl], () => { left = true; });
    assert.ok(listener);
    
    // Simulate move inside
    listener({ clientX: 150, clientY: 110 });
    assert.ok(!left);
    
    // Simulate move outside
    listener({ clientX: 300, clientY: 300 });
    assert.ok(left);
    
    hz.stop();
  });
});
