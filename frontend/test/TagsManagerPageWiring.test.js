/**
 * TagsManagerPage — the wiring afterRender lays down, and what it wires to.
 *
 * Everything the extractions left behind is event wiring: which control calls
 * which extracted module, with which arguments, and what the page does with the
 * answer. The modules themselves are covered by their own suites; what is only
 * testable here is the join — a Move… button that hands the dialog the wrong
 * parent context, a filter box that filters nothing because afterRender bound
 * the listener before the input existed, a flow that mutates the hierarchy and
 * then leaves a stale tree on screen.
 *
 * Two behaviours in here look like implementation detail and are not:
 *   • the list filters run over the rendered rows rather than through setState,
 *     because re-rendering the table would take the focus out of the search box
 *     the user is still typing in;
 *   • every mutating flow ends in _afterFlow — reload plus a nav-changed event —
 *     since the public nav is built from the same hierarchy the flow just moved.
 *
 * The page is mounted for real, against the real admin layout, and asserts on
 * the requests leaving api/client.js.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, check, fire, type } from './helpers/dom.js';
import { store } from '../src/store.js';

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), parents: [], children: [], post_count: 0, ...over,
});

/**
 * Travel > (Kyoto, Osaka, Nara), Food > Ramen, and an unfiled Misc.
 * Travel is hidden, so Kyoto carries the inherited-hidden badge. Travel needs
 * three children: a reorder is only legal between siblings, and "drop before"
 * lands the tag after the one preceding the target — which only says anything
 * when there IS one.
 */
const TAGS = [
  tag(1, 'Travel', { children: [{ id: 3 }, { id: 6 }, { id: 7 }], hidden: true, post_count: 2 }),
  tag(2, 'Food', { children: [{ id: 4 }] }),
  tag(3, 'Kyoto', {
    parents: [{ id: 1, name: 'Travel' }], post_count: 4,
    effective_hidden: true, hidden_via: 1,
  }),
  tag(4, 'Ramen', { parents: [{ id: 2, name: 'Food' }], post_count: 1 }),
  tag(5, 'Misc'),
  tag(6, 'Osaka', { parents: [{ id: 1, name: 'Travel' }], post_count: 3 }),
  tag(7, 'Nara', { parents: [{ id: 1, name: 'Travel' }], post_count: 1 }),
];

describe('TagsManagerPage — wiring', () => {
  let dom, TagsManagerPage, page, requests, respond, navRefreshes;

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

  const trace = () => requests.map(r => `${r.method} ${r.url}`);
  const toast = () => store.get('toast');
  const q = sel => dom.document.querySelector(sel);
  const qa = sel => [...dom.document.querySelectorAll(sel)];
  const settle = () => new Promise(r => setImmediate(r));

  /** A button inside the page, by selector and data-id. */
  const rowBtn = (sel, id) => qa(sel).find(b => b.dataset.id === String(id));

  /** The tag names the tree or list is currently showing. */
  const treeNames = () => qa('.tm-tag-name').map(el => el.textContent);
  /** The list rows that are not filtered out. */
  const visibleRows = () => qa('.tm-tag-row').filter(r => !r.classList.contains('hidden'))
    .map(r => r.querySelector('.tm-name-cell')?.textContent ?? r.dataset.id);

  async function mountPage() {
    dom.location.pathname = '/light/tags';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new TagsManagerPage(el, {});
    page.mount();
    await settle();
    return page;
  }

  /** Switch to the tabular view, which renders a different set of controls. */
  const listView = () => click(page.container.querySelector('#view-list-btn'));

  beforeEach(async () => {
    dom = setupDOM('<!doctype html><html><body></body></html>', { path: '/light/tags' });
    fakeFetch();
    store.set('toast', null);
    store.set('user', { username: 'tester' });

    navRefreshes = 0;
    dom.document.addEventListener('nav-changed', () => { navRefreshes++; });

    ({ default: TagsManagerPage } = await import('../src/pages/light/TagsManagerPage.js'));
  });

  afterEach(() => {
    page?.unmount();
    page = null;
    delete globalThis.fetch;
    dom.cleanup();
  });

  // ── Tree view ──────────────────────────────────────────────────────────────

  test('a row chevron opens just that branch', async () => {
    await mountPage();
    assert.deepEqual(treeNames(), ['Food', 'Travel'], 'roots only');

    click(rowBtn('.tm-toggle', 1));
    assert.deepEqual(treeNames(), ['Food', 'Travel', 'Kyoto', 'Nara', 'Osaka'],
      "Travel's children, and nobody else's");

    click(rowBtn('.tm-toggle', 1));
    assert.deepEqual(treeNames(), ['Food', 'Travel'], 'and it closes again');
  });

  test('Expand all opens every branch, Collapse all shuts them', async () => {
    await mountPage();

    click(page.container.querySelector('#expand-all-btn'));
    assert.deepEqual(treeNames(), ['Food', 'Ramen', 'Travel', 'Kyoto', 'Nara', 'Osaka']);

    click(page.container.querySelector('#collapse-all-btn'));
    assert.deepEqual(treeNames(), ['Food', 'Travel']);
  });

  test('the Unfiled group is a separate toggle, and counts what is in it', async () => {
    await mountPage();

    assert.equal(q('.tm-unfiled-count').textContent, '(1)');
    click(q('#unfiled-toggle-btn'));
    assert.ok(treeNames().includes('Misc'));
  });

  test('a row\'s + opens the editor with that row already filed as the parent', async () => {
    await mountPage();

    click(rowBtn('.add-child-btn', 2));

    const form = q('#tag-editor-form');
    assert.ok(form, 'the editor opens');
    assert.equal(form.querySelector('[name="name"]').value, '', 'as a create form');
    assert.deepEqual(
      [...form.querySelectorAll('input[name="parent_ids"]:checked')].map(b => Number(b.value)),
      [2],
      'pre-filed under the row you clicked — otherwise "add child" adds a root',
    );
  });

  test('the inherited-hidden badge opens the ancestor doing the hiding', async () => {
    // Kyoto is not hidden; Travel is. The badge is the only route from the
    // symptom to the tag that caused it, so it must open Travel, not Kyoto.
    await mountPage();
    click(rowBtn('.tm-toggle', 1));

    click(q('.tm-badge-via-btn'));

    assert.equal(q('#tag-editor-form [name="name"]').value, 'Travel');
  });

  test('the badge opens the ancestor without selecting the row it sits on', async () => {
    // In select mode a click on a row toggles that row's selection, and the
    // badge is a button inside one. Opening an editor and silently ticking a
    // tag for the next bulk delete is not a combination the user asked for.
    //
    // The handler calls e.stopPropagation(), but that is belt and braces: the
    // row's click listener already ignores anything inside INTERACTIVE, which
    // covers every button. Removing the stopPropagation changes nothing here —
    // this test is about the guarantee, not the mechanism.
    await mountPage();
    click(rowBtn('.tm-toggle', 1));
    click(page.container.querySelector('#tm-select-btn'));

    click(q('.tm-badge-via-btn'));

    assert.equal(q('#tag-editor-form [name="name"]').value, 'Travel', 'the ancestor opens');
    assert.equal(page.state.selectedIds.size, 0, 'and nothing was selected on the way');
  });

  // ── Flows reached from a row ───────────────────────────────────────────────

  test('Move… hands the dialog the tag and the parent it was clicked under', async () => {
    await mountPage();
    click(rowBtn('.tm-toggle', 1));
    requests.length = 0;

    click(rowBtn('.move-tag-btn', 3));           // Kyoto, seen under Travel
    assert.ok(q('#tm-move-confirm-btn'), 'the move dialog is open');
    const parents = qa('input[name="tm-move-parent"]');
    assert.ok(!parents.some(r => r.value === '3'), 'a tag cannot be moved under itself');
    assert.equal(parents.find(r => r.checked)?.value, '1',
      'the parent it was clicked under is preselected, so Move… opens on where it is');

    check(parents.find(r => r.value === '2'), true);       // move it under Food
    click(q('#tm-move-confirm-btn'));
    await settle();

    assert.ok(trace().includes('PUT /api/tags/3/parents'), 'the reparent is sent');
    assert.ok(trace().includes('GET /api/tags?include_empty=true'), 'and the moved tree is re-read');
    assert.equal(navRefreshes, 1, 'the nav shows the same hierarchy, so it is told too');
  });

  test('Merge… opens on the tag being merged away', async () => {
    await mountPage();
    click(rowBtn('.tm-toggle', 1));

    click(rowBtn('.merge-tag-btn', 3));

    assert.ok(q('#tm-merge-confirm-btn'), 'the merge dialog is open');
    assert.ok(!qa('input[name="tm-merge-winner"]').some(r => r.value === '3'),
      'the tag being merged away cannot be its own winner');
  });

  // ── Select mode ────────────────────────────────────────────────────────────

  test('a bulk action reloads the list and drops the selection it acted on', async () => {
    // The selection is a set of ids against a list that has just changed under
    // it. Keeping it would leave the toolbar counting tags that may no longer
    // exist, and offering to act on them again.
    await mountPage();
    click(page.container.querySelector('#tm-select-btn'));
    check(q('#tm-select-all-cb'), true);
    assert.ok(page.state.selectedIds.size > 0, 'something is selected to act on');
    requests.length = 0;

    click(q('#tm-bulk-apply-btn'));                 // apply "Hidden" to the selection
    await settle();

    assert.ok(trace().some(r => r.startsWith('PATCH /api/tags/')), 'the visibility change is sent');
    assert.ok(trace().includes('GET /api/tags?include_empty=true'), 'and the list is re-read');
    assert.equal(navRefreshes, 1, 'hidden tags leave the public nav, so it is told');
    assert.equal(page.state.selectMode, false, 'select mode is over');
    assert.equal(page.state.selectedIds.size, 0);
    assert.equal(q('#tm-bulk-toolbar'), null, 'and the toolbar goes with it');
  });

  // ── The list view ──────────────────────────────────────────────────────────

  test('the view toggle swaps the tree for the table and back', async () => {
    await mountPage();
    assert.ok(q('.tags-tree-container'));

    listView();
    assert.equal(q('.tags-tree-container'), null);
    assert.equal(visibleRows().length, 7, 'every tag is a row — the table has no hierarchy to collapse');

    click(page.container.querySelector('#view-tree-btn'));
    assert.ok(q('.tags-tree-container'));
  });

  test('a column header sorts, and clicking it again reverses', async () => {
    await mountPage();
    listView();

    const header = f => qa('.tm-sortable-header').find(th => th.dataset.field === f);
    click(header('name'));
    assert.equal(page.state.sortField, 'name');
    assert.equal(page.state.sortOrder, 'asc');
    assert.deepEqual(qa('.tm-tag-row').map(r => Number(r.dataset.id)), [2, 3, 5, 7, 6, 4, 1],
      'Food, Kyoto, Misc, Nara, Osaka, Ramen, Travel');

    click(header('name'));
    assert.equal(page.state.sortOrder, 'desc');
    assert.deepEqual(qa('.tm-tag-row').map(r => Number(r.dataset.id)), [1, 4, 6, 7, 5, 3, 2]);

    click(header('post_count'));
    assert.equal(page.state.sortField, 'post_count');
    assert.equal(page.state.sortOrder, 'asc', 'a new column starts ascending again');
  });

  test('the search box hides rows without re-rendering the table', async () => {
    await mountPage();
    listView();

    const search = q('.tm-list-search');
    const rowsBefore = qa('.tm-tag-row');
    type(search, 'ram');

    assert.deepEqual(visibleRows().map(String), ['4'], 'only Ramen matches');
    assert.equal(qa('.tm-tag-row').length, 7, 'the non-matching rows are hidden, not removed');
    assert.equal(qa('.tm-tag-row')[0], rowsBefore[0],
      'and the same row elements are still there — a re-render would take the caret with it');
  });

  test('clicking a parent badge filters by it, and the chip removes the filter', async () => {
    await mountPage();
    listView();

    click(qa('.tm-parent-filter-btn').find(b => b.dataset.parentId === '2'));

    assert.deepEqual(visibleRows().map(String), ['4'], 'only what is filed under Food');
    const chip = q('.tm-filter-chip');
    assert.ok(chip, 'the active filter is visible as a chip');
    assert.match(chip.innerHTML, /<svg/, 'with its × icon');

    click(chip);
    assert.equal(visibleRows().length, 7, 'removing the chip restores every row');
    assert.equal(q('.tm-filter-chip'), null);
  });

  test('the same parent cannot be filtered on twice', async () => {
    await mountPage();
    listView();

    const badge = qa('.tm-parent-filter-btn').find(b => b.dataset.parentId === '2');
    click(badge);
    click(badge);

    assert.equal(qa('.tm-filter-chip').length, 1);
  });

  test('Clear appears once something is filtered, and clears all of it', async () => {
    await mountPage();
    listView();

    assert.equal(q('.tm-clear-filters'), null, 'nothing to clear yet');

    type(q('.tm-list-search'), 'ram');
    click(qa('.tm-parent-filter-btn').find(b => b.dataset.parentId === '2'));
    const clear = q('.tm-clear-filters');
    assert.ok(clear && !clear.classList.contains('hidden'), 'Clear turns up when a filter is on');

    click(clear);

    assert.equal(q('.tm-list-search').value, '', 'the box is emptied');
    assert.equal(q('.tm-filter-chip'), null, 'the chips go');
    assert.equal(visibleRows().length, 7, 'and every row is back');
    assert.ok(clear.classList.contains('hidden'), 'with nothing left to clear');
  });

  test('a filter set in the list survives a re-render of the table', async () => {
    // The filters live on the page, not in state, so a re-render (sorting, say)
    // repaints rows that the filter had hidden. afterRender has to reapply it.
    await mountPage();
    listView();
    type(q('.tm-list-search'), 'ram');

    click(qa('.tm-sortable-header').find(th => th.dataset.field === 'name'));

    assert.deepEqual(visibleRows().map(String), ['4'], 'still filtered after the sort');
    assert.equal(q('.tm-list-search').value, 'ram', 'and the box still shows why');
  });

  // ── Drag and drop ──────────────────────────────────────────────────────────

  /** Drag `dragId`'s row onto `targetId`'s, dropping in the given zone. */
  function drag(dragId, targetId, zone) {
    const from = qa('.tm-row').find(r => r.dataset.id === String(dragId));
    const to = qa('.tm-row').find(r => r.dataset.id === String(targetId));
    const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    fire(from, 'dragstart', { dataTransfer });
    to.classList.add(`tm-drop-${zone}`);
    fire(to, 'drop', { dataTransfer, preventDefault() {} });
  }

  test('dropping a row onto another asks before reparenting', async () => {
    await mountPage();

    drag(2, 1, 'on');                       // Food onto Travel

    assert.ok(q('#drop-move-btn'), 'a drop is a reparent, and reparenting asks first');
    assert.match(q('.modal-header h3').textContent, /Move "Food" under "Travel"/);
    assert.ok(q('#drop-also-btn'), 'with the choice of keeping the other parents');

    requests.length = 0;
    click(q('#drop-move-btn'));
    await settle();

    assert.ok(trace().includes('PUT /api/tags/2/parents'), 'Move replaces the parent set');
    assert.ok(trace().includes('GET /api/tags?include_empty=true'), 'and the tree is re-read');
    assert.equal(navRefreshes, 1);
  });

  test('reordering within a parent moves the tag and reloads', async () => {
    await mountPage();
    click(page.container.querySelector('#expand-all-btn'));
    requests.length = 0;

    drag(6, 3, 'after');                    // Osaka after Kyoto, both under Travel
    await settle();

    assert.deepEqual(trace(), ['POST /api/tags/6/move', 'GET /api/tags?include_empty=true']);
    assert.equal(requests[0].body.parent_id, 1,
      'the move is scoped to the sibling group it happened in — other parents keep their order');
    assert.equal(requests[0].body.after_id, 3);
  });

  test('dropping before a sibling lands the tag after the one preceding it', async () => {
    // 'after' can name the target directly; 'before' cannot — the API takes an
    // after_id, so the page has to look up which sibling the target follows.
    await mountPage();
    click(page.container.querySelector('#expand-all-btn'));
    requests.length = 0;

    drag(7, 6, 'before');                   // Nara before Osaka; Kyoto precedes Osaka
    await settle();

    assert.deepEqual(trace(), ['POST /api/tags/7/move', 'GET /api/tags?include_empty=true']);
    assert.equal(requests[0].body.after_id, 3,
      'after Kyoto — the sibling Osaka follows, not the front of the group');
  });

  test('dropping before the first sibling puts the tag at the front', async () => {
    await mountPage();
    click(page.container.querySelector('#expand-all-btn'));
    requests.length = 0;

    drag(7, 3, 'before');                   // Nara before Kyoto, which is first

    await settle();
    assert.equal(requests[0].body.after_id, null, 'nothing to follow means the front');
  });

  test('reordering across parents is refused with an explanation', async () => {
    await mountPage();
    click(page.container.querySelector('#expand-all-btn'));
    requests.length = 0;

    drag(3, 4, 'after');                    // Kyoto (under Travel) after Ramen (under Food)
    await settle();

    assert.deepEqual(trace(), [], 'nothing is sent');
    assert.equal(toast().type, 'error');
    assert.match(toast().message, /Drop ON a tag to reparent/);
  });

  test('a failed reorder says so and leaves the tree alone', async () => {
    await mountPage();
    click(page.container.querySelector('#expand-all-btn'));
    requests.length = 0;
    respond = () => ({ ok: false, status: 400, body: { detail: 'Order out of range' } });

    drag(6, 3, 'after');
    await settle();

    assert.deepEqual(trace(), ['POST /api/tags/6/move'], 'no reload after a failure');
    assert.equal(toast().message, 'Order out of range');
    assert.equal(toast().type, 'error');
  });

  // ── Inside the editor ──────────────────────────────────────────────────────

  test('a section header folds its body away and turns its arrow', async () => {
    await mountPage();
    click(page.container.querySelector('#add-root-tag-btn'));

    const toggle = qa('.tm-section-toggle').find(b => b.dataset.target === 'coords-body');
    const body = q('#coords-body');
    const arrow = toggle.querySelector('.tm-section-arrow');
    const wasHidden = body.classList.contains('hidden');

    click(toggle);
    assert.equal(body.classList.contains('hidden'), !wasHidden);
    assert.equal(arrow.textContent, wasHidden ? '▼' : '▶', 'the arrow follows the body');

    click(toggle);
    assert.equal(body.classList.contains('hidden'), wasHidden, 'and back');
  });

  test('Parse turns a pasted maps link into coordinates', async () => {
    await mountPage();
    click(page.container.querySelector('#add-root-tag-btn'));
    requests.length = 0;
    respond = () => ({ ok: true, status: 200, body: { lat: 34.69, lng: 135.5 } });

    q('#coordinates-input').value = 'https://maps.example/@34.69,135.50';
    click(q('#gmaps-parse-btn'));
    await settle();

    assert.equal(q('#coord-lat').value, 34.69);
    assert.equal(q('#coord-lng').value, 135.5);
    assert.equal(q('#coordinates-input').value, '',
      'the pasted link is consumed — leaving it would re-parse on the next click');
  });

  test('an empty box geocodes the tag by name instead, but only when editing', async () => {
    await mountPage();
    click(rowBtn('.edit-tag-btn', 1));
    requests.length = 0;
    respond = () => ({ ok: true, status: 200, body: { latitude: 35.01, longitude: 135.76 } });

    click(q('#gmaps-parse-btn'));
    await settle();

    assert.deepEqual(trace(), ['POST /api/tags/1/geocode'], 'the tag it already knows about');
    assert.equal(q('#coord-lat').value, 35.01);
    assert.equal(toast().type, 'success');
  });

  test('an empty box on a new tag asks for nothing — there is nothing to geocode', async () => {
    await mountPage();
    click(page.container.querySelector('#add-root-tag-btn'));
    requests.length = 0;

    click(q('#gmaps-parse-btn'));
    await settle();

    assert.deepEqual(trace(), []);
    assert.equal(toast(), null, 'and it is not an error either');
  });

  test('the coordinate controls are locked while the lookup is in flight, and released after', async () => {
    await mountPage();
    click(rowBtn('.edit-tag-btn', 1));
    let release;
    const inFlight = new Promise(r => { release = r; });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { await inFlight; return realFetch(...args); };

    const btn = q('#gmaps-parse-btn');
    click(btn);
    await settle();

    assert.equal(btn.disabled, true, 'a second click cannot fire a second lookup');
    assert.equal(btn.textContent, '…');
    assert.equal(q('#coord-lat').disabled, true, 'and the fields cannot be edited under it');

    release();
    await settle();
    await settle();

    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, 'Parse / Geocode');
    assert.equal(q('#coord-lat').disabled, false);
  });

  test('a failed lookup reports it and unlocks the controls', async () => {
    await mountPage();
    click(rowBtn('.edit-tag-btn', 1));
    respond = () => ({ ok: false, status: 404, body: { detail: 'Nominatim found nothing' } });

    click(q('#gmaps-parse-btn'));
    await settle();

    assert.equal(toast().message, 'Nominatim found nothing');
    assert.equal(toast().type, 'error');
    assert.equal(q('#gmaps-parse-btn').disabled, false, 'the user can try again');
  });

  test('a maximized textarea saves in place, without closing the editor', async () => {
    await mountPage();
    click(rowBtn('.edit-tag-btn', 1));
    requests.length = 0;

    fire(page._modal, 'textarea:save');
    await settle();

    assert.ok(trace().includes('PATCH /api/tags/1'), 'the save goes through');
    assert.ok(page._modal, 'and the editor the user is still typing in stays open');
  });

  test('the nav-order field only appears when the tag is in the nav', async () => {
    await mountPage();
    click(page.container.querySelector('#add-root-tag-btn'));

    const row = q('#nav-order-row');
    const box = q('#in-nav-check');
    assert.ok(row.classList.contains('hidden'), 'no position to give when it is not in the nav');

    box.checked = true;
    fire(box, 'change');
    assert.ok(!row.classList.contains('hidden'));

    box.checked = false;
    fire(box, 'change');
    assert.ok(row.classList.contains('hidden'));
  });
});
