import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.ts';
import {
  FROM_POST_CHIP_CLASS, fromPostOf, fromPostState, isSheetReturn, sheetReturnOf, sheetReturnState, syncFromPostChip,
} from '../src/plugins/tags-atlas/atlasFromPost.ts';

describe('atlasFromPost', () => {
  test('the full map entry names the post it came from', () => {
    assert.deepEqual(fromPostOf(fromPostState('a-post', 'A post')), { slug: 'a-post', title: 'A post' });
    assert.equal(fromPostOf(null), null);
    assert.equal(fromPostOf({ sheet: 'open' }), null);
    assert.equal(fromPostOf({ fromPost: '' }), null);
  });

  test('the post entry asks for the open sheet and keeps the list URL marker', () => {
    const s = sheetReturnState({ other: 1 }, '/?view=map&at=48.8,2.3,6');
    assert.deepEqual(s, { other: 1, sheet: 'open', atlasReturn: '/?view=map&at=48.8,2.3,6' });
    assert.deepEqual(sheetReturnOf(s), { atlasReturn: '/?view=map&at=48.8,2.3,6' });
    assert.deepEqual(sheetReturnOf(sheetReturnState(null, null)), { atlasReturn: null });
    // A second tap with no marker drops the old one.
    assert.equal('atlasReturn' in sheetReturnState(s, null), false);
  });

  test('the full map entry is not a sheet return (it has fromPost)', () => {
    assert.equal(sheetReturnOf(fromPostState('a-post', 'A post')), null);
    assert.equal(sheetReturnOf(null), null);
    assert.equal(sheetReturnOf({ sheet: 'closed' }), null);
  });

  test('isSheetReturn: a post path with the open sheet entry', () => {
    const s = sheetReturnState(null, null);
    assert.equal(isSheetReturn('/posts/a-post', s), true);
    assert.equal(isSheetReturn('/posts/a-post?x=1#2', s), true);
    assert.equal(isSheetReturn('/posts/a-post', null), false);
    assert.equal(isSheetReturn('/tags/paris', s), false);
    assert.equal(isSheetReturn('/search', s), false);
  });

  describe('chip', () => {
    let dom: ReturnType<typeof setupDOM>;
    beforeEach(() => { dom = setupDOM(); });
    afterEach(() => dom.cleanup());

    const fakeHistory = (state: unknown) => {
      const h = { state, backs: 0, back() { h.backs++; } };
      return h;
    };
    const chip = () => document.body.querySelector<HTMLButtonElement>(`.${FROM_POST_CHIP_CLASS}`);

    test('shows "‹ <post title>" on an entry with fromPost; a tap is history.back()', () => {
      const h = fakeHistory(fromPostState('a-post', 'A post'));
      syncFromPostChip(true, document, h as unknown as History);
      assert.equal(chip()?.textContent, '‹ A post');
      assert.equal(chip()?.getAttribute('aria-label'), 'Back to A post');
      chip()!.click();
      assert.equal(h.backs, 1);
      // A second sync keeps one chip.
      syncFromPostChip(true, document, h as unknown as History);
      assert.equal(document.body.querySelectorAll(`.${FROM_POST_CHIP_CLASS}`).length, 1);
    });

    test('no chip without fromPost, or when the ocean says no', () => {
      syncFromPostChip(true, document, fakeHistory(null) as unknown as History);
      assert.equal(chip(), null);
      const h = fakeHistory(fromPostState('a-post', 'A post')) as unknown as History;
      syncFromPostChip(true, document, h);
      syncFromPostChip(false, document, h);
      assert.equal(chip(), null, 'removed');
    });
  });
});
