import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

describe('StylePickerPage', () => {
  let mod: typeof import('../src/pages/light/StylePickerPage.ts');

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
    mod = await import('../src/pages/light/StylePickerPage.ts');
  });

  test('renders one card per preset, a preview mount and a disabled Apply', () => {
    const page = new mod.default(mock<HTMLElement>({ querySelector: () => null }));
    const preset = (name: string) => ({
      id: name, name, description: '', preview_color: '', has_dark_mode: false,
      preset: { name: name.toUpperCase(), description: `${name} look`, preview_image: `/assets/images/presets/${name}.svg`,
        layout: '', typography: '', palette: '', header: '' },
    });
    page.state = { loading: false, error: null, presets: [preset('default'), preset('zine')] };
    const markup = String(page.render());
    assert.strictEqual(markup.match(/class="style-card"/g)?.length, 2);
    assert.match(markup, /data-name="zine"/);
    assert.match(markup, /zine look/);
    assert.match(markup, /src="\/assets\/images\/presets\/zine.svg"/);
    assert.match(markup, /id="style-preview"/);
    assert.match(markup, /id="style-apply"[^>]*disabled/);
  });
});
