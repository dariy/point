import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

describe('FirstPostPage', () => {
  let mod: typeof import('../src/pages/light/FirstPostPage.ts');

  before(async () => {
    globalThis.document = mock<Document>({
      createElement: () => mock<HTMLElement>({
        style: mock<CSSStyleDeclaration>({}),
        classList: mock<DOMTokenList>({ add: () => {}, remove: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {}
      }),
      body: mock<HTMLElement>({ appendChild: <T extends Node>(n: T) => n }),
      addEventListener: () => {},
      removeEventListener: () => {}
    });
    globalThis.window = mock<typeof window>({
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true
    });
    mod = await import('../src/pages/light/FirstPostPage.ts');
  });

  test('moveItem moves one place and clamps at the ends', () => {
    assert.deepStrictEqual(mod.moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepStrictEqual(mod.moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    assert.deepStrictEqual(mod.moveItem(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
    assert.deepStrictEqual(mod.moveItem(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  });

  test('firstPostContent writes one media path per line, in order', () => {
    assert.strictEqual(mod.firstPostContent([{ path: '/2026/10/a.jpg' }, { path: '/2026/10/b.jpg' }]),
      '/2026/10/a.jpg\n/2026/10/b.jpg');
  });

  test('the first step has one drop zone, one file button and a skip link', () => {
    const page = new mod.default(mock<HTMLElement>({ querySelector: () => null }));
    const markup = String(page.render());
    assert.match(markup, /Add your first photos/);
    assert.strictEqual(markup.match(/id="first-post-drop"/g)?.length, 1);
    assert.strictEqual(markup.match(/type="file"/g)?.length, 1);
    assert.match(markup, /href="\/light"[^>]*>Skip for now/);
  });
});
