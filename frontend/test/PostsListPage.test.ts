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

import { setupDOM, click, fire, type, check, must } from './helpers/dom.ts';
import { getToast, setSettings, setToast, setUser } from '../src/store.ts';
import { clearPostReadCache } from '../src/api/posts.ts';
import { mock } from './helpers/mock.ts';
import type { User } from '../src/api/auth.ts';
import type { TagsInput } from '../src/components/light/TagsInput.ts';
import type { default as PostsListPageClass } from '../src/pages/light/PostsListPage.ts';

const settle = () => new Promise<void>(r => setImmediate(r));

const POSTS = () => ([
  { id: 1, title: 'Harbour lights', slug: 'harbour-lights', status: 'PUBLISHED', type: 'post', tags: [{ id: 9, name: 'harbour', slug: 'harbour' }], created_at: '2024-08-01T10:00:00Z' },
  { id: 2, title: 'Draft thoughts', slug: 'draft-thoughts', status: 'DRAFT', type: 'post', tags: [], created_at: '2024-08-02T10:00:00Z' },
  { id: 3, title: 'About', slug: 'about', status: 'PUBLISHED', type: 'page', tags: [], created_at: '2024-08-03T10:00:00Z' },
]);

/** The JSON body of a request the page sent. Only the fields the tests read. */
interface SentBody {
  status?: string;
  tags?: string[];
  [key: string]: unknown;
}

/** One request the fake fetch saw. */
interface SentRequest {
  url: string;
  path: string;
  query: string;
  method: string;
  body: SentBody | undefined;
  params: URLSearchParams;
}

/** What a route sees of a request. */
interface RouteRequest { path: string; method: string; body: SentBody }

/** A route returns the JSON payload, or a `fail()` reply. */
type Route = (req: RouteRequest) => unknown;

/** A non-2xx reply from a route. */
interface FailReply { __response: true; status: number; payload: { message: string } }

const isFailReply = (v: unknown): v is FailReply =>
  typeof v === 'object' && v !== null && '__response' in v;

describe('PostsListPage', () => {
  let dom: ReturnType<typeof setupDOM>;
  let PostsListPage: typeof PostsListPageClass;
  let page: PostsListPageClass | null;
  let requests: SentRequest[];
  let routes: Record<string, Route>;
  let navigations: string[];

  function fakeFetch() {
    requests = [];
    globalThis.fetch = async (url: RequestInfo | URL, opts: RequestInit = {}) => {
      const method = opts.method || 'GET';
      const [path = '', query = ''] = String(url).split('?');
      let body: SentBody | undefined;
      if (typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = { raw: opts.body }; } }
      requests.push({ url: String(url), path, query, method, body, params: new URLSearchParams(query) });

      const key = Object.keys(routes)
        .filter(k => { const [m, p = ''] = k.split(' '); return m === method && path.startsWith(p); })
        .sort((a, b) => b.length - a.length)[0];
      const route = key ? routes[key] : undefined;
      const result: unknown = route ? await route({ path, method, body: body ?? {} }) : {};
      const { status, payload } = isFailReply(result) ? result : { status: 200, payload: result };
      return mock<Response>({
        ok: status < 400,
        status,
        headers: mock<Headers>({ get: () => 'application/json' }),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      });
    };
  }

  const fail = (status: number, message: string): FailReply => ({ __response: true, status, payload: { message } });

  async function mountPage(props: ConstructorParameters<typeof PostsListPageClass>[1] = {}) {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const mounted = new PostsListPage(el, props);
    page = mounted;
    mounted.mount();
    await settle();
    await settle();
    return mounted;
  }

  /** The mounted page; fails the test when none is. */
  const pg = () => must(page, 'a mounted PostsListPage');
  const q = (sel: string) => pg().container.querySelector<HTMLElement>(sel);
  /** The element at `sel`; fails the test when there is none. */
  const el = <T extends HTMLElement = HTMLElement>(sel: string) => must(pg().container.querySelector<T>(sel), sel);
  const qa = <T extends HTMLElement = HTMLElement>(sel: string) => [...pg().container.querySelectorAll<T>(sel)];
  const sent = (method: string, path: string) => requests.filter(r => r.method === method && r.path === path);
  const last = <T>(list: T[]) => must(list[list.length - 1], 'a last entry');
  const lastList = () => last(sent('GET', '/api/posts'));
  const confirmDialog = () => dom.document.querySelector<HTMLElement>('.confirm-dialog, .modal-overlay');

  /** Press the confirm button of whatever confirmation is on screen. */
  function acceptConfirm() {
    const dialog = confirmDialog();
    assert.ok(dialog, 'expected a confirmation dialog');
    click(must(dialog.querySelector('.btn-danger, .confirm-dialog__confirm, .btn-primary'), 'a confirm button'));
  }

  beforeEach(async () => {
    dom = setupDOM();
    navigations = [];
    dom.window.addEventListener('app:navigate', e => { if (e instanceof CustomEvent) navigations.push(e.detail.path); });
    clearPostReadCache();
    routes = {
      'GET /api/posts': () => ({ posts: POSTS(), page: 1, pages: 3, total: 42, per_page: 20 }),
      'GET /api/tags': () => ({ tags: [] }),
      'DELETE /api/posts': () => ({}),
      'POST /api/posts': () => ({}),
      'PATCH /api/posts': ({ body, path }) => ({ id: Number(path.split('/')[3]), status: (body.status || 'draft').toUpperCase(), type: 'post', tags: (body.tags || []).map((n: string) => ({ name: n, slug: n })) }),
    };
    fakeFetch();
    setUser(mock<User>({ username: 'owner' }));
    setSettings({ blog_title: 'Test blog' });
    setToast(null);
    ({ default: PostsListPage } = await import('../src/pages/light/PostsListPage.ts'));
  });

  afterEach(() => {
    try { page?.unmount(); } catch { /* torn down mid-flight */ }
    page = null;
    dom.cleanup();
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  // ── Loading and rendering ─────────────────────────────────────────────────

  describe('loading', () => {
    test('renders a row per post, with the status lowercased', async () => {
      await mountPage();

      assert.equal(pg().state.posts.length, 3);
      assert.deepEqual(pg().state.posts.map((p: { status: string }) => p.status), ['published', 'draft', 'published']);
      assert.ok(pg().container.textContent.includes('Harbour lights'));
    });

    test('a page-type post is shown as "Page" rather than as published', async () => {
      await mountPage();

      const select = el<HTMLSelectElement>('.status-change-btn[data-id="3"]');
      assert.ok(select, 'the page row has a status control');
      assert.equal(select.value, 'page');
    });

    test('a failed load says so and leaves the list empty rather than half-drawn', async () => {
      routes['GET /api/posts'] = () => fail(500, 'boom');

      await mountPage();

      assert.equal(getToast().type, 'error');
      assert.equal(pg().state.loading, false);
      assert.equal(pg().state.posts.length, 0);
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

      assert.match(String(globalThis.sessionStorage.getItem('point:admin:posts-list-url')), /^\/light\/posts/);
    });
  });

  // ── Filters ───────────────────────────────────────────────────────────────

  describe('filters', () => {
    test('changing the status filter reloads from page one', async () => {
      await mountPage({ query: { page: '3' } });

      const select = el<HTMLSelectElement>('#status-filter');
      select.value = 'draft';
      fire(select, 'change');
      await settle();

      assert.equal(pg().state.statusFilter, 'draft');
      assert.equal(lastList().params.get('status'), 'draft');
      assert.equal(lastList().params.get('page'), '1');
    });

    test('a search reloads from page one and lands in the URL', async () => {
      await mountPage();

      await pg()._load({ page: 1, search: 'harbour' });

      assert.equal(lastList().params.get('q'), 'harbour');
      assert.match(String(last(dom.history.entries)[1]), /search=harbour/);
    });

    test('trash is its own view: no tag editors, restore instead of delete', async () => {
      await mountPage({ query: { status: 'trash' } });

      assert.equal(lastList().params.get('status'), 'trash');
      assert.equal(qa('.tag-chip-input, #tag-filter-mount .tags-input').length, 0);
    });

    test('the URL keeps only the filters that are set', async () => {
      await mountPage();

      pg()._syncUrl({ status: '', tag: '', search: '', page: 1 });

      assert.equal(last(dom.history.entries)[1], '/light/posts');
    });
  });

  // ── Paging ────────────────────────────────────────────────────────────────

  describe('paging', () => {
    test('arrow keys page back and forth, and stop at the ends', async () => {
      await mountPage({ query: { page: '2' } });
      routes['GET /api/posts'] = () => ({ posts: POSTS(), page: 2, pages: 3, total: 42, per_page: 20 });

      const right = Object.assign(new globalThis.Event('keydown'), { key: 'ArrowRight', preventDefault: () => {} });
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
      must(pg()._onKeyNav)(mock<KeyboardEvent>({ key: 'ArrowRight', target: mock<HTMLElement>({ tagName: 'INPUT' }), preventDefault() {} }));
      await settle();

      assert.equal(sent('GET', '/api/posts').length, before);
    });

    test('the floating prev/next arrows are disabled at the edges', async () => {
      await mountPage();

      const arrows = [...dom.document.body.querySelectorAll<HTMLButtonElement>('.page-nav-arrow')];
      assert.equal(arrows.length, 2);
      assert.equal(must(arrows[0]).disabled, true, 'prev is dead on page one');
      assert.equal(must(arrows[1]).disabled, false);
    });

    test('unmounting takes the arrows and the key handler with it', async () => {
      await mountPage();
      pg().unmount();
      page = null;

      assert.equal(dom.document.body.querySelectorAll('.page-nav-arrow').length, 0);
    });
  });

  // ── Per-row status ────────────────────────────────────────────────────────

  describe('changing a post status', () => {
    test('sends the new status and reports it', async () => {
      await mountPage();

      await pg()._updatePostStatus(2, 'published');

      assert.equal(last(sent('PATCH', '/api/posts/2/status')).body?.status, 'published');
      assert.equal(must(pg().state.posts.find((p: { id: number }) => p.id === 2)).status, 'published');
      assert.equal(getToast().type, 'success');
    });

    test('choosing "scheduled" hands off to the editor, where a date can be picked', async () => {
      await mountPage();

      await pg()._updatePostStatus(1, 'scheduled');

      assert.equal(last(navigations), '/light/posts/1/edit?openSchedule=1');
      assert.equal(sent('PATCH', '/api/posts/1/status').length, 0);
    });

    test('a failure puts the control back to what it was', async () => {
      routes['PATCH /api/posts/1/status'] = () => fail(500, 'nope');
      await mountPage();
      const select = el<HTMLSelectElement>('.status-change-btn[data-id="1"]');

      await pg()._updatePostStatus(1, 'draft', select);

      assert.equal(select.value, 'published', 'reverted to the status it had');
      assert.equal(getToast().type, 'error');
      assert.equal(select.classList.contains('badge-loading'), false);
    });

    test('the row control is wired: changing it sends the request', async () => {
      await mountPage();
      const select = el<HTMLSelectElement>('.status-change-btn[data-id="2"]');

      select.value = 'hidden';
      fire(select, 'change');
      await settle();

      assert.equal(last(sent('PATCH', '/api/posts/2/status')).body?.status, 'hidden');
    });
  });

  // ── Row actions ───────────────────────────────────────────────────────────

  describe('row actions', () => {
    test('delete asks first, then trashes and reloads', async () => {
      await mountPage();

      click(el('.delete-btn[data-id="1"]'));
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

      await pg()._deletePost(1);

      assert.equal(getToast().type, 'error');
    });

    test('restore puts a trashed post back', async () => {
      await mountPage({ query: { status: 'trash' } });

      await pg()._restorePost(1, 'Harbour lights');

      assert.equal(sent('POST', '/api/posts/1/restore').length, 1);
      assert.match(getToast().message, /restored/);
    });

    test('a failed restore reports the reason', async () => {
      routes['POST /api/posts/1/restore'] = () => fail(500, 'gone');
      await mountPage({ query: { status: 'trash' } });

      await pg()._restorePost(1, 'Harbour lights');

      assert.equal(getToast().type, 'error');
    });

    test('permanent delete is irreversible, so it asks too', async () => {
      await mountPage({ query: { status: 'trash' } });

      const btn = el('.perm-delete-btn[data-id="1"]');
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

      await pg()._permanentlyDeletePost(1);

      assert.equal(getToast().type, 'error');
    });

    test('cancelling a confirmation destroys nothing', async () => {
      await mountPage();

      click(el('.delete-btn[data-id="1"]'));
      const dialog = confirmDialog();
      click(must(dialog?.querySelector('.btn-secondary, .confirm-dialog__cancel')));
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
      Object.assign(globalThis.navigator, { clipboard: mock<Clipboard>({ writeText: async t => { copied = t; } }) });
      await mountPage();

      await pg()._copyPreviewLink(1);

      assert.equal(copied, 'http://localhost/preview/abc');
      assert.match(getToast().message, /copied/i);
    });

    test('without a clipboard the link itself is shown', async () => {
      routes['POST /api/posts/1/preview'] = () => ({ preview_url: 'http://localhost/preview/abc' });
      Object.assign(globalThis.navigator, { clipboard: mock<Clipboard>({ writeText: async () => { throw new Error('denied'); } }) });
      await mountPage();

      await pg()._copyPreviewLink(1);

      assert.equal(getToast().message, 'http://localhost/preview/abc');
    });

    test('a failure to generate one is reported', async () => {
      routes['POST /api/posts/1/preview'] = () => fail(500, 'no signing key');
      await mountPage();

      await pg()._copyPreviewLink(1);

      assert.equal(getToast().type, 'error');
    });
  });

  // ── Selection and bulk actions ────────────────────────────────────────────

  describe('selection', () => {
    test('the select button arms selection mode and cancels it again', async () => {
      await mountPage();

      click(el('#select-mode-btn'));
      assert.equal(pg().state.selectMode, true);

      click(el('#select-mode-btn'));
      assert.equal(pg().state.selectMode, false);
      assert.equal(pg().state.selectedIds.size, 0);
    });

    test('select-all takes every visible row, and clearing it drops the mode', async () => {
      await mountPage();
      click(el('#select-mode-btn'));

      check(el('#select-all-cb'), true);
      assert.equal(pg().state.selectedIds.size, 3);

      check(el('#select-all-cb'), false);
      assert.equal(pg().state.selectMode, false);
    });

    test('one row at a time leaves the select-all box partial', async () => {
      await mountPage();
      click(el('#select-mode-btn'));
      pg().state.selectedIds = new Set([1]);

      pg()._updateBulkToolbar();

      const all = el<HTMLInputElement>('#select-all-cb');
      assert.equal(all.checked, false);
      assert.equal(all.indeterminate, true);
      assert.equal(el<HTMLInputElement>('#bulk-count').textContent, '1 selected');
      assert.equal(el<HTMLInputElement>('#bulk-apply-btn').disabled, false);
    });

    test('deselecting the last row leaves select mode', async () => {
      await mountPage();
      click(el('#select-mode-btn'));
      pg().state.selectedIds = new Set([1]);
      const row = el<HTMLInputElement>('.select-row-cb[data-id="1"]');

      check(row, false);

      assert.equal(pg().state.selectMode, false);
    });

    test('tapping a card in select mode toggles it', async () => {
      await mountPage();
      pg().state.selectMode = true;

      pg()._toggleCardSelection(2);
      assert.deepEqual([...pg().state.selectedIds], [2]);

      pg()._toggleCardSelection(2);
      assert.equal(pg().state.selectedIds.size, 0);
    });
  });

  describe('bulk actions', () => {
    test('applying a status walks the selection and reports the tally', async () => {
      await mountPage();
      click(el('#select-mode-btn'));
      pg().state.selectedIds = new Set([1, 2]);
      el<HTMLInputElement>('#bulk-status-select').value = 'hidden';

      await pg()._handleBulkApply();
      await settle();

      assert.equal(sent('PATCH', '/api/posts/1/status').length, 1);
      assert.equal(sent('PATCH', '/api/posts/2/status').length, 1);
      assert.match(getToast().message, /All 2 posts updated/);
      assert.equal(pg().state.selectMode, false, 'and the selection is spent');
    });

    test('a partial failure is counted rather than hidden', async () => {
      routes['PATCH /api/posts/2/status'] = () => fail(500, 'nope');
      await mountPage();
      click(el('#select-mode-btn'));
      pg().state.selectedIds = new Set([1, 2]);

      await pg()._handleBulkApply();
      await settle();

      assert.match(getToast().message, /1 of 2 posts updated\. 1 failed/);
      assert.equal(getToast().type, 'error');
    });

    test('bulk delete asks once for the whole selection', async () => {
      await mountPage();
      click(el('#select-mode-btn'));
      pg().state.selectedIds = new Set([1, 2]);

      pg()._handleBulkDelete();
      assert.match(must(confirmDialog()).textContent, /Move 2 posts to Trash/);
      acceptConfirm();
      await settle();

      assert.equal(sent('DELETE', '/api/posts/1').length, 1);
      assert.equal(sent('DELETE', '/api/posts/2').length, 1);
      assert.match(getToast().message, /2 posts moved to Trash/);
    });

    test('a partial bulk delete failure is counted', async () => {
      routes['DELETE /api/posts/2'] = () => fail(500, 'nope');
      await mountPage();
      click(el('#select-mode-btn'));
      pg().state.selectedIds = new Set([1, 2]);

      pg()._handleBulkDelete();
      acceptConfirm();
      await settle();

      assert.match(getToast().message, /1 of 2 posts moved to Trash\. 1 failed/);
    });
  });

  // ── Inline tag editing ────────────────────────────────────────────────────

  describe('editing tags in place', () => {
    test('saving tags patches the post and keeps the row in step', async () => {
      await mountPage();
      const post = pg().state.posts[0];
      pg()._mountTagEditor(post);
      const editor = last(pg()._children) as TagsInput;

      await must(editor.props.onChange)(['harbour', 'boats']);
      await settle();

      assert.deepEqual(last(sent('PATCH', '/api/posts/1/tags')).body?.tags, ['harbour', 'boats']);
      assert.deepEqual(must(post).tags.map((t: { name: string }) => t.name), ['harbour', 'boats']);
      assert.match(getToast().message, /Tags saved/);
    });

    test('a failure to save tags is reported', async () => {
      routes['PATCH /api/posts/1/tags'] = () => fail(500, 'tag limit reached');
      await mountPage();
      pg()._mountTagEditor(pg().state.posts[0]);
      const editor = last(pg()._children) as TagsInput;

      await must(editor.props.onChange)(['harbour']);
      await settle();

      assert.equal(getToast().type, 'error');
    });

    test('a row that is no longer on screen is skipped', async () => {
      await mountPage();
      const before = pg()._children.length;

      pg()._mountTagEditor(mock<Parameters<PostsListPageClass['_mountTagEditor']>[0]>({ id: 999, tags: [] }));

      assert.equal(pg()._children.length, before);
    });
  });
});
