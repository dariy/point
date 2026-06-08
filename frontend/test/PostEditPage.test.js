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
        removeEventListener: () => {},
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
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
test('should preserve other fields when switching from visual to text mode', () => {
  // We need a more functional container for this test
  const createMount = (overrides = {}) => ({ 
    appendChild: () => {}, 
    remove: () => {}, 
    innerHTML: '', 
    querySelector: () => null, 
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {} },
    addEventListener: () => {},
    closest: () => null,
    replaceChildren: () => {},
    setAttribute: () => {},
    value: '',
    checked: false,
    ...overrides
  });

  const elements = {
    '#title-input': createMount({ value: 'My Awesome Title' }),
    '#slug-input': createMount({ value: 'my-awesome-title' }),
    '#content-editor': createMount({ value: 'Some content' }),
    '#excerpt-editor': createMount({ value: 'An excerpt' }),
    '#featured-check': createMount({ checked: true }),
    '#status-select': createMount({ value: 'published', className: '' }),
    '#schedule-input': createMount({ value: '' }),
    '#css-editor': createMount({ value: '' }),
    '#immersive-mode-select': createMount({ value: 'auto' }),
    '#sidebar-mount': createMount(),
    '#tags-input-mount': createMount(),
    '#visual-editor-mount': createMount(),
    '.light-header': createMount()
  };
  const container = { 
    querySelector: (selector) => elements[selector] || createMount(), 
    querySelectorAll: () => [],
    innerHTML: '',
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const props = { params: {} }; // New post
  const page = new PostEditPage(container, props);
  page.state.loading = false;
  page.state.isNew = true;
  page.state.editorMode = 'visual';
  page.state.post = null; // New post starts with null post

  // Simulate switching to text mode
  page._switchMode('text');

  // After switch, page.state.post should contain the values from the elements
  assert.strictEqual(page.state.editorMode, 'text');
  // If the bug is present, this will likely be null or not have the title
  assert.ok(page.state.post, 'post state should be populated after switch');
  assert.strictEqual(page.state.post.title, 'My Awesome Title', 'Title should be preserved');
  assert.strictEqual(page.state.post.slug, 'my-awesome-title', 'Slug should be preserved');
  });

  test('should preserve other fields when switching from text to visual mode', () => {
  const createMount = (overrides = {}) => ({ 
    appendChild: () => {}, 
    remove: () => {}, 
    innerHTML: '', 
    querySelector: () => null, 
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {} },
    addEventListener: () => {},
    closest: () => null,
    replaceChildren: () => {},
    setAttribute: () => {},
    value: '',
    checked: false,
    ...overrides
  });

  const elements = {
    '#title-input': createMount({ value: 'Text Mode Title' }),
    '#content-editor': createMount({ value: 'Content from textarea' }),
    '#sidebar-mount': createMount(),
    '#tags-input-mount': createMount(),
    '#visual-editor-mount': createMount(),
    '.light-header': createMount()
  };

  const container = { 
    querySelector: (selector) => elements[selector] || createMount(), 
    querySelectorAll: () => [],
    innerHTML: '',
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const props = { params: {} };
  const page = new PostEditPage(container, props);
  page.state.loading = false;
  page.state.isNew = true;
  page.state.editorMode = 'text';
  page.state.post = null;

  // Mock MarkdownEditor reference
  page._markdownEditorRef = {
    getValue: () => 'Content from textarea'
  };

  page._switchMode('visual');

  assert.strictEqual(page.state.editorMode, 'visual');
  assert.strictEqual(page.state.post.title, 'Text Mode Title');
  assert.strictEqual(page.state.post.content, 'Content from textarea');
  });
  });

