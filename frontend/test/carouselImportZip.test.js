/**
 * carousel/import/zip.js — the dependency-free ZIP reader.
 *
 * Two kinds of archive are read here, deliberately:
 *
 * - `fixtures/zip-shape.pptx`, produced by the `zip` CLI (see the fixtures
 *   README), which is what proves the reader survives a real archiver's output
 *   — its directory entries, its nested paths, its mix of stored and deflated
 *   members.
 * - archives `buildZip` assembles byte by byte, which is the only way to reach
 *   the rejection paths. A Zip64 locator, a `../` member, a size field that
 *   lies about what the stream inflates to: no archiver will write those for
 *   us, and they are exactly the cases that matter for a file a user
 *   downloaded from the internet.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ZIP_LIMITS,
  ZipError,
  openZip,
  readZip,
} from '../src/plugins/carousel/import/zip.js';

const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/zip-shape.pptx', import.meta.url)));

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const encoder = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);
const bin = (value) => (typeof value === 'string' ? encoder.encode(value) : value);

const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/**
 * Assemble a ZIP from explicit field values. Every field a rejection test needs
 * to lie about is an override, and the defaults produce a valid archive of
 * stored entries.
 *
 * Entry shape: `{ name, data, method, raw, flags, localExtra, size,
 * compressedSize, localSig, centralSig }` — `raw` is what lands on disk when it
 * differs from `data` (a deflated payload), and `size`/`compressedSize` override
 * what the central directory claims about it.
 */
function buildZip(entries, options = {}) {
  const bodies = [];
  const directory = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = bin(entry.data ?? new Uint8Array(0));
    const raw = entry.raw ? bin(entry.raw) : data;
    const localExtra = entry.localExtra ?? new Uint8Array(0);
    const size = entry.size ?? data.byteLength;
    const compressedSize = entry.compressedSize ?? raw.byteLength;

    const local = new Uint8Array(30 + name.byteLength + localExtra.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, entry.localSig ?? SIG_LOCAL, true);
    lv.setUint16(6, entry.flags ?? 0, true);
    lv.setUint16(8, entry.method ?? 0, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, localExtra.byteLength, true);
    local.set(name, 30);
    local.set(localExtra, 30 + name.byteLength);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, entry.centralSig ?? SIG_CENTRAL, true);
    cv.setUint16(8, entry.flags ?? 0, true);
    cv.setUint16(10, entry.method ?? 0, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    bodies.push(local, raw);
    directory.push(central);
    offset += local.byteLength + raw.byteLength;
  }

  const cdStart = offset;
  const cd = concat(directory);
  const tail = [];

  if (options.zip64Locator) {
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, SIG_ZIP64_LOCATOR, true);
    tail.push(locator);
  }

  const comment = options.comment ? bin(options.comment) : new Uint8Array(0);
  const eocd = new Uint8Array(22 + comment.byteLength);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, options.count ?? entries.length, true);
  ev.setUint16(10, options.count ?? entries.length, true);
  ev.setUint32(12, options.cdSize ?? cd.byteLength, true);
  ev.setUint32(16, options.cdStart ?? cdStart, true);
  ev.setUint16(20, comment.byteLength, true);
  eocd.set(comment, 22);
  tail.push(eocd);

  return concat([...bodies, cd, ...tail]);
}

/** Raw deflate, for the entries whose payload has to be a real stream. */
async function deflateRaw(bytes) {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concat(chunks);
}

/** Assert a ZipError with this code, and that it names the entry when it should. */
async function rejectsWith(code, entry, run) {
  await assert.rejects(async () => run(), (err) => {
    assert.ok(err instanceof ZipError, `expected a ZipError, got ${err}`);
    assert.strictEqual(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    if (entry !== null) assert.strictEqual(err.entry, entry);
    return true;
  });
}

describe('the platform seam', () => {
  // The reader leans on two built-ins. If a future Node drops below them the
  // failure should read as this assertion, not as thirty confusing ones.
  test('node provides DecompressionStream and CompressionStream', () => {
    assert.strictEqual(typeof globalThis.DecompressionStream, 'function');
    assert.strictEqual(typeof globalThis.CompressionStream, 'function');
  });
});

describe('readZip, against an archive the zip CLI wrote', () => {
  test('every member comes back, and no directory entries do', async () => {
    const files = await readZip(FIXTURE);
    assert.deepStrictEqual(
      [...files.keys()],
      ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml'],
    );
  });

  test('a stored member passes through unchanged', async () => {
    const files = await readZip(FIXTURE);
    const content = text(files.get('[Content_Types].xml'));
    assert.match(content, /^<\?xml version="1\.0"/);
    assert.match(content, /PartName="\/ppt\/slides\/slide1\.xml"/);
    assert.strictEqual(openZip(FIXTURE).entry('[Content_Types].xml').method, 0);
  });

  test('a deflated member inflates', async () => {
    const files = await readZip(FIXTURE);
    assert.match(text(files.get('ppt/presentation.xml')), /<p:sldSz cx="12192000" cy="6858000"\/>/);
    assert.match(text(files.get('ppt/slides/slide1.xml')), /<a:t>Seamless cover<\/a:t>/);
    assert.strictEqual(openZip(FIXTURE).entry('ppt/presentation.xml').method, 8);
  });

  test('the inflated bytes match the length the directory declared', async () => {
    const zip = openZip(FIXTURE);
    for (const name of zip.names()) {
      const bytes = await zip.read(name);
      assert.strictEqual(bytes.byteLength, zip.entry(name).size, name);
    }
  });
});

describe('openZip is lazy', () => {
  test('the directory is parsed without inflating anything', () => {
    // A deflated entry whose payload is garbage: parsing has to succeed
    // regardless, and only `read()` may fail. That is the whole point of the
    // lazy form — a .pptx carrying 20 MB of images costs its directory only.
    const bytes = buildZip([
      { name: 'a.xml', data: 'hello', method: 8, raw: 'not deflate at all', size: 5 },
      { name: 'b.xml', data: 'plain' },
    ]);
    const zip = openZip(bytes);
    assert.deepStrictEqual(zip.names(), ['a.xml', 'b.xml']);
    assert.ok(zip.has('b.xml'));
    assert.ok(!zip.has('c.xml'));
    assert.strictEqual(zip.entry('c.xml'), null);
  });

  test('reading a member that is not there is typed, not undefined', async () => {
    const zip = openZip(buildZip([{ name: 'a.xml', data: 'x' }]));
    await rejectsWith('not-found', 'nope.xml', () => zip.read('nope.xml'));
  });

  test('the local header extra field is skipped, even when the directory has none', async () => {
    // A real archiver writes different extra fields in the two headers, and the
    // payload offset depends on the local one.
    const localExtra = new Uint8Array(9).fill(0x55);
    const zip = openZip(buildZip([{ name: 'a.xml', data: 'payload', localExtra }]));
    assert.strictEqual(text(await zip.read('a.xml')), 'payload');
  });

  test('an archive comment containing an EOCD signature does not fool the scan', async () => {
    const decoy = new Uint8Array(64);
    new DataView(decoy.buffer).setUint32(8, SIG_EOCD, true);
    const files = await readZip(buildZip([{ name: 'a.xml', data: 'ok' }], { comment: decoy }));
    assert.strictEqual(text(files.get('a.xml')), 'ok');
  });
});

describe('compression methods', () => {
  test('deflate round trips through the platform', async () => {
    const body = '<p:sp>'.repeat(400);
    const raw = await deflateRaw(encoder.encode(body));
    const files = await readZip(buildZip([
      { name: 'big.xml', data: body, raw, method: 8 },
    ]));
    assert.strictEqual(text(files.get('big.xml')), body);
  });

  test('a stored entry is not fed to the inflater', async () => {
    // Stored bytes are not a valid deflate stream, so a reader that inflated
    // unconditionally would fail here rather than return the content.
    const files = await readZip(buildZip([{ name: 'a.xml', data: '<x/>', method: 0 }]));
    assert.strictEqual(text(files.get('a.xml')), '<x/>');
  });

  test('any other method is refused by name', async () => {
    const zip = openZip(buildZip([{ name: 'a.xml', data: 'x', method: 12 }]));
    await rejectsWith('unsupported', 'a.xml', () => zip.read('a.xml'));
    await assert.rejects(() => zip.read('a.xml'), /method 12/);
  });

  test('an encrypted entry is refused at parse time', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x', flags: 0x1 }])),
      (err) => err.code === 'unsupported' && /encrypted/.test(err.message),
    );
  });

  test('the decompressor is a seam', async () => {
    const calls = [];
    const decompress = async (bytes, limit, name) => {
      calls.push({ bytes: bytes.byteLength, limit, name });
      return encoder.encode('substituted');
    };
    const zip = openZip(
      buildZip([{ name: 'a.xml', data: 'hello', method: 8, raw: 'xx', size: 11 }]),
      { decompress },
    );
    assert.strictEqual(text(await zip.read('a.xml')), 'substituted');
    assert.deepStrictEqual(calls, [{ bytes: 2, limit: 11, name: 'a.xml' }]);
  });
});

describe('refusals: paths', () => {
  for (const name of ['../evil.xml', 'ppt/../../evil.xml', '/etc/passwd', 'C:/evil.xml', 'ppt\\slide.xml']) {
    test(`${JSON.stringify(name)} rejects the whole archive`, () => {
      // Whole-archive, not per-entry: an archive containing a zip-slip member
      // is not one Point wants any part of.
      assert.throws(
        () => openZip(buildZip([{ name: 'ok.xml', data: 'x' }, { name, data: 'x' }])),
        (err) => err instanceof ZipError && err.code === 'unsafe-path' && err.entry === name,
      );
    });
  }

  test('a name that merely contains dots is fine', async () => {
    const files = await readZip(buildZip([{ name: 'ppt/..slide/a..b.xml', data: 'x' }]));
    assert.ok(files.has('ppt/..slide/a..b.xml'));
  });
});

describe('refusals: size', () => {
  test('an entry over the per-entry cap is refused before it is read', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x', size: 4096 }]), { maxEntryBytes: 1024 }),
      (err) => err.code === 'too-large' && err.entry === 'a.xml',
    );
  });

  test('entries that are each small but together too big are refused', () => {
    const entries = [
      { name: 'a.xml', data: 'x', size: 600 },
      { name: 'b.xml', data: 'x', size: 600 },
    ];
    assert.throws(
      () => openZip(buildZip(entries), { maxEntryBytes: 1024, maxTotalBytes: 1000 }),
      (err) => err.code === 'too-large' && err.entry === 'b.xml',
    );
  });

  test('too many entries is refused from the EOCD count alone', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x' }], { count: 5000 }), { maxEntries: 100 }),
      (err) => err.code === 'too-large' && /5000 entries/.test(err.message),
    );
  });

  test('a stream that inflates past its declared size is stopped mid-stream', async () => {
    // The decompression bomb: 512 KB of zeros compress to almost nothing, and
    // the directory claims 16 bytes. Nothing may allocate the difference.
    const bomb = await deflateRaw(new Uint8Array(512 * 1024));
    const zip = openZip(buildZip([
      { name: 'bomb.xml', data: 'x', raw: bomb, method: 8, size: 16 },
    ]));
    await rejectsWith('too-large', 'bomb.xml', () => zip.read('bomb.xml'));
  });

  test('the per-entry cap bounds an entry that declares no size at all', async () => {
    // A zeroed size in the central directory leaves nothing to bound the
    // inflate with, so the cap has to be what stops it.
    const bomb = await deflateRaw(new Uint8Array(512 * 1024));
    const zip = openZip(
      buildZip([{ name: 'bomb.xml', data: 'x', raw: bomb, method: 8, size: 0 }]),
      { maxEntryBytes: 4096 },
    );
    await rejectsWith('too-large', 'bomb.xml', () => zip.read('bomb.xml'));
  });

  test('the defaults are the documented ones', () => {
    assert.deepStrictEqual(ZIP_LIMITS, {
      maxEntries: 2048,
      maxEntryBytes: 32 * 1024 * 1024,
      maxTotalBytes: 128 * 1024 * 1024,
    });
  });
});

describe('refusals: Zip64', () => {
  test('the Zip64 locator before the EOCD is detected', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x' }], { zip64Locator: true })),
      (err) => err.code === 'zip64' && /does not support/.test(err.message),
    );
  });

  test('a 0xffffffff size in the directory is detected rather than misparsed', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x', size: 0xffffffff }])),
      (err) => err.code === 'zip64' && err.entry === 'a.xml',
    );
  });

  test('a 0xffff entry count is detected', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x' }], { count: 0xffff })),
      (err) => err.code === 'zip64',
    );
  });
});

describe('refusals: malformed', () => {
  test('bytes that are not a ZIP at all', () => {
    assert.throws(
      () => openZip(encoder.encode('<?xml version="1.0"?><nope/>'.repeat(4))),
      (err) => err.code === 'malformed' && /no end-of-central-directory/.test(err.message),
    );
  });

  test('an input too short to hold an EOCD', () => {
    assert.throws(() => openZip(new Uint8Array(8)), (err) => err.code === 'malformed');
  });

  test('a central directory pointing past the end of the archive', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x' }], { cdStart: 0xfffff })),
      (err) => err.code === 'malformed' && /past the end/.test(err.message),
    );
  });

  test('a bad central directory signature', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x', centralSig: 0xdeadbeef }])),
      (err) => err.code === 'malformed' && /bad signature/.test(err.message),
    );
  });

  test('a directory declaring more entries than it holds', () => {
    assert.throws(
      () => openZip(buildZip([{ name: 'a.xml', data: 'x' }], { count: 3 })),
      (err) => err.code === 'malformed' && /mid-record/.test(err.message),
    );
  });

  test('a bad local header signature', async () => {
    const zip = openZip(buildZip([{ name: 'a.xml', data: 'x', localSig: 0xdeadbeef }]));
    await rejectsWith('malformed', 'a.xml', () => zip.read('a.xml'));
  });

  test('a stored entry whose two sizes disagree', async () => {
    const zip = openZip(buildZip([{ name: 'a.xml', data: 'hello', size: 4 }]));
    await rejectsWith('malformed', 'a.xml', () => zip.read('a.xml'));
  });

  test('entry data running past the end of the archive', async () => {
    const zip = openZip(buildZip([
      { name: 'a.xml', data: 'hi', method: 8, compressedSize: 9999, size: 2 },
    ]));
    await rejectsWith('malformed', 'a.xml', () => zip.read('a.xml'));
  });

  test('a corrupt deflate stream names the entry', async () => {
    const zip = openZip(buildZip([
      { name: 'ppt/slides/slide3.xml', data: 'x'.repeat(40), raw: 'not deflate', method: 8, size: 40 },
    ]));
    await rejectsWith('malformed', 'ppt/slides/slide3.xml', () => zip.read('ppt/slides/slide3.xml'));
    await assert.rejects(
      () => zip.read('ppt/slides/slide3.xml'),
      /ppt\/slides\/slide3\.xml: deflate stream is corrupt/,
    );
  });

  test('a truncated deflate stream is a length mismatch, not a short read', async () => {
    const body = 'y'.repeat(400);
    const raw = await deflateRaw(encoder.encode(body));
    const zip = openZip(buildZip([
      { name: 'a.xml', data: body, raw, method: 8, size: 4000 },
    ]));
    await rejectsWith('malformed', 'a.xml', () => zip.read('a.xml'));
    await assert.rejects(() => zip.read('a.xml'), /central directory says 4000/);
  });
});

describe('input shapes', () => {
  test('an ArrayBuffer reads the same as a Uint8Array', async () => {
    const bytes = buildZip([{ name: 'a.xml', data: 'shared' }]);
    const copy = bytes.slice().buffer;
    assert.strictEqual(text((await readZip(copy)).get('a.xml')), 'shared');
  });

  test('a view into a larger buffer respects its own bounds', async () => {
    const bytes = buildZip([{ name: 'a.xml', data: 'offset' }]);
    const padded = new Uint8Array(bytes.byteLength + 24);
    padded.set(bytes, 12);
    const view = padded.subarray(12, 12 + bytes.byteLength);
    assert.strictEqual(text((await readZip(view)).get('a.xml')), 'offset');
  });
});
