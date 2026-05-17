/**
 * Image caching utilities using Cache API.
 */

const THUMB_CACHE = 'point-images-v1';
const FULL_CACHE = 'point-images-full-v1';

/**
 * Bulk pre-cache a list of image URLs.
 */
export async function preCacheImages(urls, type = 'thumbnails', onProgress = null) {
  if (typeof caches === 'undefined') {
    console.warn('Cache API not available in this environment.');
    return;
  }
  const cacheName = type === 'full' ? FULL_CACHE : THUMB_CACHE;
  const cache = await caches.open(cacheName);
  
  let completed = 0;
  const total = urls.length;

  for (const url of urls) {
    try {
      // Fetch and store in cache
      await cache.add(url);
    } catch (err) {
      console.warn(`Failed to cache image: ${url}`, err);
    }
    
    completed++;
    if (onProgress) {
      onProgress({ completed, total, current: url });
    }
  }
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
