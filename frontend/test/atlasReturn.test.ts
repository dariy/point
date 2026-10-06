import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { memoryStorage } from './helpers/mock.ts';
import { markAtlasOpen, clearAtlasOpen, takeAtlasReturn, consumeAtlasReturn } from '../src/utils/atlasReturn.ts';

describe('atlasReturn', () => {
  beforeEach(() => { globalThis.sessionStorage = memoryStorage(); });
  afterEach(() => { Reflect.deleteProperty(globalThis, 'sessionStorage'); });

  test('round trip: mark, take, consume', () => {
    markAtlasOpen({ placeTagId: 7, sheetPage: 2, sheetPerPage: 6, returnUrl: '/map?timeline=2020' });
    assert.equal(takeAtlasReturn('a-post'), '/map?timeline=2020');
    assert.deepEqual(consumeAtlasReturn(), {
      placeTagId: 7, sheetPage: 2, sheetPerPage: 6, returnUrl: '/map?timeline=2020', postSlug: 'a-post',
    });
    assert.equal(consumeAtlasReturn(), null, 'consume removes the marker');
    assert.equal(takeAtlasReturn('a-post'), null, 'take moved the open context');
  });

  test('a context without a URL falls back to /map', () => {
    markAtlasOpen({ placeTagId: 1 });
    assert.equal(takeAtlasReturn('p'), '/map');
  });

  test('no context gives null and leaves no return marker', () => {
    assert.equal(takeAtlasReturn('p'), null);
    assert.equal(consumeAtlasReturn(), null);
  });

  test('clearAtlasOpen drops the open marker', () => {
    markAtlasOpen({ placeTagId: 1 });
    clearAtlasOpen();
    assert.equal(takeAtlasReturn('p'), null);
  });
});
