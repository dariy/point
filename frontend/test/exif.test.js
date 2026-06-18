import { test, describe, before } from 'node:test';
import assert from 'node:assert';

import {
  exifVisible,
  hasExif,
  buildExifMap,
  normalizeSrc,
  metadataForSrc,
  attachExifToImage,
} from '../src/utils/exif.js';

// A representative camera-data blob plus a GPS tag that must never surface.
const META = {
  ExposureTime: '1/250',
  FNumber: '2.8',
  FocalLength: '35',
  ISOSpeedRatings: 200,
  Make: 'FUJIFILM',
  Model: 'X100V',
  GPSLatitude: '40.7128',
  GPSLongitude: '-74.0060',
};

// ── Minimal DOM mock (mirrors the style used by other frontend tests) ──────────
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    _attrs: {},
    _text: '',
    style: {},
    parentNode: null,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        const has = this._s.has(c);
        const next = force === undefined ? !has : !!force;
        if (next) this._s.add(c); else this._s.delete(c);
        return next;
      },
    },
    set className(v) { this._s = v; v.split(/\s+/).forEach((c) => c && this.classList.add(c)); },
    get className() { return [...this.classList._s].join(' '); },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    insertBefore(node, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
      node.parentNode = this;
      return node;
    },
    addEventListener() {},
  };
  return el;
}

// Recursively collect textContent from a mock element tree.
function allText(el) {
  let t = el._text || '';
  for (const c of el.children) t += ' ' + allText(c);
  return t;
}

describe('exif', () => {
  before(() => {
    global.window = { location: { origin: 'https://example.com' } };
    global.document = { createElement: (tag) => makeEl(tag) };
  });

  describe('exifVisible', () => {
    test('hidden by default', () => {
      assert.strictEqual(exifVisible({}), false);
      assert.strictEqual(exifVisible({ exif_visibility: 'hide' }), false);
    });

    test('admin only when a user is present', () => {
      assert.strictEqual(exifVisible({ exif_visibility: 'admin' }, null), false);
      assert.strictEqual(exifVisible({ exif_visibility: 'admin' }, { id: 1 }), true);
    });

    test('all shows for everyone', () => {
      assert.strictEqual(exifVisible({ exif_visibility: 'all' }, null), true);
    });
  });

  describe('hasExif', () => {
    test('true when a curated field is present', () => {
      assert.strictEqual(hasExif({ FNumber: '2.8' }), true);
    });

    test('false for null/empty', () => {
      assert.strictEqual(hasExif(null), false);
      assert.strictEqual(hasExif({}), false);
    });

    test('false when only non-curated (e.g. GPS) fields are present', () => {
      // Privacy guarantee: GPS-only metadata must not produce an EXIF affordance.
      assert.strictEqual(hasExif({ GPSLatitude: '40.7', GPSLongitude: '-74.0' }), false);
    });
  });

  describe('normalizeSrc / buildExifMap / metadataForSrc', () => {
    test('strips origin and ?thumb', () => {
      assert.strictEqual(normalizeSrc('https://example.com/2026/03/p.jpg?thumb'), '/2026/03/p.jpg');
      assert.strictEqual(normalizeSrc('/2026/03/p.jpg'), '/2026/03/p.jpg');
    });

    test('resolves metadata by normalized path', () => {
      const map = buildExifMap([
        { path: '/2026/03/p.jpg', metadata: META },
        { path: '/2026/03/noexif.jpg' }, // no metadata → not mapped
      ]);
      assert.strictEqual(metadataForSrc(map, 'https://example.com/2026/03/p.jpg?thumb'), META);
      assert.strictEqual(metadataForSrc(map, '/2026/03/noexif.jpg'), null);
      assert.strictEqual(metadataForSrc(map, '/missing.jpg'), null);
    });
  });

  describe('attachExifToImage', () => {
    test('wraps the image and renders formatted, curated fields only', () => {
      const parent = makeEl('p');
      const img = makeEl('img');
      parent.appendChild(img);

      attachExifToImage(img, META);

      const figure = parent.children.find((c) => c.classList.contains('media-exif-wrapper'));
      assert.ok(figure, 'image is wrapped in a media-exif-wrapper figure');
      assert.ok(figure.children.includes(img), 'image moved inside the wrapper');
      assert.ok(figure.children.some((c) => c.classList.contains('exif-info-btn')), 'has info button');

      const text = allText(figure);
      assert.match(text, /1\/250 s/, 'shutter formatted');
      assert.match(text, /f\/2\.8/, 'aperture formatted');
      assert.match(text, /35 mm/, 'focal length formatted');
      assert.match(text, /ISO 200/, 'ISO formatted');
      assert.match(text, /X100V/, 'model shown');
      // GPS must never appear.
      assert.doesNotMatch(text, /40\.7128|74\.0060|GPS/, 'no GPS leakage');
    });

    test('no-op when there is nothing curated to show', () => {
      const parent = makeEl('p');
      const img = makeEl('img');
      parent.appendChild(img);
      attachExifToImage(img, { GPSLatitude: '40.7' });
      assert.strictEqual(parent.children.length, 1, 'image left untouched');
      assert.strictEqual(parent.children[0], img);
    });
  });
});
