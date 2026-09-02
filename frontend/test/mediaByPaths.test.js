import { test, describe } from 'node:test';
import assert from 'node:assert';

// Regression: the post editor used to build its path -> media map from
// listMedia({ per_page: 200 }) — the first 200 media site-wide, ordered by
// upload time — so a post whose images sat past that window rendered without
// any of their metadata. getMediaByPaths asks for exactly the paths the post
// references instead.
describe('getMediaByPaths', () => {
  const jsonResponse = (media) => ({
    status: 200,
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ media, total: media.length, page: 1, per_page: media.length, pages: 1 }),
  });

  test('sends each path as its own query key and keys the result by path', async () => {
    let requested;
    global.fetch = async (url) => {
      requested = url;
      return jsonResponse([
        { id: 1, path: '/2026/03/a.jpg' },
        { id: 2, path: '/2026/03/b, c.jpg' },
      ]);
    };

    const { getMediaByPaths } = await import('../src/api/media.js');
    const byPath = await getMediaByPaths(['/2026/03/a.jpg', '/2026/03/b, c.jpg']);

    // Repeated keys, not a joined string: a filename may contain the separator.
    const params = new URLSearchParams(requested.split('?')[1]);
    assert.deepStrictEqual(params.getAll('paths'), ['/2026/03/a.jpg', '/2026/03/b, c.jpg']);
    assert.strictEqual(byPath['/2026/03/a.jpg'].id, 1);
    assert.strictEqual(byPath['/2026/03/b, c.jpg'].id, 2);
  });

  test('drops duplicates and empty paths', async () => {
    let requested;
    global.fetch = async (url) => {
      requested = url;
      return jsonResponse([]);
    };

    const { getMediaByPaths } = await import('../src/api/media.js');
    await getMediaByPaths(['/2026/03/a.jpg', '/2026/03/a.jpg', '', undefined]);

    const params = new URLSearchParams(requested.split('?')[1]);
    assert.deepStrictEqual(params.getAll('paths'), ['/2026/03/a.jpg']);
  });

  test('batches so a long photo essay does not become one enormous URL', async () => {
    const batches = [];
    global.fetch = async (url) => {
      batches.push(new URLSearchParams(url.split('?')[1]).getAll('paths'));
      return jsonResponse([]);
    };

    const paths = Array.from({ length: 250 }, (_, i) => `/2026/03/${i}.jpg`);
    const { getMediaByPaths } = await import('../src/api/media.js');
    await getMediaByPaths(paths);

    assert.deepStrictEqual(batches.map((b) => b.length), [100, 100, 50]);
    assert.deepStrictEqual(batches.flat(), paths);
  });

  test('makes no request at all when there is nothing to resolve', async () => {
    global.fetch = async () => {
      throw new Error('should not fetch');
    };

    const { getMediaByPaths } = await import('../src/api/media.js');
    assert.deepStrictEqual(await getMediaByPaths([]), {});
  });
});
