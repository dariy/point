// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
/**
 * setHTML()/insertHTML() — the single gate every HTML write goes through, and
 * the Trusted Types policy behind it.
 *
 * The policy is resolved once per module instance and memoised, so a test that
 * needs a different browser (no Trusted Types, a policy that refuses to be
 * created) imports helpers.js under a fresh specifier: ESM caches on the full
 * URL, so the query string buys a module with its memo not yet filled.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';

let dom;
beforeEach(() => { dom = setupDOM(); });
afterEach(() => { dom.cleanup(); });

let freshCount = 0;
/** helpers.js with an unresolved policy memo. */
const freshHelpers = () => import(`../src/utils/helpers.js?tt=${++freshCount}`);

/** A stand-in for window.trustedTypes that records what it was asked for. */
function fakeTrustedTypes({ createPolicy } = {}) {
  const calls = [];
  const tt = {
    calls,
    createPolicy(name, rules) {
      calls.push({ name, rules });
      if (createPolicy) return createPolicy(name, rules);
      return { name, createHTML: (s) => `TRUSTED:${rules.createHTML(s)}` };
    },
  };
  globalThis.window.trustedTypes = tt;
  return tt;
}

describe('setHTML', () => {
  test('writes html`` output into the element', async () => {
    const { html, setHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    setHTML(el, html`<p>${'<b>hi</b>'}</p>`);
    assert.strictEqual(el.innerHTML, '<p>&lt;b&gt;hi&lt;/b&gt;</p>');
  });

  test('refuses a plain string — the whole point of the funnel', async () => {
    const { setHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    assert.throws(() => setHTML(el, '<img src=x onerror=alert(1)>'), {
      name: 'TypeError',
      message: /setHTML was given string/,
    });
    assert.strictEqual(el.innerHTML, '');
  });

  test('refuses null and undefined by name', async () => {
    const { setHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    assert.throws(() => setHTML(el, null), { message: /given null/ });
    assert.throws(() => setHTML(el, undefined), { message: /given undefined/ });
  });

  test('accepts raw() output — the pre-escaped opt-out', async () => {
    const { raw, setHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    setHTML(el, raw('<b>bold</b>'));
    assert.strictEqual(el.innerHTML, '<b>bold</b>');
  });
});

describe('insertHTML', () => {
  test('inserts at the given position without disturbing what is there', async () => {
    const { html, insertHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    el.appendChild(dom.document.createElement('span'));
    insertHTML(el, 'beforeend', html`<i>${'x'}</i>`);
    assert.strictEqual(el.innerHTML, '<span></span><i>x</i>');
  });

  test('refuses a plain string', async () => {
    const { insertHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    assert.throws(() => insertHTML(el, 'beforeend', '<i>x</i>'), {
      message: /insertHTML was given string/,
    });
  });
});

describe('the script sinks', () => {
  test('setScriptSrc points a script at a same-origin path', async () => {
    const { setScriptSrc } = await freshHelpers();
    const el = dom.document.createElement('script');
    setScriptSrc(el, '/assets/vendor/leaflet/leaflet.js');
    assert.strictEqual(el.getAttribute('src'), '/assets/vendor/leaflet/leaflet.js');
  });

  // Without Trusted Types there is no policy to run the check, so the guard is
  // only claimed for the browsers that enforce it — assert it there.
  test('the policy refuses a script URL that is not a same-origin path', async () => {
    fakeTrustedTypes({ createPolicy: (name, rules) => rules });
    const { setScriptSrc } = await freshHelpers();
    const el = dom.document.createElement('script');
    for (const bad of ['https://evil.example/x.js', '//evil.example/x.js', 'data:text/javascript,0', 'x.js']) {
      assert.throws(() => setScriptSrc(el, bad), { message: /same-origin absolute paths only/ }, bad);
    }
    assert.doesNotThrow(() => setScriptSrc(el, '/comments/web/embed.mjs'));
  });

  test('setScriptJSON serialises and escapes the < that could close the tag', async () => {
    const { setScriptJSON } = await freshHelpers();
    const el = dom.document.createElement('script');
    setScriptJSON(el, { headline: 'a </script><img> b' });
    assert.strictEqual(el.textContent, '{"headline":"a \\u003c/script>\\u003cimg> b"}');
    assert.deepEqual(JSON.parse(el.textContent), { headline: 'a </script><img> b' });
  });
});

describe('the Trusted Types policy', () => {
  test('is created once, named "point", and every write goes through it', async () => {
    const tt = fakeTrustedTypes();
    const { html, setHTML, insertHTML } = await freshHelpers();
    const el = dom.document.createElement('div');

    setHTML(el, html`<p>a</p>`);
    assert.deepEqual(tt.calls.map((c) => c.name), ['point']);
    assert.strictEqual(el.innerHTML, 'TRUSTED:<p>a</p>');

    insertHTML(el, 'beforeend', html`<i>b</i>`);
    assert.strictEqual(el.innerHTML, 'TRUSTED:<p>a</p>TRUSTED:<i>b</i>');
    // Still one policy: a second createPolicy('point') would throw in a real
    // browser, so the memo is load-bearing, not an optimisation.
    assert.strictEqual(tt.calls.length, 1);
    // One policy, three rules — an HTML write, a script body and a script URL
    // each need their own.
    assert.deepEqual(Object.keys(tt.calls[0].rules).sort(),
      ['createHTML', 'createScript', 'createScriptURL']);
  });

  test('passes the markup through unchanged — the tag already escaped it', async () => {
    const tt = fakeTrustedTypes();
    const { html, setHTML } = await freshHelpers();
    setHTML(dom.document.createElement('div'), html`<p>${'a&b'}</p>`);
    const { createHTML } = tt.calls[0].rules;
    assert.strictEqual(createHTML('<p>x</p>'), '<p>x</p>');
  });

  test('a refused policy still writes — the sink reports the violation, not us', async () => {
    fakeTrustedTypes({
      createPolicy() { throw new TypeError('policy "point" disallowed by CSP'); },
    });
    const { html, setHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    setHTML(el, html`<p>a</p>`);
    assert.strictEqual(el.innerHTML, '<p>a</p>');
  });

  test('a browser without Trusted Types writes the plain string', async () => {
    delete globalThis.window.trustedTypes;
    const { html, setHTML } = await freshHelpers();
    const el = dom.document.createElement('div');
    setHTML(el, html`<p>a</p>`);
    assert.strictEqual(el.innerHTML, '<p>a</p>');
  });
});
