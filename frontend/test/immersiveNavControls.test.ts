import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';
import type * as Store from '../src/store.ts';
import type { User } from '../src/api/auth.ts';
import type { PublicHeader as PublicHeaderClass, PublicHeaderProps } from '../src/plugins/public-header/PublicHeader.ts';
import type { ImmersiveSheetViewer as ImmersiveSheetViewerClass } from '../src/plugins/immersive/ImmersiveSheetViewer.ts';

const noNodes = () => mock<NodeListOf<Element>>({ length: 0, forEach() {}, [Symbol.iterator]: [][Symbol.iterator] });

// Immersive navigation controls: the header expand button is the single
// "enter immersive" affordance (rendered only when the page passes
// onToggleImmersive, i.e. in article view), and the Details sheet has no
// Article button — the viewer's close control unwinds instead.
describe('Immersive navigation controls', () => {
  let PublicHeader: typeof PublicHeaderClass;
  let ImmersiveSheetViewer: typeof ImmersiveSheetViewerClass;
  let setRoute: typeof Store.setRoute;
  let setUser: typeof Store.setUser;
  let container: HTMLElement;

  before(async () => {
    const appendChild = <T extends Node>(node: T) => node;
    global.document = mock<Document>({
      createElement: () => mock<HTMLElement>({
        appendChild,
        remove: () => {},
        classList: mock<DOMTokenList>({ add: () => {}, remove: () => {} }),
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: noNodes,
        innerHTML: '',
        textContent: '',
        style: mock<CSSStyleDeclaration>({}),
      }),
      head: mock<HTMLHeadElement>({ appendChild }),
      body: mock<HTMLElement>({ classList: mock<DOMTokenList>({ remove: () => {}, add: () => {} }) }),
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: noNodes,
    });
    global.window = mock<typeof window>({
      location: mock<Location>({ pathname: '/posts/demo', search: '' }),
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
    });
    global.localStorage = mock<Storage>({
      getItem: () => null,
      setItem: () => {},
    });
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    ({ setRoute, setUser } = await import('../src/store.ts'));
    setRoute({ pathname: '/posts/demo', params: {}, query: {} });

    ({ PublicHeader } = await import('../src/plugins/public-header/PublicHeader.ts'));
    ({ ImmersiveSheetViewer } = await import('../src/plugins/immersive/ImmersiveSheetViewer.ts'));

    let innerHTML = '';
    container = mock<HTMLElement>({
      querySelector: () => null,
      querySelectorAll: noNodes,
      set innerHTML(val: string) { innerHTML = val; },
      get innerHTML() { return innerHTML; },
      textContent: '',
    });
  });

  function renderHeader(propsOverride: PublicHeaderProps = {}) {
    const header = new PublicHeader(container, {
      settings: mock<NonNullable<PublicHeaderProps['settings']>>({ blog_title: 'Test Blog' }),
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
    setUser(mock<User>({ id: 1 }));
    const markup = ImmersiveSheetViewer.prototype._renderActions.call(mock<ImmersiveSheetViewerClass>({
      props: { editUrl: '/light/posts/1/edit' },
    }));
    assert.ok(!markup.includes('data-action="article"'));
    assert.ok(!markup.includes('>Article<'));
    setUser(null);
  });

  test('sheet actions keep Edit (when signed in) and Share', () => {
    setUser(mock<User>({ id: 1 }));
    const markup = ImmersiveSheetViewer.prototype._renderActions.call(mock<ImmersiveSheetViewerClass>({
      props: { editUrl: '/light/posts/1/edit' },
    }));
    assert.ok(markup.includes('data-action="edit"'));
    assert.ok(markup.includes('data-action="share"'));
    setUser(null);
  });

  test('sheet actions hide Edit for anonymous visitors', () => {
    const markup = ImmersiveSheetViewer.prototype._renderActions.call(mock<ImmersiveSheetViewerClass>({
      props: { editUrl: '/light/posts/1/edit' },
    }));
    assert.ok(!markup.includes('data-action="edit"'));
    assert.ok(markup.includes('data-action="share"'));
  });
});
