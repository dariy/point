/**
 * _handleSave — the editor modal's save path.
 *
 * This is live mutation logic: it reads the form, decides between create and
 * update, and decides whether the two structure endpoints are called at all by
 * diffing the submitted parents/children against the snapshot _openModal took
 * when it opened. A wrong diff either drops a reparent the user asked for or
 * rewrites a hierarchy they never touched, and neither shows up in the UI.
 *
 * The tests drive the real modal — _openModal renders the real editor form and
 * wires the real submit handler — and assert on the HTTP requests that leave
 * api/client.ts. Nothing between the click and fetch is stubbed.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, check, fire, type, must } from './helpers/dom.ts';
import type * as Store from '../src/store.ts';
import type TagsManagerPageClass from '../src/pages/light/TagsManagerPage.ts';
import type { TreeTag } from '../src/components/light/tags/TagTreeView.ts';
import { fixtureTag } from './helpers/tags.ts';
import { jsonResponse, requestOf, type RecordedRequest, type Responder } from './helpers/fetch.ts';

const TAGS = [
  { id: 1, name: 'Travel',  slug: 'travel',  parents: [], children: [{ id: 3 }], post_count: 0 },
  { id: 2, name: 'Food',    slug: 'food',    parents: [], children: [], post_count: 0 },
  { id: 3, name: 'Kyoto',   slug: 'kyoto',   parents: [{ id: 1, name: 'Travel' }], children: [], post_count: 4,
    description: 'Old capital', kind: 'topic', in_ancestor_flyout: true },
].map(fixtureTag);

/** The tag as _openModal receives it, with its structure resolved. */
const kyoto = () => fixtureTag({ ...TAGS[2], parents: [{ id: 1, name: 'Travel' }], children: [] });

describe('TagsManagerPage._handleSave', () => {
  let dom: ReturnType<typeof setupDOM>;
  let page: TagsManagerPageClass;
  let requests: RecordedRequest[];
  let respond: Responder;
  let getToast: typeof Store.getToast;
  let setToast: typeof Store.setToast;
  /** Calls to the stubbed _load and _refreshNavTags of the current page. */
  let reloaded: number;
  let navRefreshed: number;

  /** A field of the editor form; the test fails when there is none. Typed as an input, the widest control. */
  const field = (form: ParentNode, sel: string) => must(form.querySelector<HTMLInputElement>(sel), sel);

  /** Record every request; reply with whatever `respond` currently returns. */
  function fakeFetch() {
    requests = [];
    respond = () => ({ ok: true, status: 200, body: {} });
    globalThis.fetch = async (input: RequestInfo | URL, opts: RequestInit = {}) => {
      const req = requestOf(input, opts);
      requests.push(req);
      return jsonResponse(respond(req.url, opts));
    };
  }

  /** Requests to a path, in order — the API surface each test asserts on. */
  const to = (path: string) => requests.filter(r => r.url === path);
  /** The JSON body of the `i`th request to a path; the test fails when there is none. */
  const bodyOf = (path: string, i = 0) => must(to(path)[i]?.body, `${path} body`);

  beforeEach(async () => {
    dom = setupDOM('<!doctype html><html><body></body></html>', { path: '/light/tags' });
    fakeFetch();

    ({ getToast, setToast } = await import('../src/store.ts'));
    const { default: TagsManagerPage } = await import('../src/pages/light/TagsManagerPage.ts');

    page = new TagsManagerPage(dom.document.createElement('div'));
    page.state.loading = false;
    page.state.tags = TAGS;

    // _load re-renders the whole page and _refreshNavTags fans out to the app
    // shell; both are covered elsewhere. Here they are the observable effect of
    // a successful save, so record the calls and stop.
    reloaded = 0;
    navRefreshed = 0;
    page._load = async () => { reloaded++; };
    page._refreshNavTags = async () => { navRefreshed++; };

    setToast(null);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'fetch');
    dom.cleanup();
  });

  /** Open the editor and hand back the form plus its submit button. */
  function openEditor(tag: TreeTag | null = null, parentId: number | null = null) {
    page._openModal(tag, parentId);
    const form = must(dom.document.querySelector<HTMLFormElement>('#tag-editor-form'), 'editor form');
    return { form, submit: field(form, '[type="submit"]') };
  }

  /** Tick the structure checkbox for `tagId` in the parents or children tree. */
  function toggleStructure(form: HTMLFormElement, inputName: string, tagId: number, on: boolean) {
    const box = must(form.querySelector<HTMLInputElement>(`input[name="${inputName}"][value="${tagId}"]`), `${inputName} checkbox for tag ${tagId}`);
    assert.ok(box, `expected a ${inputName} checkbox for tag ${tagId}`);
    return check(box, on);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  test('a new tag POSTs once, with its structure inline', async () => {
    const { form } = openEditor(null, 1);   // "add child of Travel"

    type(field(form, '[name="name"]'), 'Osaka');
    await page._handleSave(form, null);

    assert.equal(requests.length, 1, 'create is a single call — no structure endpoints');
    const [req] = to('/api/tags');
    assert.equal(req.method, 'POST');
    assert.equal(req.body?.name, 'Osaka');
    assert.equal(req.body?.slug, 'osaka', 'the slug auto-fills from the name');
    assert.deepEqual(req.body?.parent_ids, [1], 'the seeded parent rides along in the create');
    assert.deepEqual(req.body?.child_ids, []);
    assert.equal(getToast().type, 'success');
  });

  test('trims text fields and reads the checkbox flags off the form', async () => {
    const { form } = openEditor();

    field(form, '[name="name"]').value = '  Osaka  ';
    field(form, '[name="slug"]').value = '  osaka  ';
    field(form, '[name="description"]').value = '  Kansai  ';
    check(field(form, '[name="hidden"]'), true);
    check(field(form, '[name="in_ancestor_flyout"]'), false);

    await page._handleSave(form, null);

    const body = bodyOf('/api/tags');
    assert.equal(body.name, 'Osaka');
    assert.equal(body.slug, 'osaka');
    assert.equal(body.description, 'Kansai');
    assert.equal(body.hidden, true, 'a ticked box is true');
    assert.equal(body.hides_posts, false, 'an unticked box is false, not absent');
    assert.equal(body.in_ancestor_flyout, false, 'unticking the default clears it');
    assert.equal(body.kind, 'topic', 'the checked radio wins');
  });

  test('nav_order is null unless the tag is in the nav, and defaults to 0 there', async () => {
    let { form } = openEditor();
    type(field(form, '[name="name"]'), 'Osaka');
    await page._handleSave(form, null);
    assert.equal(bodyOf('/api/tags').nav_order, null, 'off the nav, order is null');

    // ponytail: the box on with the position left blank must still enable nav.
    requests.length = 0;
    ({ form } = openEditor());
    type(field(form, '[name="name"]'), 'Osaka');
    check(field(form, '#in-nav-check'), true);
    field(form, '[name="nav_order"]').value = '';
    await page._handleSave(form, null);
    assert.equal(bodyOf('/api/tags').nav_order, 0, 'blank position means first, not "not in nav"');

    requests.length = 0;
    ({ form } = openEditor());
    type(field(form, '[name="name"]'), 'Osaka');
    check(field(form, '#in-nav-check'), true);
    field(form, '[name="nav_order"]').value = '3';
    await page._handleSave(form, null);
    assert.equal(bodyOf('/api/tags').nav_order, 3, 'a number is parsed, not passed as a string');
  });

  test('blank coordinates are null rather than NaN', async () => {
    const { form } = openEditor();
    type(field(form, '[name="name"]'), 'Osaka');
    await page._handleSave(form, null);

    const body = bodyOf('/api/tags');
    assert.strictEqual(body.latitude, null);
    assert.strictEqual(body.longitude, null);

    requests.length = 0;
    const second = openEditor().form;
    type(field(second, '[name="name"]'), 'Osaka');
    field(second, '#coord-lat').value = '34.69';
    field(second, '#coord-lng').value = '135.50';
    await page._handleSave(second, null);
    assert.equal(bodyOf('/api/tags').latitude, 34.69);
    assert.equal(bodyOf('/api/tags').longitude, 135.5);
  });

  // ── Update, and the structure diff ────────────────────────────────────────

  test('editing without touching the structure PATCHes and nothing else', async () => {
    const { form } = openEditor(kyoto());

    type(field(form, '[name="name"]'), 'Kyoto City');
    await page._handleSave(form, 3);

    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), ['PATCH /api/tags/3'],
      'an unchanged hierarchy must not be rewritten');
    assert.equal(bodyOf('/api/tags/3').name, 'Kyoto City');
    assert.ok(!('parent_ids' in bodyOf('/api/tags/3')), 'structure never travels in the PATCH');
  });

  test('changing the parents calls setTagParents, and only that', async () => {
    const { form } = openEditor(kyoto());

    toggleStructure(form, 'parent_ids', 2, true);   // also file it under Food

    await page._handleSave(form, 3);

    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`),
      ['PATCH /api/tags/3', 'PUT /api/tags/3/parents']);
    const ids = bodyOf('/api/tags/3/parents').ids;
    assert.ok(Array.isArray(ids));
    assert.deepEqual([...ids].sort(), [1, 2]);
  });

  test('changing the children calls setTagChildren, and only that', async () => {
    const { form } = openEditor(kyoto());

    toggleStructure(form, 'child_ids', 2, true);

    await page._handleSave(form, 3);

    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`),
      ['PATCH /api/tags/3', 'PUT /api/tags/3/children']);
    assert.deepEqual(bodyOf('/api/tags/3/children').ids, [2]);
  });

  test('detaching the last parent is a change, not an empty no-op', async () => {
    const { form } = openEditor(kyoto());

    toggleStructure(form, 'parent_ids', 1, false);   // unfile it entirely

    await page._handleSave(form, 3);

    const calls = to('/api/tags/3/parents');
    assert.equal(calls.length, 1, 'clearing the parents must reach the server');
    assert.deepEqual(calls[0].body?.ids, []);
  });

  test('toggling a parent off and back on is not a change', async () => {
    const { form } = openEditor(kyoto());

    toggleStructure(form, 'parent_ids', 1, false);
    toggleStructure(form, 'parent_ids', 1, true);

    await page._handleSave(form, 3);

    assert.equal(to('/api/tags/3/parents').length, 0, 'no structure call for an unchanged set');
  });

  test('the diff compares sets, not sequences', async () => {
    // The snapshot follows the order the API listed the parents in, while the
    // form reads them back in the order the tree renders. Comparing those two
    // positionally would send a rewrite on every save of a multi-parent tag.
    const { form } = openEditor(fixtureTag({ ...kyoto(), parents: [{ id: 1, name: 'Travel' }, { id: 2, name: 'Food' }] }));

    assert.deepEqual(page._initialParentIds, [1, 2], 'the snapshot is in API order');
    assert.deepEqual(
      [...form.querySelectorAll<HTMLInputElement>('input[name="parent_ids"]:checked')].map(b => Number(b.value)),
      [2, 1],
      'the form reads back in tree order, which is alphabetical',
    );

    await page._handleSave(form, 3);

    assert.equal(to('/api/tags/3/parents').length, 0, 'same set, so no structure call');
  });

  test('the snapshot is retaken per modal, so a second edit diffs against the second tag', async () => {
    // _initialParentIds lives on the page, not the modal. If _openModal did not
    // reset it, editing a second tag would diff against the first one's parents
    // and silently rewrite the hierarchy of a tag the user only renamed.
    const first = openEditor(kyoto());
    type(field(first.form, '[name="name"]'), 'Kyoto City');
    await page._handleSave(first.form, 3);
    requests.length = 0;

    const second = openEditor({ ...TAGS[1], parents: [], children: [] });
    type(field(second.form, '[name="name"]'), 'Food & Drink');
    await page._handleSave(second.form, 2);

    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), ['PATCH /api/tags/2'],
      'the second tag has no parents and none were touched');
  });

  // ── Modal lifecycle and failure ───────────────────────────────────────────

  test('a successful save closes the modal and refreshes the page and nav', async () => {
    const { form } = openEditor(kyoto());

    await page._handleSave(form, 3);

    assert.equal(page._modal, null, 'the modal is dismissed');
    assert.equal(dom.document.querySelector('#tag-editor-form'), null, 'and detached from the document');
    assert.equal(reloaded, 1);
    assert.equal(navRefreshed, 1);
  });

  test('closeAfter:false keeps the modal open — the maximized-textarea save', async () => {
    const { form } = openEditor(kyoto());

    await page._handleSave(form, 3, { closeAfter: false });

    assert.ok(page._modal, 'the editor stays open so the user can keep typing');
    assert.ok(dom.document.querySelector('#tag-editor-form'), 'and stays in the document');
    assert.equal(reloaded, 1, 'the list still refreshes underneath');
  });

  test('a failed save restores the button and leaves the modal open', async () => {
    const { form, submit } = openEditor(kyoto());
    const label = submit.textContent;
    respond = () => ({ ok: false, status: 409, body: { detail: 'Slug already taken' } });

    await page._handleSave(form, 3);

    assert.equal(getToast().message, 'Slug already taken', 'the server message reaches the user');
    assert.equal(getToast().type, 'error');
    assert.equal(submit.disabled, false, 'the button is usable again');
    assert.equal(submit.textContent, label, 'and back to its original label');
    assert.ok(page._modal, 'the edits are not thrown away');
    assert.equal(reloaded, 0, 'nothing is reloaded after a failure');
  });

  test('a structure call failing after the PATCH still reports an error', async () => {
    // The PATCH is not rolled back, but the user must not be told it worked.
    const { form } = openEditor(kyoto());
    toggleStructure(form, 'parent_ids', 2, true);
    respond = url => url.endsWith('/parents')
      ? { ok: false, status: 400, body: { detail: 'Cycle detected' } }
      : { ok: true, status: 200, body: {} };

    await page._handleSave(form, 3);

    assert.equal(getToast().message, 'Cycle detected');
    assert.equal(getToast().type, 'error');
    assert.equal(to('/api/tags/3/children').length, 0, 'the children call is skipped after the failure');
    assert.ok(page._modal, 'the modal stays open on a partial failure');
  });

  test('submitting the form goes through _handleSave', async () => {
    // The wiring in _openModal, not just the method: a submit must be
    // intercepted rather than navigating, and must carry the edited tag's id.
    const { form } = openEditor(kyoto());
    type(field(form, '[name="name"]'), 'Kyoto City');

    const evt = fire(form, 'submit');
    await new Promise(r => setImmediate(r));

    assert.ok(evt.defaultPrevented, 'the browser must not submit the form itself');
    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), ['PATCH /api/tags/3']);
    assert.equal(bodyOf('/api/tags/3').name, 'Kyoto City');
  });

  test('ctrl+s in a maximized editor saves without closing', async () => {
    const { form } = openEditor(kyoto());
    field(form, 'textarea').classList.add('is-maximized');

    // linkedom has no KeyboardEvent; `fire` decorates a plain Event, which is
    // all the handler reads.
    const evt = fire(must(page._modal, 'modal'), 'keydown', { key: 's', ctrlKey: true });
    await new Promise(r => setImmediate(r));

    assert.ok(evt.defaultPrevented, 'the browser save dialog is suppressed');
    assert.equal(to('/api/tags/3').length, 1, 'the shortcut saves');
    assert.ok(page._modal, 'maximized means keep editing');
  });

  test('the submit button is disabled while the request is in flight', async () => {
    const { form, submit } = openEditor(kyoto());
    let release = () => {};
    const inFlight = new Promise<void>(r => { release = r; });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => { await inFlight; return realFetch(...args); };

    const saving = page._handleSave(form, 3);
    await new Promise(r => setImmediate(r));

    assert.equal(submit.disabled, true, 'a second click cannot double-submit');
    assert.equal(submit.textContent, 'Saving…');

    release();
    await saving;
  });

  test('the Cancel button closes without saving', async () => {
    openEditor(kyoto());

    click(must(dom.document.querySelector('#modal-cancel-btn'), 'cancel'));

    assert.equal(page._modal, null);
    assert.equal(requests.length, 0, 'cancelling must not write');
  });
});
