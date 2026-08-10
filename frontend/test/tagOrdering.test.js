import { test, describe } from 'node:test';
import assert from 'node:assert';

import { getChildrenOf, getSiblingBefore } from '../src/components/light/tags/tagOrdering.js';

// Travel's stored child order is Japan, France, Peru — deliberately not the
// order the tags appear in the flat list, and not alphabetical.
const tags = [
  { id: 1, name: 'Travel', children: [{ id: 3 }, { id: 2 }, { id: 4 }] },
  { id: 2, name: 'France' },
  { id: 3, name: 'Japan' },
  { id: 4, name: 'Peru' },
  { id: 5, name: 'Childless', children: [] },
  { id: 6, name: 'NoChildrenKey' },
  { id: 7, name: 'Dangling', children: [{ id: 999 }, { id: 2 }] },
];

describe('getChildrenOf', () => {
  test('returns children in the parent\'s stored order, not list order', () => {
    assert.deepEqual(getChildrenOf(tags, 1).map(t => t.name), ['Japan', 'France', 'Peru']);
  });

  test('returns [] for a parent with no children', () => {
    assert.deepEqual(getChildrenOf(tags, 5), []);
    assert.deepEqual(getChildrenOf(tags, 6), []);
  });

  test('returns [] for an unknown parent', () => {
    assert.deepEqual(getChildrenOf(tags, 12345), []);
  });

  test('returns [] for a null or zero parent id', () => {
    // Top-level rows carry no parent; 0 must not be read as a real id.
    assert.deepEqual(getChildrenOf(tags, null), []);
    assert.deepEqual(getChildrenOf(tags, undefined), []);
    assert.deepEqual(getChildrenOf(tags, 0), []);
  });

  test('drops child ids that are not in the tag list', () => {
    assert.deepEqual(getChildrenOf(tags, 7).map(t => t.name), ['France']);
  });

  test('is safe on an empty tag list', () => {
    assert.deepEqual(getChildrenOf([], 1), []);
  });
});

describe('getSiblingBefore', () => {
  test('returns the id of the preceding sibling', () => {
    // order is Japan(3), France(2), Peru(4)
    assert.equal(getSiblingBefore(tags, 2, 1), 3);
    assert.equal(getSiblingBefore(tags, 4, 1), 2);
  });

  test('returns null for the first sibling — meaning "move to the front"', () => {
    assert.equal(getSiblingBefore(tags, 3, 1), null);
  });

  test('returns null when the target is not a child of that parent', () => {
    assert.equal(getSiblingBefore(tags, 999, 1), null);
  });

  test('returns null when the parent has no children or is unknown', () => {
    assert.equal(getSiblingBefore(tags, 2, 5), null);
    assert.equal(getSiblingBefore(tags, 2, 12345), null);
    assert.equal(getSiblingBefore(tags, 2, null), null);
  });

  test('skips over dangling child ids when finding the predecessor', () => {
    // Dangling's stored children are [999(missing), 2]; France is therefore
    // first among the ones that resolve, so nothing precedes it.
    assert.equal(getSiblingBefore(tags, 2, 7), null);
  });
});
