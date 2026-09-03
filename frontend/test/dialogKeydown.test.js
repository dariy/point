/**
 * The document-level Escape handler the picker dialogs bind while they are open.
 *
 * Same shape as the body scroll lock in scrollLock.test.js: the handler is
 * bound in open() and dropped in close(), but close() is not what runs when the
 * dialog is torn out of the DOM instead — a re-render of the page holding it
 * unmounts it. Left behind, the listener calls close() on a dead component on
 * every Escape, for the life of the page.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, fire } from './helpers/dom.js';

const settle = () => new Promise(r => setImmediate(r));
const escape = () => fire(document, 'keydown', { key: 'Escape' });

describe('picker dialogs drop their Escape handler when unmounted', () => {
  let dom, savedFetch;

  beforeEach(() => {
    dom = setupDOM();
    savedFetch = globalThis.fetch;
    // Neither dialog is under test for what it loads; it only has to not throw.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      text: async () => '{}',
    });
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    dom.cleanup();
  });

  test('MediaPickerDialog', async () => {
    const { MediaPickerDialog } = await import('../src/components/light/MediaPickerDialog.js');
    const picker = new MediaPickerDialog({ onConfirm: () => {} });
    picker.mount();
    picker.open();
    await settle();

    // While open, Escape is the dialog's own close.
    escape();
    assert.equal(picker.container.classList.contains('active'), false);

    picker.open();
    await settle();
    let closes = 0;
    picker.close = () => { closes++; };

    // What a page setState() does to it: torn out, never closed.
    picker.unmount();
    escape();
    assert.equal(closes, 0, 'the unmounted dialog must not hear Escape');
  });

  test('PhotoLibraryPickerDialog', async () => {
    const { PhotoLibraryPickerDialog } = await import(
      '../src/components/light/PhotoLibraryPickerDialog.js'
    );
    const picker = new PhotoLibraryPickerDialog({ onImport: () => {} });
    picker.open();
    await settle();

    escape();
    assert.equal(picker.container.classList.contains('active'), false);

    picker.open();
    await settle();
    let closes = 0;
    picker.close = () => { closes++; };

    picker.unmount();
    escape();
    assert.equal(closes, 0, 'the unmounted dialog must not hear Escape');
  });
});
