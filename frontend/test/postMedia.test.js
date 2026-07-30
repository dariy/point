import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  mediaFromHtml,
  extractMedia,
  splitTopLevelBlocks,
  mediaTypeFromPath,
  stripHtml,
} from '../src/utils/postMedia.js';

const types = (items) => items.map((i) => i.type);

/**
 * mediaFromHtml builds the immersive viewer's slide list. A post with mixed
 * images and text used to lose every paragraph here: without an <hr> the
 * function fell through to extractMedia, which keeps only media. Forcing such
 * a post into immersive mode silently dropped all its prose (point-924a).
 */
describe('mediaFromHtml — mixed images and text', () => {
  const mixed = [
    '<p>An opening paragraph.</p>',
    '<img src="/2026/07/a.jpg" alt="first">',
    '<p>Commentary between the photographs.</p>',
    '<img src="/2026/07/b.jpg" alt="second">',
    '<p>A closing thought.</p>',
  ].join('\n');

  test('keeps the text between images as slides', () => {
    assert.deepStrictEqual(
      types(mediaFromHtml(mixed)),
      ['html', 'image', 'html', 'image', 'html'],
    );
  });

  test('preserves image order, urls and alt text', () => {
    const images = mediaFromHtml(mixed).filter((i) => i.type === 'image');
    assert.deepStrictEqual(
      images,
      [
        { type: 'image', url: '/2026/07/a.jpg', alt: 'first' },
        { type: 'image', url: '/2026/07/b.jpg', alt: 'second' },
      ],
    );
  });

  test('no prose is dropped', () => {
    const rendered = mediaFromHtml(mixed)
      .filter((i) => i.type === 'html')
      .map((i) => stripHtml(i.html))
      .join(' ');
    for (const phrase of ['An opening paragraph', 'Commentary between', 'A closing thought']) {
      assert.ok(rendered.includes(phrase), `lost text: ${phrase}`);
    }
  });

  test('agrees with the explicit <hr> path on the same content', () => {
    const withHr = mixed.split('\n').join('\n<hr>\n');
    assert.deepStrictEqual(types(mediaFromHtml(withHr)), types(mediaFromHtml(mixed)));
  });

  test('consecutive text blocks merge into one slide', () => {
    const html = '<p>One.</p><p>Two.</p><img src="/a.jpg">';
    assert.deepStrictEqual(types(mediaFromHtml(html)), ['html', 'image']);
  });
});

/**
 * Media-only posts are the common case and must be untouched by the above:
 * every one of these still yields bare media items, never a text slide.
 */
describe('mediaFromHtml — media-only posts are unchanged', () => {
  const cases = {
    'bare img tags': '<img src="/a.jpg"><img src="/b.jpg">',
    'imgs wrapped in paragraphs': '<p><img src="/a.jpg"></p><p><img src="/b.jpg"></p>',
    'several imgs in one block': '<p><img src="/a.jpg"><img src="/b.jpg"></p>',
    'bare media URL lines': '/2026/07/a.jpg\n/2026/07/b.jpg',
  };
  for (const [name, html] of Object.entries(cases)) {
    test(name, () => {
      assert.deepStrictEqual(types(mediaFromHtml(html)), ['image', 'image']);
    });
  }

  test('video and audio are recognised', () => {
    const html = '<video src="/a.mp4"></video><audio src="/b.mp3"></audio>';
    assert.deepStrictEqual(types(mediaFromHtml(html)), ['video', 'audio']);
  });

  test('empty content yields no slides', () => {
    assert.deepStrictEqual(mediaFromHtml(''), []);
  });
});

describe('mediaFromHtml — captions', () => {
  // A figure with a caption is a mixed block, so it stays one html slide —
  // the same thing the <hr> path has always done with this markup.
  test('a figure with a caption keeps its caption', () => {
    const html = '<figure><img src="/a.jpg"><figcaption>A caption</figcaption></figure>';
    const items = mediaFromHtml(html);
    assert.deepStrictEqual(types(items), ['html']);
    assert.ok(items[0].html.includes('A caption'));
  });

  test('an image whose only text is its own URL is media, not text', () => {
    const html = '<p>/2026/07/a.jpg</p>';
    assert.deepStrictEqual(types(mediaFromHtml(html)), ['image']);
  });
});

describe('mediaFromHtml — explicit <hr> separators still win', () => {
  test('a long mixed segment stays a single slide', () => {
    const html = '<p>One.</p><p>Two.</p><hr><img src="/a.jpg">';
    assert.deepStrictEqual(types(mediaFromHtml(html)), ['html', 'image']);
  });

  test('self-closing and spaced hr forms are all recognised', () => {
    for (const hr of ['<hr>', '<hr/>', '<hr />']) {
      const html = `<p>Text.</p>${hr}<img src="/a.jpg">`;
      assert.deepStrictEqual(types(mediaFromHtml(html)), ['html', 'image'], hr);
    }
  });
});

describe('splitTopLevelBlocks', () => {
  test('keeps nested markup inside its parent block', () => {
    const blocks = splitTopLevelBlocks('<div><p>a</p><p>b</p></div><p>c</p>');
    assert.deepStrictEqual(blocks, ['<div><p>a</p><p>b</p></div>', '<p>c</p>']);
  });

  test('treats a top-level void element as its own block', () => {
    assert.deepStrictEqual(
      splitTopLevelBlocks('<p>a</p><img src="/x.jpg"><p>b</p>'),
      ['<p>a</p>', '<img src="/x.jpg">', '<p>b</p>'],
    );
  });

  test('returns plain text with no tags as a single block', () => {
    assert.deepStrictEqual(splitTopLevelBlocks('just words'), ['just words']);
  });

  test('drops whitespace-only blocks', () => {
    assert.deepStrictEqual(splitTopLevelBlocks('<p>a</p>\n\n  \n<p>b</p>'), ['<p>a</p>', '<p>b</p>']);
  });

  test('an unclosed tag does not swallow the rest of the document', () => {
    assert.ok(splitTopLevelBlocks('<p>a<p>b</p>').length >= 1);
  });
});

describe('extractMedia', () => {
  test('reads src and alt from img tags', () => {
    assert.deepStrictEqual(
      extractMedia('<img src="/a.jpg" alt="hello">'),
      [{ type: 'image', url: '/a.jpg', alt: 'hello' }],
    );
  });

  test('ignores an img with no src', () => {
    assert.deepStrictEqual(extractMedia('<img alt="broken">'), []);
  });

  test('falls back to bare URL lines when there are no tags', () => {
    assert.deepStrictEqual(types(extractMedia('/a.jpg\n/b.mp4')), ['image', 'video']);
  });

  test('a non-media URL line is not picked up', () => {
    assert.deepStrictEqual(extractMedia('/some/page'), []);
  });
});

describe('mediaTypeFromPath', () => {
  test('classifies by extension, case-insensitively', () => {
    assert.strictEqual(mediaTypeFromPath('/a.JPG'), 'image');
    assert.strictEqual(mediaTypeFromPath('/a.mp4'), 'video');
    assert.strictEqual(mediaTypeFromPath('/a.mp3'), 'audio');
    assert.strictEqual(mediaTypeFromPath('/a.txt'), null);
    assert.strictEqual(mediaTypeFromPath('/no-extension'), null);
  });
});
