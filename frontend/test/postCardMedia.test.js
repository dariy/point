import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * PostCard media rendering — what a card costs before the reader asks for it.
 *
 * The public grid used to point each card's background at the ORIGINAL upload
 * and to autoplay video cards from the original file. On a photo blog that is
 * tens of megabytes for a first screen (one real homepage measured 32MB of
 * stills plus a 90MB autoplaying clip). Cards must paint the `?thumb` variant
 * instead, and video must rest on its poster frame until the site opts into
 * hover playback.
 *
 * No jsdom in the repo — render() is a pure props → HTML string, so it is
 * exercised directly with a null container.
 */

let PostCard;

const POST = {
  id: 1,
  slug: 'a-post',
  title: 'A Post',
  tags: [],
  published_at: '2026-03-01T00:00:00Z',
};

const render = (post) => new PostCard(null, { post }).render();

describe('PostCard media', () => {
  before(async () => {
    ({ PostCard } = await import('../src/components/public/PostCard.js'));
  });

  test('image cards request the thumbnail, never the original', () => {
    const html = render({ ...POST, media_url: '/2026/03/photo.jpg' });
    assert.match(html, /background-image: url\('\/2026\/03\/photo\.jpg\?thumb'\)/);
  });

  test('video cards rest on a poster frame with a play indicator', () => {
    const html = render({ ...POST, media_url: '/2026/03/clip.mp4' });
    // The poster, not the stream.
    assert.match(html, /background-image: url\('\/2026\/03\/clip\.mp4\?thumb'\)/);
    // Nothing that would fetch the original on load.
    assert.doesNotMatch(html, /<video/);
    assert.doesNotMatch(html, /autoplay/);
    assert.match(html, /video-play-indicator/);
  });

  test('no media leaves the background unstyled', () => {
    const html = render({ ...POST });
    assert.doesNotMatch(html, /background-image/);
    assert.match(html, /class="post-card text-only"/);
  });

  test('every supported video extension gets the poster treatment', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'ogv', 'm4v', 'avi', 'mkv']) {
      const html = render({ ...POST, media_url: `/2026/03/clip.${ext}` });
      assert.doesNotMatch(html, /<video/, `${ext} should not embed a video`);
      assert.match(html, /video-play-indicator/, `${ext} should mark as playable`);
    }
  });

  test('a hostile media_url is still neutralized by safeUrl', () => {
    const html = render({ ...POST, media_url: 'javascript:alert(1)' });
    assert.doesNotMatch(html, /javascript:/);
  });
});
