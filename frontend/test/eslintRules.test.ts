/**
 * The lint rules that hold the html`` convention up.
 *
 * The migration itself is done — no file hand-escapes any more — but that is a
 * fact about today's tree, not a property of it. These rules are what stop the
 * next hand-built markup string from being written, and a rule nobody exercises
 * is a rule that quietly stops matching after a parser or config change. So
 * each one gets a fixture proving it still fires, and the shapes that must keep
 * working get one proving they do not.
 *
 * The rules run in Oxlint (.oxlintrc.json, scripts/oxlint-point.mjs). Every
 * fixture is linted twice, as a .js file and as a .ts file, and each selector
 * also gets a .ts fixture per TypeScript cast — `as`, `!`, `satisfies`, `<T>` —
 * because a cast is an AST node that sits between the parts a selector names.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname;
let seq = 0;

/** Messages reported for a snippet, linted as a frontend/src file of type `ext`. */
function lint(code, ext) {
  const rel = `frontend/src/__rule_fixture_${process.pid}_${seq++}__.${ext}`;
  writeFileSync(ROOT + rel, code);
  try {
    let out;
    try {
      out = execFileSync('node_modules/.bin/oxlint', ['-f', 'json', rel], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout; // exit 1 on any error diagnostic
    }
    return JSON.parse(out).diagnostics.map((d) => d.message);
  } finally {
    rmSync(ROOT + rel, { force: true });
  }
}

const PRELUDE = "import { html, raw, setHTML, insertHTML } from './utils/helpers.ts';\nimport { store } from './store.ts';\nconst SVG = '<svg></svg>';\n";

for (const ext of ['js', 'ts']) {
  const messages = (snippet) => lint(PRELUDE + snippet, ext);

  describe(`html\`\` lint rules (.${ext})`, () => {
    describe('what must be rejected', () => {
      test('raw() around a template literal — markup assembled on the spot', () => {
        const m = messages('export const f = (x) => html`<p>${raw(`<b>${x}</b>`)}</p>`;');
        assert.ok(m.some((s) => /raw\(\) must not wrap a template literal/.test(s)), m.join(' | '));
      });

      test('raw() around a call — a value the reader cannot check here', () => {
        const m = messages('export const f = (x) => html`<p>${raw(x.toUpperCase())}</p>`;');
        assert.ok(m.some((s) => /raw\(\) must not wrap a call/.test(s)), m.join(' | '));
      });

      test('interpolation into an unquoted attribute', () => {
        const m = messages('export const f = (u) => html`<a href=${u}>x</a>`;');
        assert.ok(m.some((s) => /must be quoted/.test(s)), m.join(' | '));
      });

      test('a bare innerHTML assignment', () => {
        const m = messages('export const f = (el, s) => { el.innerHTML = s; };');
        assert.ok(m.some((s) => /Use setHTML/.test(s)), m.join(' | '));
      });

      // The funnel, not the tag, is what the Trusted Types policy is attached to:
      // markup built correctly and then written straight at the sink still dies
      // under enforcement, so the lint rule must reject it here rather than let
      // it through to fail in a browser.
      test('an innerHTML assignment through the tag but around the funnel', () => {
        const m = messages('export const f = (el, s) => { el.innerHTML = html`<p>${s}</p>`; };');
        assert.ok(m.some((s) => /Use setHTML/.test(s)), m.join(' | '));
      });

      test('an outerHTML assignment', () => {
        const m = messages('export const f = (el, s) => { el.outerHTML = html`<p>${s}</p>`; };');
        assert.ok(m.some((s) => /outerHTML bypasses/.test(s)), m.join(' | '));
      });

      test('a bare insertAdjacentHTML', () => {
        const m = messages("export const f = (el, s) => el.insertAdjacentHTML('beforeend', s);");
        assert.ok(m.some((s) => /Use insertHTML/.test(s)), m.join(' | '));
      });

      test('an insertAdjacentHTML through the tag but around the funnel', () => {
        const m = messages("export const f = (el, s) => el.insertAdjacentHTML('beforeend', html`<p>${s}</p>`);");
        assert.ok(m.some((s) => /Use insertHTML/.test(s)), m.join(' | '));
      });
    });

    describe('what must keep working', () => {
      const clean = (snippet) => {
        const m = messages(snippet);
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
}

// One fixture per security selector. W() marks the node a cast wraps: the spot
// where a wrapper separates two parts the selector names.
const SELECTORS = [
  ['innerHTML write', 'el => { W(el.innerHTML) = s; }', /Use setHTML.*bare innerHTML/],
  ['outerHTML write', 'el => { W(el.outerHTML) = s; }', /outerHTML bypasses/],
  ['insertAdjacentHTML call', "el => W(el.insertAdjacentHTML)('beforeend', s)", /bare insertAdjacentHTML/],
  ['computed-key HTML write', "el => { el[W('innerHTML')] = s; }", /computed-key HTML write/],
  ['computed-key insertAdjacentHTML', "el => el[W('insertAdjacentHTML')]('beforeend', s)", /computed-key insertAdjacentHTML/],
  ['concatenated property name', "el => { el[W('inner' + 'HTML')] = s; }", /property name from pieces/],
  ['concatenated method name', "el => el[W('insertAdjacent' + 'HTML')]('beforeend', s)", /method name from pieces/],
  ['parseFromString call', "p => W(p.parseFromString)(s, 'text/html')", /bare parseFromString/],
  ['raw() around a template literal', 'x => html`<p>${raw(W(`<b>${x}</b>`))}</p>`', /wrap a template literal/],
  ['raw() around a call', 'x => html`<p>${raw(W(x.toUpperCase()))}</p>`', /wrap a call/],
  ['store string key', "() => store.get(W('user'))", /accessor from store\.ts/],
  ['unquoted attribute', 'u => W(html)`<a href=${u}>x</a>`', /must be quoted/],
];

const WRAPS = {
  bare: (x) => x,
  as: (x) => `(${x} as any)`,
  '!': (x) => `(${x})!`,
  satisfies: (x) => `(${x} satisfies any)`,
  '<T>': (x) => `(<any>(${x}))`,
};

describe('security selectors match through TypeScript casts', () => {
  for (const [name, body, re] of SELECTORS) {
    for (const [wrap, fn] of Object.entries(WRAPS)) {
      const code = `${PRELUDE}const s = '';\nexport const f = ${body.replace(/W\(((?:[^()]|\([^()]*\))*)\)/, (_, inner) => fn(inner))};\n`;
      for (const ext of wrap === 'bare' ? ['js', 'ts'] : ['ts']) {
        test(`${name} — ${wrap} (.${ext})`, () => {
          const m = lint(code, ext);
          assert.ok(m.some((x) => re.test(x)), `${code}\n→ ${m.join(' | ')}`);
        });
      }
    }
  }
});
