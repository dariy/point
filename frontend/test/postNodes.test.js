import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseNodes, serializeNodes, firstImagePath } from '../src/utils/postNodes.js';

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
