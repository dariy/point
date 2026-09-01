/**
 * The lint rules that hold the html`` convention up.
 *
 * The migration itself is done — no file hand-escapes any more — but that is a
 * fact about today's tree, not a property of it. These rules are what stop the
 * next hand-built markup string from being written, and a rule nobody exercises
 * is a rule that quietly stops matching after a parser or config change. So
 * each one gets a fixture proving it still fires, and the shapes that must keep
 * working get one proving they do not.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert';

import { ESLint } from 'eslint';

let eslint;
before(() => {
  eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });
});

/** Rule ids + messages reported for a snippet, linted as a frontend/src file. */
async function lint(code) {
  const [result] = await eslint.lintText(code, {
    filePath: new URL('../src/__rule_fixture__.js', import.meta.url).pathname,
  });
  return result.messages.map((m) => m.message);
}

const PRELUDE = "import { html, raw, setHTML, insertHTML } from './utils/helpers.js';\nconst SVG = '<svg></svg>';\n";
const messages = (snippet) => lint(PRELUDE + snippet);

describe('html`` lint rules', () => {
  describe('what must be rejected', () => {
    test('raw() around a template literal — markup assembled on the spot', async () => {
      const m = await messages('export const f = (x) => html`<p>${raw(`<b>${x}</b>`)}</p>`;');
      assert.ok(m.some((s) => /raw\(\) must not wrap a template literal/.test(s)), m.join(' | '));
    });

    test('raw() around a call — a value the reader cannot check here', async () => {
      const m = await messages('export const f = (x) => html`<p>${raw(x.toUpperCase())}</p>`;');
      assert.ok(m.some((s) => /raw\(\) must not wrap a call/.test(s)), m.join(' | '));
    });

    test('interpolation into an unquoted attribute', async () => {
      const m = await messages('export const f = (u) => html`<a href=${u}>x</a>`;');
      assert.ok(m.some((s) => /must be quoted/.test(s)), m.join(' | '));
    });

    test('a bare innerHTML assignment', async () => {
      const m = await messages('export const f = (el, s) => { el.innerHTML = s; };');
      assert.ok(m.some((s) => /Use setHTML/.test(s)), m.join(' | '));
    });

    // The funnel, not the tag, is what the Trusted Types policy is attached to:
    // markup built correctly and then written straight at the sink still dies
    // under enforcement, so the lint rule must reject it here rather than let
    // it through to fail in a browser.
    test('an innerHTML assignment through the tag but around the funnel', async () => {
      const m = await messages('export const f = (el, s) => { el.innerHTML = html`<p>${s}</p>`; };');
      assert.ok(m.some((s) => /Use setHTML/.test(s)), m.join(' | '));
    });

    test('an outerHTML assignment', async () => {
      const m = await messages('export const f = (el, s) => { el.outerHTML = html`<p>${s}</p>`; };');
      assert.ok(m.some((s) => /outerHTML bypasses/.test(s)), m.join(' | '));
    });

    test('a bare insertAdjacentHTML', async () => {
      const m = await messages("export const f = (el, s) => el.insertAdjacentHTML('beforeend', s);");
      assert.ok(m.some((s) => /Use insertHTML/.test(s)), m.join(' | '));
    });

    test('an insertAdjacentHTML through the tag but around the funnel', async () => {
      const m = await messages("export const f = (el, s) => el.insertAdjacentHTML('beforeend', html`<p>${s}</p>`);");
      assert.ok(m.some((s) => /Use insertHTML/.test(s)), m.join(' | '));
    });
  });

  describe('what must keep working', () => {
    const clean = async (snippet) => {
      const m = await messages(snippet);
      assert.deepEqual(m.filter((s) => /raw\(\)|must be quoted|innerHTML|outerHTML|insertAdjacentHTML/.test(s)), []);
    };

    test('raw() around a module-level constant — the SVG blobs', () =>
      clean('export const f = () => html`<i>${raw(SVG)}</i>`;'));

    test('raw() around a string literal — a constant attribute fragment', () =>
      clean("export const f = (on) => html`<i${on ? raw(' checked') : ''}></i>`;"));

    test('raw() around a choice between two constants', () =>
      clean('const B = SVG;\nexport const f = (x) => html`<i>${raw(x ? SVG : B)}</i>`;'));

    test('a quoted attribute, including one carrying a query string', () =>
      clean('export const f = (u, s) => html`<a href="${u}"><img src="/map?tag=${s}"></a>`;'));

    test('a write through the funnel', () =>
      clean('export const f = (el, s) => { setHTML(el, html`<p>${s}</p>`); };'));

    test('an insert through the funnel', () =>
      clean("export const f = (el, s) => insertHTML(el, 'beforeend', html`<p>${s}</p>`);"));
  });
});
