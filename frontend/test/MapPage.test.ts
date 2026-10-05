import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock, nodeList } from './helpers/mock.ts';

/** The country features and per-feature layer the geoJSON stub hands to MapPage. */
type Feature = { properties: Record<string, string | null> };
type FeatureLayer = { bindPopup(html: string): void; on(ev: string, fn: (e: { latlng: number[] }) => void): void; openPopup(ll: number[]): void };
type GeoJSONOptions = { style(f: Feature): Record<string, unknown>; onEachFeature(f: Feature, layer: FeatureLayer): void };

describe('MapPage', () => {
  let MapPage: typeof import('../src/plugins/tags-map/index.ts').default;

  before(async () => {
    // Mock global dependencies
    globalThis.document = mock<Document>({
      createElement: () => mock<HTMLLinkElement>({
        appendChild: <T extends Node>(n: T) => n,
        remove: () => {},
        classList: mock<DOMTokenList>({ add: () => {}, remove: () => {} }),
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => nodeList<Element>([]),
        rel: '',
        href: '',
        onload: () => {},
        onerror: () => {}
      }),
      head: mock<HTMLHeadElement>({ appendChild: <T extends Node>(n: T) => n }),
      body: mock<HTMLElement>({ classList: mock<DOMTokenList>({ remove: () => {} }) }),
      documentElement: mock<HTMLElement>({ dataset: { theme: 'light' } }),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => nodeList<Element>([])
    });
    globalThis.window = mock<typeof window>({
      location: mock<Location>({ pathname: '', search: '' }),
      history: mock<History>({ replaceState: () => {}, pushState: () => {} }),
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => mock<MediaQueryList>({ matches: false }),
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
    });

    // Mock store
    const storeMod = await import('../src/store.ts');
    Object.assign(globalThis, { store: storeMod.store });

    const mod = await import('../src/plugins/tags-map/index.ts');
    MapPage = mod.default;
  });

  test('should initialize tagMarkers in constructor', () => {
    const page = new MapPage(mock<HTMLElement>({}));
    assert.ok(page._tagMarkers instanceof Map, 'tagMarkers should be a Map');
  });

  test('should populate tagMarkers and open popup if tag param exists', async () => {
    const page = new MapPage(mock<HTMLElement>({}));
    page.state.tags = [
      { slug: 'paris', name: 'Paris', lat: 48, lng: 2, post_count: 5, type: 'city' }
    ];
    page._map = globalThis.window.L.map();
    page._markerLayer = globalThis.window.L.layerGroup();

    // Mock _openTagPopup to verify it's called
    let openPopupCalled = false;
    page._openTagPopup = (slug: string) => {
        if (slug === 'paris') openPopupCalled = true;
    };

    // Mock URL with tag=paris
    globalThis.window.location.search = '?tag=paris';

    await page._redrawMarkers();

    assert.ok(page._tagMarkers.has('paris'), 'Paris marker should be in tagMarkers');
    assert.ok(openPopupCalled, '_openTagPopup should be called for paris');
  });
  test('country polygons take the matching tag style and popup', async () => {
    const page = new MapPage(mock<HTMLElement>({}));
    page.state.tags = [
      { slug: 'japan', name: 'Japan', post_count: 1, type: 'country', is_hidden: true,
        years: [{ slug: '2024', name: '2024' }] },
    ];
    page._map = globalThis.window.L.map();
    page._markerLayer = globalThis.window.L.layerGroup();
    page._geojson = { type: 'FeatureCollection', features: [] };
    globalThis.window.location.search = '';

    const features: Feature[] = [
      { properties: { name: 'Japan' } },
      { properties: { name: 'Chad', formal_en: null } },
    ];
    const styles: Record<string, unknown>[] = [];
    const popups: string[] = [];
    let clicked: number[] | null = null;
    const savedGeoJSON = globalThis.window.L.geoJSON;
    globalThis.window.L.geoJSON = (_data: unknown, opts: GeoJSONOptions) => {
      for (const f of features) {
        styles.push(opts.style(f));
        opts.onEachFeature(f, {
          bindPopup: html => { popups.push(html); },
          on: (_ev, fn) => fn({ latlng: [35, 139] }),
          openPopup: ll => { clicked = ll; },
        });
      }
      return { addTo: () => {} };
    };
    try {
      await page._redrawMarkers();
    } finally {
      globalThis.window.L.geoJSON = savedGeoJSON;
    }

    assert.strictEqual(styles[0]?.color, '#e05c00', 'the tagged country is highlighted');
    assert.strictEqual(styles[0]?.dashArray, '5 4', 'a hidden tag is dashed');
    assert.strictEqual(styles[0]?.fillOpacity, 0.2);
    assert.strictEqual(styles[1]?.color, '#888', 'an untagged country is muted');
    assert.strictEqual(popups.length, 1, 'only the tagged country gets a popup');
    assert.ok(popups[0]?.includes('/tags/japan') && popups[0].includes('map-year-link'));
    assert.deepStrictEqual(clicked, [35, 139]);
    assert.ok(page._tagMarkers.has('japan'));
  });
});
