import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock, memoryStorage } from './helpers/mock.ts';

import type { StoreSettings } from '../src/utils/helpers.ts';
type User = NonNullable<Parameters<typeof import('../src/store.ts').setUser>[0]>;

/**
 * The copyright line is an admin-editable template: `{{author_name}}` and
 * `{{engine}}` tokens, `[text](url)` links, and literal text everywhere else.
 * Because the field is admin-editable, the escaping is a security property —
 * raw HTML, `javascript:` and protocol-relative hrefs must never survive as
 * markup, so each of those has a case here.
 */
describe('PublicFooter copyright template', () => {
  let PublicFooter: typeof import('../src/plugins/public-footer/PublicFooter.ts').PublicFooter;

  before(async () => {
    // maxZoomCols() measures a probe element, so render() needs enough of a
    // document to append one to. Nothing here is under test — the assertions
    // only read the copyright line back out of the returned HTML.
    const probe = () => mock<HTMLElement>({ style: mock<CSSStyleDeclaration>({}), offsetWidth: 0, remove() {} });
    const classList = () => mock<DOMTokenList>({ add() {}, remove() {}, contains: () => false });
    globalThis.window = mock<typeof window>({
      innerWidth: 1200,
      location: mock<Location>({ pathname: '/', search: '', hash: '' }),
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => mock<MediaQueryList>({ matches: false, addEventListener() {}, removeEventListener() {} }),
      localStorage: mock<Storage>({ getItem: () => null, setItem() {}, removeItem() {} }),
    });
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.document = mock<Document>({
      addEventListener() {},
      removeEventListener() {},
      createElement: probe,
      body: mock<HTMLElement>({ appendChild: <T extends Node>(n: T) => n, classList: classList() }),
      documentElement: mock<HTMLElement>({ style: mock<CSSStyleDeclaration>({ setProperty() {} }), classList: classList() }),
      querySelector: () => null,
    });
    ({ PublicFooter } = await import('../src/plugins/public-footer/PublicFooter.ts'));
  });

  /** Render with the given settings and return just the copyright line's HTML. */
  function copyright(settings: StoreSettings) {
    const html = String(new PublicFooter(mock<HTMLElement>({}), { settings }).render());
    const m = html.match(/<p class="footer-copyright"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(m, 'footer renders a .footer-copyright element');
    return (m[1] ?? '').trim();
  }

  test('no template: author and engine are linked by default', () => {
    const out = copyright({ author_name: 'Demo' });
    assert.match(out, /<a href="\/light">Demo<\/a>/);
    assert.match(out, /<a href="https:\/\/github\.com\/dariy\/point"[^>]*>Point<\/a>/);
  });

  test('an external link opens in a new tab, a site-relative one does not', () => {
    const out = copyright({
      footer_copyright: 'photos from [picsum.photos](https://picsum.photos), [admin UI](/light)',
    });
    assert.match(
      out,
      /<a href="https:\/\/picsum\.photos" target="_blank" rel="noopener noreferrer">picsum\.photos<\/a>/,
    );
    assert.match(out, /<a href="\/light">admin UI<\/a>/);
    assert.ok(!/\/light" target/.test(out), 'a same-site link stays in the tab');
  });

  test('raw HTML in the template is escaped, never emitted', () => {
    const out = copyright({ footer_copyright: '<img src=x onerror=alert(1)> <b>bold</b>' });
    assert.ok(!out.includes('<img'), 'no element survives');
    assert.ok(!out.includes('<b>'), 'not even a harmless one');
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  test('a link only gets an href for http(s) and same-site paths', () => {
    for (const href of ['javascript:alert(1)', '//evil.example', 'data:text/html,x', 'ftp://h/f']) {
      const out = copyright({ footer_copyright: `[click](${href})` });
      assert.ok(!out.includes('<a'), `${href} is not turned into a link`);
      // The admin sees what they typed rather than the line silently vanishing.
      assert.ok(out.includes('[click]('), `${href} falls back to literal text`);
    }
  });

  test('link text is escaped like any other literal', () => {
    const out = copyright({ footer_copyright: '[<b>x</b>](/p)' });
    assert.match(out, /<a href="\/p">&lt;b&gt;x&lt;\/b&gt;<\/a>/);
  });

  test('an unknown token and stray brackets stay literal', () => {
    const out = copyright({ footer_copyright: '{{nope}} [not a link] (x) {' });
    assert.match(out, /\{\{nope\}\}/);
    assert.match(out, /\[not a link\] \(x\) \{/);
  });
});

/**
 * Revelio — the owner's switch between "everything I can see" and the guest's
 * view of the site. It only exists for a signed-in owner: a guest has nothing
 * to conceal, and a stray reveal button in a visitor's footer would advertise
 * that there is something to see.
 */
describe('PublicFooter revelio toggle', () => {
  let PublicFooter: typeof import('../src/plugins/public-footer/PublicFooter.ts').PublicFooter;
  let setUser: typeof import('../src/store.ts').setUser;
  let setRevelio: typeof import('../src/utils/revelio.ts').setRevelio;

  before(async () => {
    // The suite above stubs localStorage as a black hole (it only renders the
    // copyright line); revelio actually stores its state there, so swap in one
    // that remembers.
    globalThis.localStorage = memoryStorage();
    globalThis.window.localStorage = globalThis.localStorage;
    ({ PublicFooter } = await import('../src/plugins/public-footer/PublicFooter.ts'));
    ({ setUser } = await import('../src/store.ts'));
    ({ setRevelio } = await import('../src/utils/revelio.ts'));
  });

  // render() returns the RawHtml html`` produces; assert.match wants a primitive.
  const render = () => String(new PublicFooter(mock<HTMLElement>({}), { settings: {} }).render());

  test('a guest never sees the switch', () => {
    setUser(null);
    setRevelio(true);
    assert.ok(!render().includes('revelio-toggle'));
  });

  test('the owner gets it, reading as "revealing" by default', () => {
    setUser(mock<User>({ id: 1 }));
    setRevelio(true);
    const html = render();
    assert.match(html, /id="revelio-toggle"/);
    assert.match(html, /class="footer-action-btn revelio-toggle is-revealing"/);
    assert.match(html, /aria-pressed="true"/);
  });

  test('switched off, it offers to reveal again', () => {
    setUser(mock<User>({ id: 1 }));
    setRevelio(false);
    const html = render();
    assert.match(html, /aria-pressed="false"/);
    assert.ok(!/revelio-toggle is-revealing/.test(html), 'not marked as revealing');
    assert.match(html, /aria-label="Reveal hidden items"/);
    setRevelio(true);
  });
});
