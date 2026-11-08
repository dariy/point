import { test, describe } from 'node:test';
import assert from 'node:assert';

import { foldName, matchPlaces, SEARCH_LIMIT } from '../src/plugins/tags-atlas/atlasSearch.ts';

const p = (id: number, name: string, post_count = 0) => ({ id, name, post_count });
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);

describe('atlasSearch', () => {
  test('foldName: lower case, no accents, trimmed', () => {
    assert.equal(foldName('  Zürich '), 'zurich');
    assert.equal(foldName('SÃO PAULO'), 'sao paulo');
    assert.equal(foldName('Île-de-France'), 'ile-de-france');
  });

  test('an empty or blank query gives no results', () => {
    const places = [p(1, 'Berlin', 3)];
    assert.deepEqual(matchPlaces('', places), []);
    assert.deepEqual(matchPlaces('   ', places), []);
  });

  test('case and accent insensitive, both ways', () => {
    const places = [p(1, 'Zürich', 2), p(2, 'Montréal', 1)];
    assert.deepEqual(names(matchPlaces('zur', places)), ['Zürich']);
    assert.deepEqual(names(matchPlaces('ZÜR', places)), ['Zürich']);
    assert.deepEqual(names(matchPlaces('montre', places)), ['Montréal']);
  });

  test('prefix matches come first, then substring matches', () => {
    const places = [p(1, 'East Berlin', 50), p(2, 'Berlin', 1), p(3, 'Bern', 9)];
    assert.deepEqual(names(matchPlaces('ber', places)), ['Bern', 'Berlin', 'East Berlin']);
  });

  test('in a group, more posts first, then the name', () => {
    const places = [p(1, 'Paris', 5), p(2, 'Parma', 5), p(3, 'Pará', 9), p(4, 'Nowhere', 99)];
    assert.deepEqual(names(matchPlaces('par', places)), ['Pará', 'Paris', 'Parma']);
  });

  test('a missing post_count counts as zero', () => {
    const places = [{ id: 1, name: 'Lima' }, p(2, 'Lisbon', 1)];
    assert.deepEqual(names(matchPlaces('li', places)), ['Lisbon', 'Lima']);
  });

  test('no more than SEARCH_LIMIT results', () => {
    const places = Array.from({ length: 20 }, (_, i) => p(i, 'Town ' + i, i));
    const out = matchPlaces('town', places);
    assert.equal(SEARCH_LIMIT, 8);
    assert.equal(out.length, 8);
    assert.equal(out[0]!.name, 'Town 19');
    assert.equal(matchPlaces('town', places, 3).length, 3);
  });

  test('accepts any iterable', () => {
    const m = new Map([[1, p(1, 'Oslo', 1)]]);
    assert.deepEqual(names(matchPlaces('os', m.values())), ['Oslo']);
  });
});
