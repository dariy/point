import { test, describe } from 'node:test';
import assert from 'node:assert';

import { pageNumbers, postPlace, MAX_MAP_PAGES } from '../src/plugins/tags-atlas/atlasLayerMap.ts';

describe('postPlace', () => {
  test('takes the first tag with coordinates', () => {
    const post: any = { tags: [{ name: 'a' }, { name: 'b', latitude: 1, longitude: 2 }, { name: 'c', latitude: 3, longitude: 4 }] };
    assert.deepStrictEqual(postPlace(post), { lat: 1, lng: 2 });
  });
  test('gives null without a place tag', () => {
    assert.strictEqual(postPlace({ tags: [{ name: 'a' }] } as any), null);
    assert.strictEqual(postPlace({} as any), null);
  });
  test('keeps a zero coordinate', () => {
    assert.deepStrictEqual(postPlace({ tags: [{ name: 'x', latitude: 0, longitude: 0 }] } as any), { lat: 0, lng: 0 });
  });
});

describe('pageNumbers', () => {
  test('lists every page', () => {
    assert.deepStrictEqual(pageNumbers({ pages: 3 }), [1, 2, 3]);
  });
  test('gives page 1 for an empty pagination', () => {
    assert.deepStrictEqual(pageNumbers({}), [1]);
  });
  test('starts at a negative minPage', () => {
    assert.deepStrictEqual(pageNumbers({ minPage: -1, pages: 2 }), [-1, 0, 1, 2]);
  });
  test('stops at the cap', () => {
    assert.strictEqual(pageNumbers({ pages: 500 }).length, MAX_MAP_PAGES);
  });
});
