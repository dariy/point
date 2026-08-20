/**
 * Image caching utilities using Cache API.
 *
 * The two caches mirror what the service worker looks in (sw.js, IMAGE_CACHES):
 * original bytes in FULL_CACHE, thumbnail ladder rungs in THUMB_CACHE. Entries
 * are keyed by the full URL — query string included — so a rung and its
 * generation token are part of the key and a stale token is a miss, not a wrong
 * image.
 */

const THUMB_CACHE = 'point-images-v1';
const FULL_CACHE = 'point-images-full-v1';

/**
 * How many images to fetch at once. The ladder multiplies the URL count several
 * times over, and one `await cache.add()` at a time turns a snapshot of a few
 * hundred photographs into a walk; a handful in flight saturates a phone's link
 * without burying the page's own requests.
 */
const PRECACHE_CONCURRENCY = 5;

/**
 * Bulk pre-cache a list of image URLs.
 *
 * @param {string[]} urls
 * @param {'thumbnails'|'full'} [type]  which cache to write to
 * @param {(p: {completed: number, total: number, current: string}) => void} [onProgress]
 *   called once per URL, failures included — the count is of attempts, not hits.
 */
export async function preCacheImages(urls, type = 'thumbnails', onProgress = null) {
  if (typeof caches === 'undefined') {
    console.warn('Cache API not available in this environment.');
    return;
  }
  const cacheName = type === 'full' ? FULL_CACHE : THUMB_CACHE;
  const cache = await caches.open(cacheName);
  const report = typeof onProgress === 'function' ? onProgress : null;

  const total = urls.length;
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (next < total) {
      const url = urls[next++];
      try {
        // Fetch and store in cache
        await cache.add(url);
      } catch (err) {
        console.warn(`Failed to cache image: ${url}`, err);
      }

      completed++;
      if (report) report({ completed, total, current: url });
    }
  };

  const workers = Math.min(PRECACHE_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * Clear cached images.
 */
export async function clearImageCache(type = 'all') {
  if (typeof caches === 'undefined') return;
  if (type === 'thumbnails' || type === 'all') {
    await caches.delete(THUMB_CACHE);
  }
  if (type === 'full' || type === 'all') {
    await caches.delete(FULL_CACHE);
  }
}
