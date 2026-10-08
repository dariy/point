import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buttonsFor } from '../src/plugins/tags-atlas/atlasLayerHandle.ts';
import { GRID_SVG, MAP_FOLD_SVG, SPLIT_SVG } from '../src/utils/icons.ts';

describe('buttonsFor', () => {
  it('mapList has a map button at the start and a list button at the end', () => {
    assert.deepEqual(buttonsFor('mapList').map((b) => [b.label, b.to, b.icon, b.side]), [
      ['Maximize map', 'map', MAP_FOLD_SVG, 'start'],
      ['Maximize list', 'list', GRID_SVG, 'end'],
    ]);
  });
  it('list and map have one split button that restores mapList', () => {
    for (const state of ['list', 'map'] as const) {
      assert.deepEqual(buttonsFor(state).map((b) => [b.label, b.to, b.icon]), [['Restore map and list', 'mapList', SPLIT_SVG]]);
    }
  });
});
