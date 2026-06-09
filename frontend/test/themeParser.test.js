import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('themeParser', () => {
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

    const { parseTheme } = await import('../src/utils/themeParser.js');
    const css = await parseTheme();

    assert.equal(css, sampleCSS);
    assert.equal(mockStyleEl.textContent, sampleCSS);
  });

  test('should return empty string on fetch failure', async () => {
    global.fetch = async () => ({ ok: false, status: 404 });

    const { parseTheme } = await import('../src/utils/themeParser.js');
    const css = await parseTheme();

    assert.equal(css, '');
  });

  test('should return empty string on network error', async () => {
    global.fetch = async () => { throw new Error('Network error'); };

    const { parseTheme } = await import('../src/utils/themeParser.js');
    const css = await parseTheme();

    assert.equal(css, '');
  });
});
