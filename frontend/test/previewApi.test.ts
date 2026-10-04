import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

// Regression: previewPost used to fetch '/posts/preview/<token>' (missing the
// /api prefix), so the server answered with the SPA fallback page instead of
// post JSON and the preview page rendered empty ('Preview: undefined').
describe('previewPost', () => {
  test('requests the /api path and URL-encodes the token', async () => {
    let requested: RequestInfo | URL | undefined;
    global.fetch = async (url: RequestInfo | URL) => {
      requested = url;
      return mock<Response>({
        status: 200,
        ok: true,
        headers: mock<Headers>({ get: () => 'application/json' }),
        json: async () => ({ title: 'Draft post' }),
      });
    };

    const { previewPost } = await import('../src/api/posts.ts');
    const post = await previewPost('tok/en');

    assert.strictEqual(requested, '/api/posts/preview/tok%2Fen');
    assert.strictEqual(post.title, 'Draft post');
  });
});
