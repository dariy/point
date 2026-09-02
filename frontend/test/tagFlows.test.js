/**
 * tagFlows — the tags manager's Move…, Merge…, drop-on and bulk operations.
 *
 * These are the mutating paths, so the tests assert on the requests that leave
 * api/client.js rather than on anything in between: nothing is stubbed below
 * fetch. What matters about each flow is which calls it makes, in what order,
 * and what it tells the user when one of them fails — a Move… that skips
 * setTagParents silently orders a tag into a group it does not belong to, and
 * a bulk run that reports success over four failures is the only account the
 * user ever gets, because the list reloads either way.
 *
 * The dialogs come from openTagPickerDialog, which has its own tests; here they
 * are driven as a user would, through the real markup.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, check, selectOption, type } from './helpers/dom.js';
import { getToast, onToast, setToast } from '../src/store.js';
import {
  candidateTags, parentsWith, positionOptions, bulkOutcome, pluralTags,
  runBulk, bulkVisibility, bulkDelete,
  openBulkMoveDialog, openMergeDialog, openMoveDialog, openDropOnConfirm,
} from '../src/components/light/tags/tagFlows.js';

const tag = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase(), parents: [], children: [], post_count: 0, ...over,
});

/** Travel > Japan > (Kyoto, Osaka), plus Food > Ramen. */
const FOREST = [
  tag(1, 'Travel', { children: [{ id: 2 }] }),
  tag(2, 'Japan', { parents: [{ id: 1 }], children: [{ id: 3 }, { id: 4 }] }),
  tag(3, 'Kyoto', { parents: [{ id: 2 }] }),
  tag(4, 'Osaka', { parents: [{ id: 2 }] }),
  tag(5, 'Food', { children: [{ id: 6 }] }),
  tag(6, 'Ramen', { parents: [{ id: 5 }] }),
];

describe('tagFlows', () => {
  let dom, requests, respond, done;

  /** Record every request; reply with whatever `respond` currently returns. */
  function fakeFetch() {
    requests = [];
    respond = () => ({ ok: true, status: 200, body: {} });
    globalThis.fetch = async (url, opts = {}) => {
      requests.push({
        url,
        method: opts.method,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
      const { ok, status, body } = respond(url, opts);
      return { ok, status, headers: { get: () => 'application/json' }, json: async () => body };
    };
  }

  /** `METHOD /path` for each request, in order — what each flow asserts on. */
  const trace = () => requests.map(r => `${r.method} ${r.url}`);
  const toast = () => getToast();
  const q = sel => dom.document.querySelector(sel);
  const qa = sel => [...dom.document.querySelectorAll(sel)];
  const settle = () => new Promise(r => setImmediate(r));

  beforeEach(() => {
    dom = setupDOM('<!doctype html><html><body></body></html>', { path: '/light/tags' });
    fakeFetch();
    setToast(null);
    done = 0;
  });

  afterEach(() => {
    delete globalThis.fetch;
    dom.cleanup();
  });

  const onDone = () => { done++; };

  // ── candidateTags ──────────────────────────────────────────────────────────

  describe('candidateTags', () => {
    test('drops the excluded tags and orders the rest by name', () => {
      assert.deepEqual(
        candidateTags(FOREST, [1, 2]).map(t => t.name),
        ['Food', 'Kyoto', 'Osaka', 'Ramen'],
      );
    });

    test('takes a Set as readily as an array — the bulk caller has one', () => {
      assert.deepEqual(
        candidateTags(FOREST, new Set([3, 4, 5, 6])).map(t => t.name),
        ['Japan', 'Travel'],
      );
    });

    test('leaves the caller\'s list alone', () => {
      const order = FOREST.map(t => t.id);
      candidateTags(FOREST, []);
      assert.deepEqual(FOREST.map(t => t.id), order,
        'sorting the page\'s own tag array would reorder the tree behind it');
    });

    test('an empty exclusion offers everything', () => {
      assert.equal(candidateTags(FOREST, []).length, FOREST.length);
    });

    test('an id that is not there excludes nothing', () => {
      assert.equal(candidateTags(FOREST, [999]).length, FOREST.length);
    });
  });

  // ── parentsWith ────────────────────────────────────────────────────────────

  describe('parentsWith', () => {
    test('adds the parent, keeping the ones already there', () => {
      assert.deepEqual(parentsWith(tag(3, 'Kyoto', { parents: [{ id: 1 }] }), 5), [1, 5]);
    });

    test('returns null when the tag is already filed there', () => {
      assert.strictEqual(parentsWith(tag(3, 'Kyoto', { parents: [{ id: 5 }] }), 5), null,
        'null is the signal not to write — setTagParents replaces wholesale');
    });

    test('treats a tag with no parents as unfiled rather than throwing', () => {
      assert.deepEqual(parentsWith({ id: 3 }, 5), [5]);
    });
  });

  // ── positionOptions ────────────────────────────────────────────────────────

  describe('positionOptions', () => {
    test('offers the front of the group, then each sibling in stored order', () => {
      const html = String(positionOptions(FOREST, 2, 99));
      assert.match(html, /^<option value="">At beginning<\/option>/);
      assert.deepEqual(html.match(/After "[^"]+"/g), ['After "Kyoto"', 'After "Osaka"']);
      assert.deepEqual(html.match(/value="\d+"/g), ['value="3"', 'value="4"'],
        'the value is the sibling to sit after, which is what moveTag takes');
    });

    test('never offers the moving tag as its own anchor', () => {
      const html = String(positionOptions(FOREST, 2, 3));
      assert.doesNotMatch(html, /Kyoto/);
      assert.match(html, /Osaka/);
    });

    test('a childless parent offers only the front', () => {
      assert.equal(positionOptions(FOREST, 3, 99), '<option value="">At beginning</option>');
    });

    test('no parent — a root move — offers only the front', () => {
      assert.equal(positionOptions(FOREST, null, 99), '<option value="">At beginning</option>');
    });

    test('escapes sibling names — the label sits inside a quoted attribute\'s neighbour', () => {
      const tags = [
        tag(1, 'Parent', { children: [{ id: 2 }] }),
        tag(2, 'Food & "<b>Drink</b>"', { parents: [{ id: 1 }] }),
      ];
      assert.match(String(positionOptions(tags, 1, 99)),
        /After "Food &amp; &quot;&lt;b&gt;Drink&lt;\/b&gt;&quot;"/);
    });
  });

  // ── bulkOutcome / pluralTags ───────────────────────────────────────────────

  describe('bulkOutcome', () => {
    test('a clean run gets the caller\'s message and the done count', () => {
      assert.deepEqual(bulkOutcome(3, 3, n => `${n} done.`), { message: '3 done.', type: 'success' });
    });

    test('a partial run reports both counts as an error', () => {
      assert.deepEqual(bulkOutcome(2, 5, () => 'never'),
        { message: '2 of 5 done. 3 failed.', type: 'error' });
    });

    test('a run where everything failed is still an error, not a silent zero', () => {
      assert.deepEqual(bulkOutcome(0, 4, () => 'never'),
        { message: '0 of 4 done. 4 failed.', type: 'error' });
    });

    test('an empty selection is vacuously a success', () => {
      assert.deepEqual(bulkOutcome(0, 0, n => `${n} done.`), { message: '0 done.', type: 'success' });
    });
  });

  test('pluralTags pluralises everything but one', () => {
    assert.equal(pluralTags(0), '0 tags');
    assert.equal(pluralTags(1), '1 tag');
    assert.equal(pluralTags(2), '2 tags');
  });

  // ── runBulk ────────────────────────────────────────────────────────────────

  describe('runBulk', () => {
    test('applies the op to every id, in order, then reports and hands back', async () => {
      const seen = [];
      await runBulk([3, 1, 2], async id => seen.push(id), n => `${n} ok.`, { onDone });

      assert.deepEqual(seen, [3, 1, 2]);
      assert.deepEqual(toast(), { message: '3 ok.', type: 'success' });
      assert.equal(done, 1);
    });

    test('one failure does not abandon the rest of the selection', async () => {
      const seen = [];
      await runBulk([1, 2, 3], async id => {
        seen.push(id);
        if (id === 2) throw new Error('nope');
      }, n => `${n} ok.`, { onDone });

      assert.deepEqual(seen, [1, 2, 3], 'the run continues past the bad id');
      assert.deepEqual(toast(), { message: '2 of 3 done. 1 failed.', type: 'error' });
      assert.equal(done, 1, 'the list still reloads — two of them did change');
    });

    test('reports before handing back, so the toast is not lost to a re-render', async () => {
      const order = [];
      onToast(() => order.push('toast'))();
      const unsub = onToast(() => order.push('toast'));
      await runBulk([1], async () => {}, () => 'ok', { onDone: () => order.push('done') });
      unsub();

      assert.deepEqual(order, ['toast', 'done']);
    });

    test('an empty selection still settles rather than hanging', async () => {
      await runBulk([], async () => { throw new Error('never called'); }, n => `${n} ok.`, { onDone });
      assert.deepEqual(toast(), { message: '0 ok.', type: 'success' });
      assert.equal(done, 1);
    });

    test('runs without an onDone', async () => {
      await assert.doesNotReject(runBulk([1], async () => {}, () => 'ok'));
    });
  });

  // ── bulkVisibility / bulkDelete ────────────────────────────────────────────

  describe('bulkVisibility', () => {
    test('patches every selected tag hidden', async () => {
      await bulkVisibility({ ids: [1, 3], hidden: true, onDone });

      assert.deepEqual(trace(), ['PATCH /api/tags/1', 'PATCH /api/tags/3']);
      assert.deepEqual(requests[0].body, { hidden: true }, 'visibility only — nothing else is touched');
      assert.equal(toast().message, '2 tags marked hidden.');
    });

    test('and visible, which is the same call with the other value', async () => {
      await bulkVisibility({ ids: [1], hidden: false, onDone });

      assert.deepEqual(requests[0].body, { hidden: false });
      assert.equal(toast().message, '1 tag marked visible.');
    });

    test('a server refusal is counted, not thrown', async () => {
      respond = url => url.endsWith('/1')
        ? { ok: false, status: 403, body: { detail: 'no' } }
        : { ok: true, status: 200, body: {} };

      await bulkVisibility({ ids: [1, 3], hidden: true, onDone });

      assert.equal(toast().message, '1 of 2 done. 1 failed.');
      assert.equal(toast().type, 'error');
    });
  });

  describe('bulkDelete', () => {
    test('asks first, and writes nothing until the user agrees', () => {
      let asked = null;
      bulkDelete({ ids: [1, 3], confirm: (...args) => { asked = args; }, onDone });

      const [title, message, confirmText, variant] = asked;
      assert.equal(title, 'Delete tags');
      assert.equal(message, 'Delete 2 tags? Posts will NOT be deleted.');
      assert.equal(confirmText, 'Delete');
      assert.equal(variant, 'danger');
      assert.equal(requests.length, 0, 'nothing is deleted before the confirm');
    });

    test('deletes each one once confirmed', async () => {
      let accept;
      bulkDelete({ ids: [1, 3], confirm: (...args) => { accept = args[4]; }, onDone });
      await accept();

      assert.deepEqual(trace(), ['DELETE /api/tags/1', 'DELETE /api/tags/3']);
      assert.equal(toast().message, '2 tags deleted.');
      assert.equal(done, 1);
    });

    test('the count in the question matches the set it will act on', async () => {
      // Both come from the same snapshot, so a selection that changes behind
      // the dialog cannot make the message and the action disagree.
      let asked, accept;
      bulkDelete({ ids: [4], confirm: (...args) => { asked = args[1]; accept = args[4]; }, onDone });
      await accept();

      assert.equal(asked, 'Delete 1 tag? Posts will NOT be deleted.');
      assert.deepEqual(trace(), ['DELETE /api/tags/4']);
    });
  });

  // ── openBulkMoveDialog ─────────────────────────────────────────────────────

  describe('openBulkMoveDialog', () => {
    test('does nothing at all with an empty selection', () => {
      assert.equal(openBulkMoveDialog({ tags: FOREST, ids: [], onDone }), null);
      assert.equal(q('.modal-overlay'), null);
      assert.equal(toast(), null, 'not even a complaint — the button is disabled anyway');
    });

    test('says so when the selection leaves no tag to move under', () => {
      assert.equal(openBulkMoveDialog({ tags: FOREST, ids: FOREST.map(t => t.id), onDone }), null);
      assert.equal(q('.modal-overlay'), null);
      assert.deepEqual(toast(), { message: 'No tag left to move these under.', type: 'error' });
    });

    test('offers every tag outside the selection, and warns that it replaces', () => {
      openBulkMoveDialog({ tags: FOREST, ids: [1, 2], onDone });

      assert.deepEqual(qa('.tm-picker-name').map(s => s.textContent),
        ['Food', 'Kyoto', 'Osaka', 'Ramen']);
      assert.match(q('.tm-picker-modal').textContent, /Move 2 tags under…/);
      assert.match(q('.form-hint').textContent, /Replaces any parents/);
    });

    test('re-files every selected tag under the one parent', async () => {
      openBulkMoveDialog({ tags: FOREST, ids: [3, 4], onDone });

      check(qa('input[name="tm-bulk-parent"]').find(r => r.value === '5'));
      click(q('#tm-bulk-move-confirm-btn'));
      await settle();

      assert.deepEqual(trace(), ['PUT /api/tags/3/parents', 'PUT /api/tags/4/parents']);
      assert.deepEqual(requests[0].body, { ids: [5] }, 'one parent, replacing whatever was there');
      assert.equal(toast().message, '2 tags moved.');
      assert.equal(done, 1);
      assert.equal(q('.modal-overlay'), null, 'the dialog closes before the requests start');
    });

    test('refuses to guess when no parent is chosen', async () => {
      openBulkMoveDialog({ tags: FOREST, ids: [3], onDone });

      click(q('#tm-bulk-move-confirm-btn'));
      await settle();

      assert.deepEqual(toast(), { message: 'Select a parent first.', type: 'error' });
      assert.equal(requests.length, 0);
      assert.ok(q('.modal-overlay'), 'and stays open so the user can pick one');
    });
  });

  // ── openMergeDialog ────────────────────────────────────────────────────────

  describe('openMergeDialog', () => {
    test('does nothing for a tag that is not there', () => {
      assert.equal(openMergeDialog({ tags: FOREST, loserId: 999, onDone }), null);
      assert.equal(q('.modal-overlay'), null);
    });

    test('offers every other tag, and spells out what merging destroys', () => {
      openMergeDialog({ tags: FOREST, loserId: 3, onDone });

      assert.deepEqual(qa('.tm-picker-name').map(s => s.textContent),
        ['Food', 'Japan', 'Osaka', 'Ramen', 'Travel']);
      const body = q('.modal-body').textContent;
      assert.match(body, /Posts tagged\s+Kyoto\s+will be re-tagged/);
      assert.match(body, /Kyoto\s+will be deleted/);
    });

    test('shows the path under a name when the server sent one', () => {
      openMergeDialog({
        tags: [tag(1, 'Kyoto'), tag(2, 'Osaka', { name_path: 'Travel / Japan / Osaka' })],
        loserId: 1,
        onDone,
      });
      assert.equal(q('.tm-picker-path').textContent, 'Travel / Japan / Osaka');
    });

    test('escapes the names it interpolates', () => {
      openMergeDialog({ tags: [tag(1, '<script>x</script>'), tag(2, 'Other')], loserId: 1, onDone });

      assert.equal(q('script'), null, 'a tag name is never markup');
      assert.match(q('.modal-header').innerHTML, /&lt;script&gt;/);
    });

    test('merges into the chosen winner, keeping the redirect by default', async () => {
      openMergeDialog({ tags: FOREST, loserId: 3, onDone });

      check(qa('input[name="tm-merge-winner"]').find(r => r.value === '4'));
      click(q('#tm-merge-confirm-btn'));
      await settle();

      assert.deepEqual(trace(), ['POST /api/tags/3/merge']);
      assert.deepEqual(requests[0].body, { winner_id: 4, keep_redirect: true });
      assert.equal(toast().message, 'Tags merged successfully.');
      assert.equal(done, 1);
    });

    test('sends keep_redirect false when the box is cleared', async () => {
      openMergeDialog({ tags: FOREST, loserId: 3, onDone });

      check(qa('input[name="tm-merge-winner"]').find(r => r.value === '4'));
      check(q('#tm-merge-redirect'), false);
      click(q('#tm-merge-confirm-btn'));
      await settle();

      assert.equal(requests[0].body.keep_redirect, false,
        'the flag is read off the dialog before it is torn down');
    });

    test('a refused merge reports the server\'s reason and reloads nothing', async () => {
      openMergeDialog({ tags: FOREST, loserId: 3, onDone });
      respond = () => ({ ok: false, status: 409, body: { detail: 'Would create a cycle' } });

      check(qa('input[name="tm-merge-winner"]').find(r => r.value === '4'));
      click(q('#tm-merge-confirm-btn'));
      await settle();

      assert.deepEqual(toast(), { message: 'Would create a cycle', type: 'error' });
      assert.equal(done, 0);
    });

    test('refuses to guess a destination', async () => {
      openMergeDialog({ tags: FOREST, loserId: 3, onDone });

      click(q('#tm-merge-confirm-btn'));
      await settle();

      assert.deepEqual(toast(), { message: 'Select a destination tag first.', type: 'error' });
      assert.equal(requests.length, 0);
    });
  });

  // ── openMoveDialog ─────────────────────────────────────────────────────────

  describe('openMoveDialog', () => {
    test('does nothing for a tag that is not there', () => {
      assert.equal(openMoveDialog({ tags: FOREST, tagId: 999, contextParentId: null, onDone }), null);
      assert.equal(q('.modal-overlay'), null);
    });

    test('preselects the branch the user opened it from, and that group\'s positions', () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: 2, onDone });

      assert.equal(q('input[name="tm-move-parent"]:checked').value, '2');
      assert.deepEqual(qa('.tm-move-position-select option').map(o => o.textContent),
        ['At beginning', 'After "Osaka"'],
        'its own position is not on offer');
    });

    test('re-offers the positions when the parent changes', () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: null, onDone });
      assert.deepEqual(qa('.tm-move-position-select option').map(o => o.textContent), ['At beginning']);

      check(qa('input[name="tm-move-parent"]').find(r => r.value === '5'));

      assert.deepEqual(qa('.tm-move-position-select option').map(o => o.textContent),
        ['At beginning', 'After "Ramen"'],
        'the positions belong to the newly chosen parent, not the one it opened with');
    });

    test('files the tag under the new parent, then orders it there', async () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: null, onDone });

      check(qa('input[name="tm-move-parent"]').find(r => r.value === '5'));
      selectOption(q('.tm-move-position-select'), '6');
      click(q('#tm-move-confirm-btn'));
      await settle();

      assert.deepEqual(trace(), ['PUT /api/tags/3/parents', 'POST /api/tags/3/move'],
        'the order matters — moveTag alone would order it into a group it is not in');
      assert.deepEqual(requests[0].body, { ids: [2, 5] }, 'the existing parent is kept');
      assert.deepEqual(requests[1].body, { parent_id: 5, after_id: 6 });
      assert.equal(toast().message, 'Tag moved.');
      assert.equal(done, 1);
    });

    test('skips the parents call when the tag is already filed there', async () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: 2, onDone });

      click(q('#tm-move-confirm-btn'));
      await settle();

      assert.deepEqual(trace(), ['POST /api/tags/3/move'],
        'rewriting an unchanged parent set would renumber a hierarchy nobody touched');
    });

    test('"At beginning" sends a null anchor rather than a NaN', async () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: 2, onDone });

      click(q('#tm-move-confirm-btn'));
      await settle();

      assert.strictEqual(requests[0].body.after_id, null);
    });

    test('a refused move reports it and reloads nothing', async () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: 2, onDone });
      respond = () => ({ ok: false, status: 400, body: { detail: 'Not a sibling' } });

      click(q('#tm-move-confirm-btn'));
      await settle();

      assert.deepEqual(toast(), { message: 'Not a sibling', type: 'error' });
      assert.equal(done, 0);
    });

    test('refuses to guess a parent', async () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: null, onDone });

      click(q('#tm-move-confirm-btn'));
      await settle();

      assert.deepEqual(toast(), { message: 'Select a parent first.', type: 'error' });
      assert.equal(requests.length, 0);
    });

    test('the search box narrows the parent list', () => {
      openMoveDialog({ tags: FOREST, tagId: 3, contextParentId: null, onDone });

      type(q('.tm-picker-search'), 'ram');

      assert.deepEqual(
        qa('.tm-picker-item').filter(i => !i.classList.contains('hidden'))
          .map(i => i.querySelector('.tm-picker-name').textContent),
        ['Ramen'],
      );
    });
  });

  // ── openDropOnConfirm ──────────────────────────────────────────────────────

  describe('openDropOnConfirm', () => {
    test('does nothing when either end of the drag is unknown', () => {
      assert.equal(openDropOnConfirm({ tags: FOREST, dragId: 999, targetId: 1, onDone }), null);
      assert.equal(openDropOnConfirm({ tags: FOREST, dragId: 1, targetId: 999, onDone }), null);
      assert.equal(q('.modal-overlay'), null);
    });

    test('names both tags and both outcomes, because neither is undoable', () => {
      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 5, onDone });

      assert.match(q('.modal-header').textContent, /Move "Kyoto" under "Food"\?/);
      assert.match(q('#drop-move-btn').textContent, /replaces other parents/);
      assert.match(q('#drop-also-btn').textContent, /keeps other parents/);
    });

    test('Move replaces the parents with the drop target', async () => {
      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 5, onDone });

      click(q('#drop-move-btn'));
      await settle();

      assert.deepEqual(trace(), ['PUT /api/tags/3/parents']);
      assert.deepEqual(requests[0].body, { ids: [5] }, 'Japan is dropped, as the button says');
      assert.equal(done, 1);
      assert.equal(q('.modal-overlay'), null);
    });

    test('Also file keeps the parents it already had', async () => {
      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 5, onDone });

      click(q('#drop-also-btn'));
      await settle();

      assert.deepEqual(requests[0].body, { ids: [2, 5] });
      assert.equal(done, 1);
    });

    test('Also file on a parent it already has writes nothing, and still refreshes', async () => {
      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 2, onDone });

      click(q('#drop-also-btn'));
      await settle();

      assert.equal(requests.length, 0, 'nothing changed, so nothing is sent');
      assert.equal(done, 1, 'the drag still moved the row, so the tree is redrawn');
    });

    test('Cancel writes nothing', async () => {
      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 5, onDone });

      click(q('#drop-cancel-btn'));
      await settle();

      assert.equal(q('.modal-overlay'), null);
      assert.equal(requests.length, 0);
      assert.equal(done, 0);
    });

    test('a refusal from either button reports the server\'s reason', async () => {
      respond = () => ({ ok: false, status: 400, body: { detail: 'Cycle detected' } });

      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 5, onDone });
      click(q('#drop-move-btn'));
      await settle();
      assert.deepEqual(toast(), { message: 'Cycle detected', type: 'error' });
      assert.equal(done, 0);

      setToast(null);
      openDropOnConfirm({ tags: FOREST, dragId: 3, targetId: 5, onDone });
      click(q('#drop-also-btn'));
      await settle();
      assert.deepEqual(toast(), { message: 'Cycle detected', type: 'error' });
      assert.equal(done, 0);
    });

    test('escapes the names rather than parsing them as markup', () => {
      openDropOnConfirm({
        tags: [tag(1, 'A & <b>B</b>'), tag(2, '<script>x</script>')],
        dragId: 1, targetId: 2, onDone,
      });

      assert.equal(q('b'), null, 'a tag name never becomes an element');
      assert.equal(q('script'), null);
      // Read back as text: the serializer re-encodes only what has to be, so
      // asserting on the entity spelling would test linkedom, not the escape.
      assert.match(q('.modal-header').textContent, /Move "A & <b>B<\/b>" under "<script>x<\/script>"\?/);
      assert.match(q('#drop-also-btn').textContent, /Also file under "<script>x<\/script>"/);
    });
  });
});
