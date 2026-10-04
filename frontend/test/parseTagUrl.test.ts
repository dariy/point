import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';
import type * as TagLinks from '../src/utils/tagLinks.ts';

/**
 * Flyout tag links carry an ancestor trail as a `?path=` query
 * (see tagHref). navigateFns must split that back into { tag, navPath }
 * instead of sweeping the whole query into the slug — otherwise the tag
 * becomes "mountains?path=nature" and gets percent-encoded into a broken
 * "/tags/mountains%3Fpath%3Dnature" URL (point-jrmy).
 */
describe('parseTagUrl', () => {
  let parseTagUrl: typeof TagLinks.parseTagUrl, tagHref: typeof TagLinks.tagHref;

  before(async () => {
    globalThis.window = mock<typeof window>({ location: mock<Location>({ origin: 'https://example.com' }) });
    ({ parseTagUrl, tagHref } = await import('../src/utils/tagLinks.ts'));
  });

  test('splits the ancestor trail out of the slug', () => {
    assert.deepStrictEqual(parseTagUrl('/tags/mountains?path=nature'), {
      tag: 'mountains',
      navPath: 'nature',
    });
  });

  test('bare tag href has no trail', () => {
    assert.deepStrictEqual(parseTagUrl('/tags/mountains'), {
      tag: 'mountains',
      navPath: null,
    });
  });

  test('multi-level trail is preserved verbatim', () => {
    assert.deepStrictEqual(parseTagUrl('/tags/city?path=location/canada'), {
      tag: 'city',
      navPath: 'location/canada',
    });
  });

  test('percent-encoded slug is decoded', () => {
    assert.deepStrictEqual(parseTagUrl('/tags/montr%C3%A9al'), {
      tag: 'montréal',
      navPath: null,
    });
  });

  test('round-trips tagHref output', () => {
    const url = tagHref('city', ['location', 'canada']);
    assert.deepStrictEqual(parseTagUrl(url), {
      tag: 'city',
      navPath: 'location/canada',
    });
  });
});
