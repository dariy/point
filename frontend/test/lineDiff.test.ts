/**
 * The line diff of the post history compare view (NF-9).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { lineDiff, foldUnchanged, type DiffLine } from '../src/utils/lineDiff.ts';

/** A diff as "op text" strings, for short assertions. */
const show = (lines: Array<{ op: string; text?: string; count?: number }>) =>
  lines.map(l => (l.op === 'fold' ? `fold ${l.count}` : `${l.op} ${l.text}`));

describe('lineDiff', () => {
  test('equal texts are all unchanged lines', () => {
    assert.deepEqual(show(lineDiff('a\nb', 'a\nb')), ['same a', 'same b']);
  });

  test('a changed middle line is removed and added', () => {
    assert.deepEqual(show(lineDiff('a\nb\nc', 'a\nB\nc')), ['same a', 'del b', 'add B', 'same c']);
  });

  test('an added line keeps the lines around it unchanged', () => {
    assert.deepEqual(show(lineDiff('a\nc', 'a\nb\nc')), ['same a', 'add b', 'same c']);
  });

  test('an empty text diffs to all added or all removed', () => {
    assert.deepEqual(show(lineDiff('', 'x\ny')), ['add x', 'add y']);
    assert.deepEqual(show(lineDiff('x', '')), ['del x']);
  });

  test('CRLF and LF lines compare equal', () => {
    assert.deepEqual(show(lineDiff('a\r\nb', 'a\nb')), ['same a', 'same b']);
  });

  test('finds the common lines inside a changed middle', () => {
    const out = lineDiff('x\n1\n2\n3\ny', 'z\n1\n3\nw');
    assert.deepEqual(out.filter(l => l.op === 'same').map(l => l.text), ['1', '3']);
    assert.deepEqual(out.filter(l => l.op === 'del').map(l => l.text), ['x', '2', 'y']);
    assert.deepEqual(out.filter(l => l.op === 'add').map(l => l.text), ['z', 'w']);
  });

  test('a middle too large for the table is removed, then added', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n');
    const out = lineDiff(a, b);
    assert.equal(out.length, 3000);
    assert.equal(out[0].op, 'del');
    assert.equal(out[2999].op, 'add');
  });
});

describe('foldUnchanged', () => {
  const same = (n: number): DiffLine[] => Array.from({ length: n }, (_, i) => ({ op: 'same', text: `s${i}` }));

  test('keeps two lines of context around a change and folds the rest', () => {
    const lines: DiffLine[] = [...same(6), { op: 'add', text: 'new' }, ...same(6)];
    assert.deepEqual(show(foldUnchanged(lines)), ['fold 4', 'same s4', 'same s5', 'add new', 'same s0', 'same s1', 'fold 4']);
  });

  test('a short unchanged run between two changes stays', () => {
    const lines: DiffLine[] = [{ op: 'del', text: 'x' }, ...same(3), { op: 'add', text: 'y' }];
    assert.deepEqual(show(foldUnchanged(lines)), ['del x', 'same s0', 'same s1', 'same s2', 'add y']);
  });

  test('no change folds to one fold', () => {
    assert.deepEqual(show(foldUnchanged(same(5))), ['fold 5']);
  });
});
