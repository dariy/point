/**
 * AtlasPlaces.holdFit / releaseFit — a map built off screen (a warm build)
 * holds its opening fit-to-places until the first show().
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AtlasPlaces } from '../src/plugins/tags-atlas/AtlasPlaces.ts';

type Fit = [Array<[number, number]>, unknown];

function places() {
  const fits: Fit[] = [];
  const map = { fitBounds: (b: Array<[number, number]>, o: unknown) => { fits.push([b, o]); } };
  const p = new AtlasPlaces({
    L: {} as never,
    map: map as never,
    root: {} as HTMLElement,
    isAlive: () => true,
    onSelect: () => {},
  });
  return { p, fits };
}

const BOUNDS: Array<[number, number]> = [[52.5, 13.4], [48.9, 2.35]];

describe('AtlasPlaces fit hold', () => {
  test('a new instance does not hold the fit', () => {
    const { p } = places();
    assert.equal(p._holdFit, false);
    assert.equal(p._heldFit, null);
  });

  test('releaseFit without holdFit does nothing', () => {
    const { p, fits } = places();
    p._heldFit = BOUNDS;
    p.releaseFit();
    assert.equal(fits.length, 0);
    assert.deepEqual(p._heldFit, BOUNDS);
  });

  test('releaseFit runs the held fit once', () => {
    const { p, fits } = places();
    p.holdFit();
    assert.equal(p._holdFit, true);
    p._heldFit = BOUNDS;
    p.releaseFit();
    assert.deepEqual(fits, [[BOUNDS, { padding: [40, 40], maxZoom: 6 }]]);
    assert.equal(p._didFitBounds, true);
    assert.equal(p._holdFit, false);
    assert.equal(p._heldFit, null);
    p.releaseFit();
    assert.equal(fits.length, 1);
  });

  test('releaseFit with no held bounds only ends the hold', () => {
    const { p, fits } = places();
    p.holdFit();
    p.releaseFit();
    assert.equal(fits.length, 0);
    assert.equal(p._holdFit, false);
    assert.equal(p._didFitBounds, false);
  });

  test('a URL viewport (fit done) skips the held fit', () => {
    const { p, fits } = places();
    p._didFitBounds = true;
    p.holdFit();
    p._heldFit = BOUNDS;
    p.releaseFit();
    assert.equal(fits.length, 0);
    assert.equal(p._heldFit, null);
  });
});
