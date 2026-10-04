import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { preCacheImages, clearImageCache } from '../src/utils/imageCache.ts';
import { mock } from './helpers/mock.ts';

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
function fakeCaches({ fail = (_url: string): boolean => false } = {}) {
  const stores = new Map<string, string[]>();
  const storage = {
    inFlight: 0,
    peakInFlight: 0,
    deleted: [] as string[],
    async open(name: string) {
      const urls = stores.get(name) ?? [];
      stores.set(name, urls);
      return mock<Cache>({
        async add(input: RequestInfo | URL) {
          const url = String(input);
          storage.inFlight++;
          storage.peakInFlight = Math.max(storage.peakInFlight, storage.inFlight);
          // Yield so concurrent adds actually overlap.
          await new Promise((resolve) => setTimeout(resolve, 1));
          storage.inFlight--;
          if (fail(url)) throw new Error(`404 ${url}`);
          urls.push(url);
        },
      });
    },
    async delete(name: string) {
      storage.deleted.push(name);
      return stores.delete(name);
    },
    contents(name: string) {
      return stores.get(name) || null;
    },
  };
  return storage;
}

/** Install a fake CacheStorage as the global `caches`, and return it. */
function installCaches(opts?: Parameters<typeof fakeCaches>[0]) {
  const storage = fakeCaches(opts);
  globalThis.caches = mock<CacheStorage>(storage);
  return storage;
}

const urls = (n: number, prefix = '/2026/03/p') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.jpg?s=512&v=abc`);

describe('preCacheImages', () => {
  let warn: typeof console.warn;

  beforeEach(() => {
    warn = console.warn;
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = warn;
    Reflect.deleteProperty(globalThis, 'caches');
  });

  test("type 'full' writes to point-images-full-v1 and reports progress", async () => {
    const caches = installCaches();
    const seen: unknown[] = [];

    await preCacheImages(['/2026/03/a.jpg', '/2026/03/b.jpg'], 'full', (p) => seen.push(p));

    assert.deepStrictEqual(caches.contents('point-images-full-v1'), [
      '/2026/03/a.jpg',
      '/2026/03/b.jpg',
    ]);
    assert.strictEqual(caches.contents('point-images-v1'), null);
    assert.deepStrictEqual(seen, [
      { completed: 1, total: 2, current: '/2026/03/a.jpg' },
      { completed: 2, total: 2, current: '/2026/03/b.jpg' },
    ]);
  });

  test('defaults to the thumbnail cache', async () => {
    const caches = installCaches();
    await preCacheImages(['/2026/03/a.jpg?s=256&v=abc']);
    assert.deepStrictEqual(caches.contents('point-images-v1'), [
      '/2026/03/a.jpg?s=256&v=abc',
    ]);
  });

  test('reports every URL even when some fail, and keeps the rest', async () => {
    const caches = installCaches({ fail: (url: string) => url.includes('p1') });
    let completed = 0;

    await preCacheImages(urls(3), 'thumbnails', (p) => {
      completed = p.completed;
    });

    assert.strictEqual(completed, 3, 'a failed fetch still advances the bar');
    assert.deepStrictEqual(caches.contents('point-images-v1'), [
      '/2026/03/p0.jpg?s=512&v=abc',
      '/2026/03/p2.jpg?s=512&v=abc',
    ]);
  });

  test('fetches concurrently, but bounded', async () => {
    const caches = installCaches();
    const list = urls(40);

    await preCacheImages(list, 'thumbnails');

    assert.strictEqual(caches.contents('point-images-v1')?.length, 40);
    assert.ok(
      caches.peakInFlight > 1,
      'a serial walk makes a ladder-sized snapshot glacial',
    );
    assert.ok(
      caches.peakInFlight <= 5,
      `too many in flight: ${caches.peakInFlight}`,
    );
  });

  test('an empty list opens no workers and reports nothing', async () => {
    const caches = installCaches();
    let calls = 0;
    await preCacheImages([], 'full', () => calls++);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(caches.contents('point-images-full-v1'), []);
  });

  test('a non-function progress argument is ignored rather than thrown at', async () => {
    const caches = installCaches();
    // @ts-expect-error a progress argument that is not a function
    await preCacheImages(['/2026/03/a.jpg'], 'full', 'not a callback');
    assert.deepStrictEqual(caches.contents('point-images-full-v1'), [
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
    Reflect.deleteProperty(globalThis, 'caches');
  });

  test("'all' drops both caches, so a generation roll cannot orphan entries", async () => {
    const caches = installCaches();
    await preCacheImages(['/2026/03/a.jpg?s=512&v=old'], 'thumbnails');
    await preCacheImages(['/2026/03/a.jpg'], 'full');

    await clearImageCache('all');

    assert.deepStrictEqual(caches.deleted, [
      'point-images-v1',
      'point-images-full-v1',
    ]);
    assert.strictEqual(caches.contents('point-images-v1'), null);
    assert.strictEqual(caches.contents('point-images-full-v1'), null);
  });

  test('clears one cache at a time when asked', async () => {
    const caches = installCaches();
    await clearImageCache('thumbnails');
    assert.deepStrictEqual(caches.deleted, ['point-images-v1']);
  });
});
