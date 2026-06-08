import { test, describe, before } from 'node:test';
import assert from 'node:assert';

describe('TagsManagerPage', () => {
  let TagsManagerPage;

  before(async () => {
    // Mock global dependencies
    global.document = {
      createElement: () => ({
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => []
    };
    global.window = {
      location: { pathname: '', search: '' },
      history: { replaceState: () => {}, pushState: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    // Mock store
    const storeMod = await import('../src/store.js');
    global.store = storeMod.store;

    const mod = await import('../src/pages/light/TagsManagerPage.js');
    TagsManagerPage = mod.default;
  });

  test('should render descriptive map link in list view when tag has location', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'list';
    page.state.tags = [
      { id: 1, name: 'Paris', slug: 'paris', locations: [{ latitude: 48, longitude: 2 }], post_count: 5 }
    ];

    const html = page.render();
    assert.ok(html.includes('/map?tag=paris'), 'Link to map should be present');
    assert.ok(html.includes('tm-flag-link'), 'tm-flag-link class should be present');
    assert.ok(html.includes('Map</span>'), 'Map label should be present');
  });

  test('should render static map icon in list view when tag has NO location', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'list';
    page.state.tags = [
      { id: 2, name: 'NoLoc', slug: 'noloc', locations: [], post_count: 0 }
    ];

    const html = page.render();
    assert.ok(!html.includes('/map?tag=noloc'), 'Link to map should NOT be present');
    assert.ok(html.includes('tm-flag-static'), 'tm-flag-static class should be present');
    assert.ok(!html.includes('Map</span>'), 'Map label should NOT be present');
  });

  test('should render descriptive map link in tree view when node has location', () => {
    const container = {};
    const page = new TagsManagerPage(container);
    page.state.loading = false;
    page.state.view = 'tree';
    page.state.tags = [
      { id: 0, slug: '_root', name: 'Root', parents: [] },
      { id: 1, name: 'Paris', slug: 'paris', locations: [{ latitude: 48, longitude: 2 }], parents: [{id: 0}] }
    ];
    page.state.expanded = new Set([0]);

    const tree = page._buildTree(page.state.tags);
    // Tree view renders through _renderTree
    const html = page._renderTree(tree);

    assert.ok(html.includes('/map?tag=paris'), 'Link to map should be present in tree view');
    assert.ok(html.includes('tm-flag-link'), 'tm-flag-link class should be present in tree view');
    assert.ok(html.includes('Map</span>'), 'Map label should be present in tree view');
  });
});
