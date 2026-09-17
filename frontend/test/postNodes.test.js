import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  parseNodes,
  serializeNodes,
  firstImagePath,
  carouselFence,
  newCarouselKey,
  groupIntoCarousel,
  ungroupCarousel,
  insertPathIntoCarousel,
  removePathFromCarousel,
  dedupeCarouselKeys,
} from '../src/utils/postNodes.js';

const CAROUSEL_ONE = ':::{.carousel-block}\n\n/2026/08/slide-1.jpg\n\n:::';
const CAROUSEL_TWO =
  ':::{.carousel-block}\n\n/2026/08/slide-1.jpg\n\n/2026/08/slide-2.jpg\n\n:::';
const tenPaths = Array.from({ length: 10 }, (_, i) => `/2026/08/slide-${i + 1}.jpg`);
const CAROUSEL_KEYED =
  ':::{.carousel-block #c-7f3a}\n\n/2026/08/slide-1.jpg\n\n/2026/08/slide-2.jpg\n\n:::';
const CAROUSEL_TEN = `:::{.carousel-block}\n\n${tenPaths.join('\n\n')}\n\n:::`;

describe('parseNodes', () => {
  test('a bare media path on its own line becomes an image node', () => {
    assert.deepStrictEqual(parseNodes('/2024/05/beach.jpg'), [
      { type: 'image', path: '/2024/05/beach.jpg' },
    ]);
  });

  test('text between images is one node per run, trimmed', () => {
    const nodes = parseNodes('Morning.\n\n/2024/05/a.jpg\n/2024/05/b.jpg\n\nEvening.');
    assert.deepStrictEqual(nodes, [
      { type: 'text', text: 'Morning.' },
      { type: 'image', path: '/2024/05/a.jpg' },
      { type: 'image', path: '/2024/05/b.jpg' },
      { type: 'text', text: 'Evening.' },
    ]);
  });

  test('--- separates blocks and never becomes a node', () => {
    assert.deepStrictEqual(parseNodes('One\n---\nTwo'), [
      { type: 'text', text: 'One' },
      { type: 'text', text: 'Two' },
    ]);
  });

  test('a fenced block keeps its class out of the text', () => {
    assert.deepStrictEqual(parseNodes(':::{.note}\nWatch out\n:::'), [
      { type: 'text', text: 'Watch out', blockClass: 'note' },
    ]);
  });

  test('empty content has no nodes', () => {
    assert.deepStrictEqual(parseNodes(''), []);
    assert.deepStrictEqual(parseNodes(null), []);
    assert.deepStrictEqual(parseNodes('\n\n---\n\n'), []);
  });

  test('a path that is not a media path stays text', () => {
    assert.deepStrictEqual(parseNodes('/about'), [{ type: 'text', text: '/about' }]);
  });
});

describe('serializeNodes', () => {
  test('round trips a mixed document', () => {
    const md = 'Morning.\n---\n/2024/05/a.jpg\nEvening.\n---';
    assert.deepStrictEqual(parseNodes(serializeNodes(parseNodes(md))), parseNodes(md));
  });

  test('a fenced block round trips with its class', () => {
    const nodes = [{ type: 'text', text: 'Watch out', blockClass: 'note' }];
    assert.deepStrictEqual(parseNodes(serializeNodes(nodes)), nodes);
  });

  test('an image serializes to its bare path', () => {
    assert.strictEqual(serializeNodes([{ type: 'image', path: '/2024/05/a.jpg' }]), '/2024/05/a.jpg');
  });
});

describe('firstImagePath', () => {
  test('finds a bare path', () => {
    assert.strictEqual(firstImagePath('text\n/2024/05/a.jpg\nmore'), '/2024/05/a.jpg');
  });

  test('finds one inside markdown or HTML', () => {
    assert.strictEqual(firstImagePath('![alt](/2024/05/a.png)'), '/2024/05/a.png');
    assert.strictEqual(firstImagePath('<img src="/2024/05/a.webp">'), '/2024/05/a.webp');
  });

  test('returns the first of several', () => {
    assert.strictEqual(firstImagePath('/2024/05/a.jpg\n/2024/06/b.jpg'), '/2024/05/a.jpg');
  });

  test('skips a video — analysis runs on images', () => {
    assert.strictEqual(firstImagePath('/2024/05/clip.mp4'), null);
  });

  test('no image, empty or missing content is null', () => {
    assert.strictEqual(firstImagePath('just words'), null);
    assert.strictEqual(firstImagePath(''), null);
    assert.strictEqual(firstImagePath(undefined), null);
  });
});

describe('carousel block', () => {
  test('a :::{.carousel-block} fence parses to one carousel node, paths in order', () => {
    assert.deepStrictEqual(parseNodes(CAROUSEL_TWO), [
      { type: 'carousel', paths: ['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg'] },
    ]);
  });

  test('slides never leak out as loose image nodes', () => {
    const nodes = parseNodes(CAROUSEL_TWO);
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes.filter((n) => n.type === 'image').length, 0);
  });

  test('serializes back byte-identically in the blank-line form', () => {
    assert.strictEqual(serializeNodes(parseNodes(CAROUSEL_TWO)), CAROUSEL_TWO);
    assert.strictEqual(serializeNodes(parseNodes(CAROUSEL_ONE)), CAROUSEL_ONE);
    assert.strictEqual(serializeNodes(parseNodes(CAROUSEL_TEN)), CAROUSEL_TEN);
  });

  test('round trips: fence alone, one path and ten', () => {
    for (const md of [CAROUSEL_ONE, CAROUSEL_TWO, CAROUSEL_TEN]) {
      assert.deepStrictEqual(parseNodes(serializeNodes(parseNodes(md))), parseNodes(md));
    }
  });

  test('round trips with a paragraph above', () => {
    const md = `Intro.\n\n${CAROUSEL_TWO}`;
    assert.deepStrictEqual(parseNodes(md), [
      { type: 'text', text: 'Intro.' },
      { type: 'carousel', paths: ['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg'] },
    ]);
    assert.deepStrictEqual(parseNodes(serializeNodes(parseNodes(md))), parseNodes(md));
  });

  test('round trips with a paragraph below', () => {
    const md = `${CAROUSEL_TWO}\n\nOutro.`;
    assert.deepStrictEqual(parseNodes(md), [
      { type: 'carousel', paths: ['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg'] },
      { type: 'text', text: 'Outro.' },
    ]);
    assert.deepStrictEqual(parseNodes(serializeNodes(parseNodes(md))), parseNodes(md));
  });

  test('round trips with a paragraph above and below', () => {
    const md = `Intro.\n\n${CAROUSEL_TWO}\n\nOutro.`;
    assert.deepStrictEqual(parseNodes(md), [
      { type: 'text', text: 'Intro.' },
      { type: 'carousel', paths: ['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg'] },
      { type: 'text', text: 'Outro.' },
    ]);
    assert.deepStrictEqual(parseNodes(serializeNodes(parseNodes(md))), parseNodes(md));
  });

  test('an image directly above the fence is its own node, not swallowed', () => {
    const md = `/2026/08/cover.jpg\n${CAROUSEL_ONE}`;
    assert.deepStrictEqual(parseNodes(md), [
      { type: 'image', path: '/2026/08/cover.jpg' },
      { type: 'carousel', paths: ['/2026/08/slide-1.jpg'] },
    ]);
  });

  test('an unterminated fence keeps its text instead of losing it', () => {
    const md = ':::{.carousel-block}\n\n/2026/08/slide-1.jpg\n\nmore words';
    const nodes = parseNodes(md);
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].type, 'text');
    assert.match(nodes[0].text, /carousel-block/);
    assert.match(nodes[0].text, /slide-1\.jpg/);
  });
});

describe('keyed carousel fences', () => {
  test('carouselFence emits the key when given one, and today\'s form when not', () => {
    assert.strictEqual(carouselFence(['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg'], 'c-7f3a'), CAROUSEL_KEYED);
    assert.strictEqual(carouselFence(['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg']), CAROUSEL_TWO);
  });

  test('a keyed fence parses to a carousel node carrying the key', () => {
    assert.deepStrictEqual(parseNodes(CAROUSEL_KEYED), [
      { type: 'carousel', paths: ['/2026/08/slide-1.jpg', '/2026/08/slide-2.jpg'], key: 'c-7f3a' },
    ]);
  });

  test('a keyless fence gains no key field at all', () => {
    const [node] = parseNodes(CAROUSEL_TWO);
    assert.strictEqual('key' in node, false);
  });

  test('attribute spacing and order do not lose the slides', () => {
    const variants = [
      ':::{.carousel-block  #c-7f3a}',
      ':::{ .carousel-block #c-7f3a }',
      ':::{#c-7f3a .carousel-block}',
    ];
    for (const open of variants) {
      const nodes = parseNodes(`${open}\n\n/2026/08/slide-1.jpg\n\n:::`);
      assert.deepStrictEqual(
        nodes,
        [{ type: 'carousel', paths: ['/2026/08/slide-1.jpg'], key: 'c-7f3a' }],
        open,
      );
    }
  });

  test('a fence of some other class is not a carousel', () => {
    assert.deepStrictEqual(parseNodes(':::{.note}\nWatch out\n:::'), [
      { type: 'text', text: 'Watch out', blockClass: 'note' },
    ]);
  });

  test('slides of a keyed fence never leak out as loose image nodes', () => {
    const nodes = parseNodes(`Intro.\n\n${CAROUSEL_KEYED}\n\nOutro.`);
    assert.strictEqual(nodes.filter((n) => n.type === 'image').length, 0);
  });

  test('an unterminated keyed fence still falls back to raw text', () => {
    const nodes = parseNodes(':::{.carousel-block #c-7f3a}\n\n/2026/08/slide-1.jpg\n\nmore words');
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].type, 'text');
    assert.match(nodes[0].text, /#c-7f3a/);
  });

  test('the key round trips byte-identically, and parsing stays deterministic', () => {
    assert.strictEqual(serializeNodes(parseNodes(CAROUSEL_KEYED)), CAROUSEL_KEYED);
    assert.deepStrictEqual(parseNodes(CAROUSEL_KEYED), parseNodes(CAROUSEL_KEYED));
    assert.deepStrictEqual(parseNodes(serializeNodes(parseNodes(CAROUSEL_KEYED))), parseNodes(CAROUSEL_KEYED));
  });
});

describe('newCarouselKey', () => {
  test('looks like c-7f3a', () => {
    assert.match(newCarouselKey(), /^c-[0-9a-f]{4}$/);
  });

  test('never returns a key already taken', () => {
    // Every 4-hex key is spoken for, so the only way out is the counter suffix.
    const taken = new Set(
      Array.from({ length: 0x10000 }, (_, i) => `c-${i.toString(16).padStart(4, '0')}`),
    );
    const key = newCarouselKey(taken);
    assert.strictEqual(taken.has(key), false);
    assert.match(key, /^c-[0-9a-f]{4}-\d+$/);
  });
});

describe('carousel node operations', () => {
  const IMG_A = { type: 'image', path: '/2026/08/a.jpg' };
  const IMG_B = { type: 'image', path: '/2026/08/b.jpg' };
  const IMG_C = { type: 'image', path: '/2026/08/c.jpg' };
  const TEXT = { type: 'text', text: 'Morning.' };

  test('grouping folds the images into one keyed carousel, order preserved', () => {
    const nodes = [TEXT, IMG_A, IMG_B, IMG_C];
    const out = groupIntoCarousel(nodes, [1, 2]);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out[0], TEXT);
    assert.strictEqual(out[1].type, 'carousel');
    assert.deepStrictEqual(out[1].paths, ['/2026/08/a.jpg', '/2026/08/b.jpg']);
    assert.match(out[1].key, /^c-[0-9a-f]{4}$/);
    assert.deepStrictEqual(out[2], IMG_C);
  });

  test('grouping does not mutate its input', () => {
    const nodes = [IMG_A, IMG_B];
    const before = JSON.parse(JSON.stringify(nodes));
    groupIntoCarousel(nodes, [0, 1]);
    assert.deepStrictEqual(nodes, before);
  });

  test('indices out of order or repeated still group in document order', () => {
    const out = groupIntoCarousel([IMG_A, IMG_B, IMG_C], [2, 0, 2]);
    assert.deepStrictEqual(out[0].paths, ['/2026/08/a.jpg', '/2026/08/c.jpg']);
    assert.deepStrictEqual(out[1], IMG_B);
  });

  test('grouping a photo into an existing carousel keeps that block\'s key', () => {
    const nodes = [{ type: 'carousel', paths: ['/2026/08/s1.jpg'], key: 'c-7f3a' }, IMG_A];
    const out = groupIntoCarousel(nodes, [0, 1]);
    assert.deepStrictEqual(out, [
      { type: 'carousel', paths: ['/2026/08/s1.jpg', '/2026/08/a.jpg'], key: 'c-7f3a' },
    ]);
  });

  test('a fresh key avoids the keys already in the document', () => {
    const nodes = [{ type: 'carousel', paths: ['/2026/08/s1.jpg'], key: 'c-7f3a' }, IMG_A, IMG_B];
    const out = groupIntoCarousel(nodes, [1, 2]);
    assert.notStrictEqual(out[1].key, 'c-7f3a');
  });

  test('nothing groupable is a no-op, by identity', () => {
    const nodes = [TEXT, IMG_A];
    assert.strictEqual(groupIntoCarousel(nodes, [0]), nodes);
    assert.strictEqual(groupIntoCarousel(nodes, []), nodes);
    assert.strictEqual(groupIntoCarousel(nodes, [99]), nodes);
  });

  test('group then ungroup is the images back, in order', () => {
    const nodes = [TEXT, IMG_A, IMG_B, IMG_C];
    const grouped = groupIntoCarousel(nodes, [1, 2, 3]);
    assert.deepStrictEqual(ungroupCarousel(grouped, 1), nodes);
  });

  test('ungrouping anything that is not a carousel is a no-op, by identity', () => {
    const nodes = [TEXT, IMG_A];
    assert.strictEqual(ungroupCarousel(nodes, 0), nodes);
    assert.strictEqual(ungroupCarousel(nodes, 9), nodes);
  });

  test('a grouped document serializes to exactly carouselFence output', () => {
    const grouped = groupIntoCarousel([IMG_A, IMG_B], [0, 1]);
    const [carousel] = grouped;
    assert.strictEqual(serializeNodes(grouped), carouselFence(carousel.paths, carousel.key));
    assert.deepStrictEqual(parseNodes(serializeNodes(grouped)), grouped);
  });

  test('a path inserts at a slide index, or appends when none is given', () => {
    const nodes = [{ type: 'carousel', paths: ['/2026/08/s1.jpg', '/2026/08/s2.jpg'], key: 'c-7f3a' }];
    assert.deepStrictEqual(insertPathIntoCarousel(nodes, 0, '/2026/08/new.jpg', 1)[0].paths, [
      '/2026/08/s1.jpg',
      '/2026/08/new.jpg',
      '/2026/08/s2.jpg',
    ]);
    assert.deepStrictEqual(insertPathIntoCarousel(nodes, 0, '/2026/08/new.jpg')[0].paths, [
      '/2026/08/s1.jpg',
      '/2026/08/s2.jpg',
      '/2026/08/new.jpg',
    ]);
    // Out-of-range clamps rather than punching a hole in the slide list.
    assert.deepStrictEqual(insertPathIntoCarousel(nodes, 0, '/2026/08/new.jpg', 99)[0].paths.length, 3);
    assert.strictEqual(insertPathIntoCarousel(nodes, 0, '/2026/08/new.jpg', -5)[0].paths[0], '/2026/08/new.jpg');
    assert.deepStrictEqual(nodes[0].paths, ['/2026/08/s1.jpg', '/2026/08/s2.jpg']);
  });

  test('inserting into a non-carousel, or inserting nothing, is a no-op', () => {
    const nodes = [IMG_A, { type: 'carousel', paths: ['/2026/08/s1.jpg'] }];
    assert.strictEqual(insertPathIntoCarousel(nodes, 0, '/2026/08/new.jpg'), nodes);
    assert.strictEqual(insertPathIntoCarousel(nodes, 1, ''), nodes);
  });

  test('removing a slide leaves the rest, and the key, alone', () => {
    const nodes = [
      { type: 'carousel', paths: ['/2026/08/s1.jpg', '/2026/08/s2.jpg'], key: 'c-7f3a' },
      TEXT,
    ];
    const out = removePathFromCarousel(nodes, 0, '/2026/08/s1.jpg');
    assert.deepStrictEqual(out, [
      { type: 'carousel', paths: ['/2026/08/s2.jpg'], key: 'c-7f3a' },
      TEXT,
    ]);
    assert.deepStrictEqual(nodes[0].paths, ['/2026/08/s1.jpg', '/2026/08/s2.jpg']);
  });

  test('the last slide out takes the carousel node with it', () => {
    const nodes = [TEXT, { type: 'carousel', paths: ['/2026/08/s1.jpg'], key: 'c-7f3a' }, IMG_A];
    assert.deepStrictEqual(removePathFromCarousel(nodes, 1, '/2026/08/s1.jpg'), [TEXT, IMG_A]);
  });

  test('removing a slide that is not there is a no-op, by identity', () => {
    const nodes = [{ type: 'carousel', paths: ['/2026/08/s1.jpg'] }];
    assert.strictEqual(removePathFromCarousel(nodes, 0, '/2026/08/nope.jpg'), nodes);
    assert.strictEqual(removePathFromCarousel(nodes, 5, '/2026/08/s1.jpg'), nodes);
  });
});

describe('dedupeCarouselKeys', () => {
  test('a copy-pasted fence gets a fresh key, the first keeps its own', () => {
    const md = `${CAROUSEL_KEYED}\n\n${CAROUSEL_KEYED}`;
    const nodes = dedupeCarouselKeys(parseNodes(md));
    assert.strictEqual(nodes.length, 2);
    assert.strictEqual(nodes[0].key, 'c-7f3a');
    assert.match(nodes[1].key, /^c-[0-9a-f]{4}$/);
    assert.notStrictEqual(nodes[1].key, 'c-7f3a');
    // The slides are untouched — only the key moved.
    assert.deepStrictEqual(nodes[1].paths, nodes[0].paths);
  });

  test('three of the same key end up three different keys', () => {
    const nodes = dedupeCarouselKeys([
      { type: 'carousel', paths: ['/2026/08/a.jpg'], key: 'c-7f3a' },
      { type: 'carousel', paths: ['/2026/08/b.jpg'], key: 'c-7f3a' },
      { type: 'carousel', paths: ['/2026/08/c.jpg'], key: 'c-7f3a' },
    ]);
    assert.strictEqual(new Set(nodes.map((n) => n.key)).size, 3);
  });

  test('a fresh key never collides with one further down the document', () => {
    const nodes = dedupeCarouselKeys([
      { type: 'carousel', paths: ['/2026/08/a.jpg'], key: 'c-0001' },
      { type: 'carousel', paths: ['/2026/08/b.jpg'], key: 'c-0001' },
      { type: 'carousel', paths: ['/2026/08/c.jpg'], key: 'c-0002' },
    ]);
    assert.strictEqual(new Set(nodes.map((n) => n.key)).size, 3);
  });

  test('keyless and already-unique documents come back untouched, by identity', () => {
    const keyless = parseNodes(`${CAROUSEL_TWO}\n\n${CAROUSEL_ONE}`);
    assert.strictEqual(dedupeCarouselKeys(keyless), keyless);
    const unique = parseNodes(CAROUSEL_KEYED);
    assert.strictEqual(dedupeCarouselKeys(unique), unique);
  });

  test('does not mutate its input', () => {
    const nodes = [
      { type: 'carousel', paths: ['/2026/08/a.jpg'], key: 'c-7f3a' },
      { type: 'carousel', paths: ['/2026/08/b.jpg'], key: 'c-7f3a' },
    ];
    dedupeCarouselKeys(nodes);
    assert.strictEqual(nodes[1].key, 'c-7f3a');
  });
});
