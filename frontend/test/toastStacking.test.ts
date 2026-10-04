import { test, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const CSS_ROOT = join(import.meta.dirname, '..', 'css');

/**
 * A toast reports the result of an action, and the action is usually started
 * from an overlay — a modal dialog, the plugin settings drawer, a maximized
 * editor. When any of those outranks `#toasts`, the confirmation renders behind
 * the thing that asked for it, which is invisible in unit tests and obvious in
 * the browser. This is the guard: `#toasts` stays the highest z-index in the
 * hand-written CSS, and the built bundles carry the same number.
 */

const SOURCE_DIRS = ['common', 'light', 'public', 'p'];

// Comments are stripped first, so prose mentioning a z-index — the ladder is
// documented in more than one file — is never read as a declaration.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssSources() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const base = join(CSS_ROOT, dir);
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.css')) files.push(p);
      }
    };
    walk(base);
  }
  return files;
}

/** @returns {{file: string, value: number}[]} every z-index declaration. */
function zIndexDeclarations(file) {
  const css = stripComments(readFileSync(file, 'utf8'));
  const out = [];
  for (const m of css.matchAll(/z-index:\s*(-?\d+)/g)) {
    out.push({ file, value: Number(m[1]) });
  }
  return out;
}

function toastZIndex(css) {
  const block = stripComments(css).match(/#toasts\s*{([^}]*)}/);
  assert.ok(block, 'no #toasts rule found');
  const z = block[1].match(/z-index:\s*(-?\d+)/);
  assert.ok(z, '#toasts rule declares no z-index');
  return Number(z[1]);
}

describe('toast stacking order', () => {
  const toastsFile = join(CSS_ROOT, 'common', 'toasts.css');
  const toastsZ = toastZIndex(readFileSync(toastsFile, 'utf8'));

  test('#toasts outranks every other z-index in the CSS sources', () => {
    const others = cssSources()
      .filter((f) => f !== toastsFile)
      .flatMap(zIndexDeclarations)
      .filter((d) => d.value >= toastsZ);

    assert.deepEqual(
      others,
      [],
      `these rules sit at or above #toasts (${toastsZ}), so a toast can render ` +
        `behind them: ${others.map((d) => `${relative(CSS_ROOT, d.file)}=${d.value}`).join(', ')}`,
    );
  });

  // The bundles are generated and gitignored, so a fresh clone has none until
  // scripts/build-css.sh runs. Skip rather than fail there: the assertion is a
  // drift guard for a built tree, not a reason a bare `node --test` goes red.
  test('the built bundles carry the same z-index as the source', (t) => {
    const built = ['light.css', 'main.css'].filter((b) => existsSync(join(CSS_ROOT, b)));
    if (built.length === 0) {
      t.skip('CSS bundles not built — run scripts/build-css.sh');
      return;
    }
    for (const bundle of built) {
      const css = readFileSync(join(CSS_ROOT, bundle), 'utf8');
      assert.equal(
        toastZIndex(css),
        toastsZ,
        `${bundle} is stale — run scripts/build-css.sh`,
      );
    }
  });
});
