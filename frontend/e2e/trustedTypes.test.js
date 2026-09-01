/**
 * Trusted Types: every HTML write Point makes goes through the `point` policy.
 *
 * The lint rule proves no source file contains a bare `.innerHTML =`. This
 * proves the same thing about what actually runs — which is a different claim,
 * because a sink can be reached through a computed property, a helper the rule
 * does not model, or a bundled dependency. The browser reports every write that
 * skipped the policy, so the assertion is simply: none of them came from
 * /assets/js/.
 *
 * The vendored libraries under /assets/vendor/ do violate, and are expected to
 * — see trustedTypesCSP in api/cmd/api/server.go for why the policy ships
 * report-only until that is dealt with. They are asserted on separately so this
 * test records the state of the vendor problem rather than ignoring it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');
const POLICY = "require-trusted-types-for 'script'; trusted-types point";

/** Every violation the page saw, tagged with the file that caused it. */
const COLLECT = () => {
  window.__ttViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    if (!/trusted-types/.test(e.effectiveDirective || e.violatedDirective || '')) return;
    window.__ttViolations.push({ source: e.sourceFile || '', sample: (e.sample || '').slice(0, 80) });
  });
};

describe('Trusted Types', () => {
  let browser;
  let context;
  let page;
  let cookie = '';

  before(async () => {
    // The smoke test may have run setup already — either outcome is fine, all
    // this needs is a session and something published to look at.
    await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: PW, blog_title: 'TT Blog', author_name: 'TT User', email: 'tt@example.com',
      }),
    }).catch(() => {});

    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'the_owner', name: PW }),
    });
    if (!res.ok) throw new Error('Login failed: ' + res.status);
    const match = (res.headers.get('set-cookie') || '').match(/session=([^;]+)/);
    if (match) cookie = match[1];

    // A fenced code block, so the post page runs the syntax highlighter — one
    // of the two vendored writers this test is here to keep an eye on.
    const post = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'session=' + cookie },
      body: JSON.stringify({
        title: 'Trusted Types probe',
        slug: 'trusted-types-probe',
        content: 'Body text.\n\n```go\nfunc main() {}\n```\n',
        excerpt: 'Card text.',
        status: 'published',
      }),
    });
    // 409: this file already ran against this server. The post is there, which
    // is all the assertions below need.
    if (!post.ok && post.status !== 409) throw new Error('Post creation failed: ' + await post.text());

    browser = await chromium.launch();
    context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: cookie, url: BASE }]);
    await context.addInitScript(COLLECT);
    page = await context.newPage();
  });

  after(async () => {
    await browser?.close();
  });

  /** Load `path`, let it settle, and return what the browser reported. */
  const violationsAt = async (path) => {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    return page.evaluate(() => window.__ttViolations || []);
  };

  it('the report-only policy is served', async () => {
    const res = await fetch(BASE + '/');
    assert.equal(res.headers.get('content-security-policy-report-only'), POLICY);
    // It must not be enforced yet, and must not have leaked into the enforcing
    // policy — the vendored libraries below are why.
    assert.doesNotMatch(res.headers.get('content-security-policy') || '', /trusted-types/);
  });

  it('the comments proxy does not pass the policy to the widget', async () => {
    // Third-party code served through this origin: it sets script.src from a
    // plain string, so the directive has to come off with the rest of Point's
    // CSP or the widget breaks the day this is enforced.
    const res = await fetch(BASE + '/comments/web/embed.mjs');
    assert.equal(res.headers.get('content-security-policy-report-only'), null);
  });

  for (const path of ['/', '/posts/trusted-types-probe', '/search', '/light', '/light/posts', '/light/media', '/light/settings']) {
    it(`no violation from Point's own bundles on ${path}`, async () => {
      const own = (await violationsAt(path)).filter((v) => v.source.includes('/assets/js/'));
      assert.deepEqual(own, [], `a write skipped the policy on ${path}: ${JSON.stringify(own)}`);
    });
  }

  it('the syntax highlighter is the only writer left on a post page', async () => {
    const viol = await violationsAt('/posts/trusted-types-probe');
    // Prism's highlightElement assigns the highlighted markup itself, so a post
    // with a code block cannot be made clean without changing the vendored
    // file. Asserted rather than ignored: the day this stops firing, the
    // enforcement blocker is one library smaller.
    assert.ok(
      viol.every((v) => v.source.includes('/assets/vendor/prismjs/')),
      `unexpected writer on a post page: ${JSON.stringify(viol)}`,
    );
  });
});
