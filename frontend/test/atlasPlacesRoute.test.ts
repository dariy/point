import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import { AtlasPlaces, boxInside, chipBox, ringLayout } from '../src/plugins/tags-atlas/AtlasPlaces.ts';
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
  p._windowPlace = null;
  p._activeLimit = null;
  p._activeTag = active ? ({ slug: active } as any) : null;
  p._selectPlaceById = (id: number, o: { pan?: boolean; focusPostSlug?: string; maxRings?: number; bounds?: any } = {}) => {
    calls.push(`select ${id} pan=${o.pan} focus=${o.focusPostSlug ?? '-'}${o.maxRings ? ` rings=${o.maxRings}` : ''}`);
    if (drawn) {
      p._activeTag = p._tagsById.get(id) ?? null;
      p._activeLimit = o.maxRings ? { maxRings: o.maxRings, bounds: o.bounds ?? null } : null;
    }
    return drawn;
  };
  p._clearSelection = () => {
    calls.push('clear');
    p._activeTag = null;
    p._activeLimit = null;
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

describe('AtlasPlaces.clearSelection', () => {
  test('the open cloud closes and a pending focus is dropped', () => {
    const { p, calls } = fakePlaces({ active: 'paris' });
    p._focusOnRestore = 'a-post';
    p.clearSelection();
    assert.deepEqual(calls, ['clear']);
    assert.equal(p._activeTag, null);
    assert.equal(p._focusOnRestore, null);
  });

  test('with no selection, nothing is cleared', () => {
    const { p, calls } = fakePlaces();
    p.clearSelection();
    assert.deepEqual(calls, []);
  });
});

describe('AtlasPlaces.openWindowPlace', () => {
  const bounds = { left: 0, top: 0, width: 288, height: 288 };

  test('a window opens the place cloud with one ring, with no pan', () => {
    const { p, calls } = fakePlaces();
    p.openWindowPlace('paris', bounds);
    assert.deepEqual(calls, ['select 7 pan=false focus=- rings=1']);
    assert.deepEqual(p._activeLimit, { maxRings: 1, bounds });
  });

  test('another open cloud closes first', () => {
    const { p, calls } = fakePlaces({ active: 'lyon' });
    p.openWindowPlace('paris', bounds);
    assert.deepEqual(calls, ['clear', 'select 7 pan=false focus=- rings=1']);
  });

  test('the same place open in a window stays', () => {
    const { p, calls } = fakePlaces();
    p.openWindowPlace('paris', bounds);
    p.openWindowPlace('paris', bounds);
    assert.equal(calls.length, 1);
  });

  test('before the places load, the request waits for start()', () => {
    const { p, calls } = fakePlaces({ loaded: false });
    p.openWindowPlace('paris', bounds);
    assert.deepEqual(calls, []);
    p._data = { tags: [] };
    p._tagsById = new Map([[7, { id: 7, slug: 'paris' } as any]]);
    p._openWindowPlace();
    assert.deepEqual(calls, ['select 7 pan=false focus=- rings=1']);
    assert.equal(p._windowPlace, null);
  });

  test('null and clearSelection drop a waiting request', () => {
    const { p, calls } = fakePlaces({ loaded: false });
    p.openWindowPlace('paris', bounds);
    p.openWindowPlace(null);
    assert.equal(p._windowPlace, null);
    p.openWindowPlace('paris', bounds);
    p.clearSelection();
    assert.equal(p._windowPlace, null);
    assert.deepEqual(calls, []);
  });

  test('the tag page of the same place opens its full cloud again (not the window cloud)', () => {
    setRoute({ pathname: '/tags/paris', params: {}, query: {} });
    const { p, calls } = fakePlaces();
    p.openWindowPlace('paris', bounds);
    p.syncToRoute();
    assert.deepEqual(calls, ['select 7 pan=false focus=- rings=1', 'clear', 'select 7 pan=false focus=-']);
    assert.equal(p._activeLimit, null);
  });
});

describe('ringLayout', () => {
  test('with no limit, every chip is placed, on more rings', () => {
    assert.equal(ringLayout(20).length, 20);
  });

  test('maxRings: 1 keeps the first ring only, all at the first radius', () => {
    const one = ringLayout(20, { maxRings: 1 });
    // floor(2π·66 / 92) = 4 chips on the first ring.
    assert.equal(one.length, 4);
    for (const o of one) assert.ok(Math.abs(Math.hypot(o.dx, o.dy) - 66) < 1e-9);
    assert.deepEqual(one, ringLayout(20).slice(0, 4));
  });

  test('maxRings: 1 with fewer chips than the ring holds places them all', () => {
    assert.equal(ringLayout(3, { maxRings: 1 }).length, 3);
  });
});

describe('chipBox / boxInside', () => {
  // A 288 px window, in px from the place at its centre.
  const win = { left: -144, top: -144, width: 288, height: 288 };

  test('a first-ring chip of 140 px fits a 288 px window', () => {
    for (const o of ringLayout(4, { maxRings: 1 })) {
      assert.ok(boxInside(chipBox(o.dx, o.dy, [140, 24]), win));
    }
  });

  test('a chip that the edge cuts is not inside', () => {
    assert.ok(!boxInside(chipBox(136, 0, [40, 24]), win));
    assert.ok(boxInside(chipBox(116, 0, [40, 24]), win));
  });
});
