/**
 * tagSelection — select mode in the tags manager.
 *
 * The markup comes from the real renderers (renderTagForest / renderTagList /
 * renderBulkToolbar), because a hand-written fixture that drifts from the page
 * would test nothing: every selector here is one the page depends on.
 *
 * The bulk actions are driven through their real buttons and asserted on the
 * requests leaving api/client.js — nothing between the click and fetch is
 * stubbed. What the page itself would do next (re-render, reload) arrives as
 * onModeChange / onBulkDone, which is exactly the boundary the module owns.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, check, fire, selectOption } from './helpers/dom.js';
import { store } from '../src/store.js';
import { buildTagTree, renderTagForest } from '../src/components/light/tags/TagTreeView.js';
import { renderTagList } from '../src/components/light/tags/TagListView.js';
import {
  selectableTags, selectAllState, renderBulkToolbar, applyRowSelection,
  updateBulkToolbar, setupSelectMode, LONG_PRESS_MS, INTERACTIVE, ROW_SELECTOR,
} from '../src/components/light/tags/tagSelection.js';

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), parents: [], children: [], post_count: 0, ...over,
});

/** Travel > Japan, Food > Japan — Japan is filed twice, so it owns two rows. */
const FOREST = [
  tag(1, 'Travel', { children: [{ id: 3, name: 'Japan', slug: 'japan' }] }),
  tag(2, 'Food', { children: [{ id: 3, name: 'Japan', slug: 'japan' }] }),
  tag(3, 'Japan', { parents: [{ id: 1, name: 'Travel', slug: 'travel' }, { id: 2, name: 'Food', slug: 'food' }] }),
  tag(4, 'Lisbon'),
];

describe('tagSelection', () => {
  let dom, container, st, modeChanges, bulkDone, confirms, requests, respond;

  /** Record every request; reply with whatever `respond` currently returns. */
  function fakeFetch() {
    requests = [];
    respond = () => ({ ok: true, status: 200, body: {} });
    globalThis.fetch = async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
      const { ok, status, body } = respond(url, opts);
      return { ok, status, headers: { get: () => 'application/json' }, json: async () => body };
    };
  }

  /** The touch layout, where the row gestures apply. */
  const setBreakpoint = matches => {
    globalThis.matchMedia = q => ({
      matches: matches && q === '(max-width: 48em)', media: q,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    });
  };

  beforeEach(() => {
    dom = setupDOM('<!doctype html><html><body></body></html>', { path: '/light/tags' });
    fakeFetch();
    setBreakpoint(true);
    store.set('toast', null);
    modeChanges = [];
    bulkDone = 0;
    confirms = [];
    st = {
      selectMode: true,
      selectedIds: new Set(),
      tags: FOREST,
      view: 'tree',
      listView: { search: '', filterParents: [], selectMode: true, selectedIds: new Set() },
    };
  });

  afterEach(() => {
    delete globalThis.fetch;
    dom.cleanup();
  });

  /** Render the page's markup for the current state and wire select mode. */
  function mount({ toolbar = true, extra = '' } = {}) {
    st.listView = { ...st.listView, selectMode: st.selectMode, selectedIds: st.selectedIds };
    const view = { expanded: new Set([1, 2]), unfiledExpanded: true, ...st.listView };
    const rows = st.view === 'list'
      ? renderTagList(st.tags, { sortField: 'sort_order', sortOrder: 'asc', ...view })
      : renderTagForest(buildTagTree(st.tags), view);

    container = dom.document.createElement('div');
    container.innerHTML = `
      <button id="tm-select-btn"></button>
      ${toolbar && st.selectMode ? renderBulkToolbar() : ''}
      ${rows}
      ${extra}`;
    dom.document.body.appendChild(container);

    return setupSelectMode(container, {
      state: () => st,
      onModeChange: (selectMode, selectedIds) => {
        modeChanges.push({ selectMode, ids: [...selectedIds].sort((a, b) => a - b) });
        st.selectMode = selectMode;
        st.selectedIds = selectedIds;
      },
      onBulkDone: () => { bulkDone++; },
      confirm: (title, message, confirmText, variant, onConfirm) => {
        confirms.push({ title, message, confirmText, variant });
        onConfirm();
      },
    });
  }

  const q = sel => container.querySelector(sel);
  const qa = sel => [...container.querySelectorAll(sel)];
  const rowsFor = id => qa(`.tm-row[data-id="${id}"], .tm-tag-row[data-id="${id}"]`);
  const cbsFor = id => qa(`.tm-select-cb[data-id="${id}"]`);
  const count = () => q('#tm-bulk-count').textContent;
  const settle = () => new Promise(r => setImmediate(r));
  const trace = () => requests.map(r => `${r.method} ${r.url}`);

  // ── selectableTags ─────────────────────────────────────────────────────────

  describe('selectableTags', () => {
    const TAGS = [tag(1, 'Kyoto'), tag(2, 'Lisbon', { parents: [{ id: 1, name: 'Kyoto', slug: 'kyoto' }] })];

    test('the tree has no filters, so everything is selectable', () => {
      const filtered = { search: 'kyo', filterParents: [] };
      assert.deepEqual(selectableTags(TAGS, 'tree', filtered).map(t => t.id), [1, 2]);
    });

    test('the list view honours its search box', () => {
      assert.deepEqual(
        selectableTags(TAGS, 'list', { search: 'lisb', filterParents: [] }).map(t => t.id), [2],
      );
      // A parent's name matches too, which is why 'kyo' keeps Lisbon: it is
      // filed under Kyoto, and the list view shows it under that heading.
      assert.deepEqual(
        selectableTags(TAGS, 'list', { search: 'kyo', filterParents: [] }).map(t => t.id), [1, 2],
      );
    });

    test('the list view honours its parent chips', () => {
      assert.deepEqual(
        selectableTags(TAGS, 'list', { search: '', filterParents: [{ id: 1 }] }).map(t => t.id), [2],
      );
    });
  });

  // ── selectAllState ─────────────────────────────────────────────────────────

  describe('selectAllState', () => {
    test('none selected is neither ticked nor partial', () => {
      assert.deepEqual(selectAllState(0, 4), { checked: false, indeterminate: false });
    });

    test('some selected is partial only', () => {
      assert.deepEqual(selectAllState(2, 4), { checked: false, indeterminate: true });
    });

    test('all selected is ticked, never also partial', () => {
      assert.deepEqual(selectAllState(4, 4), { checked: true, indeterminate: false });
    });

    test('an empty list with an empty selection is not "all selected"', () => {
      assert.deepEqual(selectAllState(0, 0), { checked: false, indeterminate: false });
    });
  });

  // ── renderBulkToolbar ──────────────────────────────────────────────────────

  describe('renderBulkToolbar', () => {
    test('carries every control the page wires, with the actions disabled', () => {
      const el = dom.document.createElement('div');
      el.innerHTML = renderBulkToolbar();
      for (const id of ['#tm-select-all-cb', '#tm-bulk-count', '#tm-bulk-visibility-select',
        '#tm-bulk-apply-btn', '#tm-bulk-move-btn', '#tm-bulk-delete-btn', '#tm-bulk-done-btn']) {
        assert.ok(el.querySelector(id), `expected ${id}`);
      }
      assert.equal(el.querySelector('#tm-bulk-count').textContent, '0 selected');
      ['#tm-bulk-apply-btn', '#tm-bulk-move-btn', '#tm-bulk-delete-btn'].forEach(sel => {
        assert.ok(el.querySelector(sel).hasAttribute('disabled'), `${sel} starts disabled`);
      });
    });

    test('the way out of select mode keeps its text when labels collapse', () => {
      const el = dom.document.createElement('div');
      el.innerHTML = renderBulkToolbar();
      const done = el.querySelector('#tm-bulk-done-btn');
      assert.equal(done.querySelector('.btn-label'), null);
      assert.equal(done.textContent.trim(), 'Done');
    });
  });

  // ── applyRowSelection ──────────────────────────────────────────────────────

  describe('applyRowSelection', () => {
    test('flips every row a tag owns, not just the first', () => {
      mount();
      assert.equal(rowsFor(3).length, 2, 'Japan is filed under two parents');

      applyRowSelection(container, 3, true);
      assert.deepEqual(rowsFor(3).map(r => r.classList.contains('is-selected')), [true, true]);
      assert.deepEqual(cbsFor(3).map(cb => cb.checked), [true, true]);

      applyRowSelection(container, 3, false);
      assert.deepEqual(rowsFor(3).map(r => r.classList.contains('is-selected')), [false, false]);
      assert.deepEqual(cbsFor(3).map(cb => cb.checked), [false, false]);
    });

    test('leaves other tags alone', () => {
      mount();
      applyRowSelection(container, 3, true);
      assert.equal(rowsFor(4)[0].classList.contains('is-selected'), false);
    });
  });

  // ── updateBulkToolbar ──────────────────────────────────────────────────────

  describe('updateBulkToolbar', () => {
    test('reports the count, enables the actions and marks the tri-state', () => {
      mount();
      updateBulkToolbar(container, { selected: 2, total: () => 4 });

      assert.equal(count(), '2 selected');
      assert.deepEqual(
        ['#tm-bulk-apply-btn', '#tm-bulk-move-btn', '#tm-bulk-delete-btn'].map(s => q(s).disabled),
        [false, false, false],
      );
      assert.equal(q('#tm-select-all-cb').checked, false);
      assert.equal(q('#tm-select-all-cb').indeterminate, true);
    });

    test('an empty selection disables the actions', () => {
      mount();
      updateBulkToolbar(container, { selected: 0, total: () => 4 });
      assert.equal(count(), '0 selected');
      assert.deepEqual(
        ['#tm-bulk-apply-btn', '#tm-bulk-move-btn', '#tm-bulk-delete-btn'].map(s => q(s).disabled),
        [true, true, true],
      );
      assert.equal(q('#tm-select-all-cb').indeterminate, false);
    });

    test('counts the selectable tags only when there is a box to mark', () => {
      st.selectMode = false;                       // no toolbar in the markup
      mount();
      let counted = 0;
      assert.doesNotThrow(() => updateBulkToolbar(container, {
        selected: 1, total: () => { counted++; return 4; },
      }));
      assert.equal(counted, 0, 'the filter never runs when the toolbar is absent');
    });
  });

  // ── entering and leaving ───────────────────────────────────────────────────

  describe('entering and leaving select mode', () => {
    test('the Select button toggles the mode and drops the selection', () => {
      st.selectMode = false;
      mount();
      click(q('#tm-select-btn'));
      assert.deepEqual(modeChanges, [{ selectMode: true, ids: [] }]);
    });

    test('Cancel drops a selection rather than carrying it out of the mode', () => {
      st.selectedIds = new Set([3, 4]);
      mount();
      click(q('#tm-select-btn'));
      assert.deepEqual(modeChanges, [{ selectMode: false, ids: [] }]);
    });

    test('Done leaves select mode with nothing selected', () => {
      st.selectedIds = new Set([3]);
      mount();
      click(q('#tm-bulk-done-btn'));
      assert.deepEqual(modeChanges, [{ selectMode: false, ids: [] }]);
    });
  });

  // ── the checkboxes ─────────────────────────────────────────────────────────

  describe('row checkboxes', () => {
    test('ticking one selects the tag on every row it owns', () => {
      mount();
      check(cbsFor(3)[0], true);

      assert.deepEqual([...st.selectedIds], [3]);
      assert.deepEqual(rowsFor(3).map(r => r.classList.contains('is-selected')), [true, true]);
      assert.deepEqual(cbsFor(3).map(cb => cb.checked), [true, true]);
      assert.equal(count(), '1 selected');
      assert.equal(modeChanges.length, 0, 'selecting never re-renders the page');
    });

    test('unticking the other row of the same tag deselects it', () => {
      st.selectedIds = new Set([3]);
      mount();
      check(cbsFor(3)[1], false);

      assert.deepEqual([...st.selectedIds], []);
      assert.deepEqual(rowsFor(3).map(r => r.classList.contains('is-selected')), [false, false]);
      assert.equal(count(), '0 selected');
    });

    test('the toolbar arrives already in step with the selection', () => {
      st.selectedIds = new Set([3, 4]);
      mount();
      assert.equal(count(), '2 selected');
      assert.equal(q('#tm-bulk-apply-btn').disabled, false);
      assert.equal(q('#tm-select-all-cb').indeterminate, true);
    });
  });

  // ── select all ─────────────────────────────────────────────────────────────

  describe('select all', () => {
    test('picks every tag in the tree', () => {
      mount();
      check(q('#tm-select-all-cb'), true);
      assert.deepEqual(modeChanges, [{ selectMode: true, ids: [1, 2, 3, 4] }]);
    });

    test('reaches no further than the list view filters', () => {
      st.view = 'list';
      st.listView = { ...st.listView, search: 'japan' };
      mount();
      check(q('#tm-select-all-cb'), true);
      assert.deepEqual(modeChanges, [{ selectMode: true, ids: [3] }]);
    });

    test('unticking clears the selection', () => {
      st.selectedIds = new Set([1, 2, 3, 4]);
      mount();
      check(q('#tm-select-all-cb'), false);
      assert.deepEqual(modeChanges, [{ selectMode: true, ids: [] }]);
    });
  });

  // ── bulk actions ───────────────────────────────────────────────────────────

  describe('bulk actions', () => {
    test('Apply patches every selected tag with the chosen visibility', async () => {
      st.selectedIds = new Set([3, 4]);
      mount();
      // linkedom reports no selection until an option carries the attribute,
      // where a browser would already be on the first one (see selectOption).
      selectOption(q('#tm-bulk-visibility-select'), 'hidden');
      click(q('#tm-bulk-apply-btn'));
      await settle();

      assert.deepEqual(trace(), ['PATCH /api/tags/3', 'PATCH /api/tags/4']);
      assert.deepEqual(requests.map(r => r.body), [{ hidden: true }, { hidden: true }]);
      assert.equal(bulkDone, 1);
      assert.match(store.get('toast').message, /2 tags marked hidden/);
    });

    test('Apply reads "visible" off the select', async () => {
      st.selectedIds = new Set([4]);
      mount();
      selectOption(q('#tm-bulk-visibility-select'), 'visible');
      click(q('#tm-bulk-apply-btn'));
      await settle();

      assert.deepEqual(requests.map(r => r.body), [{ hidden: false }]);
    });

    test('Move… opens the picker over the tags not being moved', async () => {
      st.selectedIds = new Set([3]);
      mount();
      click(q('#tm-bulk-move-btn'));

      const overlay = dom.document.querySelector('.modal-overlay');
      assert.ok(overlay, 'the picker is on the page');
      const offered = [...overlay.querySelectorAll('.tm-picker-name')].map(el => el.textContent);
      assert.deepEqual(offered, ['Food', 'Lisbon', 'Travel'], 'sorted, and never the tag itself');

      check(overlay.querySelector('input[value="1"]'), true);
      click(overlay.querySelector('#tm-bulk-move-confirm-btn'));
      await settle();

      assert.deepEqual(trace(), ['PUT /api/tags/3/parents']);
      assert.deepEqual(requests[0].body, { ids: [1] }, 'the whole parent set is replaced');
      assert.equal(bulkDone, 1);
    });

    test('Delete asks first, then deletes what was selected', async () => {
      st.selectedIds = new Set([3, 4]);
      mount();
      click(q('#tm-bulk-delete-btn'));
      await settle();

      assert.equal(confirms.length, 1);
      assert.match(confirms[0].message, /Delete 2 tags\? Posts will NOT be deleted\./);
      assert.equal(confirms[0].variant, 'danger');
      assert.deepEqual(trace(), ['DELETE /api/tags/3', 'DELETE /api/tags/4']);
      assert.equal(bulkDone, 1);
    });

    test('a bulk run that half fails says so, and still reloads', async () => {
      st.selectedIds = new Set([3, 4]);
      mount();
      respond = url => (url.endsWith('/4')
        ? { ok: false, status: 500, body: { error: 'nope' } }
        : { ok: true, status: 200, body: {} });
      click(q('#tm-bulk-delete-btn'));
      await settle();

      assert.equal(store.get('toast').type, 'error');
      assert.match(store.get('toast').message, /1 of 2 done\. 1 failed\./);
      assert.equal(bulkDone, 1);
    });
  });

  // ── touch gestures ─────────────────────────────────────────────────────────

  describe('row gestures', () => {
    test('a long press starts selecting with the pressed row', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      st.selectMode = false;
      mount();
      fire(rowsFor(4)[0], 'pointerdown', { target: rowsFor(4)[0] });
      t.mock.timers.tick(LONG_PRESS_MS);

      assert.deepEqual(modeChanges, [{ selectMode: true, ids: [4] }]);
    });

    test('lifting the finger before the delay cancels it', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      st.selectMode = false;
      mount();
      const row = rowsFor(4)[0];
      fire(row, 'pointerdown', { target: row });
      fire(row, 'pointerup');
      t.mock.timers.tick(LONG_PRESS_MS);

      assert.deepEqual(modeChanges, []);
    });

    test('dragging the finger cancels it too', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      st.selectMode = false;
      mount();
      const row = rowsFor(4)[0];
      fire(row, 'pointerdown', { target: row });
      fire(row, 'pointermove');
      fire(row, 'pointercancel');            // a second cancel must be harmless
      t.mock.timers.tick(LONG_PRESS_MS);

      assert.deepEqual(modeChanges, []);
    });

    test('pressing a control inside the row is not a row press', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      st.selectMode = false;
      mount();
      const row = rowsFor(4)[0];
      fire(row.querySelector('button'), 'pointerdown');   // bubbles to the row
      t.mock.timers.tick(LONG_PRESS_MS);

      assert.deepEqual(modeChanges, []);
    });

    test('a long press while already selecting does nothing', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      mount();
      const row = rowsFor(4)[0];
      fire(row, 'pointerdown', { target: row });
      t.mock.timers.tick(LONG_PRESS_MS);

      assert.deepEqual(modeChanges, []);
    });

    test('tapping a row in select mode toggles it', () => {
      mount();
      const row = rowsFor(3)[0];
      fire(row, 'click', { target: row });
      assert.deepEqual([...st.selectedIds], [3]);
      assert.deepEqual(cbsFor(3).map(cb => cb.checked), [true, true]);

      fire(row, 'click', { target: row });
      assert.deepEqual([...st.selectedIds], []);
    });

    test('tapping a control inside the row leaves the selection alone', () => {
      mount();
      const row = rowsFor(3)[0];
      fire(row.querySelector('button'), 'click');          // bubbles to the row
      assert.deepEqual([...st.selectedIds], []);
    });

    test('tapping a row outside select mode does nothing', () => {
      st.selectMode = false;
      mount();
      const row = rowsFor(3)[0];
      fire(row, 'click', { target: row });
      assert.deepEqual([...st.selectedIds], []);
      assert.deepEqual(modeChanges, []);
    });

    test('nothing is bound on desktop — the Select button is the way in', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      setBreakpoint(false);
      st.selectMode = false;
      mount();
      const row = rowsFor(4)[0];
      fire(row, 'pointerdown', { target: row });
      t.mock.timers.tick(LONG_PRESS_MS);
      fire(row, 'click', { target: row });

      assert.deepEqual(modeChanges, []);
      assert.deepEqual([...st.selectedIds], []);
    });

    test('a row carrying no tag id is never bound', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      st.selectMode = false;
      mount({ extra: '<div class="tm-row" id="ghost-row"></div>' });

      const ghost = q('#ghost-row');
      fire(ghost, 'pointerdown', { target: ghost });
      t.mock.timers.tick(LONG_PRESS_MS);
      fire(ghost, 'click', { target: ghost });

      assert.deepEqual(modeChanges, []);
    });
  });

  // ── the swipe entry point ──────────────────────────────────────────────────

  describe('selectBySwipe', () => {
    test('starts selecting with the swiped row', () => {
      st.selectMode = false;
      const handle = mount();
      handle.selectBySwipe(rowsFor(3)[0]);
      assert.deepEqual(modeChanges, [{ selectMode: true, ids: [3] }]);
    });

    test('adds and removes once select mode is on', () => {
      const handle = mount();
      handle.selectBySwipe(rowsFor(3)[0]);
      assert.deepEqual([...st.selectedIds], [3]);
      assert.equal(count(), '1 selected');

      handle.selectBySwipe(rowsFor(3)[1]);
      assert.deepEqual([...st.selectedIds], []);
    });

    test('a row carrying no tag id is ignored', () => {
      const handle = mount();
      const row = dom.document.createElement('div');
      row.className = 'tm-row';
      assert.doesNotThrow(() => handle.selectBySwipe(row));
      assert.deepEqual([...st.selectedIds], []);
      assert.deepEqual(modeChanges, []);
    });
  });

  // ── the handle ─────────────────────────────────────────────────────────────

  describe('the handle', () => {
    test('setSelected and update are the page\'s way in between renders', () => {
      const handle = mount();
      handle.setSelected(4, true);
      assert.deepEqual([...st.selectedIds], [4]);
      assert.equal(count(), '1 selected');

      st.selectedIds.add(3);                        // a change made behind its back
      handle.update();
      assert.equal(count(), '2 selected');
    });

    test('toggleSelected flips whatever the set says', () => {
      const handle = mount();
      handle.toggleSelected(4);
      assert.deepEqual([...st.selectedIds], [4]);
      handle.toggleSelected(4);
      assert.deepEqual([...st.selectedIds], []);
    });

    test('is still usable when select mode is off — nothing to wire, but a handle', () => {
      st.selectMode = false;
      const handle = mount();
      assert.equal(typeof handle.selectBySwipe, 'function');
      assert.doesNotThrow(() => handle.update());
    });
  });

  // ── the shared constants ───────────────────────────────────────────────────

  test('the exported selectors are the ones the markup actually uses', () => {
    mount();
    assert.equal(qa(ROW_SELECTOR).length, 5, 'four tags, and Japan twice — it is filed twice');
    assert.ok(rowsFor(3)[0].querySelector(INTERACTIVE), 'rows carry controls to exclude');
    assert.equal(LONG_PRESS_MS, 500);
  });
});
