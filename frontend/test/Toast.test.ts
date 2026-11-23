import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM, must } from './helpers/dom.ts';
import { ToastContainer } from '../src/components/shared/Toast.ts';

// A toast with an action (the "Undo" after a delete) shows a button. A click
// runs the action once and closes the toast.
describe('ToastContainer action', () => {
  let dom: ReturnType<typeof setupDOM>;
  let toasts: ToastContainer;
  let el: HTMLElement;

  beforeEach(() => {
    dom = setupDOM();
    el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    toasts = new ToastContainer(el);
  });

  afterEach(() => {
    for (const t of [...toasts._toasts]) toasts._remove(t.id);
    dom.cleanup();
  });

  test('a toast without an action has no action button', () => {
    toasts._add({ message: 'Saved.', type: 'success' });
    assert.strictEqual(el.querySelector('.toast-action'), null);
  });

  test('the action button runs the action and closes the toast', () => {
    let calls = 0;
    toasts._add({ message: 'Moved to Trash.', type: 'success', action: { label: 'Undo', onClick: () => { calls++; } } });
    const btn = must(el.querySelector<HTMLButtonElement>('.toast-action'));
    assert.strictEqual(btn.textContent, 'Undo');

    btn.click();

    assert.strictEqual(calls, 1);
    assert.strictEqual(toasts._toasts.length, 0);
  });
});
