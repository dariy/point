import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('PluginsPage', () => {
  let PluginsPage;

  before(async () => {
    // Basic DOM mocking for these tests
    const el = (tag = 'div') => {
      const e = {
        tagName: tag.toUpperCase(),
        className: '',
        dataset: {},
        classList: {
          add: (c) => e.className += ` ${c}`,
          remove: (c) => e.className = e.className.replace(new RegExp(`\\b${c}\\b`, 'g'), '').trim(),
          contains: (c) => e.className.includes(c),
          toggle: (c, state) => {
            const has = e.classList.contains(c);
            if (state === undefined) state = !has;
            if (state && !has) e.classList.add(c);
            if (!state && has) e.classList.remove(c);
            return state;
          }
        },
        style: {},
        appendChild: () => {},
        removeChild: () => {},
        firstChild: null,
        innerHTML: '',
        getAttribute: (k) => e[k],
        setAttribute: (k, v) => e[k] = v,
        addEventListener: () => {},
        removeEventListener: () => {},
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return e;
    };
    global.document = {
      createElement: el,
      body: el(),
      documentElement: el(),
      head: el(),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    global.window = {
      location: { pathname: '/light/plugins', search: '', hash: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      CSS: { escape: (s) => s },
    };
    global.localStorage = global.window.localStorage;
    global.CSS = global.window.CSS;

    const mod = await import('../src/pages/light/PluginsPage.js');
    PluginsPage = mod.PluginsPage || mod.default;
  });

  function page(overrides = {}) {
    const p = new PluginsPage({ querySelector: () => null, querySelectorAll: () => [] });
    p.state = {
      ...p.state,
      loading: false,
      plugins: [
        { id: 'tags-atlas', type: 'route', slot: 'map-route', slot_rule: '0-1', enabled: true },
        { id: 'tags-map', type: 'route', slot: 'map-route', slot_rule: '0-1', enabled: false },
        { id: 'timeline', type: 'slot', slot: 'timeline', slot_rule: '0+', enabled: true, routes: ['/'] },
        { id: 'service-a', type: 'service', slot: null, slot_rule: '0+', enabled: false },
        { id: 'custom-css', type: 'enhancer', slot: null, slot_rule: '0+', enabled: true },
        { id: 'immersive', type: 'enhancer', slot: 'post-viewer', slot_rule: '1', enabled: true },
        { id: 'tags-graph', type: 'route', slot: 'tags-route', slot_rule: '0-1', enabled: false },
        { id: 'comments', type: 'enhancer', slot: 'comments', slot_rule: '0+', enabled: false },
        { id: 'public-header', type: 'slot', slot: 'header', slot_rule: '0-1', enabled: true },
        { id: 'nav-menu', type: 'slot', slot: 'menu', slot_rule: '0-1', enabled: false },
      ],
      presets: {
        'minimalistic': ['custom-css'],
        'standalone': ['custom-css', 'tags-atlas']
      },
      ...overrides,
    };
    return p;
  }

  test('render content when loading', () => {
    const p = page({ loading: true });
    const html = p._renderContent();
    assert.ok(html.includes('loading-spinner'));
  });

  test('render content with error', () => {
    const p = page({ error: 'Failed' });
    const html = p._renderContent();
    assert.ok(html.includes('error-state'));
    assert.ok(html.includes('Failed'));
  });

  test('render map', () => {
    const p = page();
    const html = p._renderMap();
    assert.ok(html.includes('pmap-card'));
    assert.ok(html.includes('Site map'));

    // Two panels: the graph owns /tags, the two maps share /map.
    assert.ok(html.includes('<code>/tags</code>'));
    assert.ok(html.includes('<code>/map</code>'));

    // Check known regions
    assert.ok(html.includes('data-plugins="tags-atlas"'));
    assert.ok(html.includes('data-plugins="tags-map"'));
    assert.ok(html.includes('data-plugins="tags-graph"'));

    // The maps are the only chooser on the tag pages; the graph stands alone.
    assert.ok(html.includes('One map plugin owns /map'));
    assert.ok(!html.includes('owns /tags'));
    
    // Check offMap
    assert.ok(html.includes('pmap-offmap'));
    assert.ok(html.includes('Service A')); // from humanize
  });

  test('_renderPresets normal view', () => {
    const p = page({ activePreset: 'minimalistic' });
    const html = p._renderPresets();
    assert.ok(html.includes('Minimalistic'));
    assert.ok(!html.includes('Editing only changes'));
  });

  test('_renderPresets edit view', () => {
    const p = page({ editingPreset: 'standalone' });
    const html = p._renderPresets();
    assert.ok(html.includes('Editing only changes'));
  });

  test('_renderGroup renders group', () => {
    const p = page();
    const html = p._renderGroup({ type: 'route', title: 'Routes', hint: 'hint' });
    assert.ok(html.includes('Routes'));
    assert.ok(html.includes('tags-atlas'));
    assert.ok(html.includes('Alternatives for <code>map-route</code>'));
    // tags-route has a single candidate now — no group heading around one row.
    assert.ok(!html.includes('Alternatives for <code>tags-route</code>'));
  });

  test('_renderGroup empty group', () => {
    const p = page({ plugins: [] });
    const html = p._renderGroup({ type: 'route', title: 'Routes', hint: 'hint' });
    assert.strictEqual(html, '');
  });

  test('_renderRowControls with settings', () => {
    const p = page();
    const html = p._renderRowControls(p.state.plugins.find(x => x.id === 'custom-css'), false);
    assert.ok(html.includes('plugin-settings-link'));
    assert.ok(html.includes('/light/themes'));
  });
  
  test('_renderInclude forced', () => {
    const p = page();
    const html = p._renderInclude({ id: 'only-viewer', slot: 'post-viewer', slot_rule: '1', enabled: true });
    assert.ok(html.includes('Always on'));
    assert.ok(html.includes('disabled'));
  });
  
  test('_setAllCollapsed toggles state', () => {
    const p = page();
    p.setState = (st) => { p.state = { ...p.state, ...st }; };
    p._setAllCollapsed(true);
    assert.strictEqual(p.state.collapsed.map, true);
    assert.strictEqual(p.state.collapsed.route, true);
  });
  
  test('_toggleEdit starts editing', () => {
    const p = page({ activePreset: 'custom', editingPreset: null });
    p.setState = (st) => { p.state = { ...p.state, ...st }; };
    p._toggleEdit();
    assert.strictEqual(p.state.editingPreset, 'minimalistic');
  });

  test('_toggleEdit stops editing', () => {
    const p = page({ editingPreset: 'minimalistic' });
    p.setState = (st) => { p.state = { ...p.state, ...st }; };
    p._toggleEdit();
    assert.strictEqual(p.state.editingPreset, null);
  });
});
