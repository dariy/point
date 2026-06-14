import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('FilterChipsRow', () => {
  let FilterChipsRow;
  let store;
  let container;

  before(async () => {
    // Mock global dependencies
    global.document = {
      createElement: () => ({
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        innerHTML: '',
        textContent: ''
      }),
      head: { appendChild: () => {} },
      body: { classList: { remove: () => {} } },
    };
    global.window = {
      location: { pathname: '/', search: '' },
    };

    const storeMod = await import('../src/store.js');
    store = storeMod.store;

    const mod = await import('../src/components/public/FilterChipsRow.js');
    FilterChipsRow = mod.FilterChipsRow;

    container = {
      querySelector: () => null,
      querySelectorAll: () => [],
      set innerHTML(val) { this._innerHTML = val; },
      get innerHTML() { return this._innerHTML || ''; },
      textContent: ''
    };
  });

  test('should show year chip when timelineVisible is false', () => {
    store.set('route', { pathname: '/', query: { timeline: '2020-2021' } });
    const row = new FilterChipsRow(container, { timelineVisible: false });
    const markup = row.render();
    assert.ok(markup.includes('2020'), 'Should include 2020');
    assert.ok(markup.includes('2021'), 'Should include 2021');
  });

  test('should NOT show year chip when timelineVisible is true', () => {
    store.set('route', { pathname: '/', query: { timeline: '2020-2021' } });
    const row = new FilterChipsRow(container, { timelineVisible: true });
    const markup = row.render();
    assert.ok(!markup.includes('2020'), 'Should NOT include 2020');
    assert.ok(!markup.includes('2021'), 'Should NOT include 2021');
  });
});
