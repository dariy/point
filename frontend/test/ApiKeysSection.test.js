import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('ApiKeysSection connected apps', () => {
  let ApiKeysSection;

  before(async () => {
    global.document = {
      createElement: () => ({
        style: {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {}
      }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    global.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {}
    };
    const mod = await import('../src/components/light/sections/ApiKeysSection.ts');
    ApiKeysSection = mod.ApiKeysSection;
  });

  function render(oauthClients) {
    const section = new ApiKeysSection({ querySelector: () => null });
    section.state = { loading: false, apiKeys: [], oauthClients };
    return String(section.render());
  }

  test('lists each client with its redirect host, token count and a Revoke button', () => {
    const out = render([
      { client_id: 'c-1', redirect_hosts: ['claude.ai'], registered_at: '2026-09-01T10:00:00Z', live_tokens: 2 },
      { client_id: 'c-2', redirect_hosts: ['127.0.0.1:9000'], registered_at: '2026-09-02T10:00:00Z', live_tokens: 0 },
    ]);
    assert.ok(out.includes('Connected apps'));
    assert.ok(out.includes('claude.ai'));
    assert.ok(out.includes('127.0.0.1:9000'));
    assert.ok(out.includes('<td>2</td>'), 'live token count shown');
    assert.strictEqual(out.match(/revoke-oauth-client-btn/g).length, 2, 'one Revoke button per client');
    assert.ok(out.includes('data-id="c-1"') && out.includes('data-id="c-2"'));
  });

  test('hides the block when no app is connected (or the mcp plugin is off)', () => {
    const out = render([]);
    assert.ok(!out.includes('Connected apps'));
    assert.ok(!out.includes('revoke-oauth-client-btn'));
  });

  test('escapes a hostile redirect host', () => {
    const out = render([
      { client_id: 'x', redirect_hosts: ['<img src=x onerror=alert(1)>'], registered_at: '2026-09-01T10:00:00Z', live_tokens: 1 },
    ]);
    assert.ok(!out.includes('<img src=x'), 'host must be escaped');
  });
});
