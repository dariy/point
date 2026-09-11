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

// The template store: keyed by slug in the path, no ?post=, and the listing
// carries names only.
describe('carousel template API client', () => {
  let dom;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom.cleanup(); });

  const jsonOk = (body) => ({
    status: 200,
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });

  test('listCarouselTemplates GETs the collection', async () => {
    let requested;
    let method;
    global.fetch = async (url, opts) => {
      requested = url;
      method = opts.method;
      return jsonOk([{ slug: 'zine', name: 'Zine', created_at: 'x' }]);
    };

    const { listCarouselTemplates } = await import('../src/api/carousel.js');
    const res = await listCarouselTemplates();

    assert.strictEqual(method, 'GET');
    assert.strictEqual(requested, '/api/carousel/templates');
    assert.strictEqual(res[0].slug, 'zine');
    assert.strictEqual(res[0].doc, undefined);
  });

  test('getCarouselTemplate puts the slug in the path, encoded', async () => {
    let requested;
    global.fetch = async (url) => {
      requested = url;
      return jsonOk({ slug: 'a b', name: 'N', doc: { version: 1 }, created_at: 'x', updated_at: 'y' });
    };

    const { getCarouselTemplate } = await import('../src/api/carousel.js');
    const res = await getCarouselTemplate('a b');

    assert.strictEqual(requested, '/api/carousel/templates/a%20b');
    assert.deepStrictEqual(res.doc, { version: 1 });
  });

  test('saveCarouselTemplate POSTs { slug, name, doc } to the collection', async () => {
    let requested;
    let opts;
    global.fetch = async (url, o) => {
      requested = url;
      opts = o;
      return jsonOk({ slug: 'zine', name: 'Zine', doc: { version: 1 }, created_at: 'x', updated_at: 'y' });
    };

    const { saveCarouselTemplate } = await import('../src/api/carousel.js');
    await saveCarouselTemplate('zine', 'Zine', { version: 1 });

    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(requested, '/api/carousel/templates');
    assert.deepStrictEqual(JSON.parse(opts.body), { slug: 'zine', name: 'Zine', doc: { version: 1 } });
  });

  test('deleteCarouselTemplate DELETEs the slug path', async () => {
    let requested;
    let method;
    global.fetch = async (url, opts) => {
      requested = url;
      method = opts.method;
      return { status: 204, ok: true, headers: { get: () => '' } };
    };

    const { deleteCarouselTemplate } = await import('../src/api/carousel.js');
    const res = await deleteCarouselTemplate('zine');

    assert.strictEqual(method, 'DELETE');
    assert.strictEqual(requested, '/api/carousel/templates/zine');
    assert.strictEqual(res, null);
  });

  test('saveCarouselTemplate surfaces the 413 the size cap returns', async () => {
    global.fetch = async () => ({
      status: 413,
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: 'template is larger than the 8 MB limit' }),
    });

    const { saveCarouselTemplate, TEMPLATE_MAX_BYTES } = await import('../src/api/carousel.js');
    assert.strictEqual(TEMPLATE_MAX_BYTES, 8 * 1024 * 1024);
    await assert.rejects(() => saveCarouselTemplate('big', 'Big', { version: 1 }), (err) => err.status === 413);
  });
});
