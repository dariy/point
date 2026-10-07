import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { isHeaderFrozen } from '../src/utils/headerFreeze.ts';

describe('headerFreeze', () => {
  const g = globalThis as unknown as { document?: unknown };
  let saved: unknown;
  let layer: string | null = null;

  beforeEach(() => {
    saved = g.document;
    layer = null;
    g.document = { body: { getAttribute: () => layer } };
  });
  afterEach(() => {
    g.document = saved;
  });

  test('frozen only in mapList and map', () => {
    for (const [value, frozen] of [[null, false], ['list', false], ['mapList', true], ['map', true]] as const) {
      layer = value;
      assert.equal(isHeaderFrozen(), frozen, String(value));
    }
  });

  test('not frozen without a document', () => {
    g.document = undefined;
    assert.equal(isHeaderFrozen(), false);
  });
});
