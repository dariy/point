/**
 * ToastContainer — the optional action button.
 *
 * A toast normally only reports. An `action` turns it into the *offer* a
 * destructive step makes instead of asking permission first — the carousel
 * studio's "Layer removed. Undo" is the first caller. These pin the two things
 * that make that offer safe: it is only rendered when there is something to
 * run, and pressing it dismisses the toast, so the step cannot be applied twice
 * from one affordance.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click } from './helpers/dom.js';

describe('toast action', () => {
  let dom, ToastContainer, host, container;

  beforeEach(async () => {
    dom = setupDOM();
    ({ ToastContainer } = await import('../src/components/shared/Toast.js'));
    host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    container = new ToastContainer(host);
    container.mount();
  });

  afterEach(() => {
    container?.unmount();
    dom.cleanup();
  });

  const toast = () => host.querySelector('.toast');
  const action = () => host.querySelector('.toast-action');

  test('a toast without an action renders only the message and the dismiss', () => {
    container._add({ message: 'Saved.', type: 'success' });
    assert.equal(toast().querySelector('.toast-message').textContent, 'Saved.');
    assert.equal(action(), null);
    assert.ok(toast().querySelector('.toast-close'));
  });

  test('an action renders as a button carrying its label', () => {
    container._add({ message: 'Layer removed.', action: { label: 'Undo', onAction() {} } });
    assert.equal(action().textContent, 'Undo');
  });

  test('an action with no handler is not offered', () => {
    // A half-built payload would otherwise render a button that does nothing,
    // which reads as "the undo is broken" rather than "there is no undo".
    container._add({ message: 'Gone.', action: { label: 'Undo' } });
    assert.equal(action(), null);
  });

  test('pressing the action runs it once and takes the toast with it', () => {
    let ran = 0;
    container._add({ message: 'Layer removed.', action: { label: 'Undo', onAction: () => ran++ } });
    const btn = action();
    click(btn);
    assert.equal(ran, 1);
    assert.equal(container._toasts.length, 0, 'the toast is dismissed');

    // The node is detached asynchronously (a transition), but the entry is gone,
    // so a second press cannot apply the step again.
    click(btn);
    assert.equal(ran, 1);
  });

  test('the label falls back to Undo, the only caller so far', () => {
    container._add({ message: 'Gone.', action: { onAction() {} } });
    assert.equal(action().textContent, 'Undo');
  });
});
