import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import { AtlasPlaces } from '../src/plugins/tags-atlas/AtlasPlaces.ts';
import { setRoute } from '../src/store.ts';

/**
 * AtlasPlaces.syncToRoute with a post to focus (a move from a post's map
 * widget to the full map). The Leaflet side is out: `_selectPlaceById` and
 * `_clearSelection` are stubs that record their calls.
 */
function fakePlaces(opts: { loaded?: boolean; drawn?: boolean; active?: string | null } = {}) {
  const { loaded = true, drawn = true, active = null } = opts;
  const calls: string[] = [];
  const p = Object.create(AtlasPlaces.prototype) as AtlasPlaces;
  p._focusOnRestore = null;
  p._data = loaded ? { tags: [] } : null;
  p._tagsById = new Map(loaded ? [[7, { id: 7, slug: 'paris' } as any], [8, { id: 8, slug: 'lyon' } as any]] : []);
  p._activeTag = active ? ({ slug: active } as any) : null;
  p._selectPlaceById = (id: number, o: { pan?: boolean; focusPostSlug?: string } = {}) => {
    calls.push(`select ${id} pan=${o.pan} focus=${o.focusPostSlug ?? '-'}`);
    if (drawn) p._activeTag = p._tagsById.get(id) ?? null;
    return drawn;
  };
  p._clearSelection = () => {
    calls.push('clear');
    p._activeTag = null;
  };
  return { p, calls };
}

describe('AtlasPlaces.syncToRoute', () => {
  beforeEach(() => setRoute({ pathname: '/tags/paris', params: {}, query: {} }));

  test('a focus selects the route place with that post chip, with no pan', () => {
    const { p, calls } = fakePlaces();
    p.syncToRoute('a-post');
    assert.deepEqual(calls, ['select 7 pan=false focus=a-post']);
    assert.equal(p._focusOnRestore, null);
  });

  test('a focus selects the place again when it is already selected', () => {
    const { p, calls } = fakePlaces({ active: 'paris' });
    p.syncToRoute('a-post');
    assert.deepEqual(calls, ['clear', 'select 7 pan=false focus=a-post']);
  });

  test('with no focus, a selection that matches the route stays', () => {
    const { p, calls } = fakePlaces({ active: 'paris' });
    p.syncToRoute();
    assert.deepEqual(calls, []);
  });

  test('before the places load, the focus waits for the load', () => {
    const { p, calls } = fakePlaces({ loaded: false });
    p.syncToRoute('a-post');
    assert.deepEqual(calls, []);
    assert.equal(p._focusOnRestore, 'a-post');
    // start() loads the places, then restores from the URL.
    p._data = { tags: [] };
    p._tagsById = new Map([[7, { id: 7, slug: 'paris' } as any]]);
    p._restoreFromUrl();
    assert.deepEqual(calls, ['select 7 pan=false focus=a-post']);
    assert.equal(p._focusOnRestore, null);
  });

  test('a tag that is not a place on the map: no selection, the focus is dropped', () => {
    setRoute({ pathname: '/tags/nowhere', params: {}, query: {} });
    const { p, calls } = fakePlaces();
    p.syncToRoute('a-post');
    assert.deepEqual(calls, []);
    assert.equal(p._focusOnRestore, null);
  });
});
