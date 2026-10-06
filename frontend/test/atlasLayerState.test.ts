import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  next, prev, cycle, getAtlasLayerState, setAtlasLayerState, clearAtlasLayerState,
  stateFromSearch, searchWithState, viewFromSearch, searchWithView,
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
    assert.equal(stateFromSearch('?atlas=map'), 'map');
    assert.equal(stateFromSearch('?atlas=list-map'), 'mapList');
    assert.equal(stateFromSearch('?atlas=bogus'), 'list');
  });

  test('searchWithState sets and removes only the atlas parameter', () => {
    assert.equal(searchWithState('', 'map'), '?atlas=map');
    assert.equal(searchWithState('?timeline=2020-2021', 'mapList'), '?timeline=2020-2021&atlas=list-map');
    assert.equal(searchWithState('?atlas=map&q=x', 'list'), '?q=x');
    assert.equal(searchWithState('?atlas=map', 'list'), '');
  });

  test('the viewport round-trips through the query and bad values give null', () => {
    const search = searchWithView('?atlas=map', { lat: 48.8566, lng: 2.3522, zoom: 6 });
    assert.deepEqual(viewFromSearch(search), { lat: 48.8566, lng: 2.3522, zoom: 6 });
    assert.equal(viewFromSearch(''), null);
    assert.equal(viewFromSearch('?view=1,2'), null);
    assert.equal(viewFromSearch('?view=a,b,c'), null);
    assert.equal(viewFromSearch('?view=95,0,3'), null);
  });
});
