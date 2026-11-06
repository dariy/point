import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRelease, dragAxis, pullOpens, recentVelocity, sidePositions, snapState, lockAxis, stateAfter, stateAfterKey, stateLabel, startsOnControl } from '../src/plugins/tags-atlas/atlasLayerGesture.ts';

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
  it('in x, right past 40px is next and left is prev', () => {
    assert.equal(classifyRelease(50, 3, 400, 'x'), 'next');
    assert.equal(classifyRelease(-50, 3, 400, 'x'), 'prev');
  });
  it('in x, a short fast fling counts and a slow one does not', () => {
    assert.equal(classifyRelease(-20, 0, 30, 'x'), 'prev');
    assert.equal(classifyRelease(20, 0, 400, 'x'), 'none');
  });
  it('in x, a vertical swipe changes nothing', () => assert.equal(classifyRelease(5, 80, 100, 'x'), 'none'));
});

describe('dragAxis', () => {
  it('the stack layout drags only in y', () => {
    assert.equal(dragAxis(false, 'mapList', 'y'), 'y');
    assert.equal(dragAxis(false, 'list', 'x'), null);
  });
  it('the side layout drags only in x from mapList and map', () => {
    assert.equal(dragAxis(true, 'mapList', 'x'), 'x');
    assert.equal(dragAxis(true, 'map', 'y'), null);
  });
  it('the side layout takes either axis from list', () => {
    assert.equal(dragAxis(true, 'list', 'x'), 'x');
    assert.equal(dragAxis(true, 'list', 'y'), 'y');
  });
  it('no axis before the lock', () => assert.equal(dragAxis(true, 'mapList', null), null));
});

describe('sidePositions', () => {
  it('gives the handle left edge for each state', () => {
    // 844x390 phone: the split map is 390 px wide, the handle 30 px.
    assert.deepEqual(sidePositions(844, 390, 30), { list: 0, mapList: 360, map: 814 });
  });
  it('keeps mapList inside the bounds', () => {
    assert.deepEqual(sidePositions(300, 400, 30), { list: 0, mapList: 270, map: 270 });
    assert.deepEqual(sidePositions(844, 10, 30), { list: 0, mapList: 0, map: 814 });
  });
  it('snaps a drag in x like a drag in y', () => {
    const pos = sidePositions(844, 390, 30);
    assert.equal(snapState(200, 'mapList', 0, pos), 'mapList');
    assert.equal(snapState(150, 'mapList', 0, pos), 'list');
    assert.equal(snapState(600, 'mapList', 0, pos), 'map');
    // A fling to the left (map gets smaller) moves one step back.
    assert.equal(snapState(340, 'mapList', -0.6, pos), 'list');
    assert.equal(snapState(380, 'mapList', 0.6, pos), 'map');
  });
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
  it('in the side layout the list column never does: it scrolls', () => {
    const n = mk();
    assert.equal(startsOnControl(n.card, n, 'mapList', true), false);
    assert.equal(startsOnControl(n.inner, n, 'mapList', true), true);
  });
  it('the map never does', () => {
    const n = mk();
    assert.equal(startsOnControl(n.pin, n, 'mapList'), false);
  });
  // A footer node is a control when `closest` finds a button, link, input or paginator.
  const mkFooter = () => {
    const bg = Object.assign(new (globalThis as any).Node(), { closest: () => null });
    const btn = Object.assign(new (globalThis as any).Node(), { closest: (s: string) => (s.includes('button') ? btn : null) });
    const footer = new (globalThis as any).Node([bg, btn]);
    return { ...mk(), bg, btn, footer };
  };
  it('the footer background takes a start in mapList and map', () => {
    const n = mkFooter();
    assert.equal(startsOnControl(n.bg, n, 'mapList'), true);
    assert.equal(startsOnControl(n.bg, n, 'map'), true);
  });
  it('the footer does not take a start in list', () => {
    const n = mkFooter();
    assert.equal(startsOnControl(n.bg, n, 'list'), false);
  });
  it('a footer control never does', () => {
    const n = mkFooter();
    assert.equal(startsOnControl(n.btn, n, 'mapList'), false);
    assert.equal(startsOnControl(n.btn, n, 'map'), false);
  });
});

describe('pullOpens', () => {
  it('a pull down at scroll top opens', () => assert.equal(pullOpens(0, 2, 12), true));
  it('not after a scroll', () => assert.equal(pullOpens(200, 2, 12), false));
  it('not going up', () => assert.equal(pullOpens(0, 2, -12), false));
  it('not before the axis locks', () => assert.equal(pullOpens(0, 1, 5), false));
  it('not on a horizontal move', () => assert.equal(pullOpens(0, 20, 9), false));
});

describe('stateAfterKey', () => {
  it('maps keys to states', () => {
    assert.equal(stateAfterKey('list', 'Enter'), 'mapList');
    assert.equal(stateAfterKey('map', ' '), 'list');
    assert.equal(stateAfterKey('list', 'ArrowDown'), 'mapList');
    assert.equal(stateAfterKey('map', 'ArrowDown'), 'map');
    assert.equal(stateAfterKey('map', 'ArrowUp'), 'mapList');
    assert.equal(stateAfterKey('list', 'ArrowUp'), 'list');
    assert.equal(stateAfterKey('map', 'Escape'), 'list');
    assert.equal(stateAfterKey('list', 'a'), null);
  });
  it('ArrowRight and ArrowLeft step only in the side layout', () => {
    assert.equal(stateAfterKey('list', 'ArrowRight'), null);
    assert.equal(stateAfterKey('list', 'ArrowRight', true), 'mapList');
    assert.equal(stateAfterKey('map', 'ArrowLeft', true), 'mapList');
    assert.equal(stateAfterKey('mapList', 'ArrowDown', true), 'map');
  });
  it('labels each state', () => {
    assert.equal(stateLabel('list'), 'List');
    assert.equal(stateLabel('mapList'), 'Map and list');
    assert.equal(stateLabel('map'), 'Map only');
  });
});

describe('snapState', () => {
  const pos = { list: 100, mapList: 600, map: 780 };
  it('goes to the nearest position', () => {
    assert.equal(snapState(150, 'list', 0, pos), 'list');
    assert.equal(snapState(380, 'list', 0.1, pos), 'mapList');
    assert.equal(snapState(300, 'mapList', 0, pos), 'list');
    assert.equal(snapState(700, 'mapList', 0, pos), 'map');
    assert.equal(snapState(691, 'mapList', 0, pos), 'map');
    assert.equal(snapState(689, 'mapList', 0, pos), 'mapList');
  });
  it('a flick moves one state in its direction, whatever the distance', () => {
    assert.equal(snapState(130, 'list', 0.8, pos), 'mapList');
    assert.equal(snapState(590, 'mapList', 0.6, pos), 'map');
    assert.equal(snapState(590, 'mapList', -0.6, pos), 'list');
    assert.equal(snapState(780, 'map', 0.9, pos), 'map');
    assert.equal(snapState(100, 'list', -0.9, pos), 'list');
  });
  it('a speed under the threshold does not flick', () => {
    assert.equal(snapState(150, 'list', 0.49, pos), 'list');
  });
});

describe('recentVelocity', () => {
  it('is 0 without samples or time', () => {
    assert.equal(recentVelocity([]), 0);
    assert.equal(recentVelocity([{ y: 5, t: 10 }]), 0);
  });
  it('uses only samples inside the window', () => {
    const samples = [{ y: 0, t: 0 }, { y: 200, t: 400 }, { y: 210, t: 450 }, { y: 230, t: 480 }];
    assert.equal(recentVelocity(samples), (230 - 200) / 80);
  });
  it('is negative going up', () => {
    assert.ok(recentVelocity([{ y: 100, t: 0 }, { y: 40, t: 50 }]) < 0);
  });
});
