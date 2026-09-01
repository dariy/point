// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click } from './helpers/dom.js';
import {
  gestureDirection,
  swipeTranslate,
  swipeOutcome,
  dropZoneFor,
  reorderPlan,
  rowParentId,
  bindSwipeToReveal,
  bindDragAndDrop,
  THRESHOLD_PX,
  DAMPING,
} from '../src/components/light/tags/tagGestures.js';

describe('gestureDirection', () => {
  test('withholds a direction until the movement is big enough', () => {
    assert.equal(gestureDirection(0, 0), null);
    assert.equal(gestureDirection(7, 7), null, 'below the 8px floor on both axes');
    assert.equal(gestureDirection(-7, 3), null);
  });

  test('picks the dominant axis once past the floor', () => {
    assert.equal(gestureDirection(20, 3), 'horizontal');
    assert.equal(gestureDirection(-20, 3), 'horizontal');
    assert.equal(gestureDirection(3, 20), 'vertical');
    assert.equal(gestureDirection(3, -20), 'vertical');
  });

  test('a perfect diagonal is treated as vertical, so scrolling wins', () => {
    // Not arbitrary: letting a tie count as horizontal would hijack scrolls.
    assert.equal(gestureDirection(20, 20), 'vertical');
  });

  test('honours a custom floor', () => {
    assert.equal(gestureDirection(5, 0), null);
    assert.equal(gestureDirection(5, 0, 4), 'horizontal');
  });
});

describe('swipeTranslate', () => {
  const W = 100;

  test('a closed row follows the finger leftward one-to-one', () => {
    assert.equal(swipeTranslate({ rawDx: -30, isOpen: false, actionsWidth: W }), -30);
    assert.equal(swipeTranslate({ rawDx: -W, isOpen: false, actionsWidth: W }), -W, 'exactly at the stop');
  });

  test('an open row starts from the revealed offset', () => {
    assert.equal(swipeTranslate({ rawDx: 0, isOpen: true, actionsWidth: W }), -W);
    assert.equal(swipeTranslate({ rawDx: 40, isOpen: true, actionsWidth: W }), -60);
  });

  test('rubber-bands past the right edge', () => {
    const t = swipeTranslate({ rawDx: 100, isOpen: false, actionsWidth: W });
    assert.equal(t, 100 * (1 - DAMPING));
    assert.ok(t < 100, 'resisted rather than following the finger');
  });

  test('rubber-bands past the left stop', () => {
    const t = swipeTranslate({ rawDx: -200, isOpen: false, actionsWidth: W });
    assert.equal(t, -W - 100 * (1 - DAMPING));
    assert.ok(t > -200, 'resisted');
    assert.ok(t < -W, 'but still past the stop');
  });

  test('resistance grows the further past the stop you drag', () => {
    const a = swipeTranslate({ rawDx: -150, isOpen: false, actionsWidth: W });
    const b = swipeTranslate({ rawDx: -250, isOpen: false, actionsWidth: W });
    assert.ok(b < a, 'still moves');
    assert.ok((a - b) < 100, 'but by less than the extra finger travel');
  });

  test('a row with no actions has nowhere to open to', () => {
    assert.equal(swipeTranslate({ rawDx: -50, isOpen: false, actionsWidth: 0 }), -50 * (1 - DAMPING));
  });
});

describe('swipeOutcome', () => {
  const W = 100;

  test('a closed row opens only past the threshold', () => {
    assert.equal(swipeOutcome({ dx: -(THRESHOLD_PX + 1), isOpen: false, actionsWidth: W }), 'open');
    assert.equal(swipeOutcome({ dx: -THRESHOLD_PX, isOpen: false, actionsWidth: W }), 'reset', 'exactly at the threshold is not past it');
    assert.equal(swipeOutcome({ dx: -5, isOpen: false, actionsWidth: W }), 'reset');
  });

  test('a closed row swiped right toggles selection', () => {
    assert.equal(swipeOutcome({ dx: THRESHOLD_PX + 1, isOpen: false, actionsWidth: W }), 'select');
    assert.equal(swipeOutcome({ dx: THRESHOLD_PX, isOpen: false, actionsWidth: W }), 'reset');
  });

  test('a row with no actions cannot open, but can still select', () => {
    assert.equal(swipeOutcome({ dx: -200, isOpen: false, actionsWidth: 0 }), 'reset');
    assert.equal(swipeOutcome({ dx: 200, isOpen: false, actionsWidth: 0 }), 'select');
  });

  test('an open row closes on a right swipe and otherwise settles back open', () => {
    assert.equal(swipeOutcome({ dx: THRESHOLD_PX + 1, isOpen: true, actionsWidth: W }), 'close');
    assert.equal(swipeOutcome({ dx: 5, isOpen: true, actionsWidth: W }), 'snap-open');
    assert.equal(swipeOutcome({ dx: -50, isOpen: true, actionsWidth: W }), 'snap-open',
      'dragging an open row further left never re-triggers select');
  });
});

describe('dropZoneFor', () => {
  const rect = { top: 100, height: 40 };

  test('the top quarter is "before" and the bottom quarter is "after"', () => {
    assert.equal(dropZoneFor(102, rect), 'before');
    assert.equal(dropZoneFor(138, rect), 'after');
  });

  test('the middle half is "on"', () => {
    assert.equal(dropZoneFor(110, rect), 'on');
    assert.equal(dropZoneFor(120, rect), 'on');
    assert.equal(dropZoneFor(130, rect), 'on');
  });

  test('the boundaries belong to "on"', () => {
    assert.equal(dropZoneFor(110, rect), 'on', 'exactly 25%');
    assert.equal(dropZoneFor(130, rect), 'on', 'exactly 75%');
  });

  test('positions outside the row still resolve', () => {
    assert.equal(dropZoneFor(0, rect), 'before');
    assert.equal(dropZoneFor(999, rect), 'after');
  });
});

describe('reorderPlan', () => {
  const siblingBefore = () => 42;

  test('a drop in the middle means reparent', () => {
    assert.deepEqual(reorderPlan({ zone: 'on', dragParent: 1, targetParent: 2, targetId: 5, siblingBefore }),
      { action: 'reparent' });
  });

  test('"after" lands directly after the target', () => {
    assert.deepEqual(reorderPlan({ zone: 'after', dragParent: 1, targetParent: 1, targetId: 5, siblingBefore }),
      { action: 'reorder', parentId: 1, afterId: 5 });
  });

  test('"before" lands after whatever currently precedes the target', () => {
    assert.deepEqual(reorderPlan({ zone: 'before', dragParent: 1, targetParent: 1, targetId: 5, siblingBefore }),
      { action: 'reorder', parentId: 1, afterId: 42 });
  });

  test('"before" the first sibling means the front of the list', () => {
    assert.deepEqual(
      reorderPlan({ zone: 'before', dragParent: 1, targetParent: 1, targetId: 5, siblingBefore: () => null }),
      { action: 'reorder', parentId: 1, afterId: null },
    );
  });

  test('reordering across two different parents is refused', () => {
    assert.deepEqual(reorderPlan({ zone: 'before', dragParent: 1, targetParent: 2, targetId: 5, siblingBefore }),
      { action: 'invalid' });
  });

  test('reordering at the unparented top level is refused', () => {
    // The backend positions a tag among a parent's children; there is no
    // ordering to express for two roots.
    for (const dragParent of [null, undefined]) {
      assert.deepEqual(reorderPlan({ zone: 'before', dragParent, targetParent: null, targetId: 5, siblingBefore }),
        { action: 'invalid' }, `dragParent=${dragParent}`);
    }
  });

  test('reparenting to the top level is still allowed', () => {
    assert.deepEqual(reorderPlan({ zone: 'on', dragParent: null, targetParent: null, targetId: 5, siblingBefore }),
      { action: 'reparent' });
  });

  test('siblingBefore is not consulted for an "after" drop', () => {
    let calls = 0;
    reorderPlan({ zone: 'after', dragParent: 1, targetParent: 1, targetId: 5, siblingBefore: () => { calls++; return 1; } });
    assert.equal(calls, 0);
  });
});

describe('DOM-bound gestures', () => {
  let dom;

  beforeEach(() => {
    dom = setupDOM();
    globalThis.matchMedia = q => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} });
    window.matchMedia = globalThis.matchMedia;
    // linkedom has no layout engine; give the measured bits a fixed size.
    const proto = window.HTMLElement.prototype;
    Object.defineProperty(proto, 'offsetWidth', {
      configurable: true,
      get() { return this.classList?.contains('tm-actions') ? 100 : 0; },
    });
    proto.getBoundingClientRect = () => ({ top: 100, height: 40 });
  });
  afterEach(() => dom.cleanup());

  const buildRows = () => {
    document.body.innerHTML = `
      <div id="c">
        <div class="tm-row" data-id="2" data-parent-id="1"><span class="nm">France</span><div class="tm-actions"><button>x</button></div></div>
        <div class="tm-row" data-id="3" data-parent-id="1"><span class="nm">Japan</span><div class="tm-actions"><button>x</button></div></div>
        <div class="tm-row" data-id="4" data-parent-id=""><span class="nm">Loose</span><div class="tm-actions"><button>x</button></div></div>
      </div>`;
    return document.getElementById('c');
  };
  const row = (c, id) => c.querySelector(`.tm-row[data-id="${id}"]`);

  const touch = (el, type, x, y, count = 1) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    const list = new Array(count).fill({ clientX: x, clientY: y });
    e.touches = list;
    e.changedTouches = list;
    el.dispatchEvent(e);
  };
  const swipe = (el, fromX, toX, y = 50) => {
    touch(el, 'touchstart', fromX, y);
    touch(el, 'touchmove', toX, y);
    touch(el, 'touchend', toX, y);
  };

  describe('bindSwipeToReveal', () => {
    test('does nothing on desktop widths', () => {
      globalThis.matchMedia = q => ({ matches: false, media: q });
      window.matchMedia = globalThis.matchMedia;
      assert.equal(bindSwipeToReveal(buildRows(), {}), null);
    });

    test('does nothing without matchMedia at all', () => {
      delete globalThis.matchMedia;
      delete window.matchMedia;
      assert.equal(bindSwipeToReveal(buildRows(), {}), null);
    });

    test('a left swipe reveals the row', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 140);
      assert.ok(row(c, 2).classList.contains('tm-row--revealed'));
      assert.equal(row(c, 2).style.transform, 'translateX(-100px)');
    });

    test('a right swipe reports a selection instead', () => {
      const c = buildRows();
      const selected = [];
      bindSwipeToReveal(c, { onSelect: r => selected.push(r.dataset.id) });
      swipe(row(c, 2), 100, 180);
      assert.deepEqual(selected, ['2']);
      assert.equal(row(c, 2).classList.contains('tm-row--revealed'), false);
    });

    test('a vertical drag is left alone so the page can scroll', () => {
      const c = buildRows();
      const selected = [];
      bindSwipeToReveal(c, { onSelect: r => selected.push(r.dataset.id) });
      touch(row(c, 2), 'touchstart', 200, 50);
      touch(row(c, 2), 'touchmove', 198, 200);
      touch(row(c, 2), 'touchend', 198, 200);
      assert.equal(row(c, 2).style.transform, '');
      assert.deepEqual(selected, []);
    });

    test('a multi-touch gesture is ignored', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      touch(row(c, 2), 'touchstart', 200, 50, 2);
      touch(row(c, 2), 'touchmove', 140, 50, 2);
      assert.equal(row(c, 2).style.transform, '');
    });

    test('opening a second row closes the first', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 140);
      swipe(row(c, 3), 200, 140);
      assert.equal(row(c, 2).classList.contains('tm-row--revealed'), false);
      assert.ok(row(c, 3).classList.contains('tm-row--revealed'));
    });

    test('swiping an open row back right closes it', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 140);
      swipe(row(c, 2), 140, 220);
      assert.equal(row(c, 2).classList.contains('tm-row--revealed'), false);
      assert.equal(row(c, 2).style.transform, '');
    });

    test('a short left swipe snaps back without opening', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 180);          // 20px — past the direction floor, under the threshold
      assert.equal(row(c, 2).style.transform, '');
      assert.equal(row(c, 2).classList.contains('tm-row--revealed'), false);
    });

    test('releasing an open row short of the threshold settles it back open', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 140);
      swipe(row(c, 2), 140, 150);          // nudged right, but not far enough
      assert.equal(row(c, 2).style.transform, 'translateX(-100px)');
    });

    test('a cancelled gesture restores the row to its resting place', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      touch(row(c, 2), 'touchstart', 200, 50);
      touch(row(c, 2), 'touchmove', 140, 50);
      touch(row(c, 2), 'touchcancel', 140, 50);
      assert.equal(row(c, 2).style.transform, '', 'a closed row snaps shut');

      swipe(row(c, 3), 200, 140);
      touch(row(c, 3), 'touchstart', 140, 50);
      touch(row(c, 3), 'touchmove', 120, 50);
      touch(row(c, 3), 'touchcancel', 120, 50);
      assert.equal(row(c, 3).style.transform, 'translateX(-100px)', 'an open row stays open');
    });

    test('clicking outside the open row closes it; clicking inside does not', () => {
      const c = buildRows();
      bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 140);
      click(row(c, 2).querySelector('.nm'));
      assert.ok(row(c, 2).classList.contains('tm-row--revealed'), 'still open');
      click(row(c, 3));
      assert.equal(row(c, 2).classList.contains('tm-row--revealed'), false);
    });

    test('rows without an actions drawer are skipped', () => {
      const c = buildRows();
      const bare = document.createElement('div');
      bare.className = 'tm-row';
      bare.dataset.id = '9';
      c.appendChild(bare);
      bindSwipeToReveal(c, {});
      swipe(bare, 200, 140);
      assert.equal(bare.style.transform, '');
    });

    test('cleanup detaches the listeners and shuts an open row', () => {
      const c = buildRows();
      const cleanup = bindSwipeToReveal(c, {});
      swipe(row(c, 2), 200, 140);
      cleanup();
      assert.equal(row(c, 2).classList.contains('tm-row--revealed'), false);

      swipe(row(c, 3), 200, 140);
      assert.equal(row(c, 3).classList.contains('tm-row--revealed'), false, 'no longer listening');
    });
  });

  describe('bindDragAndDrop', () => {
    const drag = (el, type, { clientY = 120, relatedTarget = null } = {}) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      e.clientY = clientY;
      e.relatedTarget = relatedTarget;
      e.dataTransfer = { setData() {}, getData() {} };
      el.dispatchEvent(e);
    };
    const handlers = (calls) => ({
      siblingBefore: () => 99,
      onReparent: (d, t) => calls.push(`reparent ${d}->${t}`),
      onReorder: (d, p, a) => calls.push(`reorder ${d} under ${p} after ${a}`),
      onInvalidReorder: () => calls.push('invalid'),
    });
    // The binder only attaches to draggable rows.
    const buildDraggable = () => {
      const c = buildRows();
      c.querySelectorAll('.tm-row').forEach(r => r.setAttribute('draggable', 'true'));
      return c;
    };

    test('dropping in the middle reparents', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 120 });
      drag(row(c, 3), 'drop', { clientY: 120 });
      assert.deepEqual(calls, ['reparent 2->3']);
    });

    test('dropping below a sibling reorders after it', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 135 });
      drag(row(c, 3), 'drop', { clientY: 135 });
      assert.deepEqual(calls, ['reorder 2 under 1 after 3']);
    });

    test('dropping above a sibling reorders after its predecessor', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 102 });
      drag(row(c, 3), 'drop', { clientY: 102 });
      assert.deepEqual(calls, ['reorder 2 under 1 after 99']);
    });

    test('reordering across parents is rejected', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 4), 'dragover', { clientY: 102 });
      drag(row(c, 4), 'drop', { clientY: 102 });
      assert.deepEqual(calls, ['invalid']);
    });

    test('dropping a row on itself does nothing', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 2), 'drop', { clientY: 120 });
      assert.deepEqual(calls, []);
    });

    test('a drop with no drag in progress does nothing', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 3), 'drop', { clientY: 120 });
      assert.deepEqual(calls, []);
    });

    test('dragover marks the hovered zone and switching zones re-marks', () => {
      const c = buildDraggable();
      bindDragAndDrop(c, handlers([]));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 102 });
      assert.ok(row(c, 3).classList.contains('tm-drop-before'));
      drag(row(c, 3), 'dragover', { clientY: 135 });
      assert.equal(row(c, 3).classList.contains('tm-drop-before'), false);
      assert.ok(row(c, 3).classList.contains('tm-drop-after'));
    });

    test('dragend clears the drag and its indicators', () => {
      const c = buildDraggable(); const calls = [];
      bindDragAndDrop(c, handlers(calls));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 102 });
      drag(row(c, 2), 'dragend');
      assert.equal(row(c, 3).classList.contains('tm-drop-before'), false);
      assert.equal(row(c, 2).classList.contains('tm-dragging'), false);

      drag(row(c, 3), 'drop', { clientY: 120 });
      assert.deepEqual(calls, [], 'the abandoned drag cannot still drop');
    });

    test('leaving a row for an unrelated element clears only its indicator', () => {
      const c = buildDraggable();
      bindDragAndDrop(c, handlers([]));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 102 });
      drag(row(c, 3), 'dragleave', { relatedTarget: row(c, 4) });
      assert.equal(row(c, 3).classList.contains('tm-drop-before'), false);
    });

    test('moving within a row keeps its indicator', () => {
      const c = buildDraggable();
      bindDragAndDrop(c, handlers([]));
      drag(row(c, 2), 'dragstart');
      drag(row(c, 3), 'dragover', { clientY: 102 });
      drag(row(c, 3), 'dragleave', { relatedTarget: row(c, 3).querySelector('.nm') });
      assert.ok(row(c, 3).classList.contains('tm-drop-before'));
    });
  });
});

describe('rowParentId', () => {
  test('reads a numeric parent id', () => {
    assert.equal(rowParentId({ dataset: { parentId: '7' } }), 7);
  });

  test('an empty attribute means top level', () => {
    assert.equal(rowParentId({ dataset: { parentId: '' } }), null);
  });
});
