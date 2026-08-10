import { test, describe } from 'node:test';
import assert from 'node:assert';
import { stripHtml, formatTitleDate, defaultPostTitle } from '../src/utils/formatters.js';

describe('formatters', () => {
  describe('formatTitleDate', () => {
    // Sunday, 8 March 2026, 09:07:05 local — single-digit parts exercise padding.
    const ref = new Date(2026, 2, 8, 9, 7, 5);

    test('renders the default pattern', () => {
      assert.strictEqual(formatTitleDate('YYYY-MM-DD', ref), '2026-03-08');
    });

    test('renders every token, matching the Go formatter', () => {
      assert.strictEqual(formatTitleDate('YY/MM/DD', ref), '26/03/08');
      assert.strictEqual(formatTitleDate('DD MMMM YYYY', ref), '08 March 2026');
      assert.strictEqual(formatTitleDate('DDD, MMM DD', ref), 'Sun, Mar 08');
      assert.strictEqual(formatTitleDate('DDDD', ref), 'Sunday');
      assert.strictEqual(formatTitleDate('HH:mm:ss', ref), '09:07:05');
    });

    test('copies literals through, including digits', () => {
      assert.strictEqual(formatTitleDate('Notes from DD.MM.YYYY', ref), 'Notes from 08.03.2026');
      assert.strictEqual(formatTitleDate('2006 recap: YYYY', ref), '2006 recap: 2026');
      assert.strictEqual(formatTitleDate('Journal', ref), 'Journal');
    });

    test('brackets escape words that contain a token', () => {
      assert.strictEqual(formatTitleDate('[Session] DD.MM', ref), 'Session 08.03');
      assert.strictEqual(formatTitleDate('[Journal', ref), '[Journal');
    });

    test('trims surrounding whitespace', () => {
      assert.strictEqual(formatTitleDate('  YYYY  ', ref), '2026');
      assert.strictEqual(formatTitleDate('', ref), '');
    });
  });

  describe('defaultPostTitle', () => {
    const ref = new Date(2026, 2, 8, 9, 7, 5);

    test('falls back to the built-in pattern when the setting is unset or blank', () => {
      assert.strictEqual(defaultPostTitle(undefined, ref), '2026-03-08');
      assert.strictEqual(defaultPostTitle({}, ref), '2026-03-08');
      assert.strictEqual(defaultPostTitle({ default_post_title_format: '   ' }, ref), '2026-03-08');
    });

    test('uses the configured pattern', () => {
      assert.strictEqual(defaultPostTitle({ default_post_title_format: 'DD MMM YY' }, ref), '08 Mar 26');
    });
  });

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
