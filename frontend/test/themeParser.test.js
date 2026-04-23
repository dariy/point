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
          bg: '#ffffff',
          accent: '#007aff'
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
    
    assert.match(css, /--pt-colors-bg: #ffffff/);
    assert.match(css, /--pt-colors-accent: #007aff/);
    assert.match(css, /--pt-spacing-base: 1rem/);
  });
});
