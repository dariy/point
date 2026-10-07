/**
 * atlasLayerGesture — swipe and tap on the layer controls.
 *
 * Only the handle, and the card row while the layer is open, take a gesture.
 * The map is a separate element that has no listener here, so a gesture that
 * starts in the map goes to the map alone. The classifier functions are pure.
 */

import { cycle, getAtlasLayerState, next, prev, setAtlasLayerState } from './atlasLayerState.ts';
import type { AtlasLayerState } from './atlasLayerState.ts';

/** Movement that locks the axis, and the largest movement that is still a tap. */
export const AXIS_LOCK_PX = 8;
/** A vertical drag of at least this many px changes the state. */
export const SWIPE_DISTANCE_PX = 40;
/** A faster vertical fling (px/ms) changes the state at any distance past the lock. */
export const FLING_VELOCITY = 0.5;

export type Axis = 'x' | 'y' | null;
export type Release = 'next' | 'prev' | 'tap' | 'none';

/** Which axis the gesture owns. `null` until the movement passes the lock distance. */
export function lockAxis(dx: number, dy: number): Axis {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return null;
  return Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
}

/**
 * What a finished gesture means. Down is `next`, up is `prev`. A gesture that
 * stayed under the lock distance is a tap. A horizontal gesture is `none`.
 */
export function classifyRelease(dx: number, dy: number, elapsedMs: number): Release {
  const axis = lockAxis(dx, dy);
  if (axis === null) return 'tap';
  if (axis === 'x') return 'none';
  const velocity = Math.abs(dy) / Math.max(elapsedMs, 1);
  if (Math.abs(dy) < SWIPE_DISTANCE_PX && velocity < FLING_VELOCITY) return 'none';
  return dy > 0 ? 'next' : 'prev';
}

/** Handle top edge (px from the viewport top) for each state while the layer is dragged. */
export interface SnapPositions {
  list: number;
  mapList: number;
  map: number;
}

/**
 * The state a free drag ends in. `y` is the handle top at release, `velocity`
 * the recent vertical speed in px/ms (down is positive). A flick at or above
 * `FLING_VELOCITY` moves one state from `from` in the flick direction; a slower
 * release goes to the nearest position.
 */
export function snapState(y: number, from: AtlasLayerState, velocity: number, positions: SnapPositions): AtlasLayerState {
  if (Math.abs(velocity) >= FLING_VELOCITY) return velocity > 0 ? next(from) : prev(from);
  let best: AtlasLayerState = 'list';
  for (const state of ['list', 'mapList', 'map'] as const) {
    if (Math.abs(positions[state] - y) < Math.abs(positions[best] - y)) best = state;
  }
  return best;
}

/** Speed (px/ms, down positive) over the samples of the last `SPEED_WINDOW_MS`. */
export const SPEED_WINDOW_MS = 100;
export function recentVelocity(samples: readonly { y: number; t: number }[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const first = samples.find((s) => last.t - s.t <= SPEED_WINDOW_MS) ?? last;
  return last.t === first.t ? 0 : (last.y - first.y) / (last.t - first.t);
}

/** The state a release leads to, from the current one. */
export function stateAfter(state: AtlasLayerState, release: Release): AtlasLayerState {
  if (release === 'next') return next(state);
  if (release === 'prev') return prev(state);
  if (release === 'tap') return cycle(state);
  return state;
}

/**
 * True when a gesture that starts on `target` belongs to the layer controls:
 * the handle always, the card row only while the layer is open. Never the map.
 */
export function startsOnControl(
  target: EventTarget | null,
  els: { handle: Element; grid: Element | null; map: Element | null },
  state: AtlasLayerState,
): boolean {
  if (!(target instanceof globalThis.Node)) return false;
  if (els.map?.contains(target)) return false;
  if (els.handle.contains(target)) return true;
  return state === 'mapList' && !!els.grid?.contains(target);
}

/** Quiet time (ms) after the last wheel event before the next wheel gesture counts. */
export const WHEEL_DEBOUNCE_MS = 250;

/** State a key press on the handle leads to, or `null` when the key is not ours. */
export function stateAfterKey(state: AtlasLayerState, key: string): AtlasLayerState | null {
  if (key === 'Enter' || key === ' ') return cycle(state);
  if (key === 'ArrowDown') return next(state);
  if (key === 'ArrowUp') return prev(state);
  if (key === 'Escape') return 'list';
  return null;
}

/** Text for the live region that tells the current state. */
export function stateLabel(state: AtlasLayerState): string {
  if (state === 'mapList') return 'Map and list';
  if (state === 'map') return 'Map only';
  return 'List';
}

/** Time (ms) the handle takes to slide to its snap position. */
const SNAP_MS = 200;

const px = (name: string): number => parseFloat(document.body.style.getPropertyValue(name)) || 0;

/**
 * Wire swipe and tap on the handle and the card row. Returns a teardown.
 * A vertical drag moves the handle freely: `body[data-atlas-dragging]` shows the
 * map above it and the card row below it, and `--atlas-layer-list-h` (the height
 * under the map) follows the finger. On release the handle slides to the position
 * `snapState` chose, and only then does the state change.
 */
export function mountAtlasLayerGesture(handle: HTMLElement, gridMount: () => HTMLElement | null): () => void {
  const body = document.body;
  let start: { id: number; x: number; y: number; t: number; onHandle: boolean; handleY: number; from: AtlasLayerState } | null = null;
  let axis: Axis = null;
  let samples: { y: number; t: number }[] = [];
  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  let snapTo: AtlasLayerState | null = null;

  const bounds = () => {
    const top = px('--atlas-layer-top');
    const bottom = window.innerHeight - px('--atlas-layer-footer-h') - handle.offsetHeight;
    return { top, bottom: Math.max(top, bottom) };
  };
  const positions = (): SnapPositions => {
    const { top, bottom } = bounds();
    const cs = getComputedStyle(body);
    const rowMin = parseFloat(cs.getPropertyValue('--atlas-layer-row-min')) || 120;
    const pager = parseFloat(cs.getPropertyValue('--atlas-layer-pager-h')) || 0;
    const mapList = window.innerHeight - Math.max(window.innerHeight * 0.2, handle.offsetHeight + rowMin + pager);
    return { list: top, mapList: Math.min(Math.max(mapList, top), bottom), map: bottom };
  };
  const setHandleY = (y: number) => body.style.setProperty('--atlas-layer-list-h', `${window.innerHeight - y}px`);
  // The cards take the layout of the state the handle would snap to now.
  const setDragTarget = (state: AtlasLayerState) => {
    if (body.dataset.atlasDragTarget !== state) body.dataset.atlasDragTarget = state;
  };
  let settleFrame = 0;

  const finishDrag = () => {
    if (snapTimer !== null) clearTimeout(snapTimer);
    snapTimer = null;
    const target = snapTo;
    snapTo = null;
    if (!body.hasAttribute('data-atlas-dragging')) return;
    // The drag left the layout where the new state puts it. Change the state with
    // transitions off, so the map does not fold or slide a second time.
    body.setAttribute('data-atlas-settling', '');
    if (target && target !== getAtlasLayerState()) setAtlasLayerState(target);
    body.removeAttribute('data-atlas-dragging');
    body.removeAttribute('data-atlas-snapping');
    body.removeAttribute('data-atlas-drag-target');
    body.style.removeProperty('--atlas-layer-list-h');
    cancelAnimationFrame(settleFrame);
    settleFrame = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => body.removeAttribute('data-atlas-settling'));
    });
  };

  const els = () => ({ handle, grid: gridMount(), map: document.querySelector('body > .atlas-layer-map') });

  const onDown = (e: PointerEvent) => {
    if (start || snapTimer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target instanceof globalThis.Element && e.target.closest('.atlas-layer-handle__btn')) return;
    if (!startsOnControl(e.target, els(), getAtlasLayerState())) return;
    start = {
      id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp,
      onHandle: handle.contains(e.target as Node),
      handleY: handle.getBoundingClientRect().top,
      from: getAtlasLayerState(),
    };
    axis = null;
    samples = [];
    // A mouse leaves the 20px handle on the first move, before the axis locks.
    // Capture at once so the drag keeps its events.
    if (start.onHandle) {
      try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* target gone */ }
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (axis === null) {
      axis = lockAxis(e.clientX - start.x, dy);
      if (axis === 'y') {
        try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* target gone */ }
        setHandleY(start.handleY);
        setDragTarget(start.from);
        body.setAttribute('data-atlas-dragging', '');
      }
    }
    if (axis !== 'y') return;
    const { top, bottom } = bounds();
    const y = Math.min(bottom, Math.max(top, start.handleY + dy));
    setHandleY(y);
    setDragTarget(snapState(y, start.from, 0, positions()));
    samples.push({ y: e.clientY, t: e.timeStamp });
    if (samples.length > 8) samples.shift();
  };

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!start || e.pointerId !== start.id) return;
    const { x, y, t, onHandle, handleY, from } = start;
    start = null;
    const wasAxis = axis;
    axis = null;
    if (wasAxis === 'y') {
      const pos = positions();
      const { top, bottom } = bounds();
      const releaseY = Math.min(bottom, Math.max(top, handleY + e.clientY - y));
      const target = cancelled ? from : snapState(releaseY, from, recentVelocity(samples), pos);
      snapTo = target;
      setDragTarget(target);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finishDrag();
      } else {
        body.setAttribute('data-atlas-snapping', '');
        setHandleY(pos[target]);
        snapTimer = setTimeout(finishDrag, SNAP_MS + 20);
      }
      return;
    }
    // No drag: a tap on the handle cycles the state.
    if (cancelled || wasAxis === 'x') return;
    const release = classifyRelease(e.clientX - x, e.clientY - y, e.timeStamp - t);
    const finish = release === 'tap' && !onHandle ? 'none' : release;
    const state = getAtlasLayerState();
    const target = stateAfter(state, finish);
    if (target !== state) setAtlasLayerState(target);
  };
  const onUp = (e: PointerEvent) => end(e, false);
  const onCancel = (e: PointerEvent) => end(e, true);

  const live = document.createElement('span');
  live.className = 'atlas-layer-handle__live';
  live.setAttribute('aria-live', 'polite');
  handle.append(live);
  const syncExpanded = () => {
    const state = getAtlasLayerState();
    handle.setAttribute('aria-expanded', String(state !== 'list'));
    live.textContent = stateLabel(state);
  };
  syncExpanded();
  const observer = new MutationObserver(syncExpanded);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-atlas-layer'] });

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== handle) return;
    const target = stateAfterKey(getAtlasLayerState(), e.key);
    if (target === null) return;
    e.preventDefault();
    setAtlasLayerState(target);
  };

  // One step per wheel gesture: the timer restarts on each event, so trackpad
  // inertia after the first step does not step again.
  let wheelBusy: ReturnType<typeof setTimeout> | null = null;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const busy = wheelBusy !== null;
    if (wheelBusy !== null) clearTimeout(wheelBusy);
    wheelBusy = setTimeout(() => { wheelBusy = null; }, WHEEL_DEBOUNCE_MS);
    if (busy || e.deltaY === 0) return;
    const state = getAtlasLayerState();
    setAtlasLayerState(e.deltaY > 0 ? next(state) : prev(state));
  };

  handle.addEventListener('keydown', onKey);
  handle.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onCancel);
  return () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    observer.disconnect();
    handle.removeEventListener('keydown', onKey);
    handle.removeEventListener('wheel', onWheel);
    if (wheelBusy !== null) clearTimeout(wheelBusy);
    live.remove();
    finishDrag();
    cancelAnimationFrame(settleFrame);
    body.removeAttribute('data-atlas-settling');
  };
}
