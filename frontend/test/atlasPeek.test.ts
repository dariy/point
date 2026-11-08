import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createLongPress, liftPill, PEEK_DELAY, PEEK_HOLD, PEEK_LIFT, PEEK_SLOP } from '../src/plugins/tags-atlas/atlasPeek.ts';

/** A long press on fake timers; `tick(ms)` runs the timers that are due. */
function harness() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const lp = createLongPress({
    onPeek: (id, x, y) => log.push(`peek ${id}` + (x === 100 && y === 100 ? '' : ` at ${x},${y}`)),
    onDrop: (id) => log.push('drop ' + id),
    onHide: (id) => log.push('hide ' + id),
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (t) => timers.delete(t as number),
  });
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { lp, log, tick, timers };
}

describe('atlasPeek', () => {
  test('the defaults: 450 ms, 6 px, 1.5 s', () => {
    assert.equal(PEEK_DELAY, 450);
    assert.equal(PEEK_SLOP, 6);
    assert.equal(PEEK_HOLD, 1500);
  });

  test('a press of 450 ms shows the peek; the release hides it after 1.5 s', () => {
    const { lp, log, tick } = harness();
    lp.down(7, 1, 100, 100);
    tick(449);
    assert.deepEqual(log, []);
    tick(1);
    assert.deepEqual(log, ['peek 7']);
    tick(2000); // held: the peek stays while the finger is down
    assert.deepEqual(log, ['peek 7']);
    lp.up(1);
    assert.deepEqual(log, ['peek 7', 'drop 7'], 'the release moves the pill back to its dot at once');
    tick(1499);
    assert.deepEqual(log, ['peek 7', 'drop 7']);
    tick(1);
    assert.deepEqual(log, ['peek 7', 'drop 7', 'hide 7']);
    assert.equal(lp.active(), false);
  });

  test('a peek press swallows its click one time', () => {
    const { lp, tick } = harness();
    lp.down(7, 1, 100, 100);
    tick(PEEK_DELAY);
    lp.up(1);
    assert.equal(lp.consumeClick(), true);
    assert.equal(lp.consumeClick(), false);
  });

  test('a short tap shows no peek and keeps its click', () => {
    const { lp, log, tick } = harness();
    lp.down(7, 1, 100, 100);
    tick(200);
    lp.up(1);
    tick(PEEK_DELAY + PEEK_HOLD);
    assert.deepEqual(log, []);
    assert.equal(lp.consumeClick(), false);
  });

  test('a movement of less than 6 px keeps the press; 6 px cancels it', () => {
    const near = harness();
    near.lp.down(7, 1, 100, 100);
    near.lp.move(1, 103, 104); // 5 px
    near.tick(PEEK_DELAY);
    assert.deepEqual(near.log, ['peek 7']);

    const far = harness();
    far.lp.down(7, 1, 100, 100);
    far.lp.move(1, 100, 106); // 6 px: a drag
    far.tick(PEEK_DELAY + PEEK_HOLD);
    assert.deepEqual(far.log, []);
    assert.equal(far.lp.consumeClick(), false);
  });

  test('a movement after the peek shows does not hide it', () => {
    const { lp, log, tick } = harness();
    lp.down(7, 1, 100, 100);
    tick(PEEK_DELAY);
    lp.move(1, 160, 100);
    assert.deepEqual(log, ['peek 7']);
  });

  test('another pointer does not move or end the press', () => {
    const { lp, log, tick } = harness();
    lp.down(7, 1, 100, 100);
    lp.move(2, 300, 300);
    lp.up(2);
    tick(PEEK_DELAY);
    assert.deepEqual(log, ['peek 7']);
  });

  test('a new press hides the peek that shows and resets the click', () => {
    const { lp, log, tick } = harness();
    lp.down(7, 1, 100, 100);
    tick(PEEK_DELAY);
    lp.up(1);
    lp.down(8, 2, 200, 200);
    assert.deepEqual(log, ['peek 7', 'drop 7', 'hide 7']);
    assert.equal(lp.consumeClick(), false);
    tick(PEEK_DELAY);
    assert.deepEqual(log, ['peek 7', 'drop 7', 'hide 7', 'peek 8 at 200,200']);
  });

  test('cancel stops the timers and hides the peek', () => {
    const { lp, log, tick, timers } = harness();
    lp.down(7, 1, 100, 100);
    tick(PEEK_DELAY);
    lp.cancel();
    assert.deepEqual(log, ['peek 7', 'hide 7']);
    assert.equal(timers.size, 0);
    assert.equal(lp.consumeClick(), false);
    lp.down(8, 2, 0, 0);
    lp.cancel();
    tick(PEEK_DELAY);
    assert.deepEqual(log, ['peek 7', 'hide 7']);
  });

  test('onPeek gets the touch point of the press', () => {
    const { lp, log, tick } = harness();
    lp.down(3, 1, 40, 250);
    tick(PEEK_DELAY);
    assert.deepEqual(log, ['peek 3 at 40,250']);
  });

  test('a press that shows no peek drops nothing', () => {
    const { lp, log, tick } = harness();
    lp.down(3, 1, 100, 100);
    tick(100);
    lp.up(1);
    tick(3000);
    assert.deepEqual(log, []);
  });

  describe('liftPill', () => {
    const box = { left: 0, top: 0, right: 800, bottom: 600 };
    // An 80 x 18 pill at rest at a 12 px dot whose centre is at `x`, `y`.
    const pillAt = (x: number, y: number) => ({ left: x - 9, top: y - 9, width: 80, height: 18 });
    // The pill box after the lift.
    const lift = (x: number, y: number, b = box) => {
      const p = pillAt(x, y);
      const d = liftPill(p, x, y, b);
      return { left: p.left + d.dx, top: p.top + d.dy, right: p.left + d.dx + p.width, bottom: p.top + d.dy + p.height };
    };

    test('the pill goes 44 px above the touch point, centred on the dot', () => {
      assert.equal(PEEK_LIFT, 44);
      const b = lift(400, 300);
      assert.equal(b.bottom, 300 - 44);
      assert.equal((b.left + b.right) / 2, 400);
    });

    test('at the top edge the pill goes 44 px below the finger', () => {
      const b = lift(400, 30);
      assert.equal(b.top, 30 + 44);
      assert.ok(b.top > 30, 'the pill does not contain the touch point');
    });

    test('the pill stays inside the map box at the left and right edges', () => {
      assert.equal(lift(10, 300).left, 0);
      assert.equal(lift(796, 300).right, 800);
    });

    test('with no room above or below, the pill stays inside the box bottom', () => {
      assert.equal(lift(400, 30, { left: 0, top: 0, right: 800, bottom: 80 }).bottom, 80);
    });
  });
});
