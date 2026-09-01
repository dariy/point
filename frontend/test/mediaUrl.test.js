import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  THUMB_SIZES,
  DEFAULT_THUMB_SIZE,
  thumbLadder,
  thumbUrl,
  thumbSrcset,
  thumbAttrs,
} from '../src/utils/mediaUrl.js';

/** Stand in for the document bootstrap the server injects. */
function bootstrap(media) {
  globalThis.window = media === undefined ? {} : { __MEDIA__: media };
}

describe('mediaUrl', () => {
  beforeEach(() => bootstrap({ gen: 'c0ffee01', sizes: [128, 256, 512, 1024] }));
  afterEach(() => {
    delete globalThis.window;
  });

  describe('thumbLadder', () => {
    test('prefers the server ladder over this build\'s copy', () => {
      bootstrap({ gen: 'c0ffee01', sizes: [200, 400] });
      assert.deepStrictEqual(thumbLadder(), [200, 400]);
    });

    test('falls back when the bootstrap is absent or malformed', () => {
      bootstrap(undefined);
      assert.deepStrictEqual(thumbLadder(), THUMB_SIZES);
      bootstrap({ gen: 'c0ffee01', sizes: [] });
      assert.deepStrictEqual(thumbLadder(), THUMB_SIZES);
      bootstrap({ gen: 'c0ffee01', sizes: 'nope' });
      assert.deepStrictEqual(thumbLadder(), THUMB_SIZES);
    });
  });

  describe('thumbUrl', () => {
    test('builds a rung URL with the generation token', () => {
      assert.strictEqual(
        thumbUrl('/2026/03/photo.jpg', 256),
        '/2026/03/photo.jpg?s=256&v=c0ffee01',
      );
    });

    test('replaces an existing query rather than appending to it', () => {
      // posts.thumbnail_path and published content still carry the legacy form;
      // the media API hands back a rung URL of its own.
      assert.strictEqual(
        thumbUrl('/2026/03/photo.jpg?thumb', 128),
        '/2026/03/photo.jpg?s=128&v=c0ffee01',
      );
      assert.strictEqual(
        thumbUrl('/2026/03/photo.jpg?s=512&v=deadbeef', 128),
        '/2026/03/photo.jpg?s=128&v=c0ffee01',
      );
    });

    test('drops v when there is no bootstrap to read', () => {
      // node tests and an offline shell: `v` never selects bytes, so the URL
      // still resolves — it just cannot be cached hard.
      bootstrap(undefined);
      assert.strictEqual(thumbUrl('/2026/03/photo.jpg', 512), '/2026/03/photo.jpg?s=512');
      delete globalThis.window;
      assert.strictEqual(thumbUrl('/2026/03/photo.jpg', 512), '/2026/03/photo.jpg?s=512');
    });

    test('escapes the token', () => {
      bootstrap({ gen: 'a b&c' });
      assert.strictEqual(thumbUrl('/a.jpg', 128), '/a.jpg?s=128&v=a%20b%26c');
    });

    test('snaps a size off the ladder up to a real rung', () => {
      // The route rejects an unknown size rather than clamping it, so a stray
      // number must not turn into a 400.
      assert.strictEqual(thumbUrl('/a.jpg', 200), '/a.jpg?s=256&v=c0ffee01');
      assert.strictEqual(thumbUrl('/a.jpg', 5000), '/a.jpg?s=1024&v=c0ffee01');
      assert.strictEqual(thumbUrl('/a.jpg', 'huge'), `/a.jpg?s=${DEFAULT_THUMB_SIZE}&v=c0ffee01`);
      assert.strictEqual(thumbUrl('/a.jpg'), `/a.jpg?s=${DEFAULT_THUMB_SIZE}&v=c0ffee01`);
    });

    test('returns "" for an empty path', () => {
      assert.strictEqual(thumbUrl(''), '');
      assert.strictEqual(thumbUrl(null), '');
      assert.strictEqual(thumbUrl(undefined), '');
    });
  });

  describe('thumbSrcset', () => {
    test('descriptors are the rungs when no dimensions are known', () => {
      const { srcset, sizes } = thumbSrcset('/2026/03/photo.jpg', { sizes: '80px' });
      assert.strictEqual(
        srcset,
        '/2026/03/photo.jpg?s=128&v=c0ffee01 128w, ' +
          '/2026/03/photo.jpg?s=256&v=c0ffee01 256w, ' +
          '/2026/03/photo.jpg?s=512&v=c0ffee01 512w, ' +
          '/2026/03/photo.jpg?s=1024&v=c0ffee01 1024w',
      );
      assert.strictEqual(sizes, '80px');
    });

    test('a landscape source gets exact widths, and every rung is real', () => {
      // 3000x2000: the longest side clears the top rung, so nothing is dropped
      // and the original — 3000px of camera JPEG — is never a candidate.
      const { srcset } = thumbSrcset('/a.jpg', { width: 3000, height: 2000 });
      assert.deepStrictEqual(
        srcset.split(', ').map((c) => c.split(' ')[1]),
        ['128w', '256w', '512w', '1024w'],
      );
    });

    test('a portrait source gets its true widths, not the rungs', () => {
      // 2000x3000 at rung 512 is 341 wide, not 512 — the rung caps the LONGEST
      // side. This is the over-claim the dimensionless path has to live with.
      // Truncated, matching imaging.Fit: rung 256 is 170 wide, not 171.
      const { srcset } = thumbSrcset('/a.jpg', { width: 2000, height: 3000 });
      assert.deepStrictEqual(
        srcset.split(', ').map((c) => c.split(' ')[1]),
        ['85w', '170w', '341w', '682w'],
      );
    });

    test('rungs at or above the longest side collapse into the original', () => {
      // 600x400: rung 1024 is never written — the server serves the original for
      // it — so emitting it would be two URLs for one file.
      const { srcset } = thumbSrcset('/a.jpg', { width: 600, height: 400 });
      assert.strictEqual(
        srcset,
        '/a.jpg?s=128&v=c0ffee01 128w, /a.jpg?s=256&v=c0ffee01 256w, ' +
          '/a.jpg?s=512&v=c0ffee01 512w, /a.jpg 600w',
      );
    });

    test('a source below the bottom rung is only ever the original', () => {
      const { src, srcset } = thumbSrcset('/tiny.png?thumb', { width: 90, height: 60 });
      assert.strictEqual(srcset, '/tiny.png 90w');
      assert.strictEqual(src, '/tiny.png');
    });

    test('src aims at the default rung for a browser that ignores srcset', () => {
      const { src } = thumbSrcset('/a.jpg', { width: 3000, height: 2000 });
      assert.strictEqual(src, `/a.jpg?s=${DEFAULT_THUMB_SIZE}&v=c0ffee01`);
    });

    test('src falls back to the top rung when the ladder is truncated below it', () => {
      // 400x300 tops out at the 256 rung plus the 400px original.
      const { src } = thumbSrcset('/a.jpg', { width: 400, height: 300 });
      assert.strictEqual(src, '/a.jpg?s=256&v=c0ffee01');
    });

    test('src stays on a rung for a portrait, whose descriptors never reach it', () => {
      // 540x960: every descriptor is under 512, but the 512 rung exists and is
      // a third the size of the original.
      const { src } = thumbSrcset('/a.jpg', { width: 540, height: 960 });
      assert.strictEqual(src, '/a.jpg?s=512&v=c0ffee01');
    });

    test('degrades to a plain rung URL with no bootstrap', () => {
      bootstrap(undefined);
      const { src, srcset } = thumbSrcset('/a.jpg', { sizes: '80px' });
      assert.strictEqual(src, '/a.jpg?s=512');
      assert.ok(srcset.startsWith('/a.jpg?s=128 128w, '));
    });

    test('an empty path yields nothing to render', () => {
      assert.deepStrictEqual(thumbSrcset('', { sizes: '80px' }), {
        src: '',
        srcset: '',
        sizes: '80px',
      });
    });
  });

  describe('thumbAttrs', () => {
    test('renders escaped attributes', () => {
      bootstrap({ gen: 'a&b', sizes: [128, 256] });
      const attrs = String(thumbAttrs('/2026/03/photo.jpg', { sizes: '(max-width: 48em) 50vw, 220px' }));
      assert.strictEqual(
        attrs,
        'src="/2026/03/photo.jpg?s=256&amp;v=a%26b" ' +
          'srcset="/2026/03/photo.jpg?s=128&amp;v=a%26b 128w, ' +
          '/2026/03/photo.jpg?s=256&amp;v=a%26b 256w" ' +
          'sizes="(max-width: 48em) 50vw, 220px"',
      );
    });

    test('omits sizes when the caller has none', () => {
      const attrs = String(thumbAttrs('/a.jpg'));
      assert.ok(!attrs.includes('sizes='));
    });

    test('renders nothing for an empty path, so no bare <img> is emitted', () => {
      assert.strictEqual(String(thumbAttrs('')), '');
      assert.strictEqual(String(thumbAttrs(null)), '');
    });
  });
});
