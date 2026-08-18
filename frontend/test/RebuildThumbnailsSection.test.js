import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('RebuildThumbnailsSection', () => {
  let dom;
  let RebuildThumbnailsSection;
  let store;
  let originalFetch;
  let fetchCalls = [];
  let click;

  before(async () => {
    const domHelper = await import('./helpers/dom.js');
    dom = domHelper.setupDOM();
    click = domHelper.click;

    const mod = await import('../src/components/light/sections/RebuildThumbnailsSection.js');
    RebuildThumbnailsSection = mod.RebuildThumbnailsSection;

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
  });

  after(() => {
    if (dom) dom.cleanup();
  });

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    const createMockResponse = (body, isJson = true, ok = true, status = 200) => ({
      ok,
      status,
      headers: {
        get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null
      },
      json: async () => body,
      text: async () => JSON.stringify(body)
    });

    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.includes('/api/settings')) {
        return createMockResponse({});
      }
      if (url.includes('/api/media/thumbnails/rebuild')) {
        return createMockResponse({ processed: 5, skipped: 2, errors: 0 });
      }
      return createMockResponse({});
    };
    store.set('toast', null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  test('renders the rebuild button', () => {
    const container = document.createElement('div');
    const section = new RebuildThumbnailsSection(container);
    section.mount();
    
    const btn = container.querySelector('#rebuild-thumbnails-btn');
    assert.ok(btn, 'Rebuild button is rendered');
    assert.equal(btn.textContent, 'Rebuild Thumbnails');
  });

  test('clicking the button updates settings and rebuilds thumbnails', async () => {
    // Fake the settings form in the document
    const form = document.createElement('form');
    form.id = 'plugin-settings-form';
    form.innerHTML = `
      <input name="thumbnail_width" value="400" />
      <input name="thumbnail_height" value="300" />
    `;
    document.body.appendChild(form);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const section = new RebuildThumbnailsSection(container);
    section.mount();

    const btn = container.querySelector('#rebuild-thumbnails-btn');
    
    let resolveToast;
    const toastPromise = new Promise(resolve => resolveToast = resolve);
    const unsub = store.subscribe('toast', (t) => {
      if (t) {
        resolveToast(t);
        unsub();
      }
    });

    click(btn);

    assert.equal(btn.textContent, 'Rebuilding…', 'Button shows loading state immediately');
    assert.equal(btn.disabled, true, 'Button is disabled while loading');

    const toast = await toastPromise;

    assert.equal(toast.type, 'success');
    assert.ok(toast.message.includes('Processed: 5, Skipped: 2, Errors: 0'));

    assert.equal(btn.textContent, 'Rebuild Thumbnails', 'Button text is restored');
    assert.equal(btn.disabled, false, 'Button is re-enabled');

    assert.equal(fetchCalls.length, 2, 'Should make exactly two API calls');
    assert.ok(fetchCalls[0].url.includes('/api/settings'), 'First call updates settings');
    assert.equal(fetchCalls[0].options.method, 'PUT');
    assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { thumbnail_width: "400", thumbnail_height: "300" });

    assert.ok(fetchCalls[1].url.includes('/api/media/thumbnails/rebuild'), 'Second call triggers rebuild');
    assert.equal(fetchCalls[1].options.method, 'POST');
    // api.post skips body param if it's undefined
    assert.equal(fetchCalls[1].options.body, undefined);
  });

  test('shows an error toast if rebuild fails', async () => {
    globalThis.fetch = async (url, options) => {
      const createMockResponse = (body, ok = true, status = 200) => ({
        ok,
        status,
        headers: {
          get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null
        },
        json: async () => body,
        text: async () => JSON.stringify(body)
      });

      if (url.includes('/api/media/thumbnails/rebuild')) {
        return createMockResponse({ message: 'Server error' }, false, 500);
      }
      return createMockResponse({});
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const section = new RebuildThumbnailsSection(container);
    section.mount();

    let resolveToast;
    const toastPromise = new Promise(resolve => resolveToast = resolve);
    const unsub = store.subscribe('toast', (t) => {
      if (t) {
        resolveToast(t);
        unsub();
      }
    });

    const btn = container.querySelector('#rebuild-thumbnails-btn');
    click(btn);

    const toast = await toastPromise;
    assert.equal(toast.type, 'error');
    assert.equal(toast.message, 'Server error');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Rebuild Thumbnails');
  });
});
