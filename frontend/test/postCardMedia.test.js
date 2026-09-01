import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * PostCard media rendering — what a card costs before the reader asks for it.
 *
 * The public grid used to point each card's background at the ORIGINAL upload
 * and to autoplay video cards from the original file. On a photo blog that is
 * tens of megabytes for a first screen (one real homepage measured 32MB of
 * stills plus a 90MB autoplaying clip). Cards must paint a thumbnail rung
 * instead, and video must rest on its poster frame until the site opts into
 * hover playback.
 *
 * The rung is chosen by the browser from a srcset, which is why the card paints
 * an <img> rather than the CSS background-image it carried for years: a
 * background-image has one URL and no way to say that the same card is 380px
 * wide alone on a phone and 320px wide three-across on a desktop.
 *
 * render() is a pure props → markup function, so it is exercised directly with
 * a null container, no DOM needed. The playback behaviour that the poster frame
 * defers to — hover and tap previews — lives in afterRender and is covered
 * against a real DOM in postCardVideoPreview.test.js.
 */

let PostCard;

const POST = {
  id: 1,
  slug: 'a-post',
  title: 'A Post',
  tags: [],
  published_at: '2026-03-01T00:00:00Z',
};

// render() returns the RawHtml html`` produces; String() for the assertions.
const render = (post) => String(new PostCard(null, { post }).render());

describe('PostCard media', () => {
  before(async () => {
    ({ PostCard } = await import('../src/components/public/PostCard.js'));
  });

  test('image cards request a thumbnail rung, never the original', () => {
    const html = render({ ...POST, media_url: '/2026/03/photo.jpg' });
    assert.match(html, /<img [^>]*src="\/2026\/03\/photo\.jpg\?s=512"/);
    // No URL without a rung on it: the bare path is the multi-megabyte original.
    assert.doesNotMatch(html, /"\/2026\/03\/photo\.jpg"/);
    assert.doesNotMatch(html, /background-image/);
  });

  test('a card offers the whole ladder and says how wide it will paint', () => {
    const html = render({ ...POST, media_url: '/2026/03/photo.jpg' });
    const srcset = html.match(/srcset="([^"]*)"/)?.[1];
    assert.deepEqual(
      srcset?.split(', '),
      [
        '/2026/03/photo.jpg?s=128 128w',
        '/2026/03/photo.jpg?s=256 256w',
        '/2026/03/photo.jpg?s=512 512w',
        '/2026/03/photo.jpg?s=1024 1024w',
      ],
    );
    // Without `sizes` a browser assumes 100vw and takes the top rung for every
    // card in the grid — the srcset would cost more than it saves.
    assert.match(html, /sizes="[^"]+"/);
    // Cards below the fold must not be fetched at all until they are neared.
    assert.match(html, /loading="lazy"/);
  });

  test('video cards rest on a poster frame with a play indicator', () => {
    const html = render({ ...POST, media_url: '/2026/03/clip.mp4' });
    // The poster (the rung), not the stream.
    assert.match(html, /<img [^>]*src="\/2026\/03\/clip\.mp4\?s=512"/);
    // Nothing that would fetch the original on load.
    assert.doesNotMatch(html, /<video/);
    assert.doesNotMatch(html, /autoplay/);
    assert.match(html, /video-play-indicator/);
  });

  test('no media leaves the background empty', () => {
    const html = render({ ...POST });
    assert.match(html, /<div class="post-card-background"><\/div>/);
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
    // Rejected outright rather than turned into four variant URLs — but the
    // card keeps the shape its media gave it.
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /class="post-card has-image"/);
  });
});
