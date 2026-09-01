// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';

/**
 * The tab title is set per page but reset centrally.
 *
 * The regression that motivated this: opening a post set the title to the post,
 * and every navigation afterwards — home, admin, back/forward — kept it, because
 * nothing ever put it back. The reset lives in Router._render, so these tests
 * drive the real router over a stand-in route table rather than the real pages.
 */
describe('document title', () => {
  let dom;
  let setPageTitle;
  let siteTitle;
  let router;
  let setSettings;
  let mounted;

  /** A page class that records its mount and optionally names itself. */
  const page = (title) => ({
    default: class {
      constructor(el, props) { this.el = el; this.props = props; }
      mount() { mounted.push(title || '(untitled)'); if (title) setPageTitle(title); }
      unmount() {}
    },
  });

  const routes = () => [
    { path: '/', load: async () => page(null), public: true },
    { path: '/posts/:slug', load: async () => page('Hello world'), public: true },
    { path: '/tags', load: async () => page('Tags'), public: true },
    {
      path: '/light/posts',
      load: async () => page(null),
      title: 'Posts · Light',
    },
  ];

  before(async () => {
    // /light routes ask the server whether setup is complete before rendering.
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ setup_complete: true }),
    });
    ({ setPageTitle, siteTitle } = await import('../src/utils/documentTitle.js'));
    ({ router } = await import('../src/router.js'));
    ({ setSettings } = await import('../src/store.js'));
  });

  beforeEach(() => {
    dom = setupDOM('<!doctype html><html><head><title>Loading…</title></head><body><div id="app"></div></body></html>');
    mounted = [];
    setSettings({ blog_title: 'My Blog' });
    router._routes = routes();
    router._mountPoint = document.getElementById('app');
    router._authGuard = () => true;
    router._currentPage = null;
    router._currentRoute = null;
  });

  afterEach(() => { dom.cleanup(); });

  // ── The helper ────────────────────────────────────────────────────────────

  test('a page name is suffixed with the site name', () => {
    setPageTitle('Hello world');
    assert.strictEqual(document.title, 'Hello world — My Blog');
  });

  test('no name means the site name alone, and the site never doubles', () => {
    setPageTitle();
    assert.strictEqual(document.title, 'My Blog');
    setPageTitle('   ');
    assert.strictEqual(document.title, 'My Blog');
    setPageTitle('My Blog');
    assert.strictEqual(document.title, 'My Blog', 'no "My Blog — My Blog"');
  });

  test('an unconfigured blog still gets a title, not "undefined"', () => {
    setSettings({});
    assert.strictEqual(siteTitle(), 'Point');
    setPageTitle('Posts · Light');
    assert.strictEqual(document.title, 'Posts · Light — Point');
    setSettings({ blog_title: 'My Blog' });
  });

  // ── The router funnel ─────────────────────────────────────────────────────

  test('navigating away from a titled page restores the blog title', async () => {
    await router._render('/posts/hello-world');
    assert.strictEqual(document.title, 'Hello world — My Blog');

    await router._render('/');
    assert.strictEqual(document.title, 'My Blog', 'the post title outlived the post');
  });

  test('an admin route shows its own name, not the last public page', async () => {
    await router._render('/posts/hello-world');
    await router._render('/light/posts');
    assert.strictEqual(document.title, 'Posts · Light — My Blog');
    assert.deepStrictEqual(mounted, ['Hello world', '(untitled)']);
  });

  test('back/forward is the same funnel, so it is fixed too', async () => {
    await router._render('/tags');
    assert.strictEqual(document.title, 'Tags — My Blog');

    // popstate → _render, exactly as a Back button click would.
    location.pathname = '/';
    await router._onPopState();
    assert.strictEqual(document.title, 'My Blog');
  });

  test('the route title is applied before the page mounts, so a page can override it', async () => {
    // /tags is titled by the page (a plugin viz names itself), and the reset
    // must not land after the page has spoken.
    await router._render('/light/posts');
    await router._render('/tags');
    assert.strictEqual(document.title, 'Tags — My Blog');
  });

  test('a 404 is named too', async () => {
    await router._render('/posts/hello-world');
    await router._render('/nothing-here');
    assert.strictEqual(document.title, 'Page not found — My Blog');
  });
});
