import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { jsonResponse } from './helpers/fetch.ts';

type Toast = NonNullable<Parameters<Parameters<typeof import('../src/store.ts').onToast>[0]>[0]>;

describe('RebuildThumbnailsSection', () => {
  let dom: ReturnType<typeof import('./helpers/dom.ts').setupDOM>;
  let RebuildThumbnailsSection: typeof import('../src/components/light/sections/RebuildThumbnailsSection.ts').RebuildThumbnailsSection;
  let onToast: typeof import('../src/store.ts').onToast;
  let setToast: typeof import('../src/store.ts').setToast;
  let originalFetch: typeof fetch;
  let fetchCalls: { url: string; options: RequestInit | undefined }[] = [];
  let click: typeof import('./helpers/dom.ts').click;

  before(async () => {
    const domHelper = await import('./helpers/dom.ts');
    dom = domHelper.setupDOM();
    click = domHelper.click;

    const mod = await import('../src/components/light/sections/RebuildThumbnailsSection.ts');
    RebuildThumbnailsSection = mod.RebuildThumbnailsSection;

    ({ onToast, setToast } = await import('../src/store.ts'));
  });

  after(() => {
    if (dom) dom.cleanup();
  });

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    const createMockResponse = (body: unknown, ok = true, status = 200) => jsonResponse({ ok, status, body });

    globalThis.fetch = async (input, options) => {
      const url = String(input);
      fetchCalls.push({ url, options });
      if (url.includes('/api/settings')) {
        return createMockResponse({});
      }
      if (url.includes('/api/media/thumbnails/rebuild')) {
        return createMockResponse({
          message: 'Thumbnails invalidated. Removed 8 cached images; regenerating the 2 most recent in the background.',
          stats: { generation: 'a1b2c3d4e5f6', purged: 8, legacy: 0, prewarming: 2 }
        });
      }
      return createMockResponse({});
    };
    setToast(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  test('renders the rebuild button', () => {
    const container = document.createElement('div');
    const section = new RebuildThumbnailsSection(container);
    section.mount();
    
    const btn = must(container.querySelector<HTMLButtonElement>('#rebuild-thumbnails-btn'));
    assert.ok(btn, 'Rebuild button is rendered');
    assert.equal(btn.textContent, 'Rebuild Thumbnails');
  });

  test('clicking the button rebuilds thumbnails', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const section = new RebuildThumbnailsSection(container);
    section.mount();

    const btn = must(container.querySelector<HTMLButtonElement>('#rebuild-thumbnails-btn'));
    
    let resolveToast: (t: Toast) => void = () => {};
    const toastPromise = new Promise<Toast>(resolve => { resolveToast = resolve; });
    const unsub = onToast((t) => {
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
    assert.ok(toast.message.includes('Removed 8 cached images'), 'Toast reports what the server did');

    assert.equal(btn.textContent, 'Rebuild Thumbnails', 'Button text is restored');
    assert.equal(btn.disabled, false, 'Button is re-enabled');

    assert.equal(fetchCalls.length, 1, 'The rebuild is the only call: there are no thumbnail dimensions left to save first');
    assert.ok(fetchCalls[0]?.url.includes('/api/media/thumbnails/rebuild'), 'The one call triggers the rebuild');
    assert.ok(!fetchCalls[0]?.url.includes('only_missing'), 'A rebuild discards every file; there is nothing to skip');
    assert.equal(fetchCalls[0]?.options?.method, 'POST');
    // api.post skips body param if it's undefined
    assert.equal(fetchCalls[0]?.options?.body, undefined);
  });

  test('shows an error toast if rebuild fails', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      const createMockResponse = (body: unknown, ok = true, status = 200) => jsonResponse({ ok, status, body });

      if (url.includes('/api/media/thumbnails/rebuild')) {
        return createMockResponse({ message: 'Server error' }, false, 500);
      }
      return createMockResponse({});
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const section = new RebuildThumbnailsSection(container);
    section.mount();

    let resolveToast: (t: Toast) => void = () => {};
    const toastPromise = new Promise<Toast>(resolve => { resolveToast = resolve; });
    const unsub = onToast((t) => {
      if (t) {
        resolveToast(t);
        unsub();
      }
    });

    const btn = must(container.querySelector<HTMLButtonElement>('#rebuild-thumbnails-btn'));
    click(btn);

    const toast = await toastPromise;
    assert.equal(toast.type, 'error');
    assert.equal(toast.message, 'Server error');
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Rebuild Thumbnails');
  });
});
