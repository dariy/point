import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseNodes, serializeNodes, firstImagePath } from '../src/utils/postNodes.js';

const CAROUSEL_ONE = ':::{.carousel-block}\n\n/2026/08/slide-1.jpg\n\n:::';
const CAROUSEL_TWO =
  ':::{.carousel-block}\n\n/2026/08/slide-1.jpg\n\n/2026/08/slide-2.jpg\n\n:::';
const tenPaths = Array.from({ length: 10 }, (_, i) => `/2026/08/slide-${i + 1}.jpg`);
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
