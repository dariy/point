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
    const storeMod = await import('../src/store.ts');
    global.store = storeMod.store;

    const mod = await import('../src/plugins/tags-map/index.ts');
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
  test('country polygons take the matching tag style and popup', async () => {
    const page = new MapPage({});
    page.state.tags = [
      { slug: 'japan', name: 'Japan', post_count: 1, type: 'country', is_hidden: true,
        years: [{ slug: '2024', name: '2024' }] },
    ];
    page._map = global.window.L.map();
    page._markerLayer = global.window.L.layerGroup();
    page._geojson = { type: 'FeatureCollection', features: [] };
    global.window.location.search = '';

    const features = [
      { properties: { name: 'Japan' } },
      { properties: { name: 'Chad', formal_en: null } },
    ];
    const styles = [];
    const popups = [];
    let clicked = null;
    const savedGeoJSON = global.window.L.geoJSON;
    global.window.L.geoJSON = (_data, opts) => {
      for (const f of features) {
        styles.push(opts.style(f));
        opts.onEachFeature(f, {
          bindPopup: html => popups.push(html),
          on: (_ev, fn) => fn({ latlng: [35, 139] }),
          openPopup: ll => { clicked = ll; },
        });
      }
      return { addTo: () => {} };
    };
    try {
      await page._redrawMarkers();
    } finally {
      global.window.L.geoJSON = savedGeoJSON;
    }

    assert.strictEqual(styles[0].color, '#e05c00', 'the tagged country is highlighted');
    assert.strictEqual(styles[0].dashArray, '5 4', 'a hidden tag is dashed');
    assert.strictEqual(styles[0].fillOpacity, 0.2);
    assert.strictEqual(styles[1].color, '#888', 'an untagged country is muted');
    assert.strictEqual(popups.length, 1, 'only the tagged country gets a popup');
    assert.ok(popups[0].includes('/tags/japan') && popups[0].includes('map-year-link'));
    assert.deepStrictEqual(clicked, [35, 139]);
    assert.ok(page._tagMarkers.has('japan'));
  });
});
