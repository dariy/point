import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('SetupPage', () => {
  let SetupPage;

  before(async () => {
    // Mock enough globals for the Component and SetupPage to import
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

    const mod = await import('../src/pages/light/SetupPage.js');
    SetupPage = mod.default;
  });

  test('renders email field as type="text" with autocomplete="off"', () => {
    const container = { querySelector: () => null };
    const page = new SetupPage(container);
    const html = page.render();
    
    assert.ok(html.includes('id="email"'), 'Email field should exist');
    assert.ok(html.includes('type="text"'), 'Email field should be type="text" to avoid autofill crash');
    assert.ok(html.includes('autocomplete="off"'), 'Autocomplete should be off for email');
  });

  test('helper text is outside the label', () => {
    const container = { querySelector: () => null };
    const page = new SetupPage(container);
    const html = page.render();
    
    // Check that the label for email does NOT contain the help text
    const labelMatch = html.match(/<label[^>]*for="email"[^>]*>([\s\S]*?)<\/label>/);
    assert.ok(labelMatch, 'Label for email should exist');
    assert.ok(!labelMatch[1].includes('form-help'), 'Label should not contain helper text span');
    
    // Check that form-help exists in the HTML
    assert.ok(html.includes('class="form-help"'), 'Helper text should exist');
  });

  test('password fields have form-input class', () => {
    const container = { querySelector: () => null };
    const page = new SetupPage(container);
    const html = page.render();
    
    const passwordMatch = html.match(/id="password"[^>]*class="([^"]*)"/);
    const confirmMatch = html.match(/id="confirm_password"[^>]*class="([^"]*)"/);
    
    assert.ok(passwordMatch && passwordMatch[1].includes('form-input'), 'Password field should have form-input class');
    assert.ok(confirmMatch && confirmMatch[1].includes('form-input'), 'Confirm password field should have form-input class');
  });
});
