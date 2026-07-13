import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('themeLoader', () => {
  let mockStyleEl;

  before(() => {
    mockStyleEl = { id: '', textContent: '' };
    global.document = {
      getElementById: () => null,
      head: { appendChild: () => {} },
      createElement: () => mockStyleEl,
    };
  });

  test('should fetch theme.css and inject into style element', async () => {
    const sampleCSS = ':root { --bg-primary: #ffffff; --color-primary: #2563eb; }';
    global.fetch = async (url) => {
      assert.equal(url, '/assets/css/common/theme.css');
      return { ok: true, text: async () => sampleCSS };
    };

    const { loadThemeCss } = await import('../src/utils/themeLoader.js');
    const css = await loadThemeCss();

    assert.equal(css, sampleCSS);
    assert.equal(mockStyleEl.textContent, sampleCSS);
  });

  test('should return empty string on fetch failure', async () => {
    global.fetch = async () => ({ ok: false, status: 404 });

    const { loadThemeCss } = await import('../src/utils/themeLoader.js');
    const css = await loadThemeCss();

    assert.equal(css, '');
  });

  test('should return empty string on network error', async () => {
    global.fetch = async () => { throw new Error('Network error'); };

    const { loadThemeCss } = await import('../src/utils/themeLoader.js');
    const css = await loadThemeCss();

    assert.equal(css, '');
  });
});
