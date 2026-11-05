import { test, describe } from 'node:test';
import assert from 'node:assert';

import { SETTLE_FRAMES, createAtlasOcean, defaultIdle, defaultSaveData, presentationForState } from '../src/plugins/tags-atlas/atlasOcean.ts';
import { isAtlasListPath, setAtlasLayerState } from '../src/plugins/tags-atlas/atlasLayerState.ts';

/**
 * A fake page. `log` records what the ocean did to the map and the layout;
 * `maps` counts the map controllers (one controller = one Leaflet map at most).
 */
function fakePage(initial: 'list' | 'mapList' | 'map' = 'map', opts: { saveData?: boolean; reducedMotion?: boolean; sheetReturn?: boolean } = {}) {
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
  // The container's listeners, by type (the ocean listens in the capture phase).
  const listeners = new Map<string, Set<(e: any) => void>>();
  const container = {
    dataset: {} as Record<string, string>,
    style: { transition: '', clipPath: '' },
    offsetHeight: 0,
    remove: () => log.push('container.remove'),
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => { listeners.get(type)?.delete(fn); },
  };
  /** Send a DOM event to the container's listeners. Returns what the listeners did to it. */
  const dispatch = (type: string, init: Record<string, number> = {}) => {
    const ev = {
      type, pointerId: 1, clientX: 0, clientY: 0, ...init,
      stopped: false, prevented: false,
      stopImmediatePropagation() { ev.stopped = true; },
      preventDefault() { ev.prevented = true; },
    };
    for (const fn of listeners.get(type) ?? []) fn(ev);
    return ev;
  };
  // The animation frames the ocean asked for; `tick(ms)` runs them at time `ms`.
  const frames = new Set<(now: number) => void>();
  let clock = 0;
  let windowTap: (() => void) | null = null;
  // The "‹ <post title>" chip: what the ocean asked for last.
  let chip = false;
  const log: string[] = [];
  let maps = 0;
  let urlState = initial;
  let path = '/';
  // The idle callbacks the ocean asked for; `idle()` runs them.
  const idle = new Set<() => void>();
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
        route: (focus) => log.push(focus ? `route ${focus}` : 'route'),
        setView: (c, z) => log.push(`setView ${c.lat},${c.lng} z${z}`),
        useView: (v) => log.push(`useView ${v.lat},${v.lng} z${v.zoom}`),
        warm: () => log.push('warm'),
        frame: (c, o, z) => log.push(`frame ${c ? `${c.lat},${c.lng}` : '-'} ${Math.round(o.x)},${Math.round(o.y)}${z == null ? '' : ` z${z}`}`),
        offsetOf: () => ({ x: 0, y: 0 }),
        panBy: (dx, dy) => log.push(`panBy ${dx},${dy}`),
        setWindowTap: (fn) => { windowTap = fn; },
        destroy: () => log.push('map.destroy'),
      };
    },
    observeState: (_b, fn) => { observers.add(fn); return () => observers.delete(fn); },
    path: () => path,
    idle: (fn) => {
      log.push('idle');
      idle.add(fn);
      return () => { idle.delete(fn); };
    },
    saveData: () => !!opts.saveData,
    // The box: a 400×800 viewport.
    box: () => ({ left: 0, top: 0, width: 400, height: 800 }) as DOMRect,
    reducedMotion: () => !!opts.reducedMotion,
    frame: (fn) => { frames.add(fn); return () => { frames.delete(fn); }; },
    now: () => clock,
    sheetReturn: () => !!opts.sheetReturn,
    fromPostChip: (show) => { chip = show; },
  });
  return {
    ocean,
    body,
    container,
    log,
    get maps() { return maps; },
    /** the page goes idle: run the pending idle callbacks */
    idle() {
      const fns = [...idle];
      idle.clear();
      for (const fn of fns) fn();
    },
    get pendingIdle() { return idle.size; },
    dispatch,
    /** A place pick in the map (AtlasPlaces → onSelect), as the controller sees it. */
    get windowTap() { return windowTap; },
    /** Run the pending frames at time `ms`. */
    tick(ms: number) {
      clock = ms;
      const fns = [...frames];
      frames.clear();
      for (const fn of fns) fn(ms);
    },
    get pendingFrames() { return frames.size; },
    get chip() { return chip; },
    /** the state the next page reads from its URL */
    setUrlState(s: 'list' | 'mapList' | 'map') { urlState = s; },
    /** the path and query that the ocean reads (deps.path) */
    setPath(p: string) { path = p; },
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

  test('Back to a list page whose URL names another view: the kept layout takes the URL view', () => {
    // /search arms a grid too: its layout reads `list`. A Back to /tags/x?view=map keeps that layout.
    const p = fakePage('list');
    p.setPath('/search?q=x');
    p.ocean.attach();
    p.setPath('/tags/kyiv?view=map');
    p.ocean.detach('/tags/kyiv?view=map');
    p.ocean.attach();
    assert.equal(p.body.getAttribute('data-atlas-layer'), 'map');
    assert.equal(p.ocean.presentation(), 'full');
    assert.equal(p.log.filter((l) => l === 'layout').length, 1, 'the layout stays');
  });

  test('a kept layout with no view in the URL keeps its state', () => {
    const p = fakePage('mapList');
    p.ocean.attach();
    p.setPath('/tags/france');
    p.ocean.detach('/tags/france');
    p.ocean.attach();
    assert.equal(p.body.getAttribute('data-atlas-layer'), 'mapList');
  });

  test('a return from a post takes the viewport of the list URL, before the route', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.ocean.detach('/posts/a-post');
    p.setPath('/?view=map&at=48.5,2.25,5');
    p.ocean.attach();
    assert.deepEqual(p.log.slice(-3), ['useView 48.5,2.25 z5', 'route', 'show']);
  });

  test('a move between list pages does not take the URL viewport', () => {
    const p = fakePage('map');
    p.ocean.attach();
    p.setPath('/tags/france?view=map&at=1,2,3');
    p.ocean.detach('/tags/france?view=map&at=1,2,3');
    p.ocean.attach();
    assert.ok(!p.log.some((l) => l.startsWith('useView')));
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

  test('warm-up: in list, the map builds in an idle callback after the attach, not before', () => {
    const p = fakePage('list');
    assert.equal(p.pendingIdle, 0, 'nothing is scheduled before the first grid render (attach)');
    p.ocean.attach();
    assert.ok(!p.log.includes('warm'), 'the attach itself does not build the map');
    assert.equal(p.pendingIdle, 1);
    p.idle();
    assert.deepEqual(p.log, ['layout', 'park', 'idle', 'warm']);
    assert.equal(p.ocean.presentation(), 'hidden', 'the warm map stays hidden');
    // A re-arm does not warm again.
    p.ocean.attach();
    assert.equal(p.pendingIdle, 0);
    // The first change to mapList only shows the map.
    setAtlasLayerState('mapList', p.body);
    assert.equal(p.log[p.log.length - 1], 'show');
    assert.equal(p.maps, 1);
  });

  test('warm-up: no warm-up when saveData is on; the first mapList builds the map', () => {
    const p = fakePage('list', { saveData: true });
    p.ocean.attach();
    assert.equal(p.pendingIdle, 0);
    p.idle();
    assert.ok(!p.log.includes('warm'));
    setAtlasLayerState('mapList', p.body);
    assert.deepEqual(p.log, ['layout', 'park', 'show']);
  });

  test('warm-up: no warm-up when the page attaches in mapList or map', () => {
    const p = fakePage('mapList');
    p.ocean.attach();
    assert.equal(p.pendingIdle, 0);
    setAtlasLayerState('list', p.body);
    p.ocean.attach();
    assert.equal(p.pendingIdle, 0, 'a shown map is built: nothing to warm');
  });

  test('warm-up: a state change before the idle callback cancels the warm-up', () => {
    const p = fakePage('list');
    p.ocean.attach();
    setAtlasLayerState('mapList', p.body);
    assert.equal(p.pendingIdle, 0);
    assert.ok(!p.log.includes('warm'));
  });

  test('warm-up: a move to a post before the idle callback cancels the warm-up', () => {
    const p = fakePage('list');
    p.ocean.attach();
    p.ocean.detach('/posts/a-post');
    assert.equal(p.pendingIdle, 0);
    assert.ok(!p.log.includes('warm'));
  });

  describe('window', () => {
    const slot = { left: 20, top: 500, width: 360, height: 200 };
    const paris = { lat: 48.85, lng: 2.35 };

    test('present(window) clips the box to the rect and centres the point in it', () => {
      const p = fakePage('list');
      p.ocean.present({ kind: 'window', rect: slot, center: paris });
      assert.equal(p.ocean.presentation(), 'window');
      assert.equal(p.container.dataset.atlasOcean, 'window');
      assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
      // The point goes 200 px below the box centre: the slot centre.
      assert.deepEqual(p.log, ['frame 48.85,2.35 0,200']);
      assert.equal(p.maps, 1, 'a window on a post with no list makes the map');
    });

    test('a window with no centre moves the map with the slot (a sheet scroll)', () => {
      const p = fakePage('list');
      p.ocean.present({ kind: 'window', rect: slot, center: paris });
      p.ocean.present({ kind: 'window', rect: { ...slot, top: 300 } });
      assert.equal(p.container.style.clipPath, 'inset(300px 20px 300px 20px)');
      assert.deepEqual(p.log.slice(-2), ['frame - 0,0', 'panBy 0,200']);
    });

    test('a window with a zoom frames the point at that zoom', () => {
      const p = fakePage('list');
      p.ocean.present({ kind: 'window', rect: slot, center: paris, zoom: 10 });
      assert.deepEqual(p.log, ['frame 48.85,2.35 0,200 z10']);
    });

    test('a clip shows only the slot inside it; the view follows the whole slot', () => {
      const p = fakePage('list');
      // The slot runs 100 px under the top of the sheet's scroller.
      const clip = { left: 0, top: 600, width: 400, height: 200 };
      p.ocean.present({ kind: 'window', rect: slot, clip, center: paris });
      assert.equal(p.container.style.clipPath, 'inset(600px 20px 100px 20px)');
      assert.deepEqual(p.log, ['frame 48.85,2.35 0,200']);
      // A scroll moves the slot up by 50: the map moves with the slot, not with the clip.
      p.ocean.present({ kind: 'window', rect: { ...slot, top: 450 }, clip });
      assert.equal(p.container.style.clipPath, 'inset(600px 20px 150px 20px)');
      assert.deepEqual(p.log.slice(-2), ['frame - 0,150', 'panBy 0,50']);
    });

    test('a move out of the window removes the clip and the tap', () => {
      const p = fakePage('list');
      let taps = 0;
      p.ocean.present({ kind: 'window', rect: slot, center: paris, onTap: () => taps++ });
      p.ocean.present('hidden');
      assert.equal(p.container.style.clipPath, '');
      assert.equal(p.container.dataset.atlasOcean, 'hidden');
      assert.equal(p.windowTap, null);
      assert.equal(p.log[p.log.length - 1], 'park');
      // A click on a hidden ocean goes on to the map as before.
      const ev = p.dispatch('click');
      assert.equal(ev.stopped, false);
      assert.equal(taps, 0);
    });

    test('a tap in the window calls onTap; the click does not reach the map', () => {
      const p = fakePage('list');
      let taps = 0;
      p.ocean.present({ kind: 'window', rect: slot, center: paris, onTap: () => taps++ });
      p.dispatch('pointerdown', { clientX: 100, clientY: 600 });
      p.dispatch('pointermove', { clientX: 103, clientY: 601 });
      p.dispatch('pointerup');
      const ev = p.dispatch('click');
      assert.equal(taps, 1);
      assert.equal(ev.stopped, true, 'Leaflet and AtlasPlaces do not see the click');
      assert.equal(ev.prevented, true);
    });

    test('a drag in the window moves the map and is not a tap', () => {
      const p = fakePage('list');
      let taps = 0;
      p.ocean.present({ kind: 'window', rect: slot, center: paris, onTap: () => taps++ });
      p.dispatch('pointerdown', { clientX: 100, clientY: 600 });
      p.dispatch('pointermove', { clientX: 140, clientY: 600 });
      p.dispatch('pointerup');
      const ev = p.dispatch('click');
      assert.equal(taps, 0);
      assert.equal(ev.stopped, true, 'the click after a drag selects nothing');
    });

    test('a pinch in the window is not a tap', () => {
      const p = fakePage('list');
      let taps = 0;
      p.ocean.present({ kind: 'window', rect: slot, center: paris, onTap: () => taps++ });
      p.dispatch('pointerdown', { pointerId: 1 });
      p.dispatch('pointerdown', { pointerId: 2, clientX: 50 });
      p.dispatch('pointerup', { pointerId: 2 });
      p.dispatch('pointerup', { pointerId: 1 });
      p.dispatch('click');
      assert.equal(taps, 0);
    });

    test('a place pick in the window calls onTap, not the tag page', () => {
      const p = fakePage('list');
      let taps = 0;
      p.ocean.present({ kind: 'window', rect: slot, center: paris, onTap: () => taps++ });
      assert.ok(p.windowTap, 'the controller has a window tap');
      p.windowTap!();
      assert.equal(taps, 1);
    });

    test('animateTo tweens the clip from the full box to the slot, then sets the window', async () => {
      const p = fakePage('map');
      p.ocean.attach();
      const done = p.ocean.animateTo({ kind: 'window', rect: slot, center: paris }, 100);
      // The tween runs in window mode at the full box.
      assert.equal(p.ocean.presentation(), 'window');
      assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)');
      p.tick(50);
      // Half way (eased 0.5): top 250, bottom 50, sides 10.
      assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)');
      assert.equal(p.log[p.log.length - 1], 'frame 48.85,2.35 0,100', 'the point pans with the clip');
      p.tick(100);
      await done;
      assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
      assert.equal(p.log[p.log.length - 1], 'frame 48.85,2.35 0,200');
      assert.equal(p.pendingFrames, 0);
    });

    test('animateTo from the window to full grows the clip, then removes it', async () => {
      const p = fakePage('list');
      p.ocean.present({ kind: 'window', rect: slot, center: paris });
      const done = p.ocean.animateTo('full', 100);
      p.tick(50);
      assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)');
      p.tick(100);
      await done;
      assert.equal(p.ocean.presentation(), 'full');
      assert.equal(p.container.style.clipPath, '');
      assert.equal(p.log[p.log.length - 1], 'show');
    });

    test('animateTo under reduced motion is instant', async () => {
      const p = fakePage('map', { reducedMotion: true });
      p.ocean.attach();
      await p.ocean.animateTo({ kind: 'window', rect: slot, center: paris });
      assert.equal(p.pendingFrames, 0);
      assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
    });

    test('a present during a tween stops the tween and resolves it', async () => {
      const p = fakePage('map');
      p.ocean.attach();
      const done = p.ocean.animateTo({ kind: 'window', rect: slot, center: paris }, 100);
      p.ocean.present('full');
      await done;
      assert.equal(p.pendingFrames, 0);
      assert.equal(p.ocean.presentation(), 'full');
      assert.equal(p.container.style.clipPath, '');
    });

    describe('expand (the sheet widget opens the full map)', () => {
      const target = { center: paris, zoom: 6, focusPostSlug: 'a-post' };

      test('the clip grows from the slot to the whole box; the zoom waits for the tag page', async () => {
        const p = fakePage('list');
        let taps = 0;
        p.ocean.present({ kind: 'window', rect: slot, center: paris, zoom: 10, onTap: () => taps++ });
        p.log.length = 0;
        const done = p.ocean.expand(target, 100);
        assert.equal(p.ocean.presentation(), 'window');
        assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
        p.tick(50);
        // Half way (eased 0.5): top 250, bottom 50, sides 10.
        assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)');
        p.tick(100);
        await done;
        // The map holds as a window over the whole box, the point at the centre.
        assert.equal(p.ocean.presentation(), 'window');
        assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)');
        assert.equal(p.log[p.log.length - 1], 'frame 48.85,2.35 0,0');
        assert.ok(!p.log.some((l) => /z\d/.test(l)), 'no zoom change during the tween');
        // A tap while it holds does not open the full map a second time.
        p.dispatch('pointerdown');
        p.dispatch('pointerup');
        p.dispatch('click');
        assert.equal(taps, 0);

        // The tag page attaches in `map` state: full, then the zoom, then the selection.
        p.log.length = 0;
        p.setUrlState('map');
        p.ocean.attach();
        assert.equal(p.ocean.presentation(), 'full');
        assert.equal(p.container.style.clipPath, '');
        assert.deepEqual(p.log, ['layout', 'show', 'setView 48.85,2.35 z6', 'route a-post']);
        assert.equal(p.maps, 1, 'no second map');
      });

      test('reduced motion: the window covers the box at once', async () => {
        const p = fakePage('list', { reducedMotion: true });
        p.ocean.present({ kind: 'window', rect: slot, center: paris });
        await p.ocean.expand(target);
        assert.equal(p.pendingFrames, 0);
        assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)');
        p.setUrlState('map');
        p.ocean.attach();
        assert.equal(p.ocean.presentation(), 'full');
        assert.equal(p.log[p.log.length - 1], 'route a-post');
      });

      test('a present before the attach cancels the expand', async () => {
        const p = fakePage('list');
        p.ocean.present({ kind: 'window', rect: slot, center: paris });
        const done = p.ocean.expand(target, 100);
        p.ocean.present('hidden');
        await done;
        p.log.length = 0;
        p.setUrlState('map');
        p.ocean.attach();
        assert.deepEqual(p.log, ['layout', 'show']);
      });

      test('a later attach after a finished expand is a plain attach', async () => {
        const p = fakePage('list');
        p.ocean.present({ kind: 'window', rect: slot, center: paris });
        const done = p.ocean.expand(target, 100);
        p.tick(100);
        await done;
        p.setUrlState('map');
        p.ocean.attach();
        p.log.length = 0;
        p.ocean.attach();
        assert.deepEqual(p.log, ['show']);
      });
    });

    describe('collapse (the full map goes back into the sheet widget)', () => {
      const back = { kind: 'window' as const, rect: slot, center: paris, zoom: 10 };

      test('a Back to the open sheet holds the full map over the box; collapse shrinks it into the slot', async () => {
        const p = fakePage('map', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        // Held: a window over the whole box, no hide, no park.
        assert.equal(p.ocean.presentation(), 'window');
        assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)');
        assert.ok(!p.log.includes('park'));
        p.log.length = 0;
        // The slot is inside the sheet's scroller box (its clip).
        const done = p.ocean.collapse(() => ({ ...back, clip: { left: 0, top: 150, width: 400, height: 650 } }), 100);
        assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)', 'the tween starts at the box, not at the scroller');
        p.tick(0);
        assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)');
        p.tick(50);
        assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)');
        assert.equal(p.log[p.log.length - 1], 'frame 48.85,2.35 0,100', 'the place pans back with the clip');
        assert.ok(!p.log.some((l) => /z\d/.test(l)), 'no zoom change during the tween');
        p.tick(100);
        await done;
        assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
        assert.equal(p.log[p.log.length - 1], 'frame 48.85,2.35 0,200 z10', 'the slot zoom after the tween');
        assert.equal(p.maps, 1, 'no second map');
      });

      test('collapse waits for the slot\'s first layout: no tween from a zero rect', async () => {
        const p = fakePage('map', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        let laidOut = false;
        const done = p.ocean.collapse(() => (laidOut ? back : { ...back, rect: { left: 0, top: 0, width: 0, height: 0 } }), 100);
        p.tick(10);
        p.tick(20);
        assert.equal(p.container.style.clipPath, 'inset(0px 0px 0px 0px)', 'the map holds');
        laidOut = true;
        p.tick(30);
        p.tick(80);
        assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)', 'the tween starts at the layout');
        p.tick(130);
        await done;
        assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
      });

      test('a slot off screen is not a layout', async () => {
        const p = fakePage('map', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        const below = { ...back, rect: { left: 20, top: 900, width: 360, height: 200 } };
        const done = p.ocean.collapse(() => below, 100);
        for (let i = 1; i <= SETTLE_FRAMES; i++) p.tick(i);
        await done;
        // No layout in time: the held map goes.
        assert.equal(p.ocean.presentation(), 'hidden');
      });

      test('a second collapse during the tween goes on from the clip on screen, not from the box', async () => {
        const p = fakePage('map', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        void p.ocean.collapse(() => back, 100);
        p.tick(0);
        p.tick(50);
        assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)');
        // The post re-renders: its new viewer asks again.
        const done = p.ocean.collapse(() => back, 100);
        assert.equal(p.container.style.clipPath, 'inset(250px 10px 50px 10px)', 'no jump back to the box');
        p.tick(100);
        p.tick(200);
        await done;
        assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
      });

      test('reduced motion: instant', async () => {
        const p = fakePage('map', { sheetReturn: true, reducedMotion: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        await p.ocean.collapse(() => back);
        assert.equal(p.pendingFrames, 0);
        assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
      });

      test('from a hidden map (a reload of the post), collapse shows the window at once', async () => {
        const p = fakePage('list');
        await p.ocean.collapse(() => back, 100);
        assert.equal(p.pendingFrames, 0);
        assert.equal(p.ocean.presentation(), 'window');
        assert.equal(p.container.style.clipPath, 'inset(500px 20px 100px 20px)');
      });

      test('a move to a post that is not a sheet return hides the map', () => {
        const p = fakePage('map');
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        assert.equal(p.ocean.presentation(), 'hidden');
      });

      test('a hidden map is not held', () => {
        const p = fakePage('list', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        assert.equal(p.ocean.presentation(), 'hidden');
      });

      test('a held map that no sheet takes is hidden after the timeout', async () => {
        const p = fakePage('map', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post', 5);
        assert.equal(p.ocean.presentation(), 'window');
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(p.ocean.presentation(), 'hidden');
      });

      test('a present during the wait cancels the collapse and resolves it', async () => {
        const p = fakePage('map', { sheetReturn: true });
        p.ocean.attach();
        p.ocean.detach('/posts/a-post');
        const done = p.ocean.collapse(() => null, 100);
        p.ocean.present('hidden');
        await done;
        assert.equal(p.pendingFrames, 0);
        assert.equal(p.ocean.presentation(), 'hidden');
      });

      test('the chip shows only on a list page in full', () => {
        const p = fakePage('map');
        p.ocean.attach();
        assert.equal(p.chip, true);
        p.body.setAttribute('data-atlas-layer', 'mapList');
        assert.equal(p.chip, false);
        p.body.setAttribute('data-atlas-layer', 'map');
        assert.equal(p.chip, true);
        p.ocean.detach('/search');
        assert.equal(p.chip, false, 'gone on another page');
      });
    });

    test('destroy removes the window listeners', () => {
      const p = fakePage('list');
      let taps = 0;
      p.ocean.present({ kind: 'window', rect: slot, center: paris, onTap: () => taps++ });
      p.ocean.destroy();
      p.dispatch('click');
      assert.equal(taps, 0);
    });
  });
});

describe('atlasOcean default deps', () => {
  const g = globalThis as Record<string, unknown>;

  test('defaultIdle uses requestIdleCallback and its cancel', () => {
    const calls: string[] = [];
    const prevRic = g.requestIdleCallback;
    const prevCic = g.cancelIdleCallback;
    g.requestIdleCallback = (fn: () => void, opts: { timeout: number }) => {
      calls.push(`ric:${opts.timeout}`);
      fn();
      return 7;
    };
    g.cancelIdleCallback = (id: number) => calls.push(`cic:${id}`);
    try {
      let ran = false;
      const cancel = defaultIdle(() => { ran = true; });
      cancel();
      assert.ok(ran);
      assert.deepEqual(calls, ['ric:5000', 'cic:7']);
    } finally {
      g.requestIdleCallback = prevRic;
      g.cancelIdleCallback = prevCic;
    }
  });

  test('defaultIdle falls back to a timeout that the cancel clears', async () => {
    const prevRic = g.requestIdleCallback;
    g.requestIdleCallback = undefined;
    try {
      let ran = false;
      const cancel = defaultIdle(() => { ran = true; });
      cancel();
      await new Promise((r) => setTimeout(r, 1600));
      assert.equal(ran, false);
    } finally {
      g.requestIdleCallback = prevRic;
    }
  });

  test('defaultSaveData reads navigator.connection.saveData', () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      Object.defineProperty(globalThis, 'navigator', { value: { connection: { saveData: true } }, configurable: true });
      assert.equal(defaultSaveData(), true);
      Object.defineProperty(globalThis, 'navigator', { value: { connection: { saveData: false } }, configurable: true });
      assert.equal(defaultSaveData(), false);
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
      assert.equal(defaultSaveData(), false);
    } finally {
      if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    }
  });
});
