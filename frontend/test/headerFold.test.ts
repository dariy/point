import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { FOLD_ORDER, HeaderFold } from '../src/utils/headerFold.ts';

describe('HeaderFold while frozen', () => {
  const g = globalThis as unknown as { document?: unknown; ResizeObserver?: unknown };
  let saved: { document?: unknown; ResizeObserver?: unknown };
  let layer: string | null;

  beforeEach(() => {
    saved = { document: g.document, ResizeObserver: g.ResizeObserver };
    layer = null;
    g.document = { body: { getAttribute: () => layer } };
    g.ResizeObserver = class { observe() {} disconnect() {} };
  });
  afterEach(() => {
    g.document = saved.document;
    g.ResizeObserver = saved.ResizeObserver;
  });

  /** A row that fits once `need` folds are applied. */
  function setup(need: number) {
    let folds = 0;
    const fold = new HeaderFold({ observe: null as unknown as Element, fits: () => folds >= need });
    fold.register(10, {
      reset: () => { folds = 0; },
      ops: () => [1, 2, 3].map((n) => () => { folds = Math.max(folds, n); }),
    });
    return { fold, folds: () => folds, setNeed: (n: number) => { need = n; } };
  }

  test('a page that loads in the map view still folds an overflowing row', () => {
    layer = 'map';
    const h = setup(2);
    h.fold.relayout();
    assert.equal(h.folds(), 2);
  });

  test('frozen relayout does not unfold', () => {
    const h = setup(2);
    h.fold.relayout();
    layer = 'mapList';
    h.setNeed(0);
    h.fold.relayout();
    assert.equal(h.folds(), 2);
    layer = 'list';
    h.fold.relayout();
    assert.equal(h.folds(), 0);
  });
});

describe('HeaderFold order', () => {
  test('the timeline takes its short form before any crumb folds', () => {
    for (const crumb of [FOLD_ORDER.ancestorCrumbs, FOLD_ORDER.brand, FOLD_ORDER.currentCrumb]) {
      assert.ok(FOLD_ORDER.timeline < crumb);
    }
  });

  test('the current crumb is the last crumb to fold', () => {
    assert.ok(FOLD_ORDER.currentCrumb > FOLD_ORDER.ancestorCrumbs);
    assert.ok(FOLD_ORDER.currentCrumb > FOLD_ORDER.brand);
    assert.equal(Math.max(...Object.values(FOLD_ORDER)), FOLD_ORDER.currentCrumb);
  });
});
