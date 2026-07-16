import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('PasskeysSection', () => {
  let PasskeysSection;

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
      PublicKeyCredential: function () {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {}
    };

    const mod = await import('../src/components/light/sections/PasskeysSection.js');
    PasskeysSection = mod.PasskeysSection;
  });

  function sectionWithStatus(status) {
    const container = { querySelector: () => null };
    const section = new PasskeysSection(container);
    section.state = { ...section.state, loading: false, status };
    return section.render();
  }

  // GET /api/auth/webauthn/status returns has_passkey — reading any other field
  // leaves the section stuck on "Register Passkey" forever.
  test('shows Remove, not Register, once a passkey is registered', () => {
    const html = sectionWithStatus({ has_passkey: true, configured: true });

    assert.ok(html.includes('delete-passkey-btn'), 'Remove button should be shown');
    assert.ok(!html.includes('register-passkey-btn'), 'Register button should be hidden');
  });

  test('shows Register when no passkey is registered', () => {
    const html = sectionWithStatus({ has_passkey: false, configured: true });

    assert.ok(html.includes('register-passkey-btn'), 'Register button should be shown');
    assert.ok(!html.includes('delete-passkey-btn'), 'Remove button should be hidden');
  });

  test('reports when the server has no WebAuthn configured', () => {
    const html = sectionWithStatus({ has_passkey: false, configured: false });

    assert.ok(html.includes('not configured on this server'), 'Should explain WebAuthn is unconfigured');
    assert.ok(!html.includes('register-passkey-btn'), 'Register button should be hidden');
  });
});
