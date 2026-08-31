import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.js';

/**
 * The admin's three image surfaces, on the thumbnail ladder.
 *
 * Each of them used to concatenate `?thumb` onto a path and paint whatever came
 * back — one rung, 512px, for a 48px card and for an 80px editor thumb alike,
 * and pinned to the pre-rebuild bytes because nothing outside the media route
 * could read the generation token. They ask for a candidate set now, and the
 * assertions here are about what reaches the markup: a `srcset`, a `sizes`
 * narrow enough to be worth having, and the `v` off the document bootstrap.
 *
 * render() is props → markup on all three, so a null container is enough; a DOM
 * is installed only because these modules touch globals as they load. The
 * renderers return the RawHtml html`` produces, so each result is put through
 * String() before it meets an assertion that wants a primitive.
 */

let dom;
let PostsListPage;
let MediaBrowser;
let VisualEditor;

before(async () => {
  dom = setupDOM();
  ({ default: PostsListPage } = await import('../src/pages/light/PostsListPage.js'));
  ({ MediaBrowser } = await import('../src/components/light/MediaBrowser.js'));
  ({ VisualEditor } = await import('../src/components/light/VisualEditor.js'));
  dom.cleanup();
});

beforeEach(() => {
  dom = setupDOM();
  window.__MEDIA__ = { gen: 'c0ffee01', sizes: [128, 256, 512, 1024] };
});
afterEach(() => dom.cleanup());

/** Every `<img …>` open tag in a chunk of markup. */
const imgs = (html) => String(html).match(/<img\b[^>]*>/g) || [];

/** render() output as a primitive, for assert.match and friends. */
const str = (markup) => String(markup);

const POST = {
  id: 1,
  title: 'A Post',
  slug: 'a-post',
  status: 'published',
  tags: [],
  published_at: '2026-03-01T00:00:00Z',
};

describe('PostsListPage thumbnails', () => {
  const page = (posts, over = {}) => {
    const p = new PostsListPage(null, {});
    p.state = { ...p.state, loading: false, posts, pagination: {}, ...over };
    return p;
  };

  test('a card row asks for a candidate set scoped to its 48px thumb', () => {
    const row = String(page([])._renderCardRow({ ...POST, media_url: '/2026/03/photo.jpg' }));
    const [img] = imgs(row);
    assert.ok(img, 'the card renders an <img>');
    assert.match(img, /src="\/2026\/03\/photo\.jpg\?s=512&amp;v=c0ffee01"/);
    assert.match(img, /srcset="[^"]*\?s=128&amp;v=c0ffee01 128w[^"]*\?s=1024&amp;v=c0ffee01 1024w"/);
    assert.match(img, /sizes="48px"/);
    assert.doesNotMatch(row, /\?thumb/, 'nothing still concatenates the legacy query');
  });

  test('a table row scopes to its 80px preview column', () => {
    const html = page([{ ...POST, media_url: '/2026/03/photo.jpg' }])._renderContent();
    const [img] = imgs(html);
    assert.match(img, /sizes="80px"/);
    assert.match(img, /srcset="[^"]+ 128w, [^"]+ 256w, [^"]+ 512w, [^"]+ 1024w"/);
  });

  test('a video poster is a candidate set too, over the play glyph', () => {
    // The poster 404s for a video that never got one, and dropBrokenImages
    // strips the <img> back to the glyph — so it is still rendered optimistically.
    const html = page([{ ...POST, media_url: '/2026/03/clip.mp4' }])._renderContent();
    const [img] = imgs(html);
    assert.match(img, /class="post-preview-img post-preview-img--poster"/);
    assert.match(img, /srcset="/);
    assert.match(img, /sizes="40px"/);
  });

  test('a post with no media renders no <img> at all', () => {
    const html = page([{ ...POST, media_url: null }])._renderContent();
    assert.strictEqual(imgs(html).length, 0);
  });
});

describe('MediaBrowser thumbnails', () => {
  const browser = (over = {}) => {
    const b = new MediaBrowser(null, {});
    b.state = { ...b.state, ...over };
    return b;
  };

  const IMAGE = {
    id: 7,
    filename: 'photo.jpg',
    path: '/2026/03/photo.jpg',
    thumbnail_path: '/2026/03/photo.jpg?s=512&v=c0ffee01',
    file_type: 'image',
    width: 2000,
    height: 3000,
    is_public: true,
  };

  test('an image uses its real dimensions, so a portrait claims its true width', () => {
    // The rung caps the LONGEST side: 2000x3000 at rung 512 is 341 wide.
    const [img] = imgs(browser()._renderItem(IMAGE, new Set()));
    assert.match(img, /srcset="[^"]*\?s=512&amp;v=c0ffee01 341w/);
    assert.match(img, /sizes="\(max-width: 48em\) 50vw, 220px"/);
  });

  test('the rungs come off the bare path, not the pre-sized thumbnail_path', () => {
    const [img] = imgs(browser()._renderItem(IMAGE, new Set()));
    assert.doesNotMatch(img, /s=512&amp;v=c0ffee01\?/, 'no query is appended to a query');
    assert.doesNotMatch(img, /jpg\?s=\d+&amp;v=c0ffee01&amp;/);
  });

  test('a source smaller than the top rung stops short of it', () => {
    // A 600px-wide upload has no 1024 rung on disk; the server would hand back
    // the original, so the original takes that slot under its own URL.
    const html = str(browser()._renderItem(
      { ...IMAGE, width: 600, height: 400 },
      new Set(),
    ));
    const [img] = imgs(html);
    assert.match(img, /srcset="[^"]*, \/2026\/03\/photo\.jpg 600w"/);
    assert.doesNotMatch(img, /s=1024/);
  });

  test('a video with a poster renders it under the play glyph', () => {
    const html = str(browser()._renderItem(
      {
        ...IMAGE,
        file_type: 'video',
        filename: 'clip.mp4',
        path: '/2026/03/clip.mp4',
        thumbnail_path: '/2026/03/clip.mp4?s=512&v=c0ffee01',
      },
      new Set(),
    ));
    assert.strictEqual(imgs(html).length, 1);
    assert.match(html, /file-icon--overlay/);
    // The stored dimensions describe the video, not the poster fitted into the
    // ladder's box, so the descriptors stay on the rungs.
    assert.match(imgs(html)[0], /\?s=512&amp;v=c0ffee01 512w/);
  });

  test('a video with no poster keeps the bare glyph', () => {
    // thumbnail_path is null exactly when no admin browser has captured a frame,
    // and MediaBrowser reads that as "this video needs a capture".
    const html = str(browser()._renderItem(
      { ...IMAGE, file_type: 'video', thumbnail_path: null },
      new Set(),
    ));
    assert.strictEqual(imgs(html).length, 0);
    assert.match(html, /class="file-icon"/);
  });

  test('a non-visual file keeps its glyph', () => {
    const html = str(browser()._renderItem(
      { ...IMAGE, file_type: 'audio', filename: 'song.mp3', thumbnail_path: null },
      new Set(),
    ));
    assert.strictEqual(imgs(html).length, 0);
  });
});

describe('VisualEditor thumbnails', () => {
  const render = (nodes, mediaByPath = {}) =>
    String(new VisualEditor(null, { nodes, mediaByPath }).render());

  test('an editor card scopes to its 80px thumb and keeps data-full on the original', () => {
    const html = render([{ type: 'image', path: '/2026/03/photo.jpg' }]);
    const [img] = imgs(html);
    assert.match(img, /sizes="80px"/);
    assert.match(img, /srcset="[^"]+ 128w,/);
    assert.match(img, /data-full="\/2026\/03\/photo\.jpg"/, 'the lightbox still opens the original');
    assert.doesNotMatch(html, /\?thumb/);
  });

  test('dimensions from mediaByPath sharpen the descriptors', () => {
    const html = render(
      [{ type: 'image', path: '/2026/03/photo.jpg' }],
      { '/2026/03/photo.jpg': { id: 7, width: 2000, height: 3000 } },
    );
    assert.match(imgs(html)[0], /\?s=512&amp;v=c0ffee01 341w/);
  });
});
