import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { captureInteraction, preserveInteraction } from '../src/utils/preserveInteraction.js';

/**
 * preserveInteraction — focus, caret and scroll across a rebuild.
 *
 * The failure this prevents is small and constant: a search box loses focus
 * mid-word every time its results reload. The failure it must not introduce is
 * larger — restoring focus to the WRONG control, which is why an ambiguous
 * selector restores nothing at all.
 *
 * linkedom has no focus model, so the harness supplies the two halves a browser
 * has: el.focus() setting document.activeElement, and setSelectionRange()
 * (patched in helpers/dom.js) recording the caret.
 */

let dom;

beforeEach(() => {
  dom = setupDOM();
  // linkedom implements neither focus() nor activeElement; both are load-bearing
  // here, and a stub on the prototype is the smallest thing that behaves.
  const proto = window.HTMLElement.prototype;
  proto.focus = function focus() { dom.document._active = this; };
  Object.defineProperty(dom.document, 'activeElement', {
    configurable: true,
    // Detaching the focused node hands focus back to the body — which is the
    // state every one of these tests starts the restore from, so a stub that
    // kept pointing at the removed node would make them all pass for free.
    get() {
      return this._active && this.body.contains(this._active) ? this._active : this.body;
    },
  });
});
afterEach(() => dom.cleanup());

function container(markup) {
  const el = document.createElement('div');
  el.innerHTML = markup;
  document.body.appendChild(el);
  return el;
}

describe('preserveInteraction', () => {
  test('puts focus and the caret back after a rebuild', () => {
    const el = container('<input id="search" name="q" value="hello">');
    const input = el.querySelector('#search');
    input.focus();
    input.setSelectionRange(2, 2);

    preserveInteraction(el, () => {
      el.innerHTML = '<input id="search" name="q" value="hello">';
    });

    const after = el.querySelector('#search');
    assert.equal(document.activeElement, after);
    assert.notEqual(after, input, 'the rebuild really did replace the node');
    assert.equal(after.selectionStart, 2);
    assert.equal(after.selectionEnd, 2);
  });

  test('restores the caret where it was, not at the end', () => {
    const el = container('<textarea id="body">abcdef</textarea>');
    const box = el.querySelector('#body');
    box.value = 'abcdef';
    box.focus();
    box.setSelectionRange(1, 4);

    preserveInteraction(el, () => { el.innerHTML = '<textarea id="body">abcdef</textarea>'; });

    const after = el.querySelector('#body');
    assert.equal(after.selectionStart, 1);
    assert.equal(after.selectionEnd, 4);
  });

  test('clamps a caret the rebuild left past the end of the value', () => {
    const el = container('<input id="search" value="hello">');
    const input = el.querySelector('#search');
    input.focus();
    input.setSelectionRange(5, 5);

    preserveInteraction(el, () => { el.innerHTML = '<input id="search" value="hi">'; });

    const after = el.querySelector('#search');
    assert.equal(after.selectionStart, 2);
  });

  test('falls back to name, then to data-action', () => {
    const byName = container('<input name="q">');
    byName.querySelector('input').focus();
    preserveInteraction(byName, () => { byName.innerHTML = '<input name="q">'; });
    assert.equal(document.activeElement, byName.querySelector('input'));

    const byAction = container('<button data-action="save">Save</button>');
    byAction.querySelector('button').focus();
    preserveInteraction(byAction, () => { byAction.innerHTML = '<button data-action="save">Save</button>'; });
    assert.equal(document.activeElement, byAction.querySelector('button'));
  });

  test('restores nothing when the selector would be ambiguous', () => {
    const el = container(
      '<button data-action="delete">1</button><button data-action="delete">2</button>',
    );
    el.querySelectorAll('button')[1].focus();

    preserveInteraction(el, () => {
      el.innerHTML = '<button data-action="delete">1</button><button data-action="delete">2</button>';
    });

    assert.equal(document.activeElement, document.body,
      'focusing the first row would be a wrong answer that looks like a right one');
  });

  test('restores nothing when the element did not come back', () => {
    const el = container('<input id="search">');
    el.querySelector('#search').focus();
    preserveInteraction(el, () => { el.innerHTML = '<p>gone</p>'; });
    assert.equal(document.activeElement, document.body);
  });

  test('ignores focus that was never inside the container', () => {
    const outside = container('<input id="elsewhere">');
    const el = container('<input id="search">');
    outside.querySelector('#elsewhere').focus();

    preserveInteraction(el, () => { el.innerHTML = '<input id="search">'; });

    assert.equal(document.activeElement, outside.querySelector('#elsewhere'),
      'left where it was, not stolen into the rebuilt container');
  });

  test('carries the container scroll offset across the rebuild', () => {
    const el = container('<p>tall</p>');
    el.scrollTop = 240;
    el.scrollLeft = 12;

    preserveInteraction(el, () => { el.innerHTML = '<p>tall</p>'; el.scrollTop = 0; el.scrollLeft = 0; });

    assert.equal(el.scrollTop, 240);
    assert.equal(el.scrollLeft, 12);
  });

  test('restores even when the rebuild throws, and lets the error through', () => {
    const el = container('<input id="search">');
    el.querySelector('#search').focus();
    const boom = new Error('render failed');

    assert.throws(() => preserveInteraction(el, () => { throw boom; }), /render failed/);
    assert.equal(document.activeElement, el.querySelector('#search'));
  });

  test('returns what the rebuild returned', () => {
    const el = container('<p></p>');
    assert.equal(preserveInteraction(el, () => 42), 42);
  });

  test('captureInteraction defers the restore for an async rebuild', async () => {
    const el = container('<input id="search" value="ab">');
    el.querySelector('#search').focus();
    el.querySelector('#search').setSelectionRange(1, 1);

    const restore = captureInteraction(el);
    await Promise.resolve();
    el.innerHTML = '<input id="search" value="ab">';
    const restored = restore();

    assert.equal(restored, el.querySelector('#search'));
    assert.equal(document.activeElement, restored);
    assert.equal(restored.selectionStart, 1);
  });

  test('the restore is safe to run twice', () => {
    const el = container('<input id="search">');
    el.querySelector('#search').focus();
    const restore = captureInteraction(el);
    el.innerHTML = '<input id="search">';
    assert.equal(restore(), el.querySelector('#search'));
    assert.equal(restore(), el.querySelector('#search'));
  });
});
