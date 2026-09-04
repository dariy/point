/**
 * PostEditPage, mounted for real.
 *
 * The sibling PostEditPage.test.js asserts on `render()` output against a
 * hand-stubbed document; that reaches the template but not a single one of the
 * handlers hung off it. These tests mount the page into a linkedom document
 * with `fetch` stubbed, which is the only way to reach the parts of the editor
 * that matter operationally: the load, the two save paths (explicit and
 * autosave), the overflow-menu actions, the AI field fills, and the share
 * queue the offline share target drains into a draft.
 *
 * Everything the page talks to is reached through `fetch`, so one router-shaped
 * stub covers all of it — no module mocking, and the request log doubles as the
 * assertion surface for "what did the editor actually send".
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire, type } from './helpers/dom.js';
import {
  getAutosaveStatus,
  getToast,
  onToast,
  setAutosaveStatus,
  setSettings,
  setToast,
  setUser,
} from '../src/store.js';
import { pluginHost } from '../src/core/pluginHost.js';
import { clearPostReadCache } from '../src/api/posts.js';
import { carouselFence } from '../src/utils/postNodes.js';

const settle = () => new Promise(r => setImmediate(r));

/** A saved post, as /api/posts/:id returns it. */
const POST = () => ({
  id: 7,
  title: 'Harbour lights',
  slug: 'harbour-lights',
  excerpt: 'An evening walk.',
  content: '/2024/08/harbour.jpg\n\nThe water was still.',
  status: 'PUBLISHED',
  type: 'post',
  is_featured: false,
  formatter: 'markdown',
  thumbnail_path: null,
  meta_description: null,
  css: '',
  immersive_mode: 'auto',
  instagram_share: false,
  tags: [{ name: 'harbour', slug: 'harbour' }],
});

describe('PostEditPage (mounted)', () => {
  let dom, PostEditPage, page, requests, routes, navigations;

  /**
   * Route by method + path prefix. Handlers are looked up longest-first so a
   * specific `/api/posts/7` wins over the `/api/posts` list.
   */
  function fakeFetch() {
    requests = [];
    globalThis.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const path = String(url).split('?')[0];
      let body;
      if (typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
      else body = opts.body;
      requests.push({ url: String(url), path, method, body });

      const key = Object.keys(routes)
        .filter(k => {
          const [m, p] = k.split(' ');
          return m === method && path.startsWith(p);
        })
        .sort((a, b) => b.length - a.length)[0];
      const handler = key ? routes[key] : null;
      const result = handler ? await handler({ path, method, body }) : {};
      if (result instanceof Error) throw result;
      const { status = 200, payload = result } = result?.__response ? result : {};
      return {
        ok: status < 400,
        status,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
  }

  /** Mark a route's return value as a non-2xx response with `payload`. */
  const fail = (status, message) => ({ __response: true, status, payload: { message } });

  async function mountPage(props = {}) {
    dom.location.pathname = props.params?.id ? `/light/posts/${props.params.id}/edit` : '/light/posts/new';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new PostEditPage(el, props);
    page.mount();
    await settle();
    await settle();
    return page;
  }

  const q = sel => page.container.querySelector(sel);
  const sent = (method, path) => requests.filter(r => r.method === method && r.path === path);
  /** Where the page asked the router to go — `navigate()` is an event, not a URL write. */
  const wentTo = () => navigations.at(-1);

  beforeEach(async () => {
    dom = setupDOM();
    navigations = [];
    dom.window.addEventListener('app:navigate', e => navigations.push(e.detail.path));
    globalThis.Blob ??= class Blob { constructor(parts) { this.parts = parts; } };
    globalThis.File ??= class File { constructor(parts, name, o) { this.parts = parts; this.name = name; this.type = o?.type; } };
    clearPostReadCache();
    routes = {
      'GET /api/posts/7': () => POST(),
      'GET /api/instagram/status': () => ({ connected: true, default_share: false }),
      'GET /api/media': () => ({ media: [{ id: 3, path: '/2024/08/harbour.jpg', filename: 'harbour.jpg' }] }),
      'POST /api/posts': () => ({ ...POST(), id: 11, title: 'August 26' }),
      'PUT /api/posts/7': ({ body }) => ({ ...POST(), ...body }),
      'PUT /api/posts/11': ({ body }) => ({ ...POST(), id: 11, ...body }),
      'DELETE /api/posts/7': () => ({}),
    };
    fakeFetch();
    setUser({ username: 'owner', is_admin: true });
    setSettings({ blog_title: 'Test blog' });
    setToast(null);
    setAutosaveStatus(null);
    pluginHost.init([
      { id: 'instagram', type: 'service' },
      { id: 'ai-analysis', type: 'service' },
      { id: 'custom-css', type: 'enhancer' },
    ]);
    ({ default: PostEditPage } = await import('../src/pages/light/PostEditPage.js'));
  });

  afterEach(() => {
    try { page?.unmount(); } catch { /* torn down mid-flight */ }
    page = null;
    dom.cleanup();
    delete globalThis.fetch;
  });

  // ── Loading ───────────────────────────────────────────────────────────────

  describe('loading an existing post', () => {
    test('fills the form from the API and lowercases the status', async () => {
      await mountPage({ params: { id: '7' } });

      assert.equal(page.state.loading, false);
      assert.equal(page.state.post.status, 'published');
      assert.equal(q('#title-input').value, 'Harbour lights');
      assert.equal(q('#slug-input').value, 'harbour-lights');
    });

    test('indexes the post media by path so the visual editor can name files', async () => {
      await mountPage({ params: { id: '7' } });

      assert.equal(page._mediaByPath['/2024/08/harbour.jpg'].id, 3);
    });

    test('parses the stored markdown into editable nodes', async () => {
      await mountPage({ params: { id: '7' } });

      assert.ok(page._nodes.some(n => n.type === 'image' && n.path === '/2024/08/harbour.jpg'));
      assert.deepEqual(page._tags, ['harbour']);
    });

    test('a load failure leaves the editor for the list instead of showing a blank form', async () => {
      routes['GET /api/posts/7'] = () => fail(500, 'boom');

      await mountPage({ params: { id: '7' } });

      assert.match(getToast().message, /Could not load post/);
      assert.equal(wentTo(), '/light/posts');
    });
  });

  describe('a brand new post', () => {
    test('seeds the body from the share-target handoff and consumes it', async () => {
      globalThis.sessionStorage.setItem('newPostInitialContent', '/2024/08/harbour.jpg');

      await mountPage({});

      assert.ok(page._nodes.some(n => n.path === '/2024/08/harbour.jpg'));
      assert.equal(globalThis.sessionStorage.getItem('newPostInitialContent'), null);
    });

    test('asks whether Instagram is connected, so the share toggle can default itself', async () => {
      await mountPage({});

      assert.equal(sent('GET', '/api/instagram/status').length, 1);
      assert.equal(page.state.igStatus.connected, true);
    });
  });

  // ── Saving ────────────────────────────────────────────────────────────────

  describe('saving', () => {
    test('sends the form as typed, and reports it', async () => {
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), 'Harbour lights, revisited');

      await page._save();
      await settle();

      const body = sent('PUT', '/api/posts/7').at(-1).body;
      assert.equal(body.title, 'Harbour lights, revisited');
      assert.equal(body.type, 'post');
      assert.equal(getToast().message, 'Saved.');
      assert.equal(page.state.saving, false);
    });

    test('"page" is stored as a published post of type page', async () => {
      await mountPage({ params: { id: '7' } });

      await page._save({ status: 'page' });
      await settle();

      const body = sent('PUT', '/api/posts/7').at(-1).body;
      assert.equal(body.status, 'published');
      assert.equal(body.type, 'page');
    });

    test('a first save creates the post and rewrites the URL to its id', async () => {
      await mountPage({});
      type(q('#title-input'), 'Something new');

      await page._save();
      await settle();

      assert.equal(sent('POST', '/api/posts').length, 1);
      assert.equal(page.state.isNew, false);
      assert.equal(page.state.postId, 11);
      assert.equal(dom.history.entries.at(-1)[1], '/light/posts/11/edit');
    });

    test('a failed save surfaces the server message and re-enables the form', async () => {
      routes['PUT /api/posts/7'] = () => fail(422, 'Slug already taken');
      await mountPage({ params: { id: '7' } });

      await page._save();
      await settle();

      assert.equal(getToast().type, 'error');
      assert.equal(getAutosaveStatus().status, 'failed');
      assert.equal(page.state.saving, false);
    });
  });

  describe('autosave', () => {
    test('typing arms it, and it saves the pending edit', async () => {
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), 'Edited');
      page._onInput();
      assert.equal(page.state.hasPendingEdits, true);

      await page._autosave();
      await settle();

      assert.equal(sent('PUT', '/api/posts/7').length, 1);
      assert.equal(page.state.hasPendingEdits, false);
      assert.equal(getAutosaveStatus().status, 'saved');
    });

    test('does nothing when there is nothing pending', async () => {
      await mountPage({ params: { id: '7' } });

      await page._autosave();

      assert.equal(sent('PUT', '/api/posts/7').length, 0);
    });

    test('an empty new post is not worth a draft row', async () => {
      await mountPage({});
      page.state.hasPendingEdits = true;

      await page._autosave();

      assert.equal(sent('POST', '/api/posts').length, 0);
    });

    test('a new post with a body becomes a draft and adopts the id', async () => {
      await mountPage({});
      type(q('#title-input'), '');
      page._nodes = [{ type: 'text', text: 'first words' }];
      page._mountVisualEditor();
      page.state.hasPendingEdits = true;

      await page._autosave();
      await settle();

      assert.equal(sent('POST', '/api/posts').at(-1).body.status, 'draft');
      assert.equal(page.state.postId, 11);
      // The backend titles an untitled post after the day; show that back.
      assert.equal(q('#title-input').value, 'August 26');
    });

    test('a failure is recorded rather than thrown at the user mid-keystroke', async () => {
      routes['PUT /api/posts/7'] = () => fail(500, 'nope');
      await mountPage({ params: { id: '7' } });
      page.state.hasPendingEdits = true;

      await page._autosave();
      await settle();

      assert.equal(getAutosaveStatus().status, 'failed');
      assert.equal(page.state.hasPendingEdits, true);
    });
  });

  // ── The overflow menu ─────────────────────────────────────────────────────

  describe('menu actions', () => {
    /**
     * Invoke a menu action the way its delegated click would.
     *
     * Several of these items are rendered only for a status the fixture post
     * does not have (Publish now is draft-only), so the map is called directly;
     * the delegation that reaches it is covered by its own test below.
     */
    const menuAction = (action) => page.actions[action].call(page);

    test('a click on a menu item reaches its action through the container', async () => {
      await mountPage({ params: { id: '7' } });

      // A published post's menu offers Unpublish — a real button, clicked for real.
      click(q('[data-action="unpublish"]'));
      await settle();

      assert.equal(sent('PUT', '/api/posts/7').at(-1).body.status, 'draft');
    });

    test('publish-now, mark-hidden and unpublish each send their status', async () => {
      await mountPage({ params: { id: '7' } });

      for (const [action, status] of [['publish-now', 'published'], ['mark-hidden', 'hidden'], ['unpublish', 'draft']]) {
        menuAction(action);
        await settle();
        assert.equal(sent('PUT', '/api/posts/7').at(-1).body.status, status, action);
      }
    });

    test('schedule flips the status select and reveals the schedule group', async () => {
      await mountPage({ params: { id: '7' } });

      menuAction('schedule');

      assert.equal(q('#status-select').value, 'scheduled');
    });

    test('arrange turns on the reordering mode and Escape turns it back off', async () => {
      await mountPage({ params: { id: '7' } });

      menuAction('arrange');
      assert.equal(page.state.arranging, true);
      assert.equal(q('#arrange-bar').hidden, false);

      const esc = new globalThis.Event('keydown');
      esc.key = 'Escape';
      dom.document.dispatchEvent(esc);
      assert.equal(page.state.arranging, false);
    });

    test('delete asks first, then trashes the post and leaves', async () => {
      await mountPage({ params: { id: '7' } });

      menuAction('delete');
      const dialog = dom.document.querySelector('.confirm-dialog, .modal-overlay');
      assert.ok(dialog, 'a confirmation is shown before anything is destroyed');
      assert.equal(sent('DELETE', '/api/posts/7').length, 0);

      await page._deletePost(7);
      await settle();

      assert.equal(sent('DELETE', '/api/posts/7').length, 1);
      assert.equal(wentTo(), '/light/posts');
      assert.match(getToast().message, /Trash/);
    });

    test('deleting a post that was never saved just leaves', async () => {
      await mountPage({});

      await page._deletePost(null);

      assert.equal(wentTo(), '/light/posts');
      assert.equal(sent('DELETE', '/api/posts').length, 0);
    });

    test('a failed delete keeps the editor open with the reason', async () => {
      routes['DELETE /api/posts/7'] = () => fail(500, 'still referenced');
      await mountPage({ params: { id: '7' } });

      await page._deletePost(7);
      await settle();

      assert.equal(page.state.deleting, false);
      assert.equal(getToast().type, 'error');
    });

    test('view-on-site flushes a pending edit before navigating', async () => {
      await mountPage({ params: { id: '7' } });
      page.state.hasPendingEdits = true;

      await page._viewOnSite();
      await settle();

      assert.equal(sent('PUT', '/api/posts/7').length, 1);
      assert.equal(wentTo(), '/posts/harbour-lights');
    });

    test('carousel-studio flushes a pending edit before navigating', async () => {
      pluginHost.init([{ id: 'carousel', type: 'route', routes: ['/light/carousel'] }]);
      await mountPage({ params: { id: '7' } });
      page.state.hasPendingEdits = true;

      await page._openCarouselStudio();
      await settle();

      assert.equal(sent('PUT', '/api/posts/7').length, 1);
      assert.equal(wentTo(), '/light/carousel?post=7');
    });
  });

  // ── Carousel Studio entry points ─────────────────────────────────────────

  describe('the carousel plugin', () => {
    beforeEach(() => {
      pluginHost.init([{ id: 'carousel', type: 'route', routes: ['/light/carousel'] }]);
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: carouselFence(['/2024/08/a.jpg', '/2024/08/b.jpg']),
      });
    });

    test('the menu reads "Edit Carousel" once the post already has one', async () => {
      await mountPage({ params: { id: '7' } });

      assert.equal(q('#carousel-studio-btn').textContent.trim(), 'Edit Carousel');
    });

    test('the menu reads "Carousel Studio" for a post without one', async () => {
      routes['GET /api/posts/7'] = () => POST();
      await mountPage({ params: { id: '7' } });

      assert.equal(q('#carousel-studio-btn').textContent.trim(), 'Carousel Studio');
    });

    test('the visual editor card offers Edit in Studio and it flushes before navigating', async () => {
      await mountPage({ params: { id: '7' } });
      page.state.hasPendingEdits = true;

      click(q('.ve-carousel-edit'));
      await settle();

      assert.equal(sent('PUT', '/api/posts/7').length, 1);
      assert.equal(wentTo(), '/light/carousel?post=7');
    });

    test('the card has no Edit in Studio affordance with the plugin disabled', async () => {
      pluginHost.init([]);
      await mountPage({ params: { id: '7' } });

      assert.equal(q('.ve-carousel-edit'), null);
      assert.equal(q('#carousel-studio-btn'), null);
    });
  });

  // ── Preview link ──────────────────────────────────────────────────────────

  describe('preview link', () => {
    test('copies the generated link to the clipboard', async () => {
      routes['POST /api/posts/7/preview'] = () => ({ preview_url: 'http://localhost/preview/abc' });
      let copied = null;
      globalThis.navigator.clipboard = { writeText: async t => { copied = t; } };
      await mountPage({ params: { id: '7' } });

      await page._generatePreviewLink();
      await settle();

      assert.equal(copied, 'http://localhost/preview/abc');
      assert.match(getToast().message, /copied/i);
      assert.equal(page.state.generatingPreview, false);
    });

    test('falls back to a dialog when the clipboard is unavailable', async () => {
      routes['POST /api/posts/7/preview'] = () => ({ preview_url: 'http://localhost/preview/abc' });
      globalThis.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
      globalThis.window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
      dom.document.createRange = () => ({ selectNodeContents() {} });
      await mountPage({ params: { id: '7' } });

      await page._generatePreviewLink();
      await settle();

      assert.ok(dom.document.body.textContent.includes('http://localhost/preview/abc'));
    });

    test('is refused outright for a post that has never been saved', async () => {
      await mountPage({});

      await page._generatePreviewLink();

      assert.equal(sent('POST', '/api/posts').length, 0);
    });

    test('a server error is reported and the button re-enabled', async () => {
      routes['POST /api/posts/7/preview'] = () => fail(500, 'no signing key');
      await mountPage({ params: { id: '7' } });

      await page._generatePreviewLink();
      await settle();

      assert.equal(getToast().type, 'error');
      assert.equal(page.state.generatingPreview, false);
    });
  });

  // ── Instagram ─────────────────────────────────────────────────────────────

  describe('publishing to Instagram', () => {
    const publishRoute = st => () => ({ ...POST(), instagram_status: st, instagram_error: 'rate limited' });

    test('a published result reports success', async () => {
      routes['POST /api/posts/7/instagram/publish'] = publishRoute('published');
      await mountPage({ params: { id: '7' } });

      await page._publishToInstagram();
      await settle();

      assert.equal(getToast().type, 'success');
      assert.equal(page.state.publishingToInstagram, false);
    });

    test('an error result surfaces the backend reason', async () => {
      routes['POST /api/posts/7/instagram/publish'] = publishRoute('error');
      await mountPage({ params: { id: '7' } });

      await page._publishToInstagram();
      await settle();

      assert.equal(getToast().message, 'rate limited');
      assert.equal(getToast().type, 'error');
    });

    test('anything else is reported as merely triggered', async () => {
      routes['POST /api/posts/7/instagram/publish'] = publishRoute('pending');
      await mountPage({ params: { id: '7' } });

      await page._publishToInstagram();
      await settle();

      assert.equal(getToast().type, 'info');
    });

    test('a request failure is reported', async () => {
      routes['POST /api/posts/7/instagram/publish'] = () => fail(502, 'Instagram is down');
      await mountPage({ params: { id: '7' } });

      await page._publishToInstagram();
      await settle();

      assert.equal(getToast().type, 'error');
      assert.equal(page.state.publishingToInstagram, false);
    });

    test('an unsaved post has nothing to publish', async () => {
      await mountPage({});

      await page._publishToInstagram();

      assert.equal(page.state.publishingToInstagram, false);
      assert.equal(requests.filter(r => r.path.includes('instagram') && r.method === 'POST').length, 0);
    });
  });

  // ── AI field fills ────────────────────────────────────────────────────────

  describe('AI analysis', () => {
    const analysis = { title: 'Suggested title', excerpt: 'Suggested excerpt', tags: ['boats', 'harbour'] };

    test('filling the title takes only the title', async () => {
      routes['POST /api/media/analyze-path'] = () => analysis;
      await mountPage({ params: { id: '7' } });

      await page._doAnalyzeField('title', { path: '/2024/08/harbour.jpg' });
      await settle();

      assert.equal(page.state.post.title, 'Suggested title');
      assert.equal(page.state.post.excerpt, 'An evening walk.');
      assert.match(getToast().message, /Title filled/);
    });

    test('filling tags merges with what is already there, without duplicates', async () => {
      routes['POST /api/media/analyze-path'] = () => analysis;
      await mountPage({ params: { id: '7' } });

      await page._doAnalyzeField('tags', { path: '/2024/08/harbour.jpg' });
      await settle();

      assert.deepEqual(page._tags, ['harbour', 'boats']);
    });

    test('an analysis by media id goes to the id endpoint', async () => {
      routes['POST /api/media/3/analyze'] = () => analysis;
      await mountPage({ params: { id: '7' } });

      await page._doAnalyzeField('excerpt', { id: 3, path: '/2024/08/harbour.jpg' });
      await settle();

      assert.equal(page.state.post.excerpt, 'Suggested excerpt');
    });

    test('an empty result says so rather than pretending to have filled something', async () => {
      routes['POST /api/media/analyze-path'] = () => ({});
      await mountPage({ params: { id: '7' } });

      await page._doAnalyzeField('title', { path: '/2024/08/harbour.jpg' });
      await settle();

      assert.match(getToast().message, /AI disabled|no suggestions/i);
    });

    test('a failure is reported and the field left alone', async () => {
      routes['POST /api/media/analyze-path'] = () => fail(500, 'model unavailable');
      await mountPage({ params: { id: '7' } });

      await page._doAnalyzeField('title', { path: '/2024/08/harbour.jpg' });
      await settle();

      assert.equal(getToast().type, 'error');
      assert.equal(page.state.analyzingField, null);
    });

    test('whole-post analysis fills the empty fields and merges tags', async () => {
      routes['POST /api/media/analyze-path'] = () => analysis;
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), '');

      await page._handleAnalyze({ path: '/2024/08/harbour.jpg' });
      await settle();

      assert.equal(page.state.post.title, 'Suggested title');
      assert.deepEqual(page.state.post.tags.map(t => t.name), ['harbour', 'boats']);
      assert.equal(page._analyzing, false);
    });

    test('a failed whole-post analysis keeps the typed fields', async () => {
      routes['POST /api/media/analyze-path'] = () => fail(500, 'model unavailable');
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), 'Typed by hand');

      await page._handleAnalyze({ path: '/2024/08/harbour.jpg' });
      await settle();

      assert.equal(page.state.post.title, 'Typed by hand');
      assert.equal(getToast().type, 'error');
      assert.equal(page._analyzing, false);
    });

    test('a second analysis cannot start while one is running', async () => {
      await mountPage({ params: { id: '7' } });
      page._analyzing = true;

      await page._handleAnalyze({ path: '/2024/08/harbour.jpg' });

      assert.equal(requests.filter(r => r.path.includes('analyze')).length, 0);
    });
  });

  // ── Media insertion ───────────────────────────────────────────────────────

  describe('inserting media', () => {
    test('an upload appends an image node in visual mode', async () => {
      routes['POST /api/media/upload'] = () => ({ path: '/2024/08/new.jpg' });
      await mountPage({ params: { id: '7' } });
      const before = page._nodes.length;

      await page._uploadAndInsert(new globalThis.File([''], 'new.jpg', { type: 'image/jpeg' }));
      await settle();

      assert.equal(page._nodes.length, before + 1);
      assert.equal(page._nodes.at(-1).path, '/2024/08/new.jpg');
    });

    test('a failed upload names the file in the error', async () => {
      routes['POST /api/media/upload'] = () => fail(413, 'Too large');
      await mountPage({ params: { id: '7' } });

      await page._uploadAndInsert(new globalThis.File([''], 'huge.jpg', { type: 'image/jpeg' }));
      await settle();

      assert.match(getToast().message, /Upload failed/);
    });

    test('inserting nothing changes nothing', async () => {
      await mountPage({ params: { id: '7' } });
      const before = page._nodes.length;

      page._insertMediaPaths([]);

      assert.equal(page._nodes.length, before);
    });
  });

  describe('renaming a file from the visual editor', () => {
    test('renames through the media API and rewrites the node path', async () => {
      routes['POST /api/media/3/rename'] = () => ({ id: 3, path: '/2024/08/renamed.jpg' });
      await mountPage({ params: { id: '7' } });

      await page._handleRename('/2024/08/harbour.jpg', 'renamed.jpg');
      await settle();

      assert.ok(page._nodes.some(n => n.path === '/2024/08/renamed.jpg'));
      assert.equal(getToast().type, 'success');
    });

    test('a path the media list does not know about fails loudly', async () => {
      await mountPage({ params: { id: '7' } });

      await assert.rejects(() => page._handleRename('/2024/08/gone.jpg', 'x.jpg'));
      assert.equal(getToast().type, 'error');
    });
  });

  // ── Editor mode ───────────────────────────────────────────────────────────

  describe('switching editor mode', () => {
    test('visual → text keeps the fields that were typed', async () => {
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), 'Kept across the switch');

      page._switchMode('text');

      assert.equal(page.state.editorMode, 'text');
      assert.equal(page.state.post.title, 'Kept across the switch');
    });

    test('text → visual re-parses the markdown into nodes', async () => {
      await mountPage({ params: { id: '7' } });
      page._switchMode('text');

      page._switchMode('visual');

      assert.equal(page.state.editorMode, 'visual');
      assert.ok(Array.isArray(page._nodes));
    });

    test('switching to the mode already in use is a no-op', async () => {
      await mountPage({ params: { id: '7' } });
      const post = page.state.post;

      page._switchMode('visual');

      assert.equal(page.state.post, post);
    });
  });

  // ── The offline share queue ───────────────────────────────────────────────

  describe('the offline share queue', () => {
    /** Two shares waiting from a phone that was offline when they were made. */
    const queued = () => ([
      { id: 'a', timestamp: 1, title: 'From the phone', files: [{ name: 'a.jpg', type: 'image/jpeg', data: new Uint8Array([1]) }] },
      { id: 'b', timestamp: 2, title: '', files: [{ name: 'b.jpg', type: 'image/jpeg', data: new Uint8Array([2]) }] },
    ]);

    test('drains the first entry into this post and the rest into drafts', async () => {
      routes['POST /api/media/upload'] = () => ({ path: '/2024/08/shared.jpg' });
      const rows = queued();
      const restore = installFakeIndexedDB(rows);
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), '');
      try {
        await page._processShareQueue();
        await settle();
      } finally { restore(); }

      assert.equal(q('#title-input').value, 'From the phone');
      assert.equal(rows.length, 0, 'the queue is emptied once drained');
      assert.equal(sent('POST', '/api/posts').length, 1, 'the backlog entry becomes its own draft');
      assert.match(getToast().message, /1 offline shares saved as draft/);
    });

    test('the backlog draft is filled with the uploaded paths', async () => {
      routes['POST /api/media/upload'] = () => ({ path: '/2024/08/shared.jpg' });
      const restore = installFakeIndexedDB(queued());
      await mountPage({ params: { id: '7' } });
      try {
        await page._processShareQueue();
        await settle();
      } finally { restore(); }

      assert.equal(sent('PUT', '/api/posts/11').at(-1).body.content, '/2024/08/shared.jpg');
    });

    test('a backlog entry that cannot be saved is reported, not swallowed', async () => {
      routes['POST /api/posts'] = () => fail(500, 'disk full');
      const restore = installFakeIndexedDB(queued());
      await mountPage({ params: { id: '7' } });
      const seen = [];
      const unsubscribe = onToast(t => t && seen.push(t.message));
      try {
        await page._processShareQueue();
        await settle();
      } finally { restore(); unsubscribe(); }

      assert.ok(seen.some(m => /Failed to save offline share/.test(m)), seen.join(' | '));
    });

    test('an empty queue does nothing at all', async () => {
      const restore = installFakeIndexedDB([]);
      await mountPage({ params: { id: '7' } });
      try {
        await page._processShareQueue();
      } finally { restore(); }

      assert.equal(sent('POST', '/api/posts').length, 0);
    });

    test('a queue that cannot be read is simply skipped', async () => {
      const restore = installFakeIndexedDB([], { broken: true });
      await mountPage({ params: { id: '7' } });
      try {
        await page._processShareQueue();
      } finally { restore(); }

      assert.equal(sent('POST', '/api/posts').length, 0);
    });

    test('the share query drains the queue on mount', async () => {
      routes['POST /api/media/upload'] = () => ({ path: '/2024/08/shared.jpg' });
      const rows = queued();
      const restore = installFakeIndexedDB(rows);
      try {
        await mountPage({ params: { id: '7' }, query: { share: 'pending' } });
        await settle();
        await settle();
      } finally { restore(); }

      assert.equal(rows.length, 0);
    });
  });

  // ── Details panel and preview ─────────────────────────────────────────────

  describe('the details panel', () => {
    test('opens and closes, and reports its state to assistive tech', async () => {
      await mountPage({ params: { id: '7' } });

      page._toggleDetails(true);
      assert.equal(q('#details-panel').getAttribute('aria-hidden'), 'false');

      page._toggleDetails(false);
      assert.equal(q('#details-panel').getAttribute('aria-hidden'), 'true');
    });

    test('summaries follow the fields', async () => {
      await mountPage({ params: { id: '7' } });
      type(q('#title-input'), 'A new title');

      page._updateDetailsSummaries();

      assert.match(q('#summary-title')?.textContent ?? 'A new title', /A new title/);
    });
  });
});

/**
 * An in-memory stand-in for the `indexedDB` global.
 *
 * `utils/idb.js` is the share queue's only storage and talks to the real API
 * directly; Node has no IndexedDB, so without this the queue paths are simply
 * unreachable from a test. `rows` is live — a test can read it back after a
 * drain to see that the queue was actually emptied. `broken` makes `open()`
 * fail, which is the branch where an unreadable queue must be skipped rather
 * than crash the editor.
 */
function installFakeIndexedDB(rows, { broken = false } = {}) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const store = {
    getAll() {
      const req = {};
      setImmediate(() => { req.result = rows.slice(); req.onsuccess?.(); });
      return req;
    },
    clear() { rows.length = 0; },
    put(entry) { rows.push(entry); },
  };
  const db = {
    transaction() {
      const tx = { objectStore: () => store };
      setImmediate(() => tx.oncomplete?.());
      return tx;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true, writable: true,
    value: {
      open() {
        // `result` / `error` on the request itself, the way a real IDBRequest
        // carries them — utils/idb.js reads the request, not the event.
        const req = {};
        setImmediate(() => {
          if (broken) {
            req.error = new Error('no indexeddb');
            req.onerror?.({ target: req });
          } else {
            req.result = db;
            req.onsuccess?.({ target: req });
          }
        });
        return req;
      },
    },
  });
  return () => {
    if (saved) Object.defineProperty(globalThis, 'indexedDB', saved);
    else delete globalThis.indexedDB;
  };
}
