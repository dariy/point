/**
 * Trusted Types: enforced, and everything still works.
 *
 * The lint rule proves no source file contains a bare `.innerHTML =`, and
 * scripts/check-vendor-sinks.sh proves the vendored files still route theirs
 * through a policy. This proves the claim those two only imply — that a real
 * Chromium, holding the real header, refuses nothing the pages need.
 *
 * Two halves, and the second is the one that matters. Zero violations is easy
 * to get by breaking the feature: a map that never initialises writes no HTML.
 * So every page that has a vendored writer on it is also asserted to have
 * *produced* something — highlighted tokens, zoom buttons, an attribution line,
 * a marker, a popup, an undo step that did not corrupt the buffer.
 *
 * The three policies (see trustedTypesCSP in api/cmd/api/server.go):
 *   point          utils/helpers.js — every write this frontend makes
 *   point-leaflet  frontend/vendor/leaflet/leaflet.js, patched
 *   point-codejar  frontend/vendor/codejar/codejar.js, patched
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');
const POLICY = "require-trusted-types-for 'script'; trusted-types point point-leaflet point-codejar";

/** Every violation the page saw, plus every error a refused write threw. */
const COLLECT = () => {
  window.__ttViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    if (!/trusted-types/.test(e.effectiveDirective || e.violatedDirective || '')) return;
    window.__ttViolations.push({
      disposition: e.disposition,
      source: (e.sourceFile || '') + ':' + e.lineNumber,
      sample: (e.sample || '').slice(0, 80),
    });
  });
};

describe('Trusted Types', () => {
  let browser;
  let context;
  let page;
  let cookie = '';
  const pageErrors = [];

  const api = (path, body, method = 'POST') =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    // The smoke test may have run setup already — either outcome is fine, all
    // this needs is a session and something published to look at.
    await api('/api/setup', {
      name: PW, blog_title: 'TT Blog', author_name: 'TT User', email: 'tt@example.com',
    }).catch(() => {});

    const res = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!res.ok) throw new Error('Login failed: ' + res.status);
    const match = (res.headers.get('set-cookie') || '').match(/session=([^;]+)/);
    if (match) cookie = match[1];

    // Two fenced code blocks, so the post page runs the syntax highlighter.
    const post = await api('/api/posts', {
      title: 'Trusted Types probe',
      slug: 'trusted-types-probe',
      content: 'Body text.\n\n```go\nfunc main() { println("hi") }\n```\n\n```css\n.a { color: red; }\n```\n',
      excerpt: 'Card text.',
      status: 'published',
    });
    // 409: this file already ran against this server. The post is there, which
    // is all the assertions below need.
    if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + await post.text());

    // A geo-tagged tag, so the map has a divIcon marker to open a popup on.
    await api('/api/tags', { name: 'Paris', slug: 'tt-paris', kind: 'location', latitude: 48.8566, longitude: 2.3522 });
    // The CSS editor is behind this plugin, and it is off by default.
    await api('/api/plugins/custom-css', { enabled: true }, 'PATCH');

    browser = await chromium.launch();
    context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: cookie, url: BASE }]);
    await context.addInitScript(COLLECT);
    page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
  });

  after(async () => {
    await browser?.close();
  });

  /** Load `path`, let it settle, and return what the browser reported. */
  const violationsAt = async (path, settle = 600) => {
    pageErrors.length = 0;
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(settle);
    return page.evaluate(() => window.__ttViolations || []);
  };

  const assertClean = (viol, path) => {
    assert.deepEqual(viol, [], `a write skipped the policy on ${path}: ${JSON.stringify(viol)}`);
    const refused = pageErrors.filter((e) => /TrustedHTML|TrustedScript/.test(e));
    assert.deepEqual(refused, [], `a sink threw on ${path}: ${JSON.stringify(refused)}`);
  };

  it('the directives are enforced, not reported', async () => {
    const res = await fetch(BASE + '/');
    // The tail of the enforcing policy, appended after frame-ancestors.
    assert.ok(
      (res.headers.get('content-security-policy') || '').endsWith('; ' + POLICY),
      `enforcing policy does not end with the directives: ${res.headers.get('content-security-policy')}`,
    );
    // And no second, report-only copy: a browser given both reports everything
    // twice, and a reader cannot tell which policy is the live one.
    assert.equal(res.headers.get('content-security-policy-report-only'), null);
  });

  it('the comments proxy does not pass the policy to the widget', async () => {
    // Third-party code served through this origin: it sets script.src from a
    // plain string, so the directives have to come off with the rest of
    // Point's CSP or the widget dies.
    const res = await fetch(BASE + '/comments/web/embed.mjs');
    assert.doesNotMatch(res.headers.get('content-security-policy') || '', /trusted-types/);
    assert.equal(res.headers.get('content-security-policy-report-only'), null);
  });

  for (const path of ['/', '/posts/trusted-types-probe', '/search', '/light', '/light/posts', '/light/media', '/light/settings', '/light/themes']) {
    it(`no violation on ${path}`, async () => {
      assertClean(await violationsAt(path), path);
    });
  }

  it('the allowlist is closed and each name mints once', async () => {
    // The claim the three-name allowlist makes, tested rather than asserted in
    // a comment: a fourth name cannot be registered, and none of the three can
    // be registered a second time (the directive carries no 'allow-duplicates',
    // so the policies created at load are the only ones this document will
    // ever have). Chromium dropped getPolicyNames(), so this is measured by
    // trying — which is the better test anyway.
    await violationsAt('/posts/trusted-types-probe');
    const result = await page.evaluate(() => {
      const attempt = (name) => {
        try {
          window.trustedTypes.createPolicy(name, { createHTML: (s) => s });
          return 'created';
        } catch (e) {
          return e.name;
        }
      };
      return { rogue: attempt('point-rogue'), duplicate: attempt('point') };
    });
    assert.notEqual(result.rogue, 'created', 'a policy outside the allowlist was accepted');
    assert.notEqual(result.duplicate, 'created', "'point' was minted twice — the allowlist is not a bound");
  });

  // ── The vendored writers, each asserted to have written something ──────────

  it('a post with code blocks is actually highlighted', async () => {
    const path = '/posts/trusted-types-probe';
    const viol = await violationsAt(path, 1500);
    const blocks = await page.evaluate(() =>
      [...document.querySelectorAll('pre code')].map((c) => ({
        tokens: c.querySelectorAll('.token').length,
        pre: c.parentElement.className,
        text: c.textContent.trim(),
      })));
    // Prism was dealt with by calling the string-returning highlight() and
    // writing the result with setHTML(), so there is no "prism-only" violation
    // left to tolerate — the highlighting simply has to be there.
    assert.equal(blocks.length, 2, `expected two code blocks, got ${JSON.stringify(blocks)}`);
    for (const b of blocks) {
      assert.ok(b.tokens > 0, `code block was not highlighted: ${JSON.stringify(b)}`);
      assert.match(b.pre, /language-/, `<pre> lost its language class: ${JSON.stringify(b)}`);
    }
    assert.match(blocks[0].text, /func main/, 'the source text did not survive highlighting');
    assertClean(viol, path);
  });

  it('the atlas map renders under enforcement', async () => {
    // tags-atlas owns /tags by default. Leaflet's first innerHTML happens
    // during feature detection at import time, so a refused write here takes
    // the whole library down rather than one control.
    await api('/api/plugins/tags-atlas', { enabled: true }, 'PATCH');
    const viol = await violationsAt('/tags', 2500);
    const map = await page.evaluate(() => ({
      container: !!document.querySelector('.leaflet-container'),
      zoomIn: (document.querySelector('.leaflet-control-zoom-in')?.textContent || '').trim(),
      zoomOut: (document.querySelector('.leaflet-control-zoom-out')?.textContent || '').trim(),
      attribution: (document.querySelector('.leaflet-control-attribution')?.textContent || '').trim(),
    }));
    assert.ok(map.container, 'no leaflet container — the library failed to initialise');
    assert.ok(map.zoomIn.length > 0, `zoom-in button has no label: ${JSON.stringify(map)}`);
    assert.ok(map.zoomOut.length > 0, `zoom-out button has no label: ${JSON.stringify(map)}`);
    assert.ok(map.attribution.length > 0, `no attribution line: ${JSON.stringify(map)}`);
    assertClean(viol, '/tags (atlas)');
  });

  it('the tags map renders markers and popups under enforcement', async () => {
    // tags-map shares the /tags slot with the atlas and adds the two sinks the
    // atlas does not reach: a divIcon's markup and a popup's content.
    await api('/api/plugins/tags-map', { enabled: true }, 'PATCH');
    const viol = await violationsAt('/tags', 2500);
    const markers = await page.evaluate(() => ({
      count: document.querySelectorAll('.leaflet-marker-icon').length,
      html: (document.querySelector('.leaflet-marker-icon')?.innerHTML || '').length,
    }));
    assert.ok(markers.count > 0, 'no marker rendered');
    assert.ok(markers.html > 0, 'the divIcon markup was refused — marker is empty');

    await page.click('.leaflet-marker-icon');
    await page.waitForTimeout(600);
    const popup = await page.evaluate(() => ({
      open: !!document.querySelector('.leaflet-popup'),
      content: (document.querySelector('.leaflet-popup-content')?.textContent || '').trim(),
      close: (document.querySelector('.leaflet-popup-close-button')?.textContent || '').trim(),
    }));
    assert.ok(popup.open, 'popup did not open');
    assert.ok(popup.content.length > 0, 'popup content was refused');
    assert.ok(popup.close.length > 0, 'popup close button lost its glyph');
    // __ttViolations is cumulative for this page load, so it already covers
    // what `viol` saw before the click.
    void viol;
    assertClean(await page.evaluate(() => window.__ttViolations || []), '/tags (map)');
  });

  it('the code editor survives an undo under enforcement', async () => {
    // CodeJar restores an undo step by assigning the snapshot back, and its
    // auto-close inserts the closing brace through execCommand('insertHTML').
    // Refuse either and the buffer is silently wrong rather than visibly
    // broken — the reason this is asserted on content, not on the absence of
    // an error.
    const path = '/light/themes';
    const viol = await violationsAt(path, 1500);
    const sel = '.codejar-editor.language-css';
    await page.click(sel);
    await page.keyboard.type('.probe { color: red;');
    await page.waitForTimeout(400);
    const typed = await page.evaluate((s) => document.querySelector(s).textContent, sel);
    assert.match(typed, /\.probe \{ color: red;/, `typing did not land: ${JSON.stringify(typed)}`);
    // The bead's reproduction: the `{` went missing on undo, because the
    // snapshot restore was refused and the DOM kept a half-applied edit.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    const undone = await page.evaluate((s) => document.querySelector(s).textContent, sel);
    assert.ok(
      undone === '' || typed.startsWith(undone),
      `undo left something that was never typed: ${JSON.stringify(undone)} (typed ${JSON.stringify(typed)})`,
    );
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(400);
    const redone = await page.evaluate((s) => document.querySelector(s).textContent, sel);
    assert.ok(redone.length >= undone.length, `redo lost content: ${JSON.stringify(redone)}`);
    assert.ok(
      await page.evaluate((s) => document.querySelector(s).querySelectorAll('.token').length > 0, sel),
      'the editor is not syntax-highlighted, so setHTML() never landed',
    );
    void viol;
    assertClean(await page.evaluate(() => window.__ttViolations || []), path);
  });
});
