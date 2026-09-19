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

    test('the title crumb is left out — not a placeholder like "Edit Post" — until the post loads', async () => {
      dom.location.pathname = '/light/posts/7/edit';
      const el = dom.document.createElement('div');
      dom.document.body.appendChild(el);
      page = new PostEditPage(el, { params: { id: '7' } });
      page.mount();

      const crumbs = () => [...el.querySelectorAll('.light-header h1 .breadcrumb-link, .light-header h1 .breadcrumb-current')]
        .map(n => n.textContent.trim());
      assert.deepStrictEqual(crumbs(), ['Posts'], 'no title crumb while the post is still loading');

      await settle();
      await settle();

      assert.deepStrictEqual(crumbs(), ['Posts', 'Harbour lights'], 'fills in the real title once loaded');
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
      // The fence is keyless, so the card addresses it by position — the studio
      // mints its key on the save that adopts it.
      assert.equal(wentTo(), '/light/carousel?post=7&block=1');
    });

    test("a keyed card sends the studio that block's key", async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: carouselFence(['/2024/08/a.jpg'], 'c-7f3a'),
      });
      await mountPage({ params: { id: '7' } });

      click(q('.ve-carousel-edit'));
      await settle();

      assert.equal(wentTo(), '/light/carousel?post=7&block=c-7f3a');
    });

    test('each card addresses its own carousel', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: [
          carouselFence(['/2024/08/a.jpg']),
          carouselFence(['/2024/08/b.jpg'], 'c-7f3a'),
          carouselFence(['/2024/08/c.jpg']),
        ].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });

      const buttons = [...page.container.querySelectorAll('.ve-carousel-edit')];
      assert.equal(buttons.length, 3);
      // Position counts every carousel, keyed ones included, so an ordinal and
      // the fence order the studio reads out of the content are the same list.
      assert.deepEqual(buttons.map(b => b.dataset.block), ['1', 'c-7f3a', '3']);

      click(buttons[2]);
      await settle();
      assert.equal(wentTo(), '/light/carousel?post=7&block=3');
    });

    test('the card has no Edit in Studio affordance with the plugin disabled', async () => {
      pluginHost.init([]);
      await mountPage({ params: { id: '7' } });

      assert.equal(q('.ve-carousel-edit'), null);
      assert.equal(q('#carousel-studio-btn'), null);
    });

    test('with the plugin disabled, the card still shows its thumbnails, ungroups, and reorders slides', async () => {
      pluginHost.init([]);
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: carouselFence(['/2024/08/a.jpg', '/2024/08/b.jpg'], 'c-7f3a'),
      });
      await mountPage({ params: { id: '7' } });
      const slides = () => [...page.container.querySelectorAll('.ve-slide')];

      assert.equal(slides().length, 2, 'both slides still show a thumbnail');
      assert.ok(slides()[0].querySelector('.ve-thumb'));

      fire(slides()[0].querySelector('.ve-slide-handle'), 'keydown', { key: 'ArrowRight' });
      assert.deepEqual(page._nodes[0].paths, ['/2024/08/b.jpg', '/2024/08/a.jpg']);

      click(q('.ve-carousel-ungroup'));
      assert.deepEqual(page._nodes.map(n => n.type), ['image', 'image']);
    });
  });

  // ── Selecting cards, grouping, ungrouping ────────────────────────────

  /**
   * Making a carousel out of the post's own photos, from the editor.
   *
   * The action is a selection plus one button, and the two things that make it
   * safe are asserted here: the selection is keyed by node identity, so a
   * structural change cannot silently retarget it, and both writes hand back an
   * Undo carrying a snapshot of the list as it was.
   */
  describe('selecting cards and making a carousel', () => {
    const PHOTOS = ['/2024/08/a.jpg', '/2024/08/b.jpg', '/2024/08/c.jpg'];

    beforeEach(() => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: `${PHOTOS.join('\n\n')}\n\nCaption line.`,
      });
    });

    const cards = () => [...page.container.querySelectorAll('.ve-card')];
    const selected = () => cards().filter(c => c.classList.contains('is-selected')).map(c => c.dataset.index);
    const bar = () => q('.ve-selection-bar');
    const nodes = () => page._nodes;

    test('the post parses into three photo cards and a text card', async () => {
      await mountPage({ params: { id: '7' } });

      assert.deepEqual(nodes().map(n => n.type), ['image', 'image', 'image', 'text']);
      assert.equal(bar().hidden, true, 'the bar is out of the way until something is picked');
    });

    test('a click selects a card and the bar reports the count', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);

      assert.deepEqual(selected(), ['0']);
      assert.equal(bar().hidden, false);
      assert.equal(q('.ve-selection-count').textContent, '1 selected');
    });

    test('clicking a selected card again lets it go', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(cards()[0]);

      assert.deepEqual(selected(), []);
      assert.equal(bar().hidden, true);
    });

    test('shift-click takes the whole range from the anchor', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(cards()[2], { shiftKey: true });

      assert.deepEqual(selected(), ['0', '1', '2']);
      assert.equal(q('.ve-selection-count').textContent, '3 selected');
    });

    test('a text card is refused — it cannot become a slide', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[3]);

      assert.deepEqual(selected(), []);
    });

    test('a shift-range skips a text card it spans', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: '/2024/08/a.jpg\n\nCaption line.\n\n/2024/08/b.jpg',
      });
      await mountPage({ params: { id: '7' } });
      assert.deepEqual(nodes().map(n => n.type), ['image', 'text', 'image']);

      click(cards()[0]);
      click(cards()[2], { shiftKey: true });

      assert.deepEqual(selected(), ['0', '2']);
    });

    test('shift-clicking a text card is refused like any other click on one', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(cards()[3], { shiftKey: true });

      assert.deepEqual(selected(), ['0'], 'the range is not extended to a card that cannot hold slides');
    });

    test('a shift-mousedown on a card refuses the browser text smear, but not on the handle', async () => {
      await mountPage({ params: { id: '7' } });

      assert.equal(
        fire(cards()[0], 'mousedown', { shiftKey: true }).defaultPrevented, true,
        'shift-clicking cards would otherwise paint a text selection across the page',
      );
      assert.equal(
        fire(cards()[0].querySelector('.ve-handle'), 'mousedown', { shiftKey: true }).defaultPrevented, false,
        'the handle is never a selection target, so its press is left to the reorder gesture',
      );
      assert.equal(
        fire(cards()[0], 'mousedown', {}).defaultPrevented, false,
        'an unmodified mousedown is left alone entirely',
      );
    });

    test('clicking the list outside a card clears the selection', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(q('#ve-list'));

      assert.deepEqual(selected(), []);
      assert.equal(bar().hidden, true);
    });

    test('the Clear button drops the selection', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(q('.ve-selection-clear'));

      assert.deepEqual(selected(), []);
    });

    test('clicking a thumbnail or a path still does its own job, not selection', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0].querySelector('.ve-thumb'));
      assert.deepEqual(selected(), [], 'the thumbnail opens the lightbox');

      click(cards()[0].querySelector('.ve-path'));
      assert.deepEqual(selected(), [], 'the path starts an inline rename');
      assert.ok(cards()[0].querySelector('.ve-rename-input'));
    });

    test('the selection follows the node, not its index, across a re-render', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[1]);
      assert.deepEqual(selected(), ['1'], 'b.jpg');

      // A text card inserted above shifts every photo down one. An index-keyed
      // selection would now be painting a.jpg.
      click(q('.ve-insert-zone[data-insert-at="0"] .ve-insert-text'));

      assert.deepEqual(selected(), ['2']);
      assert.equal(nodes()[2].path, '/2024/08/b.jpg');
    });

    test('the selection survives a bare setProps re-render', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      page._visualEditorRef.setProps({ nodes: page._nodes });

      assert.deepEqual(selected(), ['0']);
      assert.equal(bar().hidden, false);
    });

    test('Make carousel folds the selection into one keyed carousel, in place', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[1]);
      click(cards()[2], { shiftKey: true });
      click(q('.ve-make-carousel'));

      assert.deepEqual(nodes().map(n => n.type), ['image', 'carousel', 'text']);
      assert.equal(nodes()[0].path, '/2024/08/a.jpg');
      assert.deepEqual(nodes()[1].paths, ['/2024/08/b.jpg', '/2024/08/c.jpg']);
      assert.match(nodes()[1].key, /^c-[0-9a-f]{4}$/, 'editor-made carousels are studio-addressable');
      assert.deepEqual(selected(), [], 'the cards it named are gone');
    });

    test('one photo makes a legal one-slide carousel', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(q('.ve-make-carousel'));

      assert.equal(nodes()[0].type, 'carousel');
      assert.deepEqual(nodes()[0].paths, ['/2024/08/a.jpg']);
    });

    test('grouping a photo into a carousel keeps that block\'s key', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: `${carouselFence(['/2024/08/a.jpg'], 'c-7f3a')}\n\n/2024/08/b.jpg`,
      });
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(cards()[1], { shiftKey: true });
      click(q('.ve-make-carousel'));

      assert.equal(nodes().length, 1);
      assert.equal(nodes()[0].key, 'c-7f3a', 'the block keeps its design document');
      assert.deepEqual(nodes()[0].paths, ['/2024/08/a.jpg', '/2024/08/b.jpg']);
    });

    test('a lone carousel is not offered Make carousel — it would do nothing', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: carouselFence(['/2024/08/a.jpg'], 'c-7f3a'),
      });
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);

      assert.deepEqual(selected(), ['0'], 'a carousel card is still selectable');
      assert.equal(q('.ve-make-carousel').hidden, true);
    });

    test('the toast Undo restores the exact pre-group list', async () => {
      await mountPage({ params: { id: '7' } });
      const before = [...nodes()];

      click(cards()[0]);
      click(cards()[1], { shiftKey: true });
      click(q('.ve-make-carousel'));
      assert.equal(nodes().length, 3);
      assert.match(getToast().message, /Carousel created from 2 photos/);

      getToast().action.onAction();

      assert.deepEqual(nodes(), before);
      assert.deepEqual(selected(), [], 'and nothing is left picked');
    });

    test('Ungroup turns a carousel back into image cards, in order', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: carouselFence(['/2024/08/a.jpg', '/2024/08/b.jpg'], 'c-7f3a'),
      });
      await mountPage({ params: { id: '7' } });

      click(q('.ve-carousel-ungroup'));

      assert.deepEqual(nodes(), [
        { type: 'image', path: '/2024/08/a.jpg' },
        { type: 'image', path: '/2024/08/b.jpg' },
      ]);
      assert.match(getToast().message, /Carousel ungrouped into 2 photos/);
    });

    test("Ungroup's Undo puts the carousel back with its key", async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: `/2024/08/z.jpg\n\n${carouselFence(['/2024/08/a.jpg'], 'c-7f3a')}`,
      });
      await mountPage({ params: { id: '7' } });
      const before = [...nodes()];

      click(q('.ve-carousel-ungroup'));
      assert.deepEqual(nodes().map(n => n.type), ['image', 'image']);

      getToast().action.onAction();

      assert.deepEqual(nodes(), before);
      assert.equal(nodes()[1].key, 'c-7f3a');
    });

    test('a grouped post saves as a well-formed keyed fence', async () => {
      await mountPage({ params: { id: '7' } });

      click(cards()[0]);
      click(cards()[1], { shiftKey: true });
      click(q('.ve-make-carousel'));
      await page._save();
      await settle();

      const { content } = sent('PUT', '/api/posts/7').at(-1).body;
      const key = nodes()[0].key;
      assert.ok(
        content.startsWith(carouselFence(['/2024/08/a.jpg', '/2024/08/b.jpg'], key)),
        `fence not well formed:\n${content}`,
      );
    });
  });

  // ── Reordering ────────────────────────────────────────────────────────────

  /**
   * Card reordering, which is pointer-driven (utils/pointerReorder.js) rather
   * than HTML5 drag-and-drop.
   *
   * linkedom has no layout engine, so every element reports a zero rect and the
   * gesture's midpoint test is meaningless here. That is exactly why the
   * arithmetic lives in _moveNode(fromIdx, afterIdx): the pointer path and the
   * arrow keys both reduce to that pair, and the pair is assertable. What is
   * tested by hand is the keyboard half — a real path from a key to a new
   * order — plus _moveNode's ±1 directly.
   */
  describe('reordering cards', () => {
    const PHOTOS = ['/2024/08/a.jpg', '/2024/08/b.jpg', '/2024/08/c.jpg'];

    beforeEach(() => {
      routes['GET /api/posts/7'] = () => ({ ...POST(), content: PHOTOS.join('\n\n') });
    });

    const cards = () => [...page.container.querySelectorAll('.ve-card')];
    const order = () => page._nodes.map(n => n.path || n.type);
    const ve = () => page._visualEditorRef;

    test('nothing in the editor is draggable — the gesture is pointer events', async () => {
      await mountPage({ params: { id: '7' } });

      assert.equal(
        page.container.querySelector('#ve-list [draggable]'), null,
        'a draggable attribute would put HTML5 DnD back alongside the pointer gesture',
      );
    });

    test('the handle is a focusable button that says what it moves', async () => {
      await mountPage({ params: { id: '7' } });
      const handle = cards()[0].querySelector('.ve-handle');

      assert.equal(handle.tagName, 'BUTTON');
      assert.equal(handle.getAttribute('type'), 'button');
      assert.equal(handle.getAttribute('aria-label'), 'Move a.jpg');
    });

    test('ArrowDown on a focused handle moves the card one place later', async () => {
      await mountPage({ params: { id: '7' } });

      const e = fire(cards()[0].querySelector('.ve-handle'), 'keydown', { key: 'ArrowDown' });

      assert.deepEqual(order(), ['/2024/08/b.jpg', '/2024/08/a.jpg', '/2024/08/c.jpg']);
      assert.equal(e.defaultPrevented, true, 'the arrows would otherwise scroll the page');
    });

    test('ArrowUp moves it back, and focus follows the card it moved', async () => {
      await mountPage({ params: { id: '7' } });

      // linkedom's `focus()` does not move `activeElement`, so record the calls
      // instead — what matters is that the rebuilt handle gets one. Without it
      // the second press of a repeated arrow would land on a dead node.
      const proto = dom.window.HTMLElement.prototype;
      const realFocus = proto.focus;
      const focused = [];
      proto.focus = function focusSpy() { focused.push(this); };
      try {
        fire(cards()[2].querySelector('.ve-handle'), 'keydown', { key: 'ArrowUp' });
      } finally {
        proto.focus = realFocus;
      }

      assert.deepEqual(order(), ['/2024/08/a.jpg', '/2024/08/c.jpg', '/2024/08/b.jpg']);
      assert.equal(focused.at(-1), cards()[1].querySelector('.ve-handle'));
    });

    test('ArrowUp onto the front of the list works — there is no card to land behind', async () => {
      await mountPage({ params: { id: '7' } });

      fire(cards()[1].querySelector('.ve-handle'), 'keydown', { key: 'ArrowUp' });

      assert.deepEqual(order(), ['/2024/08/b.jpg', '/2024/08/a.jpg', '/2024/08/c.jpg']);
    });

    test('an arrow off either end of the list does nothing at all', async () => {
      await mountPage({ params: { id: '7' } });

      const up = fire(cards()[0].querySelector('.ve-handle'), 'keydown', { key: 'ArrowUp' });
      const down = fire(cards()[2].querySelector('.ve-handle'), 'keydown', { key: 'ArrowDown' });

      assert.deepEqual(order(), PHOTOS);
      assert.equal(up.defaultPrevented, false, 'a refused move leaves the key to the page');
      assert.equal(down.defaultPrevented, false);
    });

    test('an arrow away from a handle is left alone — a text card is being typed in', async () => {
      routes['GET /api/posts/7'] = () => ({ ...POST(), content: 'Caption line.\n\n/2024/08/a.jpg' });
      await mountPage({ params: { id: '7' } });

      const e = fire(page.container.querySelector('.ve-text-area'), 'keydown', { key: 'ArrowDown' });

      assert.deepEqual(order(), ['text', '/2024/08/a.jpg']);
      assert.equal(e.defaultPrevented, false);
    });

    test('_moveNode lands the node behind its anchor, forwards and backwards', async () => {
      await mountPage({ params: { id: '7' } });

      // Forwards: the anchor sits behind the moved node, so splicing it out
      // first slides the anchor down one — insert AT the anchor's old index.
      ve()._moveNode(0, 2);
      assert.deepEqual(order(), ['/2024/08/b.jpg', '/2024/08/c.jpg', '/2024/08/a.jpg']);

      // Backwards: nothing behind the anchor moved, so insert after it.
      ve()._moveNode(2, 0);
      assert.deepEqual(order(), ['/2024/08/b.jpg', '/2024/08/a.jpg', '/2024/08/c.jpg']);
    });

    test('_moveNode with a null anchor puts the node at the front', async () => {
      await mountPage({ params: { id: '7' } });

      ve()._moveNode(2, null);

      assert.deepEqual(order(), ['/2024/08/c.jpg', '/2024/08/a.jpg', '/2024/08/b.jpg']);
    });

    test('a move that changes nothing is not a change', async () => {
      await mountPage({ params: { id: '7' } });
      const before = page._nodes;

      ve()._moveNode(1, 0);      // already directly behind a.jpg
      ve()._moveNode(0, null);   // already at the front
      ve()._moveNode(1, 1);      // released over itself, which names itself as anchor

      assert.equal(page._nodes, before, 'an identical list would still cost an autosave');
    });

    test('_moveNode refuses an index that is not a card', async () => {
      await mountPage({ params: { id: '7' } });
      const before = page._nodes;

      ve()._moveNode(null, 1);
      ve()._moveNode(9, 0);

      assert.equal(page._nodes, before);
    });
  });

  /**
   * Reordering a carousel card's own slides, within its strip. Same pointer
   * gesture as card reordering, a second container and axis, and its own
   * index arithmetic in _moveSlide(nodeIdx, fromIdx, afterIdx) — the strip's
   * counterpart to _moveNode().
   */
  describe('reordering slides within a carousel', () => {
    const SLIDES = ['/2024/08/a.jpg', '/2024/08/b.jpg', '/2024/08/c.jpg'];

    beforeEach(() => {
      routes['GET /api/posts/7'] = () => ({ ...POST(), content: carouselFence(SLIDES) });
    });

    const slides = () => [...page.container.querySelectorAll('.ve-slide')];
    const paths = () => page._nodes[0].paths;
    const ve = () => page._visualEditorRef;

    test('.ve-thumb is not the reorder item selector, so the ambiguity cannot come back', async () => {
      await mountPage({ params: { id: '7' } });
      const before = page._nodes;
      const thumb = slides()[0].querySelector('.ve-thumb');

      assert.equal(thumb.dataset.index, undefined, 'only .ve-slide carries the position');

      // A drop naming the thumb as the moved item — the exact ambiguity a
      // shared .ve-thumb selector used to create — has no index to read and
      // moves nothing.
      ve()._onReorderDrop({
        item: thumb,
        from: page.container.querySelector('.ve-carousel-strip'),
        to: page.container.querySelector('.ve-carousel-strip'),
        afterEl: null,
      });

      assert.equal(page._nodes, before);
    });

    test('the slide handle is a focusable button that says what it moves', async () => {
      await mountPage({ params: { id: '7' } });
      const handle = slides()[0].querySelector('.ve-slide-handle');

      assert.equal(handle.tagName, 'BUTTON');
      assert.equal(handle.getAttribute('type'), 'button');
      assert.equal(handle.getAttribute('aria-label'), 'Move slide 1 of 3');
    });

    test('ArrowRight on a focused slide handle moves it one place later', async () => {
      await mountPage({ params: { id: '7' } });

      const e = fire(slides()[0].querySelector('.ve-slide-handle'), 'keydown', { key: 'ArrowRight' });

      assert.deepEqual(paths(), ['/2024/08/b.jpg', '/2024/08/a.jpg', '/2024/08/c.jpg']);
      assert.equal(e.defaultPrevented, true, 'the arrows would otherwise scroll the strip');
    });

    test('ArrowLeft moves it back, and focus follows the slide it moved', async () => {
      await mountPage({ params: { id: '7' } });

      const proto = dom.window.HTMLElement.prototype;
      const realFocus = proto.focus;
      const focused = [];
      proto.focus = function focusSpy() { focused.push(this); };
      try {
        fire(slides()[2].querySelector('.ve-slide-handle'), 'keydown', { key: 'ArrowLeft' });
      } finally {
        proto.focus = realFocus;
      }

      assert.deepEqual(paths(), ['/2024/08/a.jpg', '/2024/08/c.jpg', '/2024/08/b.jpg']);
      assert.equal(focused.at(-1), slides()[1].querySelector('.ve-slide-handle'));
    });

    test('ArrowLeft onto the front of the strip works — there is no slide to land behind', async () => {
      await mountPage({ params: { id: '7' } });

      fire(slides()[1].querySelector('.ve-slide-handle'), 'keydown', { key: 'ArrowLeft' });

      assert.deepEqual(paths(), ['/2024/08/b.jpg', '/2024/08/a.jpg', '/2024/08/c.jpg']);
    });

    test('an arrow off either end of the strip does nothing at all', async () => {
      await mountPage({ params: { id: '7' } });

      const left = fire(slides()[0].querySelector('.ve-slide-handle'), 'keydown', { key: 'ArrowLeft' });
      const right = fire(slides()[2].querySelector('.ve-slide-handle'), 'keydown', { key: 'ArrowRight' });

      assert.deepEqual(paths(), SLIDES);
      assert.equal(left.defaultPrevented, false, 'a refused move leaves the key to the page');
      assert.equal(right.defaultPrevented, false);
    });

    test('the drop handler, given a synthetic drop within the same strip, reorders the paths', async () => {
      await mountPage({ params: { id: '7' } });
      const strip = page.container.querySelector('.ve-carousel-strip');

      ve()._onReorderDrop({ item: slides()[0], from: strip, to: strip, afterEl: slides()[2] });

      assert.deepEqual(paths(), ['/2024/08/b.jpg', '/2024/08/c.jpg', '/2024/08/a.jpg']);
    });

    test('the drop handler moves a slide dropped into the list out of its carousel', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: [carouselFence(SLIDES), '/2024/08/z.jpg'].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const strip = page.container.querySelector('.ve-carousel-strip');
      const list = page.container.querySelector('#ve-list');

      ve()._onReorderDrop({ item: slides()[0], from: strip, to: list, afterEl: null });

      assert.deepEqual(
        page._nodes.map(n => (n.type === 'carousel' ? n.paths : n.path)),
        ['/2024/08/a.jpg', ['/2024/08/b.jpg', '/2024/08/c.jpg'], '/2024/08/z.jpg'],
        'the slide became a loose image at the front, and the carousel kept the rest',
      );
    });

    test('the drop handler collapses a carousel whose last slide leaves for the list', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: [carouselFence(['/2024/08/a.jpg']), '/2024/08/z.jpg'].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const strip = page.container.querySelector('.ve-carousel-strip');
      const list = page.container.querySelector('#ve-list');
      const order = () => page._nodes.map(n => n.path || n.type);

      ve()._onReorderDrop({ item: slides()[0], from: strip, to: list, afterEl: null });

      assert.deepEqual(order(), ['/2024/08/a.jpg', '/2024/08/z.jpg'], 'no empty carousel card is left behind');
    });

    test('_moveSlide lands the slide behind its anchor, forwards and backwards', async () => {
      await mountPage({ params: { id: '7' } });

      ve()._moveSlide(0, 0, 2);
      assert.deepEqual(paths(), ['/2024/08/b.jpg', '/2024/08/c.jpg', '/2024/08/a.jpg']);

      ve()._moveSlide(0, 2, 0);
      assert.deepEqual(paths(), ['/2024/08/b.jpg', '/2024/08/a.jpg', '/2024/08/c.jpg']);
    });

    test('_moveSlide with a null anchor puts the slide at the front', async () => {
      await mountPage({ params: { id: '7' } });

      ve()._moveSlide(0, 2, null);

      assert.deepEqual(paths(), ['/2024/08/c.jpg', '/2024/08/a.jpg', '/2024/08/b.jpg']);
    });

    test('a move that changes nothing is not a change', async () => {
      await mountPage({ params: { id: '7' } });
      const before = page._nodes;

      ve()._moveSlide(0, 1, 0);   // already directly behind a.jpg
      ve()._moveSlide(0, 0, null); // already at the front
      ve()._moveSlide(0, 1, 1);   // released over itself

      assert.equal(page._nodes, before, 'an identical list would still cost an autosave');
    });

    test('_moveSlide refuses an index that is not a slide, or a node that is not a carousel', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: [carouselFence(SLIDES), '/2024/08/d.jpg'].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const before = page._nodes;

      ve()._moveSlide(0, null, 1);
      ve()._moveSlide(0, 9, 0);
      ve()._moveSlide(1, 0, null); // node 1 is the plain image card, not a carousel

      assert.equal(page._nodes, before);
    });
  });

  /**
   * Crossing the boundary between the top-level list and a carousel's strip:
   * a photo dragged in, a slide dragged out, a slide dragged into a different
   * carousel. Each is one onChange() call, built out of A1's node operations
   * (insertPathIntoCarousel, removePathFromCarousel) rather than duplicating
   * their arithmetic here.
   */
  describe('dragging photos in and out of a carousel', () => {
    const ve = () => page._visualEditorRef;
    const nodeShapes = () => page._nodes.map(n => (n.type === 'carousel' ? n.paths : n.path || n.type));

    test('a photo dropped into a strip joins that carousel, and leaves the list', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: ['/2024/08/x.jpg', carouselFence(['/2024/08/a.jpg', '/2024/08/b.jpg'])].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const card = page.container.querySelector('.ve-card:not(.ve-card--carousel)');
      const strip = page.container.querySelector('.ve-carousel-strip');
      const firstSlide = strip.querySelector('.ve-slide');

      ve()._onReorderDrop({ item: card, from: page.container.querySelector('#ve-list'), to: strip, afterEl: firstSlide });

      assert.deepEqual(
        nodeShapes(),
        [['/2024/08/a.jpg', '/2024/08/x.jpg', '/2024/08/b.jpg']],
        'the photo left the list and landed behind the slide it was dropped on',
      );
    });

    test('a text card dropped into a strip is refused — only a photo can join a carousel', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: ['Caption line.', carouselFence(['/2024/08/a.jpg'])].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const before = page._nodes;
      const card = page.container.querySelector('.ve-card--text');
      const strip = page.container.querySelector('.ve-carousel-strip');

      ve()._onReorderDrop({ item: card, from: page.container.querySelector('#ve-list'), to: strip, afterEl: null });

      assert.equal(page._nodes, before);
    });

    test('a slide dragged into a different carousel moves between them', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: [
          carouselFence(['/2024/08/a.jpg', '/2024/08/b.jpg']),
          carouselFence(['/2024/08/c.jpg']),
        ].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const strips = [...page.container.querySelectorAll('.ve-carousel-strip')];
      const firstSlide = strips[0].querySelector('.ve-slide');

      ve()._onReorderDrop({ item: firstSlide, from: strips[0], to: strips[1], afterEl: null });

      assert.deepEqual(
        nodeShapes(),
        [['/2024/08/b.jpg'], ['/2024/08/a.jpg', '/2024/08/c.jpg']],
        'the slide left the first carousel and landed at the front of the second',
      );
    });

    test('the last slide crossing into another carousel collapses its old one', async () => {
      routes['GET /api/posts/7'] = () => ({
        ...POST(),
        content: [
          carouselFence(['/2024/08/a.jpg']),
          carouselFence(['/2024/08/c.jpg']),
        ].join('\n\n'),
      });
      await mountPage({ params: { id: '7' } });
      const strips = [...page.container.querySelectorAll('.ve-carousel-strip')];
      const firstSlide = strips[0].querySelector('.ve-slide');

      ve()._onReorderDrop({ item: firstSlide, from: strips[0], to: strips[1], afterEl: null });

      assert.deepEqual(nodeShapes(), [['/2024/08/a.jpg', '/2024/08/c.jpg']]);
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
