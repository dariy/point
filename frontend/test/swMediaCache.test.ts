import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { mock } from './helpers/mock.ts';

/**
 * The service worker's media branch (sw.ts, serveMedia).
 *
 * sw.ts is a classic worker script, not a module — it cannot be imported. It is
 * evaluated here in a vm context holding stand-ins for the worker globals; its
 * top-level function declarations land on that context's global object, so the
 * handler can be called directly.
 *
 * What is under test is which cache entry answers a request now that a media URL
 * names one rung of the thumbnail ladder. Matching with `ignoreSearch` — as this
 * did when every image had exactly one URL — lets a 128px chip answer a request
 * for the 1024 rung, so the exact query has to be part of the key, with the
 * approximate match kept only as an offline last resort.
 */

const SW_SOURCE = stripTypeScriptTypes(
  readFileSync(fileURLToPath(new URL('../sw.ts', import.meta.url)), 'utf8'),
);

/** A Cache holding whole URLs as keys, matching the Cache API's semantics. */
class FakeCache {
  entries: Map<string, Response>;

  constructor(entries: Record<string, Response> = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  async match(url: string, { ignoreSearch = false } = {}) {
    if (this.entries.has(url)) return this.entries.get(url);
    if (!ignoreSearch) return undefined;
    const bare = String(url).split('?')[0];
    for (const [key, value] of this.entries) {
      if (key.split('?')[0] === bare) return value;
    }
    return undefined;
  }
}

/**
 * A CacheStorage over named FakeCaches. `rejectUnknown` reproduces the
 * implementations that throw for a cacheName that was never opened, which is
 * every browser of a reader who has never pressed "Update Offline Data".
 */
class FakeCacheStorage {
  caches: Map<string | undefined, FakeCache>;
  rejectUnknown: boolean;

  constructor(caches: Record<string, Record<string, Response>> = {}, { rejectUnknown = false } = {}) {
    this.caches = new Map(
      Object.entries(caches).map(([name, entries]) => [name, new FakeCache(entries)]),
    );
    this.rejectUnknown = rejectUnknown;
  }

  async match(url: string, { cacheName, ignoreSearch }: { cacheName?: string; ignoreSearch?: boolean } = {}) {
    const cache = this.caches.get(cacheName);
    if (!cache) {
      if (this.rejectUnknown) throw new Error(`no such cache: ${cacheName}`);
      return undefined;
    }
    return cache.match(url, { ignoreSearch });
  }
}

/**
 * Evaluate sw.ts, its types stripped, against stub globals and hand back the context, so the test can
 * both call into the worker and see what it did.
 */
/** What the request stand-in holds: the fields serveMedia reads. */
interface SWRequest { url: string; method: string }

/** The sw.ts functions under test, as they land on the context's global object. */
interface SWGlobals {
  isMediaPath(path: string): boolean;
  serveMedia(request: SWRequest): Promise<Response>;
}

interface LoadSWOptions {
  caches?: FakeCacheStorage;
  onLine?: boolean;
  fetch?: (request: SWRequest) => Promise<Response>;
}

function loadSW({ caches = new FakeCacheStorage(), onLine = true, fetch }: LoadSWOptions = {}) {
  const fetchCalls: string[] = [];
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
      location: { origin: 'https://example.test' },
    },
    caches,
    navigator: { onLine },
    fetch: async (request: SWRequest) => {
      fetchCalls.push(request.url);
      if (fetch) return fetch(request);
      return new Response('network', { status: 200 });
    },
    Response,
    Request,
    URL,
    console: { warn() {}, error() {}, log() {} },
    indexedDB: undefined,
    crypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);
  return { sw: mock<SWGlobals>(sandbox), fetchCalls };
}

const request = (url: string): SWRequest => ({ url, method: 'GET' });
const body = (response: Response) => response.text();

const rung = (size: number) => `https://example.test/2026/03/p.jpg?s=${size}&v=abc123`;

describe('sw.ts — isMediaPath', () => {
  let sw: SWGlobals;
  beforeEach(() => {
    sw = loadSW().sw;
  });

  test('matches the public media path, whatever the query', () => {
    assert.strictEqual(sw.isMediaPath('/2026/03/p.jpg'), true);
    assert.strictEqual(sw.isMediaPath('/2026/03/a_b-c.jpeg'), true);
  });

  test('does not match app routes or nested paths', () => {
    assert.strictEqual(sw.isMediaPath('/api/posts'), false);
    assert.strictEqual(sw.isMediaPath('/2026/03/nested/p.jpg'), false);
    assert.strictEqual(sw.isMediaPath('/light/posts/new'), false);
  });
});

describe('sw.ts — serveMedia', () => {
  test('serves an exact hit from the full-size cache first', async () => {
    const { sw, fetchCalls } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-full-v1': { [rung(1024)]: new Response('full') },
        'point-images-v1': { [rung(1024)]: new Response('thumb') },
      }),
    });

    assert.strictEqual(await body(await sw.serveMedia(request(rung(1024)))), 'full');
    assert.deepStrictEqual(fetchCalls, []);
  });

  test('falls through to the thumbnail cache on an exact hit', async () => {
    const { sw, fetchCalls } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-full-v1': {},
        'point-images-v1': { [rung(512)]: new Response('thumb') },
      }),
    });

    assert.strictEqual(await body(await sw.serveMedia(request(rung(512)))), 'thumb');
    assert.deepStrictEqual(fetchCalls, []);
  });

  // The regression this branch exists for: with ignoreSearch, the 128 chip below
  // answered every request for the same file, at any rung.
  test('a cached 128 rung does not satisfy a request for 1024 when online', async () => {
    const { sw, fetchCalls } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-v1': { [rung(128)]: new Response('chip') },
      }),
      onLine: true,
    });

    const response = await sw.serveMedia(request(rung(1024)));
    assert.strictEqual(await body(response), 'network');
    assert.deepStrictEqual(fetchCalls, [rung(1024)]);
  });

  test('a stale generation token is a miss, not a wrong image', async () => {
    const { sw, fetchCalls } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-v1': {
          ['https://example.test/2026/03/p.jpg?s=512&v=old']: new Response('stale'),
        },
      }),
      onLine: true,
    });

    const response = await sw.serveMedia(
      request('https://example.test/2026/03/p.jpg?s=512&v=new'),
    );
    assert.strictEqual(await body(response), 'network');
    assert.strictEqual(fetchCalls.length, 1);
  });

  test('offline, a neighbouring rung answers rather than nothing', async () => {
    const { sw, fetchCalls } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-v1': { [rung(256)]: new Response('near') },
      }),
      onLine: false,
    });

    const response = await sw.serveMedia(request(rung(1024)));
    assert.strictEqual(await body(response), 'near');
    assert.deepStrictEqual(fetchCalls, [], 'must not reach for the network offline');
  });

  test('offline with nothing cached for that file is a 404', async () => {
    const { sw } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-v1': { [rung(256)]: new Response('other file') },
      }),
      onLine: false,
    });

    const response = await sw.serveMedia(
      request('https://example.test/2026/03/q.jpg?s=1024&v=abc123'),
    );
    assert.strictEqual(response.status, 404);
  });

  test('an online request that cannot reach the network falls back to a near rung', async () => {
    const { sw } = loadSW({
      caches: new FakeCacheStorage({
        'point-images-v1': { [rung(256)]: new Response('near') },
      }),
      onLine: true,
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const response = await sw.serveMedia(request(rung(1024)));
    assert.strictEqual(await body(response), 'near');
  });

  test('an online request with nothing cached and no network is a 404', async () => {
    const { sw } = loadSW({
      caches: new FakeCacheStorage(),
      onLine: true,
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    assert.strictEqual((await sw.serveMedia(request(rung(512)))).status, 404);
  });

  test('a cache storage that rejects unknown names is treated as a miss', async () => {
    const { sw, fetchCalls } = loadSW({
      caches: new FakeCacheStorage({}, { rejectUnknown: true }),
      onLine: true,
    });

    const response = await sw.serveMedia(request(rung(512)));
    assert.strictEqual(await body(response), 'network');
    assert.deepStrictEqual(fetchCalls, [rung(512)]);
  });
});
