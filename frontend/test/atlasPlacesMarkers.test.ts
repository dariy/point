/**
 * AtlasPlaces on a fake Leaflet: the place search (`_mountSearch`,
 * `pickPlace`), the cluster and label passes (`_applyClusters`,
 * `_applyLabels`, `setLabelBounds`) and the long-press peek (`_setPeek`,
 * `_liftPeek`, `_dropPeek`, `_listenPeek`). The DOM is linkedom.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.ts';
import { AtlasPlaces } from '../src/plugins/tags-atlas/AtlasPlaces.ts';

type LatLng = [number, number];
type Handler = (e?: unknown) => void;

/** A layer group that records its layers. */
function fakeLayer() {
  const layers = new Set<unknown>();
  return {
    layers,
    addLayer(m: unknown) { layers.add(m); return this; },
    removeLayer(m: unknown) { layers.delete(m); return this; },
    clearLayers() { layers.clear(); return this; },
    addTo() { return this; },
  };
}
type Layer = ReturnType<typeof fakeLayer>;

/** A marker whose icon is a real element, built from the divIcon html. */
function fakeMarker(latLng: LatLng, opts: { icon?: { className?: string; html?: string } } = {}) {
  const on = new Map<string, Handler[]>();
  const el = document.createElement('div');
  el.className = opts.icon?.className ?? '';
  el.innerHTML = opts.icon?.html ?? '';
  const m = {
    latLng,
    _icon: el as HTMLElement,
    on(ev: string, fn: Handler) { on.set(ev, [...(on.get(ev) ?? []), fn]); return m; },
    fire(ev: string, e?: unknown) { for (const fn of on.get(ev) ?? []) fn(e); },
    addTo(layer: Layer) { layer.addLayer(m); return m; },
    getLatLng: () => latLng,
  };
  return m;
}
type Marker = ReturnType<typeof fakeMarker>;

/** Container px: 10 px per degree, lng → x, lat → y. */
const px = (ll: LatLng) => ({ x: ll[1] * 10, y: ll[0] * 10 });

function fakeL() {
  const stops: unknown[] = [];
  return {
    stops,
    DomEvent: {
      disableClickPropagation() {},
      disableScrollPropagation() {},
      stop(e: unknown) { stops.push(e); },
    },
    divIcon: (o: unknown) => o,
    marker: (ll: LatLng, o: { icon?: { className?: string; html?: string } }) => fakeMarker(ll, o),
    latLngBounds: (pts: LatLng[]) => ({ pts }),
  };
}

function fakeMap(root: HTMLElement) {
  const on = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  let dragOn = true;
  const map = {
    calls,
    zoom: 4,
    maxZoom: 18,
    options: {} as { maxBounds?: unknown },
    getSize: () => ({ x: 1000, y: 1000 }),
    getZoom: () => map.zoom,
    getMaxZoom: () => map.maxZoom,
    latLngToContainerPoint: px,
    project: px,
    getContainer: () => root,
    fitBounds: (b: unknown, o: unknown) => { calls.push('fitBounds ' + JSON.stringify([b, o])); },
    flyTo: (ll: unknown, z: number, o: { animate: boolean }) => { calls.push(`flyTo ${JSON.stringify(ll)} ${z} animate=${o.animate}`); },
    flyToBounds: (b: unknown, o: { maxZoom: number }) => { calls.push(`flyToBounds ${JSON.stringify(b)} max=${o.maxZoom}`); },
    setMaxBounds: (b: unknown) => { calls.push('setMaxBounds ' + JSON.stringify(b)); },
    on(evs: string, fn: Handler) { for (const ev of evs.split(' ')) { if (!on.has(ev)) on.set(ev, new Set()); on.get(ev)!.add(fn); } },
    off(evs: string, fn: Handler) { for (const ev of evs.split(' ')) on.get(ev)?.delete(fn); },
    fire(ev: string) { for (const fn of [...(on.get(ev) ?? [])]) fn(); },
    listeners: (ev: string) => on.get(ev)?.size ?? 0,
    dragging: {
      enabled: () => dragOn,
      disable: () => { dragOn = false; calls.push('drag off'); },
      enable: () => { dragOn = true; calls.push('drag on'); },
    },
  };
  return map;
}

const TAGS = [
  { id: 1, slug: 'berlin', name: 'Berlin', post_count: 9 },
  { id: 2, slug: 'bern', name: 'Bern', post_count: 2 },
  { id: 3, slug: 'paris', name: 'Paris', post_count: 4, is_hidden: true },
];

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const L = fakeL();
  const map = fakeMap(root);
  const p = new AtlasPlaces({ L, map, root, isAlive: () => true, onSelect: () => {} } as never);
  for (const t of TAGS) p._tagsById.set(t.id, t as never);
  return { root, L, map, p };
}

/** Put a place marker for `id` at `ll` (a 12 px dot, a 60 px pill). */
function addPlace(p: AtlasPlaces, id: number, ll: LatLng, weight = 1) {
  const m = fakeMarker(ll, {
    icon: { className: 'atlas-marker', html: '<span class="atlas-marker__dot"></span><span class="atlas-marker__label">x</span>' },
  });
  m._icon.dataset.placeId = String(id);
  p._markerLayer.addLayer(m);
  p._labels.set(id, {
    id, latLng: ll, marker: m,
    label: { dx: -9, dy: -9, width: 60, height: 18 },
    dot: { dx: -6, dy: -6, width: 12, height: 12 },
    weight,
  });
  return m;
}

const key = (k: string) => Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: k });

describe('AtlasPlaces place search', () => {
  let dom: ReturnType<typeof setupDOM>;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => dom.cleanup());

  function search() {
    const s = setup();
    for (const t of TAGS) s.p._placeActivators.set(t.id, { latLng: [0, 0], setActive: () => {}, key: 'g' + t.id });
    const picks: number[] = [];
    s.p.pickPlace = (id: number) => { picks.push(id); return true; };
    const box = s.p._mountSearch();
    s.root.append(box);
    const open = box.querySelector<HTMLButtonElement>('.atlas-search__open')!;
    const input = box.querySelector<HTMLInputElement>('.atlas-search__input')!;
    const list = box.querySelector<HTMLUListElement>('.atlas-search__list')!;
    const type = (v: string) => { input.value = v; input.dispatchEvent(new Event('input')); };
    const items = () => [...list.querySelectorAll<HTMLElement>('.atlas-search__item')];
    return { ...s, box, open, input, list, type, items, picks };
  }

  test('the button opens and closes the field', () => {
    const { box, open } = search();
    assert.equal(open.getAttribute('aria-expanded'), 'false');
    open.click();
    assert.ok(box.classList.contains('is-open'));
    assert.equal(open.getAttribute('aria-expanded'), 'true');
    open.click();
    assert.ok(!box.classList.contains('is-open'));
  });

  test('a query lists the drawn places that match, the first one active', () => {
    const { input, list, type, items } = search();
    type('ber');
    assert.equal(list.hidden, false);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    const names = items().map((li) => li.querySelector('.atlas-search__name')!.textContent);
    assert.deepEqual(names, ['Berlin', 'Bern']);
    assert.equal(items()[0]!.querySelector('.atlas-search__count')!.textContent, '9');
    assert.ok(items()[0]!.classList.contains('is-active'));
    assert.equal(input.getAttribute('aria-activedescendant'), 'atlas-search-opt-0');
  });

  test('a place that is not drawn is not found', () => {
    const { p, type, items } = search();
    p._placeActivators.delete(2);
    type('ber');
    assert.deepEqual(items().map((li) => li.dataset.placeId), ['1']);
  });

  test('a hidden place has the hidden mark', () => {
    const { type, items } = search();
    type('par');
    assert.ok(items()[0]!.classList.contains('atlas-search__item--hidden'));
  });

  test('no match closes the list', () => {
    const { input, list, type, items } = search();
    type('ber');
    type('zzz');
    assert.equal(list.hidden, true);
    assert.equal(items().length, 0);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.getAttribute('aria-activedescendant'), null);
  });

  test('the arrow keys move the active item, with a wrap', () => {
    const { input, type, items } = search();
    type('ber');
    input.dispatchEvent(key('ArrowDown'));
    assert.ok(items()[1]!.classList.contains('is-active'));
    assert.equal(items()[1]!.getAttribute('aria-selected'), 'true');
    input.dispatchEvent(key('ArrowDown'));
    assert.ok(items()[0]!.classList.contains('is-active'));
    input.dispatchEvent(key('ArrowUp'));
    assert.ok(items()[1]!.classList.contains('is-active'));
  });

  test('an arrow key with no results does nothing', () => {
    const { input, items } = search();
    const e = key('ArrowDown');
    input.dispatchEvent(e);
    assert.equal(e.defaultPrevented, false);
    assert.equal(items().length, 0);
  });

  test('Enter picks the active place and closes the field', () => {
    const { box, open, input, type, picks } = search();
    open.click();
    type('ber');
    input.dispatchEvent(key('ArrowDown'));
    const e = key('Enter');
    input.dispatchEvent(e);
    assert.ok(e.defaultPrevented);
    assert.deepEqual(picks, [2]);
    assert.ok(!box.classList.contains('is-open'));
    assert.equal(input.value, '');
  });

  test('Enter with no results picks nothing', () => {
    const { input, picks } = search();
    input.dispatchEvent(key('Enter'));
    assert.deepEqual(picks, []);
  });

  test('a click on an item picks it; the click does not reach the map', () => {
    const { root, type, items, picks } = search();
    let reached = 0;
    root.addEventListener('click', () => reached++);
    type('ber');
    const md = new Event('mousedown', { bubbles: true, cancelable: true });
    items()[1]!.dispatchEvent(md);
    assert.ok(md.defaultPrevented, 'mousedown does not blur the field');
    items()[1]!.dispatchEvent(new Event('click', { bubbles: true }));
    assert.deepEqual(picks, [2]);
    assert.equal(reached, 0);
  });

  test('Escape closes the field; a key does not reach the page', () => {
    const { box, open, input, type } = search();
    let reached = 0;
    document.addEventListener('keydown', () => reached++);
    open.click();
    type('ber');
    input.dispatchEvent(key('Escape'));
    assert.ok(!box.classList.contains('is-open'));
    assert.equal(input.value, '');
    input.dispatchEvent(key('a'));
    assert.equal(reached, 0);
  });
});

describe('AtlasPlaces.pickPlace', () => {
  let dom: ReturnType<typeof setupDOM>;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => dom.cleanup());

  function picker() {
    const s = setup();
    const selects: string[] = [];
    s.p._select = ((tag: { slug: string }, _ll: unknown, _sa: unknown, k: string, o: { fly?: boolean }) => {
      selects.push(`${tag.slug} ${k} fly=${o.fly}`);
      return undefined;
    }) as never;
    return { ...s, selects };
  }

  test('an unknown or undrawn place is no pick', () => {
    const { p, map } = picker();
    assert.equal(p.pickPlace(99), false);
    p._placeActivators.set(99, { latLng: [1, 1], setActive: () => {}, key: 'g99' });
    assert.equal(p.pickPlace(99), false);
    assert.deepEqual(map.calls, []);
  });

  test('a marker place: fly in to the pick zoom, then select it', () => {
    const { p, map, selects } = picker();
    p._placeActivators.set(1, { latLng: [52, 13], setActive: () => {}, key: 'g1' });
    assert.equal(p.pickPlace(1), true);
    assert.deepEqual(map.calls, ['flyTo [52,13] 10 animate=true']);
    assert.deepEqual(selects, ['berlin g1 fly=true']);
  });

  test('a marker place: a deeper zoom stays, and the max zoom caps it', () => {
    const { p, map } = picker();
    p._placeActivators.set(1, { latLng: [52, 13], setActive: () => {}, key: 'g1' });
    map.zoom = 14;
    p.pickPlace(1);
    map.maxZoom = 8;
    map.zoom = 3;
    p.pickPlace(1);
    assert.deepEqual(map.calls, ['flyTo [52,13] 14 animate=true', 'flyTo [52,13] 8 animate=true']);
  });

  test('a shape place: fit its bounds', () => {
    const { p, map } = picker();
    p._placeActivators.set(3, { latLng: [46, 2], setActive: () => {}, key: 'g3', bounds: 'FR' });
    p.pickPlace(3);
    assert.deepEqual(map.calls, ['flyToBounds "FR" max=10']);
  });

  test('the place that is open already is not selected again', () => {
    const { p, selects } = picker();
    p._placeActivators.set(1, { latLng: [52, 13], setActive: () => {}, key: 'g1' });
    p._activeKey = 'g1';
    p.pickPlace(1);
    assert.deepEqual(selects, []);
  });

  test('the max-bounds check is off for the fly and comes back at zoomend', () => {
    const { p, map } = picker();
    map.options.maxBounds = 'WORLD';
    p._placeActivators.set(1, { latLng: [52, 13], setActive: () => {}, key: 'g1' });
    p.pickPlace(1);
    assert.equal(map.calls[0], 'setMaxBounds null');
    assert.equal(map.listeners('zoomend'), 1);
    map.fire('zoomend');
    assert.equal(map.calls[map.calls.length - 1], 'setMaxBounds "WORLD"');
    assert.equal(map.listeners('zoomend'), 0);
    assert.equal(map.listeners('dragstart'), 0);
  });

  test('reduced motion: no animation, and the max-bounds check stays', () => {
    const { p, map } = picker();
    window.matchMedia = (() => ({ matches: true })) as never;
    map.options.maxBounds = 'WORLD';
    p._placeActivators.set(1, { latLng: [52, 13], setActive: () => {}, key: 'g1' });
    p.pickPlace(1);
    assert.deepEqual(map.calls, ['flyTo [52,13] 10 animate=false']);
  });
});

describe('AtlasPlaces clusters and labels', () => {
  let dom: ReturnType<typeof setupDOM>;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => dom.cleanup());

  function layers() {
    const s = setup();
    s.p._markerLayer = fakeLayer();
    s.p._clusterLayer = fakeLayer();
    return s;
  }

  test('dots that overlap merge into one cluster at the largest place', () => {
    const { p } = layers();
    const berlin = addPlace(p, 1, [52, 13], 9);
    const bern = addPlace(p, 2, [52, 13.1], 2);
    addPlace(p, 3, [10, 60], 4);
    p._applyClusters();
    assert.deepEqual([...p._clustered].sort(), [1, 2]);
    assert.ok(!p._markerLayer.layers.has(berlin));
    assert.ok(!p._markerLayer.layers.has(bern));
    assert.equal(p._clusters.length, 1);
    const c = p._clusters[0]!;
    assert.deepEqual(c.ids, [1, 2]);
    assert.ok(p._clusterLayer.layers.has(c.marker));
    const icon = c.marker._icon as HTMLElement;
    assert.equal(icon.getAttribute('aria-label'), '2 places: Berlin and 1 more');
    assert.equal(icon.dataset.clusterSize, '2');
    assert.match(icon.innerHTML, /Berlin \+1/);
    assert.equal(c.label.id, -1);
    assert.equal(c.label.weight, 11);
  });

  test('a tap on a cluster fits its places', () => {
    const { p, map, L } = layers();
    addPlace(p, 1, [52, 13], 9);
    addPlace(p, 2, [52, 13.1], 2);
    p._applyClusters();
    const ev = { type: 'click' };
    (p._clusters[0]!.marker as Marker).fire('click', ev);
    assert.deepEqual(L.stops, [ev]);
    assert.deepEqual(map.calls, ['fitBounds ' + JSON.stringify([{ pts: [[52, 13], [52, 13.1]] }, { padding: [60, 60], maxZoom: 18 }])]);
  });

  test('a hidden lead place gives the cluster a hidden label', () => {
    const { p } = layers();
    addPlace(p, 3, [52, 13], 9);
    addPlace(p, 2, [52, 13.1], 2);
    p._applyClusters();
    assert.match((p._clusters[0]!.marker._icon as HTMLElement).innerHTML, /atlas-label--hidden/);
  });

  test('at the max zoom no cluster forms, and the members come back', () => {
    const { p, map } = layers();
    const berlin = addPlace(p, 1, [52, 13], 9);
    addPlace(p, 2, [52, 13.1], 2);
    p._applyClusters();
    map.zoom = 18;
    p._applyClusters();
    assert.equal(p._clusters.length, 0);
    assert.equal(p._clustered.size, 0);
    assert.ok(p._markerLayer.layers.has(berlin));
  });

  test('the open place and the window place stay out of a cluster', () => {
    const { p } = layers();
    addPlace(p, 1, [52, 13], 9);
    addPlace(p, 2, [52, 13.1], 2);
    p._activeTag = TAGS[0] as never;
    p._applyClusters();
    assert.equal(p._clusters.length, 0);
    p._activeTag = null;
    p._windowSlug = 'bern';
    p._applyClusters();
    assert.equal(p._clusters.length, 0);
  });

  test('with no layers the cluster pass does nothing', () => {
    const { p } = setup();
    p._applyClusters();
    assert.equal(p._clusters.length, 0);
  });

  test('pills with room are labelled; a pill that covers another dot is not', () => {
    const { p } = layers();
    const a = addPlace(p, 1, [10, 10], 9);
    const b = addPlace(p, 2, [10, 12], 2); // 20 px right: the 60 px pill of a covers the dot of b
    const c = addPlace(p, 3, [50, 50], 4);
    p._applyLabels();
    const on = (m: Marker) => m._icon.classList.contains('atlas-marker--labelled');
    assert.equal(on(a), false);
    assert.equal(on(b), true);
    assert.equal(on(c), true);
  });

  test('the selected place goes first while no cloud shows', () => {
    const { p } = layers();
    const a = addPlace(p, 1, [10, 10], 9);
    const b = addPlace(p, 2, [10, 12], 2);
    p._activeTag = TAGS[1] as never;
    p._applyLabels();
    assert.equal(b._icon.classList.contains('atlas-marker--labelled'), true);
    assert.equal(a._icon.classList.contains('atlas-marker--labelled'), false);
  });

  test('label bounds: only the places in the window are labelled; the same bounds do not run the pass', () => {
    const { p } = layers();
    const a = addPlace(p, 1, [10, 10], 9);
    const c = addPlace(p, 3, [50, 50], 4);
    p.setLabelBounds({ left: 0, top: 0, width: 200, height: 200 });
    assert.equal(a._icon.classList.contains('atlas-marker--labelled'), true);
    assert.equal(c._icon.classList.contains('atlas-marker--labelled'), false);
    let runs = 0;
    p._applyLabels = () => { runs++; };
    p.setLabelBounds({ left: 0, top: 0, width: 200, height: 200 });
    assert.equal(runs, 0);
    p.setLabelBounds(null);
    assert.equal(runs, 1);
  });

  test('a label width is measured once per text', () => {
    const { p } = setup();
    const w = p._measureLabel('Berlin');
    assert.ok(w > 10);
    assert.ok(p._labelFont.startsWith('600 11px'));
    p._labelWidths.set('Berlin', 77);
    assert.equal(p._measureLabel('Berlin'), 77);
  });
});

describe('AtlasPlaces peek', () => {
  let dom: ReturnType<typeof setupDOM>;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => dom.cleanup());

  function peek() {
    const s = setup();
    s.p._markerLayer = fakeLayer();
    const m = addPlace(s.p, 1, [10, 10], 9);
    s.root.append(m._icon);
    const label = m._icon.querySelector<HTMLElement>('.atlas-marker__label')!;
    return { ...s, m, icon: m._icon, label };
  }

  test('a peek expands the pill and holds the map drag until the release', () => {
    const { p, map, icon } = peek();
    p._setPeek(1, true);
    assert.ok(icon.classList.contains('atlas-marker--peek'));
    assert.equal(p._peekHeldDrag, true);
    assert.deepEqual(map.calls, ['drag off']);
    p._releasePeekDrag();
    p._releasePeekDrag();
    assert.deepEqual(map.calls, ['drag off', 'drag on']);
    p._setPeek(1, false);
    assert.ok(!icon.classList.contains('atlas-marker--peek'));
  });

  test('a lift moves the pill above the finger; a hide puts it back', () => {
    const { p, icon, label } = peek();
    p._liftPeek(1, 100, 100);
    assert.ok(icon.classList.contains('atlas-marker--lift'));
    assert.match(label.style.getPropertyValue('--atlas-lift-y'), /^-?\d+px$/);
    p._setPeek(1, false);
    assert.ok(!icon.classList.contains('atlas-marker--lift'));
    assert.equal(label.style.getPropertyValue('--atlas-lift-y'), '');
    p._liftPeek(99, 0, 0); // no such place: nothing
  });

  test('a drop moves the pill back with a transition', () => {
    const { p, icon, label } = peek();
    p._dropPeek(1); // no lift: nothing
    assert.ok(!icon.classList.contains('atlas-marker--drop'));
    p._liftPeek(1, 100, 100);
    p._dropPeek(1);
    assert.ok(!icon.classList.contains('atlas-marker--lift'));
    assert.ok(icon.classList.contains('atlas-marker--drop'));
    label.dispatchEvent(new Event('transitionend'));
    assert.ok(!icon.classList.contains('atlas-marker--drop'));
  });

  test('reduced motion: the drop is instant', () => {
    const { p, icon } = peek();
    window.matchMedia = (() => ({ matches: true })) as never;
    p._liftPeek(1, 100, 100);
    p._dropPeek(1);
    assert.ok(!icon.classList.contains('atlas-marker--lift'));
    assert.ok(!icon.classList.contains('atlas-marker--drop'));
  });

  test('touch input on a place pill drives the long press', () => {
    const { p, root, icon } = peek();
    const log: string[] = [];
    let consume = false;
    p._peek = {
      down: (id: number, pid: number) => log.push(`down ${id} ${pid}`),
      move: (pid: number, x: number) => log.push(`move ${pid} ${x}`),
      up: (pid: number) => log.push(`up ${pid}`),
      cancel: () => log.push('cancel'),
      consumeClick: () => consume,
    } as never;
    p._peekHeldDrag = true;
    const off = p._listenPeek();
    const ptr = (type: string, target: Element, o: Record<string, unknown> = {}) => {
      const e = Object.assign(new Event(type, { bubbles: true, cancelable: true }),
        { pointerType: 'touch', isPrimary: true, pointerId: 5, clientX: 7, clientY: 8, ...o });
      target.dispatchEvent(e);
      return e;
    };
    const dot = icon.querySelector('.atlas-marker__dot')!;
    ptr('pointerdown', dot);
    ptr('pointermove', dot);
    ptr('pointerup', dot);
    assert.deepEqual(log, ['down 1 5', 'move 5 7', 'up 5']);
    assert.equal(p._peekHeldDrag, false, 'the release frees the map');
    // A mouse, a press off a pill, and a press in a window cancel.
    log.length = 0;
    ptr('pointerdown', dot, { pointerType: 'mouse' });
    ptr('pointerdown', root);
    root.dataset.atlasOcean = 'window';
    ptr('pointerdown', dot);
    assert.deepEqual(log, ['cancel', 'cancel', 'cancel']);
    // The click of a peek press is no tap.
    const plain = ptr('click', dot);
    assert.equal(plain.defaultPrevented, false);
    consume = true;
    const swallowed = ptr('click', dot);
    assert.equal(swallowed.defaultPrevented, true);
    // No system menu on a marker.
    const menu = ptr('contextmenu', dot);
    assert.equal(menu.defaultPrevented, true);
    assert.equal(ptr('contextmenu', root).defaultPrevented, false);
    off();
    log.length = 0;
    ptr('pointerup', dot);
    assert.deepEqual(log, []);
  });
});
