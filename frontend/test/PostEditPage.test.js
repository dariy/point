import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('PostEditPage', () => {
  let PostEditPage;

  before(async () => {
    // Mock CustomElementRegistry
    global.customElements = { define: () => {} };
    // Mock HTMLElement
    global.HTMLElement = class { 
      constructor() { this.attachShadow = () => ({ innerHTML: '' }); } 
      get clientHeight() { return 800; }
      get offsetHeight() { return 50; }
    };
    global.document = {
      createElement: () => ({ 
        appendChild: () => {}, 
        remove: () => {}, 
        style: {}, 
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {}
      }),
      body: { appendChild: () => {}, remove: () => {}, classList: { add: () => {}, remove: () => {} } },
      activeElement: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => []
    };
    global.window = {
        Point: { emit: () => {}, on: () => {} },
        location: { pathname: '' },
        history: { replaceState: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {}
    };

    const mod = await import('../src/pages/light/PostEditPage.js');
    PostEditPage = mod.default;
  });

  test('should show delete button when editing an existing post', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const props = { params: { id: '123' } };
    const page = new PostEditPage(container, props);
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 123, title: 'Test' };
    
    const html = page.render();
    assert.ok(html.includes('id="delete-btn"'), 'Delete button should be present');
  });

  test('should disable all header buttons when deleting', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const props = { params: { id: '123' } };
    const page = new PostEditPage(container, props);
    page.state.loading = false;
    page.state.isNew = false;
    page.state.deleting = true;
    
    const html = page.render();
    assert.ok(html.includes('id="delete-btn"') && html.includes('disabled'), 'Delete button should be disabled');
    assert.ok(html.includes('id="save-btn"') && html.includes('disabled'), 'Save button should be disabled');
    assert.ok(html.includes('id="analyze-btn"') && html.includes('disabled'), 'Analyze button should be disabled');
  });
});
