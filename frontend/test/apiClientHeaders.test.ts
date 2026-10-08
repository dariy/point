import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

// Regression: request() spread ...init after the merged headers, so a caller
// that passed init.headers lost the Accept default.
describe('ApiClient.request headers', () => {
  test('keeps default Accept when the caller passes headers', async () => {
    let sent: RequestInit | undefined;
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = init;
      return mock<Response>({
        status: 200,
        ok: true,
        headers: mock<Headers>({ get: () => 'application/json' }),
        json: async () => ({}),
      });
    };

    const { api: client } = await import('../src/api/client.ts');
    await client.request('/x', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
    });

    const h = sent?.headers as Record<string, string>;
    assert.strictEqual(h.Accept, 'application/json');
    assert.strictEqual(h['Content-Type'], 'text/plain');
    assert.strictEqual(sent?.method, 'POST');
  });

  test('an explicit caller header wins over the default', async () => {
    let sent: RequestInit | undefined;
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = init;
      return mock<Response>({
        status: 200,
        ok: true,
        headers: mock<Headers>({ get: () => 'application/json' }),
        json: async () => ({}),
      });
    };

    const { api: client } = await import('../src/api/client.ts');
    await client.request('/x', { headers: { Accept: 'text/plain' } });

    assert.strictEqual((sent?.headers as Record<string, string>).Accept, 'text/plain');
  });
});
