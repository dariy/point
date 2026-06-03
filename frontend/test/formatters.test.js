import { test, describe } from 'node:test';
import assert from 'node:assert';
import { stripHtml } from '../src/utils/formatters.js';

describe('formatters', () => {
  describe('stripHtml', () => {
    test('should remove simple tags', () => {
      assert.strictEqual(stripHtml('<p>Hello</p>'), 'Hello');
    });

    test('should remove tags with attributes', () => {
      assert.strictEqual(stripHtml('<a href="https://example.com">Link</a>'), 'Link');
    });

    test('should handle empty or null input', () => {
      assert.strictEqual(stripHtml(''), '');
      assert.strictEqual(stripHtml(null), '');
      assert.strictEqual(stripHtml(undefined), '');
    });

    test('should remove nested/crafted tags to prevent injection', () => {
      // Recursive stripping ensures that even crafted tags are removed.
      // <scr<img>ipt> becomes <script> which then becomes empty string.
      assert.strictEqual(stripHtml('<scr<img>ipt>'), '');
      assert.strictEqual(stripHtml('<<<<svg/onload=alert(1)>>>>'), '');
      assert.strictEqual(stripHtml('<p<p>>Hello</p</p>>'), 'Hello');
    });
  });
});
