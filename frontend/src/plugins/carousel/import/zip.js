/**
 * carousel/import/zip.js — a read-only ZIP reader, no dependencies.
 *
 * A `.pptx` is a ZIP of XML, and `docs/vendors.md` allows the frontend no npm
 * runtime dependency — but reading one does not need a library:
 * `DecompressionStream('deflate-raw')` has shipped in every browser Point
 * targets since May 2023, and it is what inflates an entry here.
 *
 * This reader is deliberately partial, and read-only. There is no writer and
 * there will not be one: Point reads OOXML, it does not produce it. What it
 * does support is the subset a template exporter actually emits — stored and
 * deflated entries in a single-disk, non-Zip64 archive.
 *
 * Two decisions worth keeping:
 *
 * - **Sizes and offsets come from the central directory, never a local
 *   header.** When an entry is written with a data descriptor (general-purpose
 *   flag bit 3, which streaming exporters set) its local header carries zeroed
 *   crc and sizes, with the real values trailing the compressed data. The
 *   central directory always has them. Only the local header's name/extra
 *   lengths are read, and only to find where the payload starts.
 * - **It is pointed at hostile bytes.** The input is a file a user downloaded
 *   from the internet, so a path escaping the archive root and an entry that
 *   inflates without bound are rejections, not surprises. Rejection is
 *   whole-archive for a bad path (an archive containing a zip-slip entry is not
 *   an archive Point wants any part of) and per-entry for a size cap.
 *
 * Its size — ~200 lines of code against the ~150 this was scoped at — is all
 * rejection path: Zip64 detection, the path check, three caps, and the bounds
 * checks on both headers. That is the right place for the overage; what must
 * not grow here is format coverage.
 *
 * Not verified: CRC32. The inflated length is checked against the central
 * directory, which catches truncation and the bomb case; a checksum over parts
 * that are about to be handed to an XML parser buys little for the ~40 lines a
 * table-driven CRC costs. Add it if a real archive ever proves otherwise.
 */

/** On-disk record signatures, little-endian. */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const EOCD_SIZE = 22;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const MAX_COMMENT = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** Compression methods this reader understands. */
const STORED = 0;
const DEFLATE = 8;

/**
 * Caps, sized for what this reader is for: a carousel template, which is a
 * `.pptx` of a handful of slides. They are options, not constants, so the PPTX
 * importer can tighten them further without editing this file.
 */
export const ZIP_LIMITS = {
  maxEntries: 2048,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/**
 * A typed ZIP failure. `code` is stable enough to branch on and `entry` names
 * the archive member when the failure belongs to one, so the importer can
 * report "could not read ppt/slides/slide3.xml" rather than failing anonymously.
 *
 * @typedef {'malformed'|'zip64'|'unsupported'|'unsafe-path'|'too-large'|'not-found'} ZipErrorCode
 */
export class ZipError extends Error {
  /**
   * @param {ZipErrorCode} code
   * @param {string} message
   * @param {string} [entry] archive member the failure belongs to
   */
  constructor(code, message, entry) {
    super(entry ? `${entry}: ${message}` : message);
    this.name = 'ZipError';
    /** @type {ZipErrorCode} */
    this.code = code;
    this.entry = entry || '';
  }
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name path within the archive, `/`-separated
 * @property {number} method compression method — {@link STORED} or {@link DEFLATE}
 * @property {number} compressedSize bytes on disk
 * @property {number} size bytes once inflated, per the central directory
 * @property {number} offset local file header offset
 */

/**
 * @typedef {object} ZipReader
 * @property {() => string[]} names entry paths, central-directory order, directories excluded
 * @property {(name: string) => boolean} has
 * @property {(name: string) => ZipEntry|null} entry the central-directory record, unread
 * @property {(name: string) => Promise<Uint8Array>} read inflate one entry
 */

/**
 * @typedef {object} ZipOptions
 * @property {number} [maxEntries]
 * @property {number} [maxEntryBytes]
 * @property {number} [maxTotalBytes]
 * @property {(bytes: Uint8Array, limit: number, name: string) => Promise<Uint8Array>} [decompress]
 *   raw-deflate inflater; the seam exists so a runtime without
 *   `DecompressionStream` can be tested rather than skipped
 */

const nameDecoder = new TextDecoder('utf-8');

/** @param {string} [entry] */
const zip64 = (entry) =>
  new ZipError('zip64', 'this archive uses Zip64, which this reader does not support', entry);

/**
 * True when a stored name is safe to treat as a relative path inside the
 * archive. A backslash is refused outright rather than normalized: a reader
 * that rewrites `..\` into a path segment is one interpretation away from
 * writing outside the root.
 *
 * @param {string} name
 */
function isSafePath(name) {
  if (!name || name.length > 1024) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').includes('..');
}

/**
 * Locate the end-of-central-directory record by scanning back from the end.
 * The comment length has to account for exactly the bytes that follow, which is
 * what rules out a signature that happens to appear inside a comment.
 *
 * @param {DataView} view
 * @param {number} len
 * @returns {number} offset of the record
 */
function findEocd(view, len) {
  const floor = Math.max(0, len - EOCD_SIZE - MAX_COMMENT);
  for (let at = len - EOCD_SIZE; at >= floor; at--) {
    if (view.getUint32(at, true) !== SIG_EOCD) continue;
    if (view.getUint16(at + 20, true) === len - at - EOCD_SIZE) return at;
  }
  throw new ZipError('malformed', 'not a ZIP archive: no end-of-central-directory record');
}

/**
 * Parse the central directory. Nothing is inflated here — `read()` does that
 * per entry, so a `.pptx` carrying 20 MB of images costs only its directory
 * until the importer asks for a part it wants.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {ZipOptions} [options]
 * @returns {ZipReader}
 */
export function openZip(bytes, options = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const limits = {
    maxEntries: options.maxEntries ?? ZIP_LIMITS.maxEntries,
    maxEntryBytes: options.maxEntryBytes ?? ZIP_LIMITS.maxEntryBytes,
    maxTotalBytes: options.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes,
  };
  const decompress = options.decompress || inflateRaw;
  if (data.byteLength < EOCD_SIZE) {
    throw new ZipError('malformed', 'too small to be a ZIP archive');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const eocd = findEocd(view, data.byteLength);
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) throw zip64();
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdStart = view.getUint32(eocd + 16, true);
  if (count === U16_MAX || cdSize === U32_MAX || cdStart === U32_MAX) throw zip64();
  if (cdStart + cdSize > data.byteLength) {
    throw new ZipError('malformed', 'central directory runs past the end of the archive');
  }
  if (count > limits.maxEntries) {
    throw new ZipError('too-large', `archive declares ${count} entries, over the ${limits.maxEntries} cap`);
  }

  /** @type {Map<string, ZipEntry>} */
  const entries = new Map();
  const cdEnd = cdStart + cdSize;
  let total = 0;
  let at = cdStart;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > cdEnd) {
      throw new ZipError('malformed', `central directory ends mid-record (entry ${i} of ${count})`);
    }
    if (view.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ZipError('malformed', `central directory record ${i} has a bad signature`);
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const next = at + CENTRAL_SIZE + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (next > cdEnd) {
      throw new ZipError('malformed', `central directory ends mid-record (entry ${i} of ${count})`);
    }
    const name = nameDecoder.decode(data.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLen));
    at = next;

    // A directory marker has no payload; nothing downstream wants one.
    if (name.endsWith('/')) continue;
    if (compressedSize === U32_MAX || size === U32_MAX || offset === U32_MAX) throw zip64(name);
    if (!isSafePath(name)) {
      throw new ZipError(
        'unsafe-path',
        `refusing an entry whose path escapes the archive root: ${JSON.stringify(name)}`,
        name,
      );
    }
    if (flags & 0x1) throw new ZipError('unsupported', 'entry is encrypted', name);
    if (size > limits.maxEntryBytes) {
      throw new ZipError('too-large', `declares ${size} bytes, over the ${limits.maxEntryBytes} per-entry cap`, name);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new ZipError('too-large', `archive inflates past the ${limits.maxTotalBytes} total cap`, name);
    }
    entries.set(name, { name, method, compressedSize, size, offset });
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    entry: (name) => entries.get(name) || null,
    read: (name) => readEntry(data, view, entries, name, limits, decompress),
  };
}

/**
 * Every entry, inflated, keyed by path. The convenience form — prefer
 * {@link openZip} when only a few parts of a large archive are wanted.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {ZipOptions} [options]
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(bytes, options = {}) {
  const zip = openZip(bytes, options);
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const name of zip.names()) out.set(name, await zip.read(name));
  return out;
}

/**
 * @param {Uint8Array} data
 * @param {DataView} view
 * @param {Map<string, ZipEntry>} entries
 * @param {string} name
 * @param {{maxEntryBytes: number}} limits
 * @param {NonNullable<ZipOptions['decompress']>} decompress
 * @returns {Promise<Uint8Array>}
 */
async function readEntry(data, view, entries, name, limits, decompress) {
  const entry = entries.get(name);
  if (!entry) throw new ZipError('not-found', 'no such entry in this archive', name);
  if (entry.offset + LOCAL_SIZE > data.byteLength) {
    throw new ZipError('malformed', 'local header runs past the end of the archive', name);
  }
  if (view.getUint32(entry.offset, true) !== SIG_LOCAL) {
    throw new ZipError('malformed', 'local header has a bad signature', name);
  }
  // Only the two length fields — see the header note on data descriptors.
  const skip = view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const from = entry.offset + LOCAL_SIZE + skip;
  if (from + entry.compressedSize > data.byteLength) {
    throw new ZipError('malformed', 'entry data runs past the end of the archive', name);
  }
  const raw = data.subarray(from, from + entry.compressedSize);

  // Stored entries pass through: small XML parts are often written uncompressed
  // and feeding them to an inflater fails.
  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) {
      throw new ZipError('malformed', 'a stored entry declares two different sizes', name);
    }
    return raw.slice();
  }
  if (entry.method !== DEFLATE) {
    throw new ZipError(
      'unsupported',
      `uses compression method ${entry.method}; only stored (0) and deflate (8) are read`,
      name,
    );
  }
  const limit = Math.min(entry.size || limits.maxEntryBytes, limits.maxEntryBytes);
  const out = await decompress(raw, limit, name);
  if (entry.size && out.byteLength !== entry.size) {
    throw new ZipError(
      'malformed',
      `inflated to ${out.byteLength} bytes, central directory says ${entry.size}`,
      name,
    );
  }
  return out;
}

/**
 * Raw-deflate inflate through the platform, counting bytes as they arrive so a
 * bomb is stopped mid-stream rather than after it has been allocated.
 *
 * @param {Uint8Array} bytes
 * @param {number} limit
 * @param {string} name
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(bytes, limit, name) {
  const Inflate = globalThis.DecompressionStream;
  if (typeof Inflate !== 'function') {
    throw new ZipError('unsupported', 'this runtime has no DecompressionStream', name);
  }
  // The BufferSource annotation and cast are about tsc, not about the code: a
  // stream's type parameter is invariant to it, so a `ReadableStream<Uint8Array>`
  // will not pipe into `DecompressionStream.writable`, which is a
  // `WritableStream<BufferSource>`.
  /** @type {ReadableStream<BufferSource>} */
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(/** @type {BufferSource} */ (bytes));
      controller.close();
    },
  });
  const reader = source.pipeThrough(new Inflate('deflate-raw')).getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new ZipError('too-large', `inflates past its declared ${limit} bytes`, name);
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof ZipError) throw err;
    throw new ZipError('malformed', `deflate stream is corrupt: ${err.message}`, name);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
