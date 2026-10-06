import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRelease, lockAxis, stateAfter, startsOnControl } from '../src/plugins/tags-atlas/atlasLayerGesture.ts';

describe('lockAxis', () => {
  it('stays open under 8px', () => assert.equal(lockAxis(5, 7), null));
  it('locks y on a mostly vertical move', () => assert.equal(lockAxis(2, 9), 'y'));
  it('locks x on a mostly horizontal move', () => assert.equal(lockAxis(-12, 4), 'x'));
});

describe('classifyRelease', () => {
  it('a still touch is a tap', () => assert.equal(classifyRelease(1, 2, 80), 'tap'));
  it('down past 40px is next', () => assert.equal(classifyRelease(0, 50, 400), 'next'));
  it('up past 40px is prev', () => assert.equal(classifyRelease(0, -50, 400), 'prev'));
  it('a short slow drag snaps back', () => assert.equal(classifyRelease(0, 20, 400), 'none'));
  it('a short fast fling counts', () => assert.equal(classifyRelease(0, -20, 30), 'prev'));
  it('a horizontal swipe changes nothing', () => assert.equal(classifyRelease(80, 10, 100), 'none'));
});

describe('stateAfter', () => {
  it('maps releases onto the state machine', () => {
    assert.equal(stateAfter('list', 'next'), 'mapList');
    assert.equal(stateAfter('map', 'next'), 'map');
    assert.equal(stateAfter('mapList', 'prev'), 'list');
    assert.equal(stateAfter('map', 'tap'), 'list');
    assert.equal(stateAfter('mapList', 'none'), 'mapList');
  });
});

describe('startsOnControl', () => {
  class N {
    kids: N[];
    constructor(kids: N[] = []) { this.kids = kids; }
    contains(n: unknown): boolean { return n === this || this.kids.some((k) => k.contains(n)); }
  }
  (globalThis as any).Node ??= N;
  const mk = () => {
    const inner = new (globalThis as any).Node();
    const handle = new (globalThis as any).Node([inner]);
    const card = new (globalThis as any).Node();
    const grid = new (globalThis as any).Node([card]);
    const pin = new (globalThis as any).Node();
    const map = new (globalThis as any).Node([pin]);
    return { inner, handle, card, grid, pin, map };
  };
  it('the handle takes a start in every state', () => {
    const n = mk();
    assert.equal(startsOnControl(n.inner, n, 'list'), true);
  });
  it('the card row takes a start only in mapList', () => {
    const n = mk();
    assert.equal(startsOnControl(n.card, n, 'mapList'), true);
    assert.equal(startsOnControl(n.card, n, 'list'), false);
  });
  it('the map never does', () => {
    const n = mk();
    assert.equal(startsOnControl(n.pin, n, 'mapList'), false);
  });
});
