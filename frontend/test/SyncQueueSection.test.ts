import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert';

describe('SyncQueueSection', () => {
  let dom;
  let SyncQueueSection;

  before(async () => {
    const domHelper = await import('./helpers/dom.ts');
    dom = domHelper.setupDOM();
    ({ SyncQueueSection } = await import('../src/components/light/sections/SyncQueueSection.ts'));
  });

  after(() => {
    if (dom) dom.cleanup();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const op = (id, status) => ({
    id, timestamp: Date.UTC(2026, 0, 2), method: 'PUT', url: `/api/posts/${id}`,
    body: null, blob_key: null, status, error: status === 'failed' ? 'Server error' : null, temp_id_map: {},
  });

  test('a failed op shows as failed and offers Retry Failed', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const section = new SyncQueueSection(container);
    section.mount();
    section.setState({ loading: false, queue: [op('a', 'failed'), op('b', 'pending')] });

    const items = container.querySelectorAll('.sync-queue-item');
    assert.strictEqual(items.length, 2);
    assert.ok(items[0].classList.contains('status-failed'));
    assert.ok(items[1].classList.contains('status-pending'));
    assert.ok(container.querySelector('#reset-sync-btn'), 'Retry Failed button is shown');
    assert.ok(container.querySelector('#sync-now-btn'), 'Sync Now button is shown');
    assert.notStrictEqual(container.querySelector('.sync-meta').textContent.trim(), '');
  });

  test('only pending ops show no Retry Failed button', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const section = new SyncQueueSection(container);
    section.mount();
    section.setState({ loading: false, queue: [op('b', 'pending')] });

    assert.strictEqual(container.querySelector('#reset-sync-btn'), null);
    assert.ok(container.querySelector('#sync-now-btn'));
  });
});
