// Fails when the Node that runs the tests cannot remove TypeScript types.
// Every test that imports a frontend/src .ts module depends on that.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sum } from './fixtures/typed.ts';

test('Node removes TypeScript types from an imported .ts module', () => {
    assert.equal(sum({ a: 2, b: 3 }), 5);
});
