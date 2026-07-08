import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// Immersive navigation controls: the header expand button is the single
// "enter immersive" affordance (rendered only when the page passes
// onToggleImmersive, i.e. in article view), and the Details sheet has no
// Article button — the viewer's close control unwinds instead.
describe('Immersive navigation controls', () => {
  let PublicHeader;
  let ImmersiveSheetViewer;
  let store;
  let container;

  before(async () => {
    global.document = {
      createElement: () => ({
        appendChild: () => {},
        remove: () => {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        innerHTML: '',
        textContent: '',
        style: {},
      }),
      head: { appendChild: () => {} },
      body: { classList: { remove: () => {}, add: () => {} } },
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
    };
    global.window = {
      location: { pathname: '/posts/demo', search: '' },
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
    };
    global.localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
    store.set('route', { pathname: '/posts/demo', params: {}, query: {} });

    ({ PublicHeader } = await import('../src/plugins/public-header/PublicHeader.js'));
    ({ ImmersiveSheetViewer } = await import('../src/plugins/immersive/ImmersiveSheetViewer.js'));

    container = {
      querySelector: () => null,
      querySelectorAll: () => [],
      set innerHTML(val) { this._innerHTML = val; },
      get innerHTML() { return this._innerHTML || ''; },
      textContent: '',
    };
  });

  function renderHeader(propsOverride = {}) {
    const header = new PublicHeader(container, {
      settings: { blog_title: 'Test Blog' },
      navTags: [],
      breadcrumb: [],
      ...propsOverride,
    });
    return header.render();
  }

  // ── Header expand button ───────────────────────────────────────────────────

  test('header renders the immersive toggle only when onToggleImmersive is passed', () => {
    const withToggle = renderHeader({ onToggleImmersive: () => {} });
    assert.ok(withToggle.includes('immersive-toggle-btn'));

    const withoutToggle = renderHeader();
    assert.ok(!withoutToggle.includes('immersive-toggle-btn'));
  });

  test('header toggle is enter-only: always "Immersive mode", never "Article view"', () => {
    const markup = renderHeader({ onToggleImmersive: () => {} });
    assert.ok(markup.includes('Immersive mode'));
    assert.ok(!markup.includes('Article view'));
  });

  // ── Details sheet actions ──────────────────────────────────────────────────

  test('sheet actions have no Article button', () => {
    store.set('user', { id: 1 });
    const markup = ImmersiveSheetViewer.prototype._renderActions.call({
      props: { editUrl: '/light/posts/1/edit' },
    });
    assert.ok(!markup.includes('data-action="article"'));
    assert.ok(!markup.includes('>Article<'));
    store.set('user', null);
  });

  test('sheet actions keep Edit (when signed in) and Share', () => {
    store.set('user', { id: 1 });
    const markup = ImmersiveSheetViewer.prototype._renderActions.call({
      props: { editUrl: '/light/posts/1/edit' },
    });
    assert.ok(markup.includes('data-action="edit"'));
    assert.ok(markup.includes('data-action="share"'));
    store.set('user', null);
  });

  test('sheet actions hide Edit for anonymous visitors', () => {
    const markup = ImmersiveSheetViewer.prototype._renderActions.call({
      props: { editUrl: '/light/posts/1/edit' },
    });
    assert.ok(!markup.includes('data-action="edit"'));
    assert.ok(markup.includes('data-action="share"'));
  });
});
