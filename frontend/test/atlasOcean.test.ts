import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createAtlasOcean, presentationForState } from '../src/plugins/tags-atlas/atlasOcean.ts';
import { isAtlasListPath, setAtlasLayerState } from '../src/plugins/tags-atlas/atlasLayerState.ts';

/**
 * A fake page. `log` records what the ocean did to the map and the layout;
 * `maps` counts the map controllers (one controller = one Leaflet map at most).
 */
function fakePage(initial: 'list' | 'mapList' | 'map' = 'map') {
  const attrs = new Map<string, string>();
  const observers = new Set<() => void>();
  const body = {
    getAttribute: (n: string) => attrs.get(n) ?? null,
    setAttribute: (n: string, v: string) => {
      attrs.set(n, v);
      for (const fn of observers) fn();
    },
    removeAttribute: (n: string) => { attrs.delete(n); },
  } as unknown as HTMLElement;
  const container = { dataset: {} as Record<string, string>, style: { transition: '' }, offsetHeight: 0, remove: () => log.push('container.remove') };
  const log: string[] = [];
  let maps = 0;
  let urlState = initial;
  const ocean = createAtlasOcean({
    body,
    container: () => container as unknown as HTMLElement,
    mountLayout: (b) => {
      log.push('layout');
      setAtlasLayerState(urlState, b);
      return () => { log.push('layout.cleanup'); setAtlasLayerState('list', b); };
    },
    mountMap: () => {
      maps++;
      return {
        show: () => log.push('show'),
        park: () => log.push('park'),
        route: () => log.push('route'),
        destroy: () => log.push('map.destroy'),
      };
    },
    observeState: (_b, fn) => { observers.add(fn); return () => observers.delete(fn); },
    path: () => '/',
  });
  return {
    ocean,
    body,
    container,
    log,
    get maps() { return maps; },
    /** the state the next page reads from its URL */
    setUrlState(s: 'list' | 'mapList' | 'map') { urlState = s; },
  };
}

describe('atlasOcean', () => {
  test('isAtlasListPath: home and tag pages, not a post inside a tag', () => {
    assert.equal(isAtlasListPath('/'), true);
    assert.equal(isAtlasListPath('/?view=split'), true);
    assert.equal(isAtlasListPath('/tags/france'), true);
    assert.equal(isAtlasListPath('/tags/france?slug=a-post'), false);
    assert.equal(isAtlasListPath('/posts/a-post'), false);
    assert.equal(isAtlasListPath('/search?q=x'), false);
  });

  test('presentation follows the layer state', () => {
    assert.equal(presentationForState('list'), 'hidden');
    assert.equal(presentationForState('mapList'), 'mapList');
    assert.equal(presentationForState('map'), 'full');
  });

  test('attach shows the map for the state; a state change changes the presentation', () => {
    const p = fakePage('map');
    p.ocean.attach();
    assert.equal(p.ocean.presentation(), 'full');
    assert.equal(p.container.dataset.atlasOcean, 'full');
    assert.deepEqual(p.log, ['layout', 'show']);
    setAtlasLayerState('mapList', p.body);
    assert.equal(p.ocean.presentation(), 'mapList');
    setAtlasLayerState('list', p.body);
    assert.equal(p.ocean.presentation(), 'hidden');
  });

  test('a change to list on the same page parks the map; the change back shows it', () => {
    const p = fakePage('mapList');
    p.ocean.attach();
    setAtlasLayerState('list', p.body);
    setAtlasLayerState('mapList', p.body);
    assert.deepEqual(p.log, ['layout', 'show', 'park', 'show']);
  });

  test('a list state does not show the map (Leaflet does not load)', () => {
    const p = fakePage('list');
    p.ocean.attach();
    assert.equal(p.ocean.presentation(), 'hidden');
    assert.ok(!p.log.includes('show'));
  });

  test('a re-arm on the same page keeps the map and does not re-route it', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.attach();
    assert.equal(p.maps, 1);
    assert.deepEqual(p.log, ['layout', 'show', 'show']);
  });

  test('list → list: one map, the layout stays, the map follows the new route', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/tags/france');
    assert.equal(p.ocean.presentation(), 'full', 'the map stays on screen between the pages');
    p.ocean.attach();
    assert.equal(p.maps, 1);
    assert.deepEqual(p.log, ['layout', 'show', 'route', 'show']);
  });

  test('list → post → list: the map is hidden, kept, and shown again', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/posts/a-post');
    assert.equal(p.ocean.presentation(), 'hidden');
    assert.ok(!p.log.includes('map.destroy'), 'a post does not destroy the map');
    assert.ok(!p.log.includes('container.remove'));
    p.ocean.attach();
    assert.equal(p.maps, 1, 'no second map');
    assert.equal(p.ocean.presentation(), 'full');
    assert.deepEqual(p.log, ['layout', 'show', 'layout.cleanup', 'park', 'layout', 'route', 'show']);
  });

  test('the return does not slide the map in', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/posts/a-post');
    const seen: string[] = [];
    const style = p.container.style;
    p.container.style = new Proxy(style, {
      set(t, k, v) { if (k === 'transition') seen.push(v); (t as any)[k] = v; return true; },
    });
    p.ocean.attach();
    assert.equal(seen[0], 'none');
    assert.equal(p.container.style.transition, '', 'the transition comes back');
  });

  test('a list page that never arrives releases the layout after the timeout', async () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/', 5);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.ocean.presentation(), 'hidden');
    assert.deepEqual(p.log.slice(-2), ['layout.cleanup', 'park']);
    assert.ok(!p.log.includes('map.destroy'));
  });

  test('an attach in time stops the timeout', async () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/', 5);
    p.ocean.attach();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!p.log.includes('layout.cleanup'));
    assert.equal(p.ocean.presentation(), 'full');
  });

  test('a hidden ocean ignores a state change on another page', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/search?q=x');
    setAtlasLayerState('map', p.body);
    assert.equal(p.ocean.presentation(), 'hidden');
  });

  test('destroy (tags-atlas off) destroys the map and removes the container', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.destroy();
    assert.deepEqual(p.log.slice(-3), ['layout.cleanup', 'map.destroy', 'container.remove']);
    assert.equal(p.ocean.presentation(), 'hidden');
  });
});
