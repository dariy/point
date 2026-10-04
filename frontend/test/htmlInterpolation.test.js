/**
 * Markup interpolated into html`` has to be html`` too.
 *
 * The tag escapes every interpolation that is not a `RawHtml`, which is the
 * whole point of it — but that means a plain template literal holding markup
 * comes out the other side as *visible text*:
 *
 *   html`<div>${cond ? `<button>Hi</button>` : ''}</div>`
 *                      ^ escaped into &lt;button&gt;Hi&lt;/button&gt;
 *
 * Nothing catches this today. The `point/restricted-syntax` selectors cannot
 * see the difference between that and the legitimate shape one line away —
 * `${count ? ` (${count})` : ''}`, plain text an author *wants* escaped —
 * because telling them apart means looking at the literal's contents, not its
 * shape. And it fails silently: no error, no violation, just a button that
 * renders as its own source. It shipped once, in the atlas legend's "Hidden"
 * toggle, and was only found by a human looking at the page.
 *
 * So it is asserted here, where a parser and the string are both in hand.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

const SRC = new URL('../src', import.meta.url).pathname;

/** Looks like an HTML element rather than prose that happens to contain "<". */
const MARKUP = /<\/[a-z][a-z0-9-]*\s*>|<[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/i;

/**
 * Every .js and .ts source; .d.ts holds no code. eslintRules.test.js writes and
 * deletes __rule_fixture_* files here in parallel, so skip them.
 */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('__rule_fixture_')) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.[jt]s$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * Every TemplateLiteral reachable from an html`` interpolation without passing
 * through another tag. A nested html`` (or raw(), or a call) is somebody else's
 * problem — those already have rules — so recursion stops at any tagged
 * template or call expression.
 */
function untaggedLiteralsIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) untaggedLiteralsIn(n, out);
    return out;
  }
  if (!node.type) return out;
  if (node.type === 'TaggedTemplateExpression' || node.type === 'CallExpression') return out;
  if (node.type === 'TemplateLiteral') out.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    untaggedLiteralsIn(node[key], out);
  }
  return out;
}

/** oxc gives byte offsets only; the report wants a line. */
function lineOf(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!node.type) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    walk(node[key], visit);
  }
}

test('no untagged markup literal is interpolated into html``', () => {
  const offences = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('html`')) continue;
    const { program: ast, errors } = parseSync(file, source, { sourceType: 'module' });
    // A parse error yields a partial AST, and a partial AST hides offences.
    assert.deepEqual(errors.map((e) => e.message), [], `${file} does not parse`);
    walk(ast, (node) => {
      if (node.type !== 'TaggedTemplateExpression') return;
      if (node.tag.type !== 'Identifier' || node.tag.name !== 'html') return;
      for (const expr of node.quasi.expressions) {
        for (const lit of untaggedLiteralsIn(expr)) {
          const text = lit.quasis.map((q) => q.value.cooked ?? '').join('');
          if (!MARKUP.test(text)) continue;
          offences.push(
            `${file.slice(SRC.length + 1)}:${lineOf(source, lit.start)}  ${text.trim().slice(0, 70)}`,
          );
        }
      }
    });
  }
  assert.deepEqual(
    offences,
    [],
    'markup in a plain template literal is escaped by the html`` tag and renders as text.\n' +
      'Tag it: `${cond ? html`<b>…</b>` : ""}`.\n' +
      offences.join('\n'),
  );
});
