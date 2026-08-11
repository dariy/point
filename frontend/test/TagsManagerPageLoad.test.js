/**
 * TagsManagerPage — loading, the data operations, and the URL the editor keeps.
 *
 * What is left in the page after the extractions is wiring and data ops, and
 * this is the data-ops half: _load, _handleDelete, _handleRecalc, and the
 * history bookkeeping _openModal / _closeModal do around them.
 *
 * _load is more than a fetch. It also drives the deep link: /light/tags/:slug
 * opens that tag's editor as soon as the list arrives, and the three cases it
 * has to tell apart — a real slug, the literal 'new', and a slug that matches
 * nothing — are the difference between landing on an editor, a blank editor,
 * and a page that must not open one at all. Nothing about that is visible from
 * the list; a wrong branch either strands the user on a page with no editor or
 * opens a create form where they expected to edit.
 *
 * These tests mount the real page against the real admin layout and assert on
 * the requests leaving api/client.js. Nothing between the click and fetch is
 * stubbed.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire } from './helpers/dom.js';
import { store } from '../src/store.js';

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), parents: [], children: [], post_count: 0, ...over,
});

/** Travel > Kyoto, plus a parentless Food. */
const TAGS = [
  tag(1, 'Travel', { children: [{ id: 3 }] }),
  tag(2, 'Food'),
  tag(3, 'Kyoto', { parents: [{ id: 1, name: 'Travel' }], post_count: 4, description: 'Old capital' }),
];

describe('TagsManagerPage — loading and data operations', () => {
  let dom, TagsManagerPage, page, requests, respond, navRefreshes, onNavChanged;

  /** Record every request; reply with whatever `respond` currently returns. */
  function fakeFetch() {
    requests = [];
    respond = () => ({ ok: true, status: 200, body: { tags: TAGS, total: TAGS.length } });
    globalThis.fetch = async (url, opts = {}) => {
      requests.push({
        url,
        method: opts.method || 'GET',
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
      const { ok, status, body } = respond(url, opts);
      return { ok, status, headers: { get: () => 'application/json' }, json: async () => body };
    };
  }

  /** `METHOD /path` for each request, in order. */
  const trace = () => requests.map(r => `${r.method} ${r.url}`);
  const toast = () => store.get('toast');
  const q = sel => dom.document.querySelector(sel);
  const qa = sel => [...dom.document.querySelectorAll(sel)];
  const settle = () => new Promise(r => setImmediate(r));

  /** Mount the page as the router would, and wait for the first load. */
  async function mountPage({ slug = undefined, path = '/light/tags' } = {}) {
    dom.location.pathname = path;
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new TagsManagerPage(el, slug === undefined ? {} : { params: { slug } });
    page.mount();
    await settle();
    return page;
  }

  /** The tag names the tree is currently showing. */
  const renderedNames = () => qa('.tm-tag-name').map(el => el.textContent);

  /**
   * Open every collapsed branch, including the Unfiled group.
   *
   * A freshly loaded tree only shows its roots, so a child row — and the
   * buttons on it — is not in the document until someone expands it.
   */
  function revealAll() {
    click(page.container.querySelector('#expand-all-btn'));
    click(page.container.querySelector('#unfiled-toggle-btn'));
  }

  /** The editor modal's fields, or null when no editor is open. */
  function editor() {
    const form = q('#tag-editor-form');
    if (!form) return null;
    return {
      form,
      name: form.querySelector('[name="name"]').value,
      slug: form.querySelector('#modal-slug').value,
      checkedParents: [...form.querySelectorAll('input[name="parent_ids"]:checked')].map(b => Number(b.value)),
    };
  }

  beforeEach(async () => {
    dom = setupDOM('<!doctype html><html><body></body></html>', { path: '/light/tags' });
    fakeFetch();
    store.set('toast', null);
    store.set('user', { username: 'tester' });

    // The nav is a sibling of this page in the app shell; the event is the only
    // thing the page says to it, so counting them is what "the nav was told" means.
    navRefreshes = 0;
    onNavChanged = () => { navRefreshes++; };
    dom.document.addEventListener('nav-changed', onNavChanged);

    ({ default: TagsManagerPage } = await import('../src/pages/light/TagsManagerPage.js'));
  });

  afterEach(() => {
    // Unmount before the globals go: the admin layout holds store subscriptions
    // that re-render this page, and a leaked one renders into the next test's DOM.
    page?.unmount();
    page = null;
    delete globalThis.fetch;
    dom.cleanup();
  });

  // ── _load ──────────────────────────────────────────────────────────────────

  test('mounting asks for every tag, including the ones with no posts', async () => {
    await mountPage();

    assert.deepEqual(trace(), ['GET /api/tags?include_empty=true'],
      'include_empty, because an unused tag is exactly the one you came here to delete');
    assert.equal(page.state.loading, false);
    assert.deepEqual(renderedNames(), ['Travel'], 'a fresh tree shows its roots, collapsed');
    assert.equal(q('.tm-unfiled-count').textContent, '(1)', 'and counts what is filed nowhere');

    revealAll();
    assert.deepEqual(renderedNames(), ['Travel', 'Kyoto', 'Food'], 'every tag arrived');
  });

  test('the spinner shows until the tags arrive, then gives way to the tree', async () => {
    dom.location.pathname = '/light/tags';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new TagsManagerPage(el, {});
    page.mount();

    assert.ok(q('.loading-spinner'), 'the request is in flight');
    assert.equal(renderedNames().length, 0);

    await settle();

    assert.equal(q('.loading-spinner'), null, 'and gone once it lands');
    assert.ok(renderedNames().length > 0);
  });

  test('a failed load empties the page and reports it', async () => {
    // BUG point-tags-load-error-state-dead-80li, asserted as it behaves today:
    // the page has an `error` state and renders it, but nothing ever sets it.
    // A failed load therefore paints the ordinary empty tree — "No tags found."
    // — and once the toast fades the page claims the site has no tags.
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args);
    respond = () => ({ ok: false, status: 500, body: { detail: 'boom' } });

    try {
      await mountPage();
    } finally {
      console.error = realError;
    }

    assert.equal(toast().type, 'error');
    assert.equal(toast().message, 'Could not load tags.');
    assert.equal(page.state.loading, false, 'the spinner must not be left spinning');
    assert.deepEqual(page.state.tags, [], 'and stale tags must not be left on screen');
    assert.equal(errors.length, 1, 'the failure is logged for the console too');
  });

  test('a load that fails after a good one clears what was on screen', async () => {
    // The catch resets tags to []. It matters on the second load, not the
    // first: leaving the previous list up would present tags that may since
    // have been deleted as though they were just fetched.
    const realError = console.error;
    console.error = () => {};
    try {
      await mountPage();
      assert.ok(renderedNames().length > 0);

      respond = () => ({ ok: false, status: 500, body: { detail: 'boom' } });
      await page._load();
      await settle();
    } finally {
      console.error = realError;
    }

    assert.deepEqual(page.state.tags, []);
    assert.deepEqual(renderedNames(), [], 'nothing stale is left behind');
  });

  test('reloading replaces the rendered tags rather than adding to them', async () => {
    await mountPage();

    respond = () => ({ ok: true, status: 200, body: { tags: [tag(9, 'Osaka', { nav_order: 1 })], total: 1 } });
    await page._load();
    await settle();

    assert.deepEqual(renderedNames(), ['Osaka']);
  });

  // ── The deep link: /light/tags/:slug ───────────────────────────────────────

  test('/light/tags/:slug opens that tag in the editor once the list arrives', async () => {
    await mountPage({ slug: 'kyoto', path: '/light/tags/kyoto' });

    const ed = editor();
    assert.ok(ed, 'the editor opens by itself — that is what the deep link is for');
    assert.equal(ed.name, 'Kyoto');
    assert.deepEqual(ed.checkedParents, [1],
      'the tag is opened with its own structure, so this is an edit, not a blank form');
    assert.equal(page._initialParentIds.length, 1, 'and the save diff is snapshotted against it');
  });

  test('/light/tags/new opens an empty editor', async () => {
    await mountPage({ slug: 'new', path: '/light/tags/new' });

    const ed = editor();
    assert.ok(ed, "'new' is not a slug to look up — it is the create form");
    assert.equal(ed.name, '', 'nothing is prefilled');
    assert.deepEqual(ed.checkedParents, [], 'and nothing is filed anywhere yet');
  });

  test('a slug matching no tag opens no editor, and the page still works', async () => {
    await mountPage({ slug: 'atlantis', path: '/light/tags/atlantis' });

    assert.equal(editor(), null, 'a stale link must not open a create form the user did not ask for');
    revealAll();
    assert.deepEqual(renderedNames(), ['Travel', 'Kyoto', 'Food'], 'the list is there to pick from');
  });

  test('no slug means no editor', async () => {
    await mountPage();

    assert.equal(editor(), null);
  });

  test('arriving by URL opens the editor and preserves the URL', async () => {
    await mountPage({ slug: 'kyoto', path: '/light/tags/kyoto' });

    assert.ok(editor(), 'the editor does open');
    assert.deepEqual(dom.history.entries, [], 'nothing was pushed');
    assert.equal(dom.location.pathname, '/light/tags/kyoto', 'and the tag stays in the URL');
  });

  test('opening the editor from the page does push, and closing puts the URL back', async () => {
    await mountPage();
    revealAll();

    click(qa('.edit-tag-btn').find(b => b.dataset.id === '3'));
    assert.deepEqual(dom.history.entries, [['push', '/light/tags/kyoto']],
      'an open editor is a place you can link to and go back from');

    page._closeModal();
    assert.equal(dom.location.pathname, '/light/tags',
      'and closing it leaves the list URL, not the tag it just closed');
    assert.deepEqual(dom.history.entries.at(-1), ['replace', '/light/tags']);
  });

  test('the header links to the tag being edited, not the site root', async () => {
    await mountPage({ slug: 'kyoto', path: '/light/tags/kyoto' });

    assert.equal(page.container.querySelector('.public-home-link').getAttribute('href'), '/tags/kyoto',
      'the View-public-site button follows the deep link');
  });

  test('Escape closes the editor', async () => {
    await mountPage({ slug: 'kyoto', path: '/light/tags/kyoto' });

    fire(dom.document, 'keydown', { key: 'Escape' });

    assert.equal(editor(), null);
    assert.equal(page._modal, null);
  });

  // ── _handleDelete ──────────────────────────────────────────────────────────

  /** Click a row's delete button and hand back the confirm dialog's parts. */
  function clickDelete(id) {
    click(qa('.delete-tag-btn').find(b => b.dataset.id === String(id)));
    return {
      message: q('.modal-body p')?.textContent,
      ok: q('#confirm-ok-btn'),
      cancel: q('#confirm-cancel-btn'),
    };
  }

  test('deleting asks first, names the tag, and says the posts survive', async () => {
    await mountPage();
    revealAll();

    const dialog = clickDelete(3);

    assert.ok(dialog.ok, 'delete is never immediate');
    assert.match(dialog.message, /Kyoto/, 'the user must see which tag they are about to lose');
    assert.match(dialog.message, /Posts will NOT be deleted/);
    assert.equal(requests.length, 1, 'and nothing has been sent yet');
  });

  test('confirming deletes the tag, reloads the list and tells the nav', async () => {
    await mountPage();
    revealAll();
    requests.length = 0;

    click(clickDelete(3).ok);
    await settle();

    assert.deepEqual(trace(), ['DELETE /api/tags/3', 'GET /api/tags?include_empty=true'],
      'the list must be re-read — deleting a parent changes rows that are still on screen');
    assert.equal(toast().type, 'success');
    assert.equal(navRefreshes, 1, 'the public nav shows tags, so it has to be told');
  });

  test('cancelling deletes nothing', async () => {
    await mountPage();
    revealAll();
    requests.length = 0;

    click(clickDelete(3).cancel);
    await settle();

    assert.deepEqual(trace(), []);
    assert.equal(q('#confirm-ok-btn'), null, 'and the dialog goes away');
  });

  test('a failed delete reports the server message and reloads nothing', async () => {
    await mountPage();
    revealAll();
    requests.length = 0;
    respond = () => ({ ok: false, status: 409, body: { detail: 'Tag still has children' } });

    click(clickDelete(3).ok);
    await settle();

    assert.deepEqual(trace(), ['DELETE /api/tags/3'], 'no reload after a failure');
    assert.equal(toast().message, 'Tag still has children');
    assert.equal(toast().type, 'error');
    assert.equal(navRefreshes, 0, 'and nothing changed, so the nav is not told anything');
  });

  // ── _handleRecalc ──────────────────────────────────────────────────────────

  test('recalculating counts posts once and re-reads the list', async () => {
    await mountPage();
    requests.length = 0;
    respond = url => (url.endsWith('/recalculate-counts')
      ? { ok: true, status: 200, body: {} }
      : { ok: true, status: 200, body: { tags: [tag(3, 'Kyoto', { nav_order: 1, post_count: 7 })], total: 1 } });

    click(page.container.querySelector('#recalc-counts-btn'));
    await settle();

    assert.deepEqual(trace(), ['POST /api/tags/recalculate-counts', 'GET /api/tags?include_empty=true'],
      'the new counts are only visible after a reload');
    assert.equal(toast().type, 'success');
    assert.equal(q('.tm-count-badge').textContent, '7');
  });

  test('a failed recalculation reports it and leaves the counts alone', async () => {
    await mountPage();
    requests.length = 0;
    respond = () => ({ ok: false, status: 500, body: { detail: 'Recount timed out' } });

    click(page.container.querySelector('#recalc-counts-btn'));
    await settle();

    assert.deepEqual(trace(), ['POST /api/tags/recalculate-counts']);
    assert.equal(toast().message, 'Recount timed out');
    assert.equal(toast().type, 'error');
  });
});
