import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

/**
 * The offline settings card's half of the thumbnail ladder: which URLs it hands
 * to preCacheImages, and the progress it reports while they download.
 *
 * Both were broken by the ladder. The URL set said `path + "?thumb"`, one URL
 * per image, from before a variant had a size or a generation token; and the
 * progress callback was passed as preCacheImages' second argument — the cache
 * name — so it was never called, and the arithmetic waiting for it multiplied a
 * progress object by 0.6 and painted "NaN%".
 */

describe('OfflineDataSection', () => {
  let dom;
  let OfflineDataSection;

  before(async () => {
    const domHelper = await import('./helpers/dom.js');
    dom = domHelper.setupDOM();
    globalThis.window.__MEDIA__ = { gen: 'c0ffee01', sizes: [128, 256, 512, 1024] };
    ({ OfflineDataSection } = await import(
      '../src/components/light/sections/OfflineDataSection.js'
    ));
  });

  after(() => {
    if (dom) dom.cleanup();
  });

  let section;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    section = new OfflineDataSection(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('_imageUrls', () => {
    const snapshot = {
      posts: [
        { media_url: '/2026/03/cover.jpg' },
        { media_url: '/2026/03/clip.mp4' },
        { media_url: 'https://cdn.example.com/remote.jpg' },
        { media_url: null },
        {},
      ],
      media: [{ path: '/2026/03/cover.jpg' }, { path: '/2026/04/other.jpg' }],
    };

    test('asks for ladder rungs, token and all — never the old "?thumb"', () => {
      const { thumbs } = section._imageUrls(snapshot);
      assert.ok(thumbs.length > 0);
      for (const url of thumbs) {
        assert.match(url, /\?s=\d+&v=c0ffee01$/, url);
      }
    });

    test('takes the two rungs a post cover is painted at, and 256 for the grid', () => {
      const { thumbs } = section._imageUrls(snapshot);
      assert.deepStrictEqual(thumbs, [
        '/2026/03/cover.jpg?s=512&v=c0ffee01',
        '/2026/03/cover.jpg?s=1024&v=c0ffee01',
        '/2026/03/clip.mp4?s=512&v=c0ffee01',
        '/2026/03/clip.mp4?s=1024&v=c0ffee01',
        '/2026/03/cover.jpg?s=256&v=c0ffee01',
        '/2026/04/other.jpg?s=256&v=c0ffee01',
      ]);
    });

    test('keeps originals for images only — a video original is not a thumbnail', () => {
      const { originals } = section._imageUrls(snapshot);
      assert.deepStrictEqual(originals, ['/2026/03/cover.jpg', '/2026/04/other.jpg']);
    });

    test('skips remote URLs, which cache.add cannot store and the SW never sees', () => {
      const { thumbs, originals } = section._imageUrls(snapshot);
      const all = [...thumbs, ...originals];
      assert.ok(!all.some((u) => u.includes('cdn.example.com')), all.join(' '));
    });

    test('survives a snapshot with neither key', () => {
      assert.deepStrictEqual(section._imageUrls({}), { thumbs: [], originals: [] });
    });
  });

  describe('_imageProgress', () => {
    /** Render the card mid-download, where the progress bar exists. */
    function showDownloading() {
      section.setState({
        loading: false,
        stats: { post_count: 2, image_count: 3, original_bytes: 10, thumbnail_bytes: 2 },
        downloading: true,
        progress: 40,
        statusText: 'Caching images…',
      });
    }

    test('runs the bar from 40% to 100% across both cache passes', () => {
      showDownloading();
      // Four thumbnails and one original: one counter, two preCacheImages calls.
      const onImage = section._imageProgress(5);
      for (let i = 0; i < 4; i++) onImage();
      assert.ok(section.state.progress > 40 && section.state.progress < 100);

      onImage();
      assert.strictEqual(section.state.progress, 100);
      assert.match(container.textContent, /Caching images \(100%\)/);
      assert.ok(!container.textContent.includes('NaN'), container.textContent);
    });

    test('never renders NaN — the callback takes a progress object', () => {
      showDownloading();
      const onImage = section._imageProgress(3);
      onImage({ completed: 1, total: 3, current: '/2026/03/a.jpg' });
      assert.strictEqual(Number.isFinite(section.state.progress), true);
      assert.ok(!container.textContent.includes('NaN'), container.textContent);
    });

    test('re-renders once per whole percent, not once per image', () => {
      showDownloading();
      let renders = 0;
      const rerender = section._rerender.bind(section);
      section._rerender = () => {
        renders++;
        rerender();
      };

      const onImage = section._imageProgress(500);
      for (let i = 0; i < 500; i++) onImage();

      assert.strictEqual(section.state.progress, 100);
      // At most one render per whole percent it passes through, 0 to 100.
      assert.ok(renders <= 101, `re-rendered ${renders} times for 500 images`);
    });

    test('an empty download still finishes the bar', () => {
      showDownloading();
      section._imageProgress(0)();
      assert.strictEqual(section.state.progress, 100);
    });
  });
});
