import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('themeParser', () => {
  before(() => {
    // Mocking document and fetch for node environment
    global.document = {
      getElementById: () => null,
      head: {
        appendChild: () => {},
        querySelector: () => null
      },
      createElement: () => ({
        id: '',
        textContent: ''
      })
    };
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        colors: {
          "bg-primary": '#ffffff',
          "accent": '#007aff'
        },
        spacing: {
          base: '1rem'
        }
      })
    });
  });

  test('should parse theme config and map to CSS variables', async () => {
    const { parseTheme } = await import('../src/utils/themeParser.js');
    const css = await parseTheme();
    
    assert.match(css, /--bg-primary: #ffffff/);
    assert.match(css, /--color-primary: #007aff/);
    assert.match(css, /--spacing-md: 1rem/);
  });

  test('should handle dual-mode (light/dark/shared) structure', async () => {
    // Override global fetch for this test
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        shared: {
          spacing: { base: '1rem' }
        },
        light: {
          colors: { "bg-primary": '#ffffff' }
        },
        dark: {
          colors: { "bg-primary": '#121212' }
        }
      })
    });

    const { parseTheme } = await import('../src/utils/themeParser.js');
    const css = await parseTheme();

    assert.match(css, /:root {\n  --spacing-md: 1rem;/);
    assert.match(css, /:root {\n  --bg-primary: #ffffff;/);
    assert.match(css, /\[data-theme="dark"\] {\n  --bg-primary: #121212;/);

    // Restore fetch
    global.fetch = originalFetch;
  });

  test('should handle Sepia theme with shared typography', async () => {
    const originalFetch = global.fetch;
    const sepiaTheme = {
      shared: { typography: { 'font-family': 'Georgia' } },
      light: { colors: { 'bg-primary': '#f4ecd8' } },
      dark: { colors: { 'bg-primary': '#2b261d' } }
    };
    
    global.fetch = async () => ({
      ok: true,
      json: async () => sepiaTheme
    });

    const { parseTheme } = await import('../src/utils/themeParser.js');
    const css = await parseTheme();
    
    assert.match(css, /--font-family: Georgia/);
    assert.match(css, /--bg-primary: #f4ecd8/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /--bg-primary: #2b261d/);
    
    global.fetch = originalFetch;
  });
});
