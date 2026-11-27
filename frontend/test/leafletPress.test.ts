import { test, describe } from 'node:test';
import assert from 'node:assert';

import { MOUSE_CLICK_TOLERANCE, setPressTolerance } from '../src/utils/leaflet.ts';
import type { PressMap } from '../src/utils/leaflet.ts';
import { PRESS_SLOP_PX } from '../src/utils/pointerMode.ts';

type Down = (e: { pointerType: string }) => void;

// A map container that keeps its pointerdown listeners, and a map with a Draggable.
function fakeMap(draggable = true) {
  const downs = new Set<Down>();
  const el = {
    addEventListener: (type: string, fn: Down, opts: { capture: boolean }) => {
      assert.equal(type, 'pointerdown');
      assert.equal(opts.capture, true, 'it runs before Leaflet');
      downs.add(fn);
    },
    removeEventListener: (_type: string, fn: Down) => { downs.delete(fn); },
  } as unknown as HTMLElement;
  const options = { clickTolerance: 3 };
  const map: PressMap = {
    getContainer: () => el,
    dragging: draggable ? { _draggable: { options } } : {},
  };
  const press = (pointerType: string) => { for (const fn of [...downs]) fn({ pointerType }); };
  return { map, options, press, downs };
}

describe('setPressTolerance', () => {
  test('a pen press and a touch press set PRESS_SLOP_PX; a mouse press sets 3', () => {
    const { map, options, press } = fakeMap();
    setPressTolerance(map);
    press('pen');
    assert.equal(options.clickTolerance, PRESS_SLOP_PX);
    assert.equal(options.clickTolerance, 10);
    press('mouse');
    assert.equal(options.clickTolerance, MOUSE_CLICK_TOLERANCE);
    assert.equal(options.clickTolerance, 3);
    press('touch');
    assert.equal(options.clickTolerance, 10);
  });

  test('a map with no _draggable causes no error', () => {
    const { map, press } = fakeMap(false);
    setPressTolerance(map);
    assert.doesNotThrow(() => press('pen'));
    const bare: PressMap = { getContainer: map.getContainer };
    setPressTolerance(bare);
    assert.doesNotThrow(() => press('touch'));
  });

  test('the returned function removes the listener', () => {
    const { map, options, press, downs } = fakeMap();
    const off = setPressTolerance(map);
    off();
    assert.equal(downs.size, 0);
    press('pen');
    assert.equal(options.clickTolerance, 3);
  });
});
