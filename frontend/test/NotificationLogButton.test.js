// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';
import { store } from '../src/store.js';
import { NotificationLogButton } from '../src/components/shared/NotificationLogButton.js';

// Toast log entries carry API error text and filenames — values the admin did
// not author. The modal body used to be built with a bare template literal
// wrapped in raw(), so `e.message` reached innerHTML unescaped.
describe('NotificationLogButton modal escaping', () => {
  let dom;
  let btn;
  let body;

  beforeEach(() => {
    dom = setupDOM();
    btn = new NotificationLogButton();
    body = dom.document.createElement('div');
    // Drive _refreshModalContent directly: the escaping is what is under test,
    // not the Modal plumbing that supplies the mount point.
    btn._activeModal = { getBodyMount: () => body };
  });

  afterEach(() => {
    store.set('toast_log', []);
    dom.cleanup();
  });

  test('an img onerror payload in a message renders as text, not as an element', () => {
    store.set('toast_log', [
      { type: 'error', message: '<img src=x onerror=alert(1)>', timestamp: Date.now() },
    ]);
    btn._refreshModalContent();

    assert.strictEqual(body.querySelector('img'), null);
    assert.strictEqual(
      body.querySelector('.notification-log-message').textContent,
      '<img src=x onerror=alert(1)>'
    );
  });

  test('a hostile type falls back to info and cannot inject a class', () => {
    store.set('toast_log', [
      { type: '" onmouseover="alert(1)', message: 'hi', timestamp: Date.now() },
    ]);
    btn._refreshModalContent();

    const item = body.querySelector('.notification-log-item');
    assert.ok(item.classList.contains('notification-log-item-info'));
    assert.strictEqual(item.getAttribute('onmouseover'), null);
  });

  test('an ordinary entry still renders its icon and message', () => {
    store.set('toast_log', [
      { type: 'success', message: 'Saved', timestamp: Date.now() },
    ]);
    btn._refreshModalContent();

    assert.strictEqual(body.querySelector('.notification-log-icon').textContent, '✓');
    assert.strictEqual(body.querySelector('.notification-log-message').textContent, 'Saved');
  });

  test('an empty log renders the empty state', () => {
    store.set('toast_log', []);
    btn._refreshModalContent();

    assert.ok(body.querySelector('.notification-log-empty'));
  });
});
