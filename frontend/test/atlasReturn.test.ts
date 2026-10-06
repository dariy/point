import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { memoryStorage } from './helpers/mock.ts';
import { markAtlasOpen, clearAtlasOpen, takeAtlasReturn } from '../src/utils/atlasReturn.ts';

describe('atlasReturn', () => {
  beforeEach(() => { globalThis.sessionStorage = memoryStorage(); });
  afterEach(() => { Reflect.deleteProperty(globalThis, 'sessionStorage'); });

  test('round trip: mark, then take once', () => {
    markAtlasOpen({ returnUrl: '/tags/paris?atlas=list-map&view=48.8,2.3,6' });
    assert.equal(takeAtlasReturn(), '/tags/paris?atlas=list-map&view=48.8,2.3,6');
    assert.equal(takeAtlasReturn(), null, 'take removes the marker');
  });

  test('no marker gives null', () => {
    assert.equal(takeAtlasReturn(), null);
  });

  test('clearAtlasOpen drops the marker', () => {
    markAtlasOpen({ returnUrl: '/' });
    clearAtlasOpen();
    assert.equal(takeAtlasReturn(), null);
  });
});
