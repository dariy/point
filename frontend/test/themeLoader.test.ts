import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

describe('themeLoader', () => {
  let mockStyleEl: { id: string; textContent: string };

  before(() => {
    mockStyleEl = { id: '', textContent: '' };
    global.document = mock<Document>({
      getElementById: () => null,
      head: mock<HTMLHeadElement>({ appendChild: <T extends Node>(node: T) => node }),
      createElement: () => mock<HTMLElement>(mockStyleEl),
    });
  });

  test('should fetch theme.css and inject into style element', async () => {
    const sampleCSS = ':root { --bg-primary: #ffffff; --color-primary: #2563eb; }';
    global.fetch = async (url: RequestInfo | URL) => {
      assert.equal(url, '/assets/css/common/theme.css');
      return mock<Response>({ ok: true, text: async () => sampleCSS });
    };

    const { loadThemeCss } = await import('../src/utils/themeLoader.ts');
    const css = await loadThemeCss();

    assert.equal(css, sampleCSS);
    assert.equal(mockStyleEl.textContent, sampleCSS);
  });

  test('should return empty string on fetch failure', async () => {
    global.fetch = async () => mock<Response>({ ok: false, status: 404 });

    const { loadThemeCss } = await import('../src/utils/themeLoader.ts');
    const css = await loadThemeCss();

    assert.equal(css, '');
  });

  test('should return empty string on network error', async () => {
    global.fetch = async () => { throw new Error('Network error'); };

    const { loadThemeCss } = await import('../src/utils/themeLoader.ts');
    const css = await loadThemeCss();

    assert.equal(css, '');
  });
});
