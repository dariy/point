/**
 * PostsListPage — the admin list at /light/posts.
 *
 * The list is one screen doing five jobs at once: filtering (status, tag,
 * search), paging, per-row status edits, bulk actions, and the trash view. They
 * share one `_load()` and one URL, so most of what can go wrong is one of them
 * clobbering another's state — a filter change that forgets to reset the page,
 * a bulk apply that leaves select mode armed, a status revert that doesn't
 * revert. Those are what these tests pin down.
 *
 * Everything reaches the backend through `fetch`, so a single routing stub
 * covers the lot and the request log is the assertion surface for "what did the
 * page actually ask for".
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire, type, check } from './helpers/dom.js';
import { getToast, setSettings, setToast, setUser } from '../src/store.js';
import { clearPostReadCache } from '../src/api/posts.js';

const settle = () => new Promise(r => setImmediate(r));

const POSTS = () => ([
  { id: 1, title: 'Harbour lights', slug: 'harbour-lights', status: 'PUBLISHED', type: 'post', tags: [{ id: 9, name: 'harbour', slug: 'harbour' }], created_at: '2024-08-01T10:00:00Z' },
  { id: 2, title: 'Draft thoughts', slug: 'draft-thoughts', status: 'DRAFT', type: 'post', tags: [], created_at: '2024-08-02T10:00:00Z' },
  { id: 3, title: 'About', slug: 'about', status: 'PUBLISHED', type: 'page', tags: [], created_at: '2024-08-03T10:00:00Z' },
]);

describe('PostsListPage', () => {
  let dom, PostsListPage, page, requests, routes, navigations;

  function fakeFetch() {
    requests = [];
    globalThis.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const [path, query = ''] = String(url).split('?');
      let body;
      if (typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
      requests.push({ url: String(url), path, query, method, body, params: new URLSearchParams(query) });

      const key = Object.keys(routes)
        .filter(k => { const [m, p] = k.split(' '); return m === method && path.startsWith(p); })
        .sort((a, b) => b.length - a.length)[0];
      const result = key ? await routes[key]({ path, method, body }) : {};
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

  const fail = (status, message) => ({ __response: true, status, payload: { message } });

  async function mountPage(props = {}) {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new PostsListPage(el, props);
    page.mount();
    await settle();
    await settle();
    return page;
  }

  const q = sel => page.container.querySelector(sel);
  const qa = sel => [...page.container.querySelectorAll(sel)];
  const sent = (method, path) => requests.filter(r => r.method === method && r.path === path);
  const lastList = () => sent('GET', '/api/posts').at(-1);
  const confirmDialog = () => dom.document.querySelector('.confirm-dialog, .modal-overlay');

  /** Press the confirm button of whatever confirmation is on screen. */
  function acceptConfirm() {
    const dialog = confirmDialog();
    assert.ok(dialog, 'expected a confirmation dialog');
    const btn = dialog.querySelector('.btn-danger, .confirm-dialog__confirm, .btn-primary');
    click(btn);
  }

  beforeEach(async () => {
    dom = setupDOM();
    navigations = [];
    dom.window.addEventListener('app:navigate', e => navigations.push(e.detail.path));
    clearPostReadCache();
    routes = {
      'GET /api/posts': () => ({ posts: POSTS(), page: 1, pages: 3, total: 42, per_page: 20 }),
      'GET /api/tags': () => ({ tags: [] }),
      'DELETE /api/posts': () => ({}),
      'POST /api/posts': () => ({}),
      'PATCH /api/posts': ({ body, path }) => ({ id: Number(path.split('/')[3]), status: (body.status || 'draft').toUpperCase(), type: 'post', tags: (body.tags || []).map(n => ({ name: n, slug: n })) }),
    };
    fakeFetch();
    setUser({ username: 'owner', is_admin: true });
    setSettings({ blog_title: 'Test blog' });
    setToast(null);
    ({ default: PostsListPage } = await import('../src/pages/light/PostsListPage.js'));
  });

  afterEach(() => {
    try { page?.unmount(); } catch { /* torn down mid-flight */ }
    page = null;
    dom.cleanup();
    delete globalThis.fetch;
  });

  // ── Loading and rendering ─────────────────────────────────────────────────

  describe('loading', () => {
    test('renders a row per post, with the status lowercased', async () => {
      await mountPage();

      assert.equal(page.state.posts.length, 3);
      assert.deepEqual(page.state.posts.map(p => p.status), ['published', 'draft', 'published']);
      assert.ok(page.container.textContent.includes('Harbour lights'));
    });

    test('a page-type post is shown as "Page" rather than as published', async () => {
      await mountPage();

      const select = q('.status-change-btn[data-id="3"]');
      assert.ok(select, 'the page row has a status control');
      assert.equal(select.value, 'page');
    });

    test('a failed load says so and leaves the list empty rather than half-drawn', async () => {
      routes['GET /api/posts'] = () => fail(500, 'boom');

      await mountPage();

      assert.equal(getToast().type, 'error');
      assert.equal(page.state.loading, false);
      assert.equal(page.state.posts.length, 0);
    });

    test('the query string seeds the filters, and the request carries them', async () => {
      await mountPage({ query: { status: 'draft', tag: 'harbour', search: 'lights', page: '2' } });

      const params = lastList().params;
      assert.equal(params.get('status'), 'draft');
      assert.equal(params.get('tag'), 'harbour');
      assert.equal(params.get('q'), 'lights');
      assert.equal(params.get('page'), '2');
    });

    test('the list URL is remembered so the editor can offer a way back', async () => {
      await mountPage();

      assert.match(globalThis.sessionStorage.getItem('point:admin:posts-list-url'), /^\/light\/posts/);
    });
  });

  // ── Filters ───────────────────────────────────────────────────────────────

  describe('filters', () => {
    test('changing the status filter reloads from page one', async () => {
      await mountPage({ query: { page: '3' } });

      const select = q('#status-filter');
      select.value = 'draft';
      fire(select, 'change');
      await settle();

      assert.equal(page.state.statusFilter, 'draft');
      assert.equal(lastList().params.get('status'), 'draft');
      assert.equal(lastList().params.get('page'), '1');
    });

    test('a search reloads from page one and lands in the URL', async () => {
      await mountPage();

      await page._load({ page: 1, search: 'harbour' });

      assert.equal(lastList().params.get('q'), 'harbour');
      assert.match(dom.history.entries.at(-1)[1], /search=harbour/);
    });

    test('trash is its own view: no tag editors, restore instead of delete', async () => {
      await mountPage({ query: { status: 'trash' } });

      assert.equal(lastList().params.get('status'), 'trash');
      assert.equal(qa('.tag-chip-input, #tag-filter-mount .tags-input').length, 0);
    });

    test('the URL keeps only the filters that are set', async () => {
      await mountPage();

      page._syncUrl({ status: '', tag: '', search: '', page: 1 });

      assert.equal(dom.history.entries.at(-1)[1], '/light/posts');
    });
  });

  // ── Paging ────────────────────────────────────────────────────────────────

  describe('paging', () => {
    test('arrow keys page back and forth, and stop at the ends', async () => {
      await mountPage({ query: { page: '2' } });
      routes['GET /api/posts'] = () => ({ posts: POSTS(), page: 2, pages: 3, total: 42, per_page: 20 });

      const right = new globalThis.Event('keydown');
      right.key = 'ArrowRight';
      right.preventDefault = () => {};
      dom.window.dispatchEvent(right);
      await settle();

      assert.equal(lastList().params.get('page'), '2');
    });

    test('typing in a field is not a page turn', async () => {
      await mountPage();
      const before = sent('GET', '/api/posts').length;

      // Dispatching would retarget the event at the window; the guard being
      // tested reads `e.target`, so hand the handler the event a keystroke
      // inside the search box would really give it.
      page._onKeyNav({ key: 'ArrowRight', target: { tagName: 'INPUT' }, preventDefault() {} });
      await settle();

      assert.equal(sent('GET', '/api/posts').length, before);
    });

    test('the floating prev/next arrows are disabled at the edges', async () => {
      await mountPage();

      const arrows = [...dom.document.body.querySelectorAll('.page-nav-arrow')];
      assert.equal(arrows.length, 2);
      assert.equal(arrows[0].disabled, true, 'prev is dead on page one');
      assert.equal(arrows[1].disabled, false);
    });

    test('unmounting takes the arrows and the key handler with it', async () => {
      await mountPage();
      page.unmount();
      page = null;

      assert.equal(dom.document.body.querySelectorAll('.page-nav-arrow').length, 0);
    });
  });

  // ── Per-row status ────────────────────────────────────────────────────────

  describe('changing a post status', () => {
    test('sends the new status and reports it', async () => {
      await mountPage();

      await page._updatePostStatus(2, 'published');

      assert.equal(sent('PATCH', '/api/posts/2/status').at(-1).body.status, 'published');
      assert.equal(page.state.posts.find(p => p.id === 2).status, 'published');
      assert.equal(getToast().type, 'success');
    });

    test('choosing "scheduled" hands off to the editor, where a date can be picked', async () => {
      await mountPage();

      await page._updatePostStatus(1, 'scheduled');

      assert.equal(navigations.at(-1), '/light/posts/1/edit?openSchedule=1');
      assert.equal(sent('PATCH', '/api/posts/1/status').length, 0);
    });

    test('a failure puts the control back to what it was', async () => {
      routes['PATCH /api/posts/1/status'] = () => fail(500, 'nope');
      await mountPage();
      const select = q('.status-change-btn[data-id="1"]');

      await page._updatePostStatus(1, 'draft', select);

      assert.equal(select.value, 'published', 'reverted to the status it had');
      assert.equal(getToast().type, 'error');
      assert.equal(select.classList.contains('badge-loading'), false);
    });

    test('the row control is wired: changing it sends the request', async () => {
      await mountPage();
      const select = q('.status-change-btn[data-id="2"]');

      select.value = 'hidden';
      fire(select, 'change');
      await settle();

      assert.equal(sent('PATCH', '/api/posts/2/status').at(-1).body.status, 'hidden');
    });
  });

  // ── Row actions ───────────────────────────────────────────────────────────

  describe('row actions', () => {
    test('delete asks first, then trashes and reloads', async () => {
      await mountPage();

      click(q('.delete-btn[data-id="1"]'));
      assert.ok(confirmDialog(), 'nothing is destroyed without a confirmation');
      assert.equal(sent('DELETE', '/api/posts/1').length, 0);

      acceptConfirm();
      await settle();

      assert.equal(sent('DELETE', '/api/posts/1').length, 1);
      assert.match(getToast().message, /Trash/);
    });

    test('a failed delete reports the reason', async () => {
      routes['DELETE /api/posts/1'] = () => fail(500, 'still referenced');
      await mountPage();

      await page._deletePost(1);

      assert.equal(getToast().type, 'error');
    });

    test('restore puts a trashed post back', async () => {
      await mountPage({ query: { status: 'trash' } });

      await page._restorePost(1, 'Harbour lights');

      assert.equal(sent('POST', '/api/posts/1/restore').length, 1);
      assert.match(getToast().message, /restored/);
    });

    test('a failed restore reports the reason', async () => {
      routes['POST /api/posts/1/restore'] = () => fail(500, 'gone');
      await mountPage({ query: { status: 'trash' } });

      await page._restorePost(1, 'Harbour lights');

      assert.equal(getToast().type, 'error');
    });

    test('permanent delete is irreversible, so it asks too', async () => {
      await mountPage({ query: { status: 'trash' } });

      const btn = q('.perm-delete-btn[data-id="1"]');
      assert.ok(btn, 'the trash view offers a permanent delete');
      click(btn);
      acceptConfirm();
      await settle();

      assert.equal(sent('DELETE', '/api/posts/1/permanent').length, 1);
      assert.match(getToast().message, /permanently/i);
    });

    test('a failed permanent delete reports the reason', async () => {
      routes['DELETE /api/posts/1/permanent'] = () => fail(500, 'locked');
      await mountPage({ query: { status: 'trash' } });

      await page._permanentlyDeletePost(1);

      assert.equal(getToast().type, 'error');
    });

    test('cancelling a confirmation destroys nothing', async () => {
      await mountPage();

      click(q('.delete-btn[data-id="1"]'));
      const dialog = confirmDialog();
      click(dialog.querySelector('.btn-secondary, .confirm-dialog__cancel'));
      await settle();

      assert.equal(sent('DELETE', '/api/posts/1').length, 0);
      assert.equal(confirmDialog(), null, 'and the dialog is gone');
    });
  });

  // ── Preview links ─────────────────────────────────────────────────────────

  describe('preview links', () => {
    test('the generated link goes to the clipboard', async () => {
      routes['POST /api/posts/1/preview'] = () => ({ preview_url: 'http://localhost/preview/abc' });
      let copied = null;
      globalThis.navigator.clipboard = { writeText: async t => { copied = t; } };
      await mountPage();

      await page._copyPreviewLink(1);

      assert.equal(copied, 'http://localhost/preview/abc');
      assert.match(getToast().message, /copied/i);
    });

    test('without a clipboard the link itself is shown', async () => {
      routes['POST /api/posts/1/preview'] = () => ({ preview_url: 'http://localhost/preview/abc' });
      globalThis.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
      await mountPage();

      await page._copyPreviewLink(1);

      assert.equal(getToast().message, 'http://localhost/preview/abc');
    });

    test('a failure to generate one is reported', async () => {
      routes['POST /api/posts/1/preview'] = () => fail(500, 'no signing key');
      await mountPage();

      await page._copyPreviewLink(1);

      assert.equal(getToast().type, 'error');
    });
  });

  // ── Selection and bulk actions ────────────────────────────────────────────

  describe('selection', () => {
    test('the select button arms selection mode and cancels it again', async () => {
      await mountPage();

      click(q('#select-mode-btn'));
      assert.equal(page.state.selectMode, true);

      click(q('#select-mode-btn'));
      assert.equal(page.state.selectMode, false);
      assert.equal(page.state.selectedIds.size, 0);
    });

    test('select-all takes every visible row, and clearing it drops the mode', async () => {
      await mountPage();
      click(q('#select-mode-btn'));

      check(q('#select-all-cb'), true);
      assert.equal(page.state.selectedIds.size, 3);

      check(q('#select-all-cb'), false);
      assert.equal(page.state.selectMode, false);
    });

    test('one row at a time leaves the select-all box partial', async () => {
      await mountPage();
      click(q('#select-mode-btn'));
      page.state.selectedIds = new Set([1]);

      page._updateBulkToolbar();

      const all = q('#select-all-cb');
      assert.equal(all.checked, false);
      assert.equal(all.indeterminate, true);
      assert.equal(q('#bulk-count').textContent, '1 selected');
      assert.equal(q('#bulk-apply-btn').disabled, false);
    });

    test('deselecting the last row leaves select mode', async () => {
      await mountPage();
      click(q('#select-mode-btn'));
      page.state.selectedIds = new Set([1]);
      const row = q('.select-row-cb[data-id="1"]');

      check(row, false);

      assert.equal(page.state.selectMode, false);
    });

    test('tapping a card in select mode toggles it', async () => {
      await mountPage();
      page.state.selectMode = true;

      page._toggleCardSelection(2);
      assert.deepEqual([...page.state.selectedIds], [2]);

      page._toggleCardSelection(2);
      assert.equal(page.state.selectedIds.size, 0);
    });
  });

  describe('bulk actions', () => {
    test('applying a status walks the selection and reports the tally', async () => {
      await mountPage();
      click(q('#select-mode-btn'));
      page.state.selectedIds = new Set([1, 2]);
      q('#bulk-status-select').value = 'hidden';

      await page._handleBulkApply();
      await settle();

      assert.equal(sent('PATCH', '/api/posts/1/status').length, 1);
      assert.equal(sent('PATCH', '/api/posts/2/status').length, 1);
      assert.match(getToast().message, /All 2 posts updated/);
      assert.equal(page.state.selectMode, false, 'and the selection is spent');
    });

    test('a partial failure is counted rather than hidden', async () => {
      routes['PATCH /api/posts/2/status'] = () => fail(500, 'nope');
      await mountPage();
      click(q('#select-mode-btn'));
      page.state.selectedIds = new Set([1, 2]);

      await page._handleBulkApply();
      await settle();

      assert.match(getToast().message, /1 of 2 posts updated\. 1 failed/);
      assert.equal(getToast().type, 'error');
    });

    test('bulk delete asks once for the whole selection', async () => {
      await mountPage();
      click(q('#select-mode-btn'));
      page.state.selectedIds = new Set([1, 2]);

      page._handleBulkDelete();
      assert.match(confirmDialog().textContent, /Move 2 posts to Trash/);
      acceptConfirm();
      await settle();

      assert.equal(sent('DELETE', '/api/posts/1').length, 1);
      assert.equal(sent('DELETE', '/api/posts/2').length, 1);
      assert.match(getToast().message, /2 posts moved to Trash/);
    });

    test('a partial bulk delete failure is counted', async () => {
      routes['DELETE /api/posts/2'] = () => fail(500, 'nope');
      await mountPage();
      click(q('#select-mode-btn'));
      page.state.selectedIds = new Set([1, 2]);

      page._handleBulkDelete();
      acceptConfirm();
      await settle();

      assert.match(getToast().message, /1 of 2 posts moved to Trash\. 1 failed/);
    });
  });

  // ── Inline tag editing ────────────────────────────────────────────────────

  describe('editing tags in place', () => {
    test('saving tags patches the post and keeps the row in step', async () => {
      await mountPage();
      const post = page.state.posts[0];
      page._mountTagEditor(post);
      const editor = page._children.at(-1);

      await editor.props.onChange(['harbour', 'boats']);
      await settle();

      assert.deepEqual(sent('PATCH', '/api/posts/1/tags').at(-1).body.tags, ['harbour', 'boats']);
      assert.deepEqual(post.tags.map(t => t.name), ['harbour', 'boats']);
      assert.match(getToast().message, /Tags saved/);
    });

    test('a failure to save tags is reported', async () => {
      routes['PATCH /api/posts/1/tags'] = () => fail(500, 'tag limit reached');
      await mountPage();
      page._mountTagEditor(page.state.posts[0]);
      const editor = page._children.at(-1);

      await editor.props.onChange(['harbour']);
      await settle();

      assert.equal(getToast().type, 'error');
    });

    test('a row that is no longer on screen is skipped', async () => {
      await mountPage();
      const before = page._children.length;

      page._mountTagEditor({ id: 999, tags: [] });

      assert.equal(page._children.length, before);
    });
  });
});
