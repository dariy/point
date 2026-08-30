import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click } from './helpers/dom.js';

/**
 * The body scroll lock overlays take out while they are open.
 *
 * Two defects motivated the shared helper, and both left the admin looking at a
 * page that would not scroll with nothing on screen to explain why:
 *
 *  - the lock was cleared by assigning '' rather than restoring the previous
 *    value, so an inner dialog closing unlocked the page underneath an outer
 *    overlay that was still open;
 *  - the lock was released only from the overlay's own close handler, which is
 *    not what runs when Component._rerender() unmounts the overlay instead —
 *    and that happens on every setState() of the page holding it.
 */

let dom;
let lock;

beforeEach(async () => {
  dom = setupDOM();
  lock ??= await import('../src/utils/scrollLock.js');
});
afterEach(() => {
  dom.cleanup();
});

describe('scrollLock', () => {
  test('the first acquire pins the body, the last release restores it', () => {
    const owner = {};
    lock.acquireScrollLock(owner);
    assert.equal(document.body.style.overflow, 'hidden');
    assert.equal(lock.isScrollLocked(), true);

    lock.releaseScrollLock(owner);
    assert.equal(document.body.style.overflow, '');
    assert.equal(lock.isScrollLocked(), false);
  });

  test('restores whatever the body had before, not the empty string', () => {
    document.body.style.overflow = 'scroll';
    const owner = {};

    lock.acquireScrollLock(owner);
    lock.releaseScrollLock(owner);

    assert.equal(document.body.style.overflow, 'scroll');
  });

  test('an inner overlay closing does not unlock the outer one', () => {
    const outer = {};
    const inner = {};

    lock.acquireScrollLock(outer);
    lock.acquireScrollLock(inner);
    lock.releaseScrollLock(inner);

    assert.equal(document.body.style.overflow, 'hidden', 'outer overlay is still open');

    lock.releaseScrollLock(outer);
    assert.equal(document.body.style.overflow, '');
  });

  test('acquiring twice as the same owner still takes one release', () => {
    const owner = {};
    lock.acquireScrollLock(owner);
    lock.acquireScrollLock(owner);
    assert.equal(lock.scrollLockOwnerCount(), 1);

    lock.releaseScrollLock(owner);
    assert.equal(document.body.style.overflow, '');
  });

  test('a repeat acquire does not re-record the already-locked value', () => {
    const first = {};
    const second = {};

    lock.acquireScrollLock(first);
    lock.acquireScrollLock(second);
    lock.releaseScrollLock(first);
    lock.releaseScrollLock(second);

    assert.equal(document.body.style.overflow, '', 'must not restore "hidden"');
  });

  test('releasing an owner that holds nothing is a no-op', () => {
    const holder = {};
    lock.acquireScrollLock(holder);
    lock.releaseScrollLock({});

    assert.equal(document.body.style.overflow, 'hidden');
    lock.releaseScrollLock(holder);
    assert.equal(lock.scrollLockOwnerCount(), 0);
  });
});

describe('overlays release the lock when they are unmounted', () => {
  test('CommandPalette', async () => {
    const { CommandPalette } = await import('../src/components/light/CommandPalette.js');
    const host = document.createElement('div');
    document.body.appendChild(host);

    const palette = new CommandPalette(host, {});
    palette.mount();
    palette.open();
    assert.equal(document.body.style.overflow, 'hidden');

    // What a page setState() does to it: torn out, never closed.
    palette.unmount();
    assert.equal(document.body.style.overflow, '', 'page must scroll again');
    assert.equal(lock.isScrollLocked(), false);
  });

  test('ShortcutHelp', async () => {
    const { ShortcutHelp } = await import('../src/components/light/ShortcutHelp.js');
    const host = document.createElement('div');
    document.body.appendChild(host);

    const help = new ShortcutHelp(host, {});
    help.mount();
    help.open();
    assert.equal(document.body.style.overflow, 'hidden');

    help.unmount();
    assert.equal(document.body.style.overflow, '');
  });

  test('AdminBottomBar — its own re-render closes the More sheet', async () => {
    const { AdminBottomBar } = await import('../src/components/light/AdminBottomBar.js');
    const host = document.createElement('div');
    document.body.appendChild(host);

    const bar = new AdminBottomBar(host, {});
    bar.mount();
    click(host.querySelector('#bottom-bar-more'));
    assert.equal(document.body.style.overflow, 'hidden');

    // The sheet's open state is a class on the overlay, so a re-render loses it.
    bar.setState({});
    assert.equal(host.querySelector('#more-sheet-overlay').classList.contains('active'), false);
    assert.equal(document.body.style.overflow, '', 'the lock must go with the sheet');

    bar.unmount();
    assert.equal(lock.isScrollLocked(), false);
  });
});
