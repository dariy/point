import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createLongPress, peekText, PEEK_DELAY, PEEK_HOLD, PEEK_SLOP } from '../src/plugins/tags-atlas/atlasPeek.ts';

/** A long press on fake timers; `tick(ms)` runs the timers that are due. */
function harness() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const lp = createLongPress({
    onPeek: (id) => log.push('peek ' + id),
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
  test('peekText: one post, many posts', () => {
    assert.equal(peekText('Berlin', 1), 'Berlin · 1 post');
    assert.equal(peekText('Berlin', 12), 'Berlin · 12 posts');
    assert.equal(peekText('Berlin', 0), 'Berlin · 0 posts');
  });

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
    tick(1499);
    assert.deepEqual(log, ['peek 7']);
    tick(1);
    assert.deepEqual(log, ['peek 7', 'hide 7']);
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
    assert.deepEqual(log, ['peek 7', 'hide 7']);
    assert.equal(lp.consumeClick(), false);
    tick(PEEK_DELAY);
    assert.deepEqual(log, ['peek 7', 'hide 7', 'peek 8']);
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
});
