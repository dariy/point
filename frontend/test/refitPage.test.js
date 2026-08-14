import { test, describe } from 'node:test';
import assert from 'node:assert';

// gridFit.js reads localStorage/document at import time for its zoom helpers;
// refitPage itself is pure arithmetic, so the stubs only have to exist.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { innerWidth: 1200, innerHeight: 800, getComputedStyle: () => ({}), dispatchEvent() {} };
globalThis.document = {
  body: { classList: { add() {}, remove() {}, contains: () => false }, style: { setProperty() {}, removeProperty() {} }, appendChild() {} },
  createElement: () => ({ style: {}, remove() {}, offsetWidth: 0 }),
  appendChild() {},
  querySelector: () => null,
};

const { refitPage } = await import('../src/utils/gridFit.js');

/**
 * A resize re-fits per_page, which moves the page boundaries under the reader.
 * refitPage picks the page that still holds the first post they were looking
 * at — on both sides of the feed, since the owner's scheduled queue (pages 0,
 * -1, …) is indexed outwards from page 1 rather than continuing its run.
 */
describe('refitPage', () => {
  test('the same per_page leaves the page alone', () => {
    for (const p of [-2, -1, 0, 1, 5]) {
      assert.equal(refitPage(p, 10, 10), p);
    }
  });

  test('page 1 and page 0 are the fixed points of the feed', () => {
    // They are offset 0 into their respective halves, whatever the page size.
    assert.equal(refitPage(1, 10, 3), 1);
    assert.equal(refitPage(0, 10, 3), 0);
  });

  test('a smaller page pushes the reader further out on either side', () => {
    // Published: posts 10-19 (page 2 of 10) start page 4 of 5.
    assert.equal(refitPage(2, 10, 5), 3);
    // Queue: the same 10 posts into the queue, now 5 at a time.
    assert.equal(refitPage(-1, 10, 5), -2);
  });

  test('a bigger page pulls them back in', () => {
    assert.equal(refitPage(4, 5, 10), 2);
    assert.equal(refitPage(-3, 5, 10), -1);
  });

  test('a post mid-page keeps its page rather than jumping past it', () => {
    // Page 3 of 4 starts at post 8; at 6 per page that post is on page 2, whose
    // range (6-11) still contains it.
    assert.equal(refitPage(3, 4, 6), 2);
    assert.equal(refitPage(-2, 4, 6), -1);
  });
});
