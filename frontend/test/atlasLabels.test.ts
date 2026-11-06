import { test, describe } from 'node:test';
import assert from 'node:assert';

import { boxesOverlap, clusterDots, declutter, dotsMerge, type DotItem, type LabelItem } from '../src/plugins/tags-atlas/atlasLabels.ts';

const bounds = { left: 0, top: 0, width: 1000, height: 800 };

/** A place with a 12 px dot and a `w`×18 label to the right of the dot. */
function place(id: number, x: number, y: number, weight: number, w = 80): LabelItem {
  return {
    id, x, y, weight,
    dot: { dx: -6, dy: -6, width: 12, height: 12 },
    label: { dx: 9, dy: -9, width: w, height: 18 },
  };
}

const ids = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('atlasLabels', () => {
  test('boxesOverlap: touch is not overlap, pad makes it one', () => {
    const a = { left: 0, top: 0, width: 10, height: 10 };
    const b = { left: 10, top: 0, width: 10, height: 10 };
    assert.equal(boxesOverlap(a, b), false);
    assert.equal(boxesOverlap(a, b, 1), true);
    assert.equal(boxesOverlap(a, { ...b, left: 5 }), true);
  });

  test('no overlap: all places get a label', () => {
    const items = [place(1, 100, 100, 3), place(2, 400, 100, 1), place(3, 100, 400, 2)];
    assert.deepEqual(ids(declutter(items, bounds)), [1, 2, 3]);
  });

  test('two labels overlap: the larger post count keeps its label', () => {
    const items = [place(1, 100, 100, 2), place(2, 130, 105, 9)];
    assert.deepEqual(ids(declutter(items, bounds)), [2]);
  });

  test('a label over another place\'s dot loses', () => {
    // Place 2 is small, but its dot is under place 1's label.
    const items = [place(1, 100, 100, 9), place(2, 150, 100, 1, 10)];
    assert.deepEqual(ids(declutter(items, bounds)), [2]);
  });

  test('a shape label (no dot) takes space only with its label', () => {
    const shape: LabelItem = { id: 5, x: 300, y: 300, weight: 50, dot: null, label: { dx: -40, dy: -9, width: 80, height: 18 } };
    const items = [shape, place(6, 300, 340, 1)];
    assert.deepEqual(ids(declutter(items, bounds)), [5, 6]);
  });

  test('places outside the bounds do not take space', () => {
    // Place 1 is out of view: its dot and its label do not stop place 2.
    const view = { left: 200, top: 0, width: 800, height: 800 };
    const items = [place(1, 190, 100, 9), place(2, 205, 100, 1)];
    assert.deepEqual(ids(declutter(items, view)), [2]);
  });

  test('ties are stable: the lower id wins', () => {
    const a = [place(7, 100, 100, 4), place(3, 120, 100, 4)];
    const b = [place(3, 120, 100, 4), place(7, 100, 100, 4)];
    assert.deepEqual(ids(declutter(a, bounds)), [3]);
    assert.deepEqual(ids(declutter(b, bounds)), [3]);
  });

  test('a taken box (a cloud chip) stops a label', () => {
    const items = [place(1, 100, 100, 9)];
    const chip = { left: 120, top: 90, width: 60, height: 20 };
    assert.deepEqual(ids(declutter(items, bounds, [chip])), []);
  });

  test('negative coordinates work (a box above the left edge)', () => {
    const view = { left: -500, top: -500, width: 1000, height: 1000 };
    const items = [place(1, -300, -300, 2), place(2, -300, -285, 1)];
    assert.deepEqual(ids(declutter(items, view)), [1]);
  });

  test('a pass for 500 places takes under 4 ms', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const items = Array.from({ length: 500 }, (_, i) => place(i + 1, rnd() * 1000, rnd() * 800, Math.floor(rnd() * 200), 40 + rnd() * 80));
    for (let i = 0; i < 20; i++) declutter(items, bounds); // warm the JIT
    const runs = 50;
    const t0 = performance.now();
    let shown = 0;
    for (let i = 0; i < runs; i++) shown = declutter(items, bounds).size;
    const per = (performance.now() - t0) / runs;
    assert.ok(per < 4, `a pass took ${per.toFixed(2)} ms`);
    assert.ok(shown > 0 && shown < 500);
    // No two shown labels overlap.
    const labelled = items.filter((it) => declutter(items, bounds).has(it.id));
    for (let i = 0; i < labelled.length; i++) {
      for (let j = i + 1; j < labelled.length; j++) {
        const a = labelled[i], b = labelled[j];
        assert.equal(
          boxesOverlap(
            { left: a.x + a.label.dx, top: a.y + a.label.dy, width: a.label.width, height: a.label.height },
            { left: b.x + b.label.dx, top: b.y + b.label.dy, width: b.label.width, height: b.label.height },
          ),
          false,
        );
      }
    }
  });
});

describe('atlasLabels clusterDots', () => {
  const dot = (id: number, x: number, y: number, weight = 1, r = 6, pinned = false): DotItem => ({ id, x, y, r, weight, pinned });

  test('dotsMerge: an overlap of more than half the smaller radius merges', () => {
    // Two 6 px dots: they merge below 12 - 3 = 9 px apart.
    assert.equal(dotsMerge(dot(1, 0, 0), dot(2, 8.9, 0)), true);
    assert.equal(dotsMerge(dot(1, 0, 0), dot(2, 9, 0)), false);
    assert.equal(dotsMerge(dot(1, 0, 0), dot(2, 11, 0)), false, 'a small overlap is no merge');
    // A 15 px dot and a 6 px dot: below 21 - 3 = 18 px.
    assert.equal(dotsMerge(dot(1, 0, 0, 1, 15), dot(2, 0, 17.9)), true);
    assert.equal(dotsMerge(dot(1, 0, 0, 1, 15), dot(2, 0, 18)), false);
  });

  test('dots apart: no cluster', () => {
    assert.deepEqual(clusterDots([dot(1, 0, 0), dot(2, 40, 0), dot(3, 0, 40)]), []);
    assert.deepEqual(clusterDots([dot(1, 0, 0)]), []);
    assert.deepEqual(clusterDots([]), []);
  });

  test('a stack becomes one cluster, the largest place first', () => {
    const items = [dot(1, 100, 100, 1), dot(2, 101, 102, 5), dot(3, 99, 98, 2), dot(4, 300, 300, 9)];
    assert.deepEqual(clusterDots(items), [[2, 3, 1]]);
  });

  test('equal weights: the lower id leads', () => {
    assert.deepEqual(clusterDots([dot(7, 0, 0), dot(3, 2, 0), dot(5, 4, 0)]), [[3, 5, 7]]);
  });

  test('a leader takes only the dots that overlap its own dot', () => {
    // 1 - 2 - 3 in a row, 8 px apart: 1 takes 2; 3 is 16 px from 1 and stays a dot.
    assert.deepEqual(clusterDots([dot(1, 0, 0, 3), dot(2, 8, 0, 2), dot(3, 16, 0, 1)]), [[1, 2]]);
  });

  test('a pinned place is in no cluster and starts none', () => {
    const items = [dot(1, 0, 0, 9, 6, true), dot(2, 2, 0, 1), dot(3, 4, 0, 1)];
    assert.deepEqual(clusterDots(items), [[2, 3]]);
    assert.deepEqual(clusterDots([dot(1, 0, 0, 9, 6, true), dot(2, 2, 0, 1)]), []);
  });

  test('two stacks give two clusters; the cell edge does not split a stack', () => {
    const items = [dot(1, 29.5, 29.5), dot(2, 30.5, 30.5), dot(3, 500, 500), dot(4, 503, 500)];
    assert.deepEqual(clusterDots(items), [[1, 2], [3, 4]]);
  });

  test('far projected points (a high zoom) keep their own cells', () => {
    const big = 60_000_000;
    const items = [dot(1, big, big), dot(2, big + 2, big), dot(3, big, big + 2 * 8388608 * 30)];
    assert.deepEqual(clusterDots(items), [[1, 2]]);
  });

  test('2000 places: a pass is fast', () => {
    const items: DotItem[] = [];
    for (let i = 0; i < 2000; i++) items.push(dot(i, (i * 37) % 1200, (i * 53) % 900, i % 7));
    const t0 = performance.now();
    const out = clusterDots(items);
    const ms = performance.now() - t0;
    const seen = new Set<number>();
    for (const g of out) for (const id of g) {
      assert.ok(!seen.has(id), 'a place is in one cluster only');
      seen.add(id);
    }
    assert.ok(ms < 50, `a pass took ${ms.toFixed(1)} ms`);
  });
});
