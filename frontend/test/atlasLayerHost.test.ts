import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';

import { parkAtlasLayer, takeParkedAtlasLayer, dropParkedAtlasLayer } from '../src/plugins/tags-atlas/atlasLayerHost.ts';
import { isAtlasListPath } from '../src/plugins/tags-atlas/atlasLayerState.ts';

function fakeKept() {
  const log: string[] = [];
  const owners: Array<(() => boolean) | null> = [];
  return {
    log,
    owners,
    kept: {
      layout: () => { log.push('layout'); },
      map: {
        setOwner: (fn: (() => boolean) | null) => { owners.push(fn); },
        destroy: () => { log.push('map'); },
      },
    },
  };
}

describe('atlasLayerHost', () => {
  afterEach(() => dropParkedAtlasLayer());

  test('isAtlasListPath: home and tag pages, not a post inside a tag', () => {
    assert.equal(isAtlasListPath('/'), true);
    assert.equal(isAtlasListPath('/?view=split'), true);
    assert.equal(isAtlasListPath('/tags/france'), true);
    assert.equal(isAtlasListPath('/tags/france?slug=a-post'), false);
    assert.equal(isAtlasListPath('/posts/a-post'), false);
    assert.equal(isAtlasListPath('/search?q=x'), false);
  });

  test('a move to a list page parks the layer, and the next pager takes it', () => {
    const f = fakeKept();
    assert.equal(parkAtlasLayer(f.kept, '/tags/france'), true);
    assert.deepEqual(f.log, [], 'nothing is destroyed');
    assert.deepEqual(f.owners, [null], 'the parked map has no owner');
    assert.equal(takeParkedAtlasLayer(), f.kept);
    assert.equal(takeParkedAtlasLayer(), null, 'only one pager takes it');
  });

  test('a move to any other page destroys the layer at once', () => {
    for (const path of ['/posts/a-post', '/search?q=x', '/light', '/tags/france?slug=a-post']) {
      const f = fakeKept();
      assert.equal(parkAtlasLayer(f.kept, path), false, path);
      assert.deepEqual(f.log, ['map', 'layout'], path);
      assert.equal(takeParkedAtlasLayer(), null, path);
    }
  });

  test('a parked layer that no pager takes is destroyed after the timeout', async () => {
    const f = fakeKept();
    parkAtlasLayer(f.kept, '/', 5);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(f.log, ['map', 'layout']);
    assert.equal(takeParkedAtlasLayer(), null);
  });

  test('a second park destroys the first parked layer', () => {
    const a = fakeKept();
    const b = fakeKept();
    parkAtlasLayer(a.kept, '/');
    parkAtlasLayer(b.kept, '/tags/france');
    assert.deepEqual(a.log, ['map', 'layout']);
    assert.equal(takeParkedAtlasLayer(), b.kept);
  });

  test('a taken layer is not destroyed by the old timer', async () => {
    const f = fakeKept();
    parkAtlasLayer(f.kept, '/', 5);
    takeParkedAtlasLayer();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(f.log, []);
  });
});
