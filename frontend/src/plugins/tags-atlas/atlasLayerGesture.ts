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

/** Largest follow distance while dragging, so the sheet does not leave the screen. */
const FOLLOW_MAX_PX = 120;

/**
 * Wire swipe and tap on the handle and the card row. Returns a teardown.
 * While a drag runs the controls follow the finger by `transform`; on release
 * they snap to the state the classifier chose.
 */
export function mountAtlasLayerGesture(handle: HTMLElement, gridMount: () => HTMLElement | null): () => void {
  let start: { id: number; x: number; y: number; t: number; onHandle: boolean } | null = null;
  let axis: Axis = null;
  let followed: HTMLElement[] = [];

  const clearFollow = () => {
    for (const el of followed) {
      el.style.transform = '';
      el.style.transition = '';
    }
    followed = [];
  };

  const els = () => ({ handle, grid: gridMount(), map: document.querySelector('body > .atlas-layer-map') });

  const onDown = (e: PointerEvent) => {
    if (start || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!startsOnControl(e.target, els(), getAtlasLayerState())) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, onHandle: handle.contains(e.target as Node) };
    axis = null;
  };

  const onMove = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (axis === null) {
      axis = lockAxis(dx, dy);
      if (axis === 'y') {
        try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* target gone */ }
        const grid = gridMount();
        followed = [handle, ...(grid && getAtlasLayerState() === 'mapList' ? [grid] : [])];
      }
    }
    if (axis !== 'y') return;
    const follow = Math.max(-FOLLOW_MAX_PX, Math.min(FOLLOW_MAX_PX, dy));
    for (const el of followed) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${follow}px)`;
    }
  };

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!start || e.pointerId !== start.id) return;
    const { x, y, t, onHandle } = start;
    start = null;
    const wasAxis = axis;
    axis = null;
    const release = cancelled && wasAxis !== 'y' ? 'none' : classifyRelease(e.clientX - x, e.clientY - y, e.timeStamp - t);
    for (const el of followed) el.style.transition = 'transform 0.2s ease-out';
    const finish = release === 'tap' && !onHandle ? 'none' : release;
    const state = getAtlasLayerState();
    const target = cancelled ? state : stateAfter(state, finish);
    if (target !== state) setAtlasLayerState(target);
    // Snap: the new layout takes over, so drop the offset.
    requestAnimationFrame(clearFollow);
  };
  const onUp = (e: PointerEvent) => end(e, false);
  const onCancel = (e: PointerEvent) => end(e, true);

  const syncExpanded = () => handle.setAttribute('aria-expanded', String(getAtlasLayerState() !== 'list'));
  syncExpanded();
  const observer = new MutationObserver(syncExpanded);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-atlas-layer'] });

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
    clearFollow();
  };
}
