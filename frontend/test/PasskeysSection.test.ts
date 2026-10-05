import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

type PasskeyStatus = Awaited<ReturnType<typeof import('../src/api/auth.ts').getPasskeyStatus>>;

describe('PasskeysSection', () => {
  let PasskeysSection: typeof import('../src/components/light/sections/PasskeysSection.ts').PasskeysSection;

  before(async () => {
    globalThis.document = mock<Document>({
      createElement: () => mock<HTMLElement>({
        style: mock<CSSStyleDeclaration>({}),
        classList: mock<DOMTokenList>({ add: () => {}, remove: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {}
      }),
      body: mock<HTMLElement>({ appendChild: <T extends Node>(n: T) => n }),
      addEventListener: () => {},
      removeEventListener: () => {}
    });
    globalThis.window = mock<typeof window>({
      PublicKeyCredential: mock<typeof PublicKeyCredential>({}),
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true
    });

    const mod = await import('../src/components/light/sections/PasskeysSection.ts');
    PasskeysSection = mod.PasskeysSection;
  });

  function sectionWithStatus(status: PasskeyStatus) {
    const container = mock<HTMLElement>({ querySelector: () => null });
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
