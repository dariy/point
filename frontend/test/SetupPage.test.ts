import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

describe('SetupPage', () => {
  let SetupPage: typeof import('../src/pages/light/SetupPage.ts').default;
  let setupTokenFrom: typeof import('../src/pages/light/SetupPage.ts').setupTokenFrom;

  before(async () => {
    // Mock enough globals for the Component and SetupPage to import
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
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true
    });

    const mod = await import('../src/pages/light/SetupPage.ts');
    SetupPage = mod.default;
    setupTokenFrom = mod.setupTokenFrom;
  });

  test('renders email field as type="text" with autocomplete="off"', () => {
    const container = mock<HTMLElement>({ querySelector: () => null });
    const page = new SetupPage(container);
    const html = String(page.render());
    
    assert.ok(html.includes('id="email"'), 'Email field should exist');
    assert.ok(html.includes('type="text"'), 'Email field should be type="text" to avoid autofill crash');
    assert.ok(html.includes('autocomplete="off"'), 'Autocomplete should be off for email');
  });

  test('helper text is outside the label', () => {
    const container = mock<HTMLElement>({ querySelector: () => null });
    const page = new SetupPage(container);
    const html = String(page.render());
    
    // Check that the label for email does NOT contain the help text
    const labelMatch = html.match(/<label[^>]*for="email"[^>]*>([\s\S]*?)<\/label>/);
    assert.ok(labelMatch, 'Label for email should exist');
    assert.ok(!labelMatch[1]?.includes('form-help'), 'Label should not contain helper text span');
    
    // Check that form-help exists in the HTML
    assert.ok(html.includes('class="form-help"'), 'Helper text should exist');
  });

  test('password fields have form-input class', () => {
    const container = mock<HTMLElement>({ querySelector: () => null });
    const page = new SetupPage(container);
    const html = String(page.render());
    
    const passwordMatch = html.match(/id="password"[^>]*class="([^"]*)"/);
    const confirmMatch = html.match(/id="confirm_password"[^>]*class="([^"]*)"/);
    
    assert.ok(passwordMatch && passwordMatch[1]?.includes('form-input'), 'Password field should have form-input class');
    assert.ok(confirmMatch && confirmMatch[1]?.includes('form-input'), 'Confirm password field should have form-input class');
  });

  test('setupTokenFrom reads the token from the setup link', () => {
    assert.strictEqual(setupTokenFrom('?token=abc-123'), 'abc-123');
    assert.strictEqual(setupTokenFrom('?x=1&token=a%2Bb'), 'a+b');
    assert.strictEqual(setupTokenFrom(''), '');
    assert.strictEqual(setupTokenFrom('?token='), '');
  });
});
