// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * The copyright line is an admin-editable template: `{{author_name}}` and
 * `{{engine}}` tokens, `[text](url)` links, and literal text everywhere else.
 * Because the field is admin-editable, the escaping is a security property —
 * raw HTML, `javascript:` and protocol-relative hrefs must never survive as
 * markup, so each of those has a case here.
 */
describe('PublicFooter copyright template', () => {
  let PublicFooter;

  before(async () => {
    // maxZoomCols() measures a probe element, so render() needs enough of a
    // document to append one to. Nothing here is under test — the assertions
    // only read the copyright line back out of the returned HTML.
    const probe = () => ({ style: {}, offsetWidth: 0, remove() {} });
    global.window = {
      innerWidth: 1200,
      location: { pathname: '/', search: '', hash: '' },
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };
    global.localStorage = global.window.localStorage;
    global.document = {
      addEventListener() {},
      removeEventListener() {},
      createElement: probe,
      body: { appendChild() {}, classList: { add() {}, remove() {}, contains: () => false } },
      documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, contains: () => false } },
      querySelector: () => null,
    };
    ({ PublicFooter } = await import('../src/plugins/public-footer/PublicFooter.js'));
  });

  /** Render with the given settings and return just the copyright line's HTML. */
  function copyright(settings) {
    const html = new PublicFooter(null, { settings }).render();
    const m = html.match(/<p class="footer-copyright"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(m, 'footer renders a .footer-copyright element');
    return m[1].trim();
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
  let PublicFooter, setUser, setRevelio;

  before(async () => {
    // The suite above stubs localStorage as a black hole (it only renders the
    // copyright line); revelio actually stores its state there, so swap in one
    // that remembers.
    const mem = new Map();
    global.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
    global.window.localStorage = global.localStorage;
    ({ PublicFooter } = await import('../src/plugins/public-footer/PublicFooter.js'));
    ({ setUser } = await import('../src/store.js'));
    ({ setRevelio } = await import('../src/utils/revelio.js'));
  });

  // render() returns the RawHtml html`` produces; assert.match wants a primitive.
  const render = () => String(new PublicFooter(null, { settings: {} }).render());

  test('a guest never sees the switch', () => {
    setUser(null);
    setRevelio(true);
    assert.ok(!render().includes('revelio-toggle'));
  });

  test('the owner gets it, reading as "revealing" by default', () => {
    setUser({ id: 1 });
    setRevelio(true);
    const html = render();
    assert.match(html, /id="revelio-toggle"/);
    assert.match(html, /class="footer-action-btn revelio-toggle is-revealing"/);
    assert.match(html, /aria-pressed="true"/);
  });

  test('switched off, it offers to reveal again', () => {
    setUser({ id: 1 });
    setRevelio(false);
    const html = render();
    assert.match(html, /aria-pressed="false"/);
    assert.ok(!/revelio-toggle is-revealing/.test(html), 'not marked as revealing');
    assert.match(html, /aria-label="Reveal hidden items"/);
    setRevelio(true);
  });
});
