import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('MapPage', () => {
  let MapPage;

  before(async () => {
    // Mock global dependencies
    global.document = {
      createElement: () => ({
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        rel: '',
        href: '',
        onload: () => {},
        onerror: () => {}
      }),
      head: { appendChild: () => {} },
      body: { classList: { remove: () => {} } },
      documentElement: { dataset: { theme: 'light' } },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => []
    };
    global.window = {
      location: { pathname: '', search: '' },
      history: { replaceState: () => {}, pushState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false }),
      L: {
        map: () => ({
          setView: () => ({ addTo: () => {} }),
          fitBounds: () => {},
          remove: () => {}
        }),
        tileLayer: () => ({ addTo: () => {} }),
        layerGroup: () => ({ addTo: () => {}, clearLayers: () => {} }),
        divIcon: () => ({}),
        marker: () => ({
          addTo: () => ({ bindPopup: () => {}, on: () => {} }),
          bindPopup: () => {},
          on: () => {},
          openPopup: () => {}
        }),
        geoJSON: () => ({ addTo: () => {} })
      }
    };
    global.URLSearchParams = class {
        constructor(search) { this.search = search; }
        get(key) { 
            if (key === 'tag' && this.search.includes('tag=paris')) return 'paris';
            return null;
        }
    };

    // Mock store
    const storeMod = await import('../src/store.js');
    global.store = storeMod.store;

    const mod = await import('../src/plugins/tags-map/index.js');
    MapPage = mod.default;
  });

  test('should initialize tagMarkers in constructor', () => {
    const page = new MapPage({});
    assert.ok(page._tagMarkers instanceof Map, 'tagMarkers should be a Map');
  });

  test('should populate tagMarkers and open popup if tag param exists', async () => {
    const page = new MapPage({});
    page.state.tags = [
      { slug: 'paris', name: 'Paris', lat: 48, lng: 2, post_count: 5, type: 'city' }
    ];
    page._map = global.window.L.map();
    page._markerLayer = global.window.L.layerGroup();

    // Mock _openTagPopup to verify it's called
    let openPopupCalled = false;
    page._openTagPopup = (slug) => {
        if (slug === 'paris') openPopupCalled = true;
    };

    // Mock URL with tag=paris
    global.window.location.search = '?tag=paris';

    await page._redrawMarkers();

    assert.ok(page._tagMarkers.has('paris'), 'Paris marker should be in tagMarkers');
    assert.ok(openPopupCalled, '_openTagPopup should be called for paris');
  });
});
