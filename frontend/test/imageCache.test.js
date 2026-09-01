// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { preCacheImages, clearImageCache } from '../src/utils/imageCache.js';

/**
 * imageCache writes the two caches the service worker reads (sw.js,
 * IMAGE_CACHES). The offline settings card used to call it as
 * `preCacheImages(urls, callback)`, which put the callback where the cache name
 * goes: `type === 'full'` was never true, so originals landed in the thumbnail
 * cache, point-images-full-v1 was never created at all — and the SW looks there
 * first — and the progress callback, sitting in the wrong parameter, was never
 * called.
 */

/** A CacheStorage recording what was added, and how many adds were in flight. */
function fakeCaches({ fail = () => false } = {}) {
  const stores = new Map();
  const storage = {
    inFlight: 0,
    peakInFlight: 0,
    deleted: [],
    async open(name) {
      if (!stores.has(name)) stores.set(name, []);
      const urls = stores.get(name);
      return {
        async add(url) {
          storage.inFlight++;
          storage.peakInFlight = Math.max(storage.peakInFlight, storage.inFlight);
          // Yield so concurrent adds actually overlap.
          await new Promise((resolve) => setTimeout(resolve, 1));
          storage.inFlight--;
          if (fail(url)) throw new Error(`404 ${url}`);
          urls.push(url);
        },
      };
    },
    async delete(name) {
      storage.deleted.push(name);
      return stores.delete(name);
    },
    contents(name) {
      return stores.get(name) || null;
    },
  };
  return storage;
}

const urls = (n, prefix = '/2026/03/p') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.jpg?s=512&v=abc`);

describe('preCacheImages', () => {
  let warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = warn;
    delete globalThis.caches;
  });

  test("type 'full' writes to point-images-full-v1 and reports progress", async () => {
    globalThis.caches = fakeCaches();
    const seen = [];

    await preCacheImages(['/2026/03/a.jpg', '/2026/03/b.jpg'], 'full', (p) => seen.push(p));

    assert.deepStrictEqual(globalThis.caches.contents('point-images-full-v1'), [
      '/2026/03/a.jpg',
      '/2026/03/b.jpg',
    ]);
    assert.strictEqual(globalThis.caches.contents('point-images-v1'), null);
    assert.deepStrictEqual(seen, [
      { completed: 1, total: 2, current: '/2026/03/a.jpg' },
      { completed: 2, total: 2, current: '/2026/03/b.jpg' },
    ]);
  });

  test('defaults to the thumbnail cache', async () => {
    globalThis.caches = fakeCaches();
    await preCacheImages(['/2026/03/a.jpg?s=256&v=abc']);
    assert.deepStrictEqual(globalThis.caches.contents('point-images-v1'), [
      '/2026/03/a.jpg?s=256&v=abc',
    ]);
  });

  test('reports every URL even when some fail, and keeps the rest', async () => {
    globalThis.caches = fakeCaches({ fail: (url) => url.includes('p1') });
    let completed = 0;

    await preCacheImages(urls(3), 'thumbnails', (p) => {
      completed = p.completed;
    });

    assert.strictEqual(completed, 3, 'a failed fetch still advances the bar');
    assert.deepStrictEqual(globalThis.caches.contents('point-images-v1'), [
      '/2026/03/p0.jpg?s=512&v=abc',
      '/2026/03/p2.jpg?s=512&v=abc',
    ]);
  });

  test('fetches concurrently, but bounded', async () => {
    globalThis.caches = fakeCaches();
    const list = urls(40);

    await preCacheImages(list, 'thumbnails');

    assert.strictEqual(globalThis.caches.contents('point-images-v1').length, 40);
    assert.ok(
      globalThis.caches.peakInFlight > 1,
      'a serial walk makes a ladder-sized snapshot glacial',
    );
    assert.ok(
      globalThis.caches.peakInFlight <= 5,
      `too many in flight: ${globalThis.caches.peakInFlight}`,
    );
  });

  test('an empty list opens no workers and reports nothing', async () => {
    globalThis.caches = fakeCaches();
    let calls = 0;
    await preCacheImages([], 'full', () => calls++);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(globalThis.caches.contents('point-images-full-v1'), []);
  });

  test('a non-function progress argument is ignored rather than thrown at', async () => {
    globalThis.caches = fakeCaches();
    await preCacheImages(['/2026/03/a.jpg'], 'full', 'not a callback');
    assert.deepStrictEqual(globalThis.caches.contents('point-images-full-v1'), [
      '/2026/03/a.jpg',
    ]);
  });

  test('is a no-op where the Cache API does not exist', async () => {
    await preCacheImages(['/2026/03/a.jpg'], 'full', () => {
      throw new Error('must not be called');
    });
  });
});

describe('clearImageCache', () => {
  afterEach(() => {
    delete globalThis.caches;
  });

  test("'all' drops both caches, so a generation roll cannot orphan entries", async () => {
    globalThis.caches = fakeCaches();
    await preCacheImages(['/2026/03/a.jpg?s=512&v=old'], 'thumbnails');
    await preCacheImages(['/2026/03/a.jpg'], 'full');

    await clearImageCache('all');

    assert.deepStrictEqual(globalThis.caches.deleted, [
      'point-images-v1',
      'point-images-full-v1',
    ]);
    assert.strictEqual(globalThis.caches.contents('point-images-v1'), null);
    assert.strictEqual(globalThis.caches.contents('point-images-full-v1'), null);
  });

  test('clears one cache at a time when asked', async () => {
    globalThis.caches = fakeCaches();
    await clearImageCache('thumbnails');
    assert.deepStrictEqual(globalThis.caches.deleted, ['point-images-v1']);
  });
});
