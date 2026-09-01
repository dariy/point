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
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      }),
      body: { appendChild: () => {}, remove: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
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
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
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
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
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

  test('pins title and tags to the canvas by default, everything else to Details', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test', slug: 'test' };

    const html = page.render();
    const panelAt = html.indexOf('id="details-panel"');
    assert.ok(html.indexOf('id="pinned-fields"') < panelAt, 'pinned container is on the canvas');
    for (const key of ['title', 'tags']) {
      assert.ok(html.indexOf(`data-group="${key}"`) < panelAt, `${key} renders on the canvas`);
    }
    for (const key of ['status', 'schedule', 'slug', 'excerpt', 'immersive', 'css']) {
      assert.ok(html.indexOf(`data-group="${key}"`) > panelAt, `${key} renders in the Details panel`);
    }
  });

  test('no per-field pin buttons — arrange mode is the one way to move a field', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test' };
    page.state.igStatus = { enabled: true, connected: true, default_share: false };

    const html = page.render();
    assert.ok(!html.includes('data-pin='), 'no pin buttons');
    assert.ok(!html.includes('details-pin-btn'), 'no pin markup left behind');
    assert.ok(html.includes('data-action="arrange"'), 'the menu still offers the mode');
  });

  test('a persisted pin set decides placement', () => {
    const saved = global.localStorage;
    global.localStorage = { getItem: () => JSON.stringify(['slug']), setItem: () => {}, removeItem: () => {} };
    try {
      const container = { querySelector: () => null, querySelectorAll: () => [] };
      const page = new PostEditPage(container, { params: { id: '1' } });
      page.state.loading = false;
      page.state.isNew = false;
      page.state.post = { id: 1, title: 'Test', slug: 'test' };

      const html = page.render();
      const panelAt = html.indexOf('id="details-panel"');
      assert.ok(html.indexOf('data-group="slug"') < panelAt, 'slug pinned to the canvas');
      assert.ok(html.indexOf('data-group="title"') > panelAt, 'title moved into Details');
    } finally {
      global.localStorage = saved;
    }
  });

  test('Schedule is hidden unless the post is scheduled', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;

    page.state.post = { id: 1, title: 'Test', status: 'draft' };
    assert.match(String(page.render()), /class="details-group is-hidden" data-group="schedule"/, 'hidden for a draft');

    page.state.post = { id: 1, title: 'Test', status: 'scheduled', scheduled_at: '2030-01-02T10:00:00Z' };
    assert.ok(!/is-hidden" data-group="schedule"/.test(String(page.render())), 'visible for a scheduled post');
  });

  test('dropping into the other list moves the live element and records the side', () => {
    let stored = {};
    const saved = global.localStorage;
    global.localStorage = {
      getItem: (k) => stored[k] ?? null,
      setItem: (k, v) => { stored[k] = v; },
      removeItem: (k) => { delete stored[k]; },
    };
    try {
      const el = (classes = [], dataset = {}) => {
        const set = new Set(classes);
        return {
          dataset, open: false, children: [], _classes: set,
          classList: {
            contains: (c) => set.has(c),
            add: (c) => set.add(c),
            remove: (c) => set.delete(c),
            toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
          },
          setAttribute: () => {}, focus: () => {},
          querySelector: () => null,
          insertBefore(node, ref) {
            this.children = this.children.filter((c) => c !== node);
            const at = ref ? this.children.indexOf(ref) : -1;
            if (at === -1) this.children.push(node); else this.children.splice(at, 0, node);
          },
        };
      };

      const slug = el(['details-group'], { group: 'slug' });
      const title = el(['details-group'], { group: 'title' });
      const canvas = el([]);
      canvas.children = [title];
      const panel = el([]);
      panel.children = [slug];
      panel.querySelector = () => (panel.children.length ? panel.children[0] : null);

      const container = {
        querySelector: (sel) => ({ '#pinned-fields': canvas, '.details-panel-body': panel }[sel] ?? null),
        querySelectorAll: () => [],
      };

      const page = new PostEditPage(container, { params: { id: '1' } });
      page._dropGroup(slug, canvas, title);

      assert.ok(page._pinned.has('slug'), 'slug now lives on the canvas');
      assert.deepStrictEqual(JSON.parse(stored['point:editor:pinned']).includes('slug'), true, 'side persisted');
      assert.deepStrictEqual(canvas.children.map((c) => c.dataset.group), ['title', 'slug'], 'dropped after title');
      assert.ok(slug._classes.has('is-pinned'), 'element marked as a canvas block');
      assert.strictEqual(slug.open, true, 'a canvas block is always expanded');
      assert.deepStrictEqual(JSON.parse(stored['point:editor:field-order']).slice(0, 2), ['title', 'slug'], 'order persisted');
    } finally {
      global.localStorage = saved;
    }
  });

  test('content is a canvas block with a handle but no pin', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test' };

    const html = page.render();
    const panelAt = html.indexOf('id="details-panel"');
    assert.ok(html.indexOf('data-group="content"') < panelAt, 'content sits on the canvas');
    assert.ok(html.includes('data-handle="content"'), 'content can be reordered');
    // The editor itself is that block's body, not a sibling of the field list.
    const contentAt = html.indexOf('data-group="content"');
    const mountAt = html.indexOf('visual-editor-mount');
    assert.ok(contentAt < mountAt && mountAt < html.indexOf('data-group="status"'), 'the editor is the content block body');
  });

  test('every field carries a drag handle and the arrange bar starts hidden', () => {
    const container = { querySelector: () => null, querySelectorAll: () => [] };
    const page = new PostEditPage(container, { params: { id: '1' } });
    page.state.loading = false;
    page.state.isNew = false;
    page.state.post = { id: 1, title: 'Test' };
    page.state.igStatus = { enabled: true, connected: true, default_share: false };

    const html = page.render();
    for (const key of ['title', 'tags', 'content', 'status', 'schedule', 'slug', 'excerpt', 'immersive', 'css', 'instagram']) {
      assert.ok(html.includes(`data-handle="${key}"`), `${key} has a drag handle`);
    }
    assert.ok(html.includes('id="arrange-bar"') && /id="arrange-bar"[^>]*hidden/.test(html), 'arrange bar present but hidden');
    assert.ok(html.includes('id="arrange-done"'), 'the mode has a way out');
    assert.ok(html.includes('data-action="arrange"'), 'the menu can enter the mode');
  });

  test('a stored order decides placement, unknown keys sort last', () => {
    const saved = global.localStorage;
    global.localStorage = {
      getItem: (k) => (k === 'point:editor:field-order' ? JSON.stringify(['tags', 'title']) : null),
      setItem: () => {}, removeItem: () => {},
    };
    try {
      const container = { querySelector: () => null, querySelectorAll: () => [] };
      const page = new PostEditPage(container, { params: { id: '1' } });
      page.state.loading = false;
      page.state.isNew = false;
      page.state.post = { id: 1, title: 'Test' };

      const html = page.render();
      assert.ok(html.indexOf('data-group="tags"') < html.indexOf('data-group="title"'), 'stored order wins');
      // Keys absent from the stored order keep their default sequence after it.
      assert.ok(html.indexOf('data-group="status"') < html.indexOf('data-group="slug"'), 'the rest keep default order');
    } finally {
      global.localStorage = saved;
    }
  });

  test('_moveInOrder repositions one key and leaves the rest alone', () => {
    const saved = global.localStorage;
    let stored = null;
    global.localStorage = { getItem: () => null, setItem: (_k, v) => { stored = v; }, removeItem: () => {} };
    try {
      const container = { querySelector: () => null, querySelectorAll: () => [] };
      const page = new PostEditPage(container, { params: { id: '1' } });

      page._moveInOrder('slug', 'title');
      assert.deepStrictEqual(page._order.slice(0, 4), ['title', 'slug', 'tags', 'content']);

      page._moveInOrder('excerpt', null);
      assert.strictEqual(page._order[0], 'excerpt', 'a null anchor means first');
      assert.strictEqual(JSON.parse(stored)[0], 'excerpt', 'order persisted');
    } finally {
      global.localStorage = saved;
    }
  });

  test('a drop into Details is refused for content', () => {
    const saved = global.localStorage;
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    try {
      const panel = { insertBefore: () => { throw new Error('content must not move into Details'); }, querySelector: () => null, children: [] };
      const canvas = { insertBefore: () => {}, querySelector: () => null, children: [] };
      const container = {
        querySelector: (sel) => ({ '#pinned-fields': canvas, '.details-panel-body': panel }[sel] ?? null),
        querySelectorAll: () => [],
      };
      const page = new PostEditPage(container, { params: { id: '1' } });
      const before = [...page._order];

      page._dropGroup({ dataset: { group: 'content' } }, panel, null);

      assert.ok(page._pinned.has('content'), 'content stays on the canvas');
      assert.deepStrictEqual(page._order, before, 'a refused drop changes nothing');
    } finally {
      global.localStorage = saved;
    }
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

  describe('delete from the editor', () => {
    const withStubs = async (fetchImpl, fn) => {
      const savedFetch = global.fetch;
      const savedDispatch = global.window.dispatchEvent;
      // Node's own `navigator` is a getter-only global and has no `onLine`,
      // which the api client reads to decide between fetch and the offline queue.
      const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const navigations = [];
      global.fetch = fetchImpl;
      Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: true }, configurable: true, writable: true,
      });
      global.window.dispatchEvent = (e) => {
        if (e.type === 'app:navigate') navigations.push(e.detail.path);
      };
      try {
        await fn(navigations);
      } finally {
        global.fetch = savedFetch;
        if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav);
        else delete globalThis.navigator;
        global.window.dispatchEvent = savedDispatch;
      }
    };

    const makePage = () => {
      const container = { querySelector: () => null, querySelectorAll: () => [] };
      const page = new PostEditPage(container, { params: { id: '123' } });
      page.state.loading = false;
      page.state.isNew = false;
      page.state.post = { id: 123, title: 'Test' };
      page.setState = (patch) => { Object.assign(page.state, patch); };
      return page;
    };

    test('confirming the menu Delete trashes the post and leaves the editor', async () => {
      const calls = [];
      await withStubs(
        async (url, opts) => { calls.push([url, opts.method]); return { status: 204 }; },
        async (navigations) => {
          const page = makePage();
          let confirmed = null;
          page._showConfirm = (title, message, confirmText, variant, onConfirm) => {
            confirmed = { title, confirmText, variant };
            return onConfirm();
          };

          await page._handleMenuAction('delete');
          // _showConfirm's onConfirm is async; let the delete settle.
          await new Promise((r) => setImmediate(r));

          assert.ok(confirmed, 'Delete opens the confirm dialog');
          assert.strictEqual(confirmed.variant, 'danger');
          assert.deepStrictEqual(calls, [['/api/posts/123', 'DELETE']], 'DELETE hits the post');
          assert.deepStrictEqual(navigations, ['/light/posts'], 'editor returns to the list');
        }
      );
    });

    test('a failed delete keeps the editor open and re-enables the actions', async () => {
      await withStubs(
        async () => ({
          status: 500,
          ok: false,
          headers: { get: () => 'application/json' },
          json: async () => ({ detail: 'nope' }),
        }),
        async (navigations) => {
          const page = makePage();
          await page._deletePost('123');

          assert.strictEqual(page.state.deleting, false, 'actions are usable again');
          assert.deepStrictEqual(navigations, [], 'the editor stays put');
        }
      );
    });

    test('deleting a never-saved post just leaves, without an API call', async () => {
      await withStubs(
        async () => { throw new Error('no request expected'); },
        async (navigations) => {
          const page = makePage();
          page.state.isNew = true;
          page.state.postId = undefined;

          await page._deletePost(undefined);

          assert.deepStrictEqual(navigations, ['/light/posts']);
        }
      );
    });
  });
  });

