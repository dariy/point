import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';

// The carousel document API: the post id rides in ?post=<id> on every verb,
// there is no path parameter, and PUT wraps the document in { doc }.
describe('carousel API client', () => {
  let dom;
  // The client's PUT/DELETE fall to the IndexedDB mutation queue when
  // navigator.onLine is falsy; setupDOM gives us onLine: true.
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  const jsonOk = (body) => ({
    status: 200,
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });

  test('getCarousel requests /api/carousel?post=<id>', async () => {
    let requested;
    let method;
    global.fetch = async (url, opts) => {
      requested = url;
      method = opts.method;
      return jsonOk({ post_id: 7, doc: { version: 1 }, created_at: 'x', updated_at: 'y' });
    };

    const { getCarousel } = await import('../src/api/carousel.js');
    const res = await getCarousel(7);

    assert.strictEqual(method, 'GET');
    assert.strictEqual(requested, '/api/carousel?post=7');
    assert.deepStrictEqual(res.doc, { version: 1 });
  });

  test('saveCarousel PUTs { doc } to the ?post= URL', async () => {
    let requested;
    let opts;
    global.fetch = async (url, o) => {
      requested = url;
      opts = o;
      return jsonOk({ post_id: 7, doc: { version: 1, aspect: '1:1' }, created_at: 'x', updated_at: 'y' });
    };

    const { saveCarousel } = await import('../src/api/carousel.js');
    await saveCarousel(7, { version: 1, aspect: '1:1' });

    assert.strictEqual(opts.method, 'PUT');
    assert.strictEqual(requested, '/api/carousel?post=7');
    assert.deepStrictEqual(JSON.parse(opts.body), { doc: { version: 1, aspect: '1:1' } });
  });

  test('deleteCarousel DELETEs the ?post= URL', async () => {
    let requested;
    let method;
    global.fetch = async (url, opts) => {
      requested = url;
      method = opts.method;
      return { status: 204, ok: true, headers: { get: () => '' } };
    };

    const { deleteCarousel } = await import('../src/api/carousel.js');
    const res = await deleteCarousel(7);

    assert.strictEqual(method, 'DELETE');
    assert.strictEqual(requested, '/api/carousel?post=7');
    assert.strictEqual(res, null);
  });

  test('getCarousel rejects with the 404 status when the post has no carousel', async () => {
    global.fetch = async () => ({
      status: 404,
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: 'no carousel for this post' }),
    });

    const { getCarousel } = await import('../src/api/carousel.js');
    await assert.rejects(() => getCarousel(7), (err) => err.status === 404);
  });
});
