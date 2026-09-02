import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// The Plugins page derives its radio/lock behavior from each row's `slot_rule`
// (the cardinality of the slot the plugin claims), so the tag visualizations and
// the immersive viewers are driven by one rule set. These tests pin that mapping:
// a "0-1" slot is a plain radio group, a "1" slot is a radio group whose current
// claimant cannot be switched off.
describe('PluginsPage slot rules', () => {
  let PluginsPage;

  before(async () => {
    const el = () => ({
      style: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: () => {},
      dataset: {},
    });
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
    };
    global.localStorage = global.window.localStorage;

    const mod = await import('../src/pages/light/PluginsPage.js');
    PluginsPage = mod.PluginsPage || mod.default;
  });

  // Rows as the backend serves them: three candidates for the 0-1 tags slot and
  // two for the 1 post-viewer slot, each slot with one candidate enabled.
  function page(overrides = {}) {
    const p = new PluginsPage({ querySelector: () => null, querySelectorAll: () => [] });
    p.state = {
      ...p.state,
      loading: false,
      plugins: [
        { id: 'tags-atlas', type: 'route', slot: 'tags-route', slot_rule: '0-1', enabled: true },
        { id: 'tags-map', type: 'route', slot: 'tags-route', slot_rule: '0-1', enabled: false },
        { id: 'tags-graph', type: 'route', slot: 'tags-route', slot_rule: '0-1', enabled: false },
        { id: 'immersive', type: 'enhancer', slot: 'post-viewer', slot_rule: '1', enabled: false },
        { id: 'immersive-sheet', type: 'enhancer', slot: 'post-viewer', slot_rule: '1', enabled: true, locked: true },
        { id: 'timeline', type: 'slot', slot: 'timeline', slot_rule: '0+', enabled: true },
      ],
      ...overrides,
    };
    return p;
  }

  const rowOf = (p, id) => p._renderPlugin(p.state.plugins.find((x) => x.id === id));

  test('alternatives for a slot are rendered as radio buttons, replacing the lock behavior', () => {
    const p = page();

    const active = rowOf(p, 'immersive-sheet');
    assert.ok(!active.includes('plugin-pill-locked'), 'alternatives no longer use the locked pill');
    assert.ok(active.includes('type="radio"'), 'the active alternative is a radio button');

    const inactive = rowOf(p, 'immersive');
    assert.ok(inactive.includes('type="radio"'), 'the inactive alternative is a radio button');
  });

  test('a 0-1 slot never locks its sole claimant — "none" is a valid state there', () => {
    const p = page();
    const atlas = rowOf(p, 'tags-atlas');
    assert.ok(!atlas.includes('plugin-pill-locked'), '/tags may be turned off entirely');
    assert.ok(atlas.includes('plugin-toggle'), 'the enabled viz keeps its toggle');
  });

  test('candidates competing for one slot are marked as alternatives; other plugins are not', () => {
    const p = page();
    assert.ok(rowOf(p, 'tags-atlas').includes('Alternative'), 'tags viz rows are alternatives');
    assert.ok(rowOf(p, 'immersive').includes('Alternative'), 'viewer rows are alternatives');
    assert.ok(!rowOf(p, 'timeline').includes('Alternative'), 'a many-slot plugin competes with nothing');
  });

  // _withLocks re-derives `locked` after a toggle so the page does not need a
  // reload to make the incoming claimant read-only.
  test('locks follow the claimant when a required slot switches over', () => {
    const p = page();
    const switched = p.state.plugins.map((x) =>
      x.slot === 'post-viewer' ? { ...x, enabled: x.id === 'immersive', locked: false } : x,
    );

    const locked = p._withLocks(switched).filter((x) => x.locked).map((x) => x.id);
    assert.deepStrictEqual(locked, ['immersive'], 'only the new sole claimant is locked');
  });

  test('a required slot with several claimants enabled locks neither', () => {
    const p = page();
    const both = p.state.plugins.map((x) =>
      x.slot === 'post-viewer' ? { ...x, enabled: true, locked: false } : x,
    );

    assert.deepStrictEqual(
      p._withLocks(both).filter((x) => x.locked).map((x) => x.id),
      [],
      'with two viewers on, either may be disabled',
    );
  });
});
