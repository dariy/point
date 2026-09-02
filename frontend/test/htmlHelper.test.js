import { test } from 'node:test';
import assert from 'node:assert';
import { html, raw } from '../src/utils/helpers.js';

test('html template helper', async (t) => {
  await t.test('escapes by default', () => {
    const out = html`<div class="${'a"b'}">${'<script>'}</div>`;
    assert.strictEqual(out.toString(), '<div class="a&quot;b">&lt;script&gt;</div>');
  });

  await t.test('raw opt-out', () => {
    const out = html`<div>${raw('<span>')}</div>`;
    assert.strictEqual(out.toString(), '<div><span></div>');
  });

  await t.test('arrays join without separators', () => {
    const out = html`<ul>${['a', 'b', 'c']}</ul>`;
    assert.strictEqual(out.toString(), '<ul>abc</ul>');
  });

  await t.test('arrays of raw/html', () => {
    const items = ['<a>', '<b>'];
    const out = html`<ul>${items.map(i => raw(i))}</ul>`;
    assert.strictEqual(out.toString(), '<ul><a><b></ul>');
  });

  await t.test('null/undefined handling', () => {
    assert.strictEqual(html`${null}${undefined}`.toString(), '');
  });

  await t.test('safeUrl in URL attributes', () => {
    const checks = [
      { prev: '<a href="', val: 'javascript:alert(1)', expected: '<a href="#">' },
      { prev: '<img src="', val: 'data:text/html,', expected: '<img src="#">' },
      { prev: '<button formaction="', val: '//evil.com', expected: '<button formaction="#">' },
      { prev: '<svg><use xlink:href="', val: '  javascript:1', expected: '<svg><use xlink:href="#">' },
      { prev: '<a href="', val: '\x01javascript:alert', expected: '<a href="#">' },
    ];
    for (const c of checks) {
      const parts = [c.prev, '">'];
      parts.raw = parts;
      const out = html(parts, c.val);
      assert.strictEqual(out.toString(), c.expected);
    }
  });
});
