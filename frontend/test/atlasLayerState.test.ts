import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  next, prev, cycle, getAtlasLayerState, setAtlasLayerState, clearAtlasLayerState,
  stateFromSearch, searchWithState, viewFromSearch, searchWithView, carryStateToPath,
  initialState, readSavedState, saveState, stateFromSearchOrNull,
} from '../src/plugins/tags-atlas/atlasLayerState.ts';

function fakeBody() {
  const attrs = new Map<string, string>();
  return {
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => { attrs.set(n, v); },
    removeAttribute: (n: string) => { attrs.delete(n); },
  } as unknown as HTMLElement;
}

describe('atlasLayerState', () => {
  test('next moves toward map and stops there', () => {
    assert.equal(next('list'), 'mapList');
    assert.equal(next('mapList'), 'map');
    assert.equal(next('map'), 'map');
  });

  test('prev moves toward list and stops there', () => {
    assert.equal(prev('map'), 'mapList');
    assert.equal(prev('mapList'), 'list');
    assert.equal(prev('list'), 'list');
  });

  test('cycle wraps from map to list', () => {
    assert.equal(cycle('list'), 'mapList');
    assert.equal(cycle('mapList'), 'map');
    assert.equal(cycle('map'), 'list');
  });

  test('the body attribute round-trips, and unknown values read as list', () => {
    const body = fakeBody();
    assert.equal(getAtlasLayerState(body), 'list');
    setAtlasLayerState('mapList', body);
    assert.equal(body.getAttribute('data-atlas-layer'), 'mapList');
    assert.equal(getAtlasLayerState(body), 'mapList');
    body.setAttribute('data-atlas-layer', 'bogus');
    assert.equal(getAtlasLayerState(body), 'list');
    clearAtlasLayerState(body);
    assert.equal(body.getAttribute('data-atlas-layer'), null);
  });

  test('the URL names the state: absent or unknown is list', () => {
    assert.equal(stateFromSearch(''), 'list');
    assert.equal(stateFromSearch('?view=map'), 'map');
    assert.equal(stateFromSearch('?view=split'), 'mapList');
    assert.equal(stateFromSearch('?view=bogus'), 'list');
  });

  test('searchWithState sets and removes only the atlas parameter', () => {
    assert.equal(searchWithState('', 'map'), '?view=map');
    assert.equal(searchWithState('?timeline=2020-2021', 'mapList'), '?timeline=2020-2021&view=split');
    assert.equal(searchWithState('?view=map&q=x', 'list'), '?view=list&q=x');
    assert.equal(searchWithState('?view=map', 'list'), '?view=list');
  });

  test('the viewport round-trips through the query and bad values give null', () => {
    const search = searchWithView('?view=map', { lat: 48.8566, lng: 2.3522, zoom: 6 });
    assert.deepEqual(viewFromSearch(search), { lat: 48.8566, lng: 2.3522, zoom: 6 });
    assert.equal(viewFromSearch(''), null);
    assert.equal(viewFromSearch('?at=1,2'), null);
    assert.equal(viewFromSearch('?at=a,b,c'), null);
    assert.equal(viewFromSearch('?at=95,0,3'), null);
  });

  test('carryStateToPath keeps the state on list pages only', () => {
    assert.equal(carryStateToPath('/tags/city', 'map'), '/tags/city?view=map');
    assert.equal(carryStateToPath('/tags/city?path=a/b', 'mapList'), '/tags/city?path=a%2Fb&view=split');
    assert.equal(carryStateToPath('/', 'map'), '/?view=map');
    assert.equal(carryStateToPath('/tags/city', 'list'), '/tags/city?view=list');
    assert.equal(carryStateToPath('/tags/city?slug=post', 'map'), '/tags/city?slug=post');
    assert.equal(carryStateToPath('/posts/x', 'map'), '/posts/x');
    assert.equal(carryStateToPath('/tags/city?view=split', 'map'), '/tags/city?view=split');
  });

  test('initialState: the URL, then the saved state, then list', () => {
    const store = (v: string | null) => ({ getItem: () => v });
    assert.equal(initialState('?view=map', store('mapList')), 'map');
    assert.equal(initialState('', store('mapList')), 'mapList');
    assert.equal(initialState('?view=bogus', store('map')), 'map');
    assert.equal(initialState('?view=bogus', store('bogus')), 'list');
    assert.equal(initialState('', store(null)), 'list');
    assert.equal(initialState('', null), 'list');
  });

  test('a legacy ?atlas= link still opens its state', () => {
    assert.equal(stateFromSearchOrNull('?atlas=list-map'), 'mapList');
    assert.equal(stateFromSearchOrNull('?view=list&atlas=map'), 'list');
    assert.equal(stateFromSearchOrNull('?atlas=bogus'), null);
  });

  test('saveState and readSavedState round-trip and survive a blocked store', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveState('mapList', storage);
    assert.equal(readSavedState(storage), 'mapList');
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    saveState('map', blocked);
    assert.equal(readSavedState(blocked), null);
  });
});
