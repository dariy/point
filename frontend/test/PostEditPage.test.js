import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { pluginHost } from '../src/core/pluginHost.js';

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
      querySelector: () => null,
      querySelectorAll: () => []
    };
    global.window = {
        Point: { emit: () => {}, on: () => {} },
        location: { pathname: '' },
        history: { replaceState: () => {} },
        matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
        addEventListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {},
        __PLUGINS__: [
          {id: 'instagram', type: 'service'},
          {id: 'ai-analysis', type: 'service'},
          {id: 'custom-css', type: 'enhancer'}
        ]
    };

    pluginHost.init(global.window.__PLUGINS__);

    global.localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
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
    page.state.post = { status: 'published' };
    
    const html = page.render();
    assert.ok(html.includes('id="delete-btn"') && html.includes('disabled'), 'Delete button should be disabled');
    assert.ok(html.includes('id="update-btn"') && html.includes('disabled'), 'Update button should be disabled');
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
    insertAdjacentHTML: () => {},
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
    insertAdjacentHTML: () => {},
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
  page._markdownEditorRef = { getValue: () => 'Content from textarea' };

  // Mock MarkdownEditor reference
  page._markdownEditorRef = {
    getValue: () => 'Content from textarea'
  };

  page._switchMode('visual');

  assert.strictEqual(page.state.editorMode, 'visual');
  assert.strictEqual(page.state.post.title, 'Text Mode Title');
  assert.strictEqual(page.state.post.content, 'Content from textarea');
  });

  test('should hide Instagram section when igStatus is null', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test' };
    page.state.igStatus = null;

    const html = page.render();
    assert.ok(!html.includes('ig-share-input'), 'Instagram section hidden when igStatus is null');
  });

  test('should hide Instagram section when enable_instagram is false', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test' };
    page.state.igStatus = { enabled: false, connected: true, default_share: false };

    const html = page.render();
    assert.ok(!html.includes('ig-share-input'), 'Instagram section hidden when enable_instagram is false');
  });

  test('should show Instagram section when enabled, with correct share state', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test', instagram_share: true, instagram_status: 'published' };
    page.state.igStatus = { enabled: true, connected: true, default_share: false };

    const html = page.render();
    assert.ok(html.includes('ig-share-input'), 'Instagram toggle visible when enabled');
    assert.ok(html.includes('checked'), 'Toggle checked when instagram_share is true');
    assert.ok(html.includes('badge-success'), 'Status badge shows published');
  });

  test('should show failed status badge with error text', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test', instagram_share: false, instagram_status: 'failed', instagram_error: 'No image' };
    page.state.igStatus = { enabled: true, connected: true, default_share: false };

    const html = page.render();
    assert.ok(html.includes('badge-danger'), 'Failed badge present');
    assert.ok(html.includes('No image'), 'Error text visible');
  });

  test('should render the Details toggle button and rail/sheet panel', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test', slug: 'test' };

    const html = page.render();
    assert.ok(html.includes('id="details-toggle"'), 'Details header toggle present');
    assert.ok(html.includes('aria-controls="details-panel"'), 'Toggle controls the panel');
    assert.ok(html.includes('id="details-panel"'), 'Details panel present');
    assert.ok(html.includes('id="details-backdrop"'), 'Sheet backdrop present');
  });

  test('should render collapsible groups with summaries in spec order', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test', slug: 'my-trip' };
    page.state.igStatus = { enabled: true, connected: true, default_share: false };

    const html = page.render();
    const order = ['data-group="status"', 'data-group="slug"', 'data-group="excerpt"', 'data-group="immersive"', 'data-group="css"', 'data-group="instagram"'];
    let last = -1;
    for (const marker of order) {
      const idx = html.indexOf(marker);
      assert.ok(idx > last, `${marker} should appear after the previous group`);
      last = idx;
    }
    assert.ok(html.includes('id="summary-slug"') && html.includes('my-trip'), 'Slug summary reflects the slug');
    assert.ok(html.includes('id="summary-excerpt"'), 'Excerpt summary present');
  });

  test('aria-hidden on the panel reflects persisted detailsOpen state', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test' };

    page.state.detailsOpen = true;
    assert.ok(page.render().includes('aria-hidden="false"'), 'panel visible when open');
    page.state.detailsOpen = false;
    assert.ok(page.render().includes('aria-hidden="true"'), 'panel hidden when closed');
  });

  test('should use default_share for new posts when igStatus loaded', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: {} });
    page.state.loading = false;
    page.state.isNew = true;
    page.state.post = null;
    page.state.igStatus = { enabled: true, connected: true, default_share: true };

    const html = page.render();
    assert.ok(html.includes('ig-share-input'), 'Instagram toggle visible for new post when enabled');
    assert.ok(html.includes('checked'), 'Toggle pre-checked via default_share');
    assert.ok(!html.includes('ig-publish-now-btn'), 'Publish button absent for new posts');
  });
  });

