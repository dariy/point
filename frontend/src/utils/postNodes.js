/**
 * The visual editor's document model.
 *
 * A post's content is markdown, but the visual editor edits it as a flat list
 * of nodes — an image is a bare `/YYYY/MM/name.jpg` path on its own line, and
 * everything between images is one text node. `---` separates blocks and is a
 * pure serialization artefact, so it never becomes a node.
 *
 * A `:::{.carousel-block}` fence of bare media paths is a first-class
 * `{type: "carousel", paths: [...]}` node — parsed line-based here (ahead of
 * IMAGE_PATH_RE) so its slides never leak out as loose image nodes, and
 * serialized back in the blank-line form the render contract requires
 * (`docs/features/carousel-studio.md`). VisualEditor.js carries its own copy
 * of this parse/serialize pair and must learn the same node.
 *
 * The fence may carry a key — `:::{.carousel-block #c-7f3a}` — which is how a
 * post addresses one carousel among several. Parse and serialize only carry a
 * key that is already written down; neither mints one. The round trip is
 * asserted as a deep-equal of two independent parses, so a key minted inside
 * the parser would make the same markdown parse into two different documents.
 * Minting belongs to the node operations at the bottom of this file, which the
 * editor calls explicitly — `dedupeCarouselKeys` right after every parse.
 *
 * The pair is a round trip: `serializeNodes(parseNodes(md))` is the same
 * document, which is what lets the editor switch between Text and Visual mode
 * without a canonical form on either side.
 */

/**
 * One node of the visual editor's document. Which fields are present follows
 * `type`: a text node has `text` (and `blockClass` when it was wrapped in a
 * `:::{.class}` fence), an image node a `path`, a carousel node its `paths`
 * and, when its fence was keyed, a `key`.
 *
 * @typedef {object} EditorNode
 * @property {'text'|'image'|'carousel'} type
 * @property {string} [text]
 * @property {string} [blockClass]
 * @property {string} [path]
 * @property {string[]} [paths]
 * @property {string} [key]
 */

/** A bare media path on its own line — how the visual editor stores an image. */
export const IMAGE_PATH_RE = /^\/\d{4}\/\d{2}\/.+$/;

/**
 * The class on the fenced div that wraps a carousel's slides. Hardcoded a
 * second time as CAROUSEL_BLOCK_RE in postMedia.js (duplicated, not imported,
 * to keep that module dependency-free for the preload path) and a third time
 * as carouselBlockRe in api/internal/services/post_publish.go — Go and JS
 * cannot share a constant. Changing the class name means updating all three.
 */
export const CAROUSEL_BLOCK_CLASS = "carousel-block";

const CAROUSEL_FENCE_OPEN = `:::{.${CAROUSEL_BLOCK_CLASS}}`;

/** A `:::{…}` fence-open line, with its attribute list captured. */
const FENCE_OPEN_RE = /^:::\{([^}]*)\}$/;

/**
 * The first media path in raw markdown, wherever it sits — bare, in a link, in
 * quotes. Used to pick the image an AI analysis should run on when the editor
 * is in Text mode; the extension list is what keeps it off a video.
 */
const FIRST_IMAGE_IN_TEXT_RE =
  /(?:^|["'\s(])(\/\d{4}\/\d{2}\/.+?\.(?:jpe?g|png|webp|gif|avif|heic|tiff|bmp))(?:["'\s)]|$)/i;

/**
 * Read a trimmed line as a carousel fence-open. Attribute order and spacing are
 * whatever goldmark-attributes accepts, so `:::{ #c-7f3a .carousel-block }` is
 * the same fence as `:::{.carousel-block #c-7f3a}` — a hand-edited post must
 * not silently lose its slides to a stray space.
 *
 * @param {string} line  A trimmed line.
 * @returns {{key?: string}|null}  null when the line opens no carousel fence;
 *   otherwise the fence's attributes, `key` absent when it is keyless.
 */
function matchCarouselFenceOpen(line) {
  const match = line.match(FENCE_OPEN_RE);
  if (!match) return null;
  const attrs = match[1].trim().split(/\s+/).filter(Boolean);
  if (!attrs.includes(`.${CAROUSEL_BLOCK_CLASS}`)) return null;
  const id = attrs.find((a) => a.length > 1 && a.startsWith("#"));
  return id ? { key: id.slice(1) } : {};
}

/**
 * The `:::{.carousel-block}` fence for a list of media paths, in the blank-line
 * form the render contract requires (`docs/features/carousel-studio.md`): a
 * blank line between every path, because `html.WithHardWraps()` would otherwise
 * collapse adjacent paths into one `<br>`-joined `<p>`.
 *
 * Shared so the carousel plugin's `buildCarouselBlock` and this module's node
 * serializer emit byte-identical blocks.
 *
 * @param {string[]} paths
 * @param {string} [key]  Block key; omitted, the fence stays in today's
 *   keyless form, so nothing rewrites a post that never needed one.
 * @returns {string}
 */
export function carouselFence(paths, key) {
  const open = key
    ? `:::{.${CAROUSEL_BLOCK_CLASS} #${key}}`
    : CAROUSEL_FENCE_OPEN;
  return `${open}\n\n${(paths || []).join("\n\n")}\n\n:::`;
}

/** Serialize a carousel node back to its fenced div, blank line between paths. */
function serializeCarousel(paths, key) {
  return carouselFence(paths, key);
}

/**
 * A carousel node. The key is absent, not empty, when there is none: a keyless
 * fence has to parse to a node with no `key` at all for the round-trip
 * deep-equal to hold on it.
 *
 * @param {string[]} paths
 * @param {string} [key]
 * @returns {EditorNode}
 */
function carouselNode(paths, key) {
  /** @type {EditorNode} */
  const node = { type: "carousel", paths };
  if (key) node.key = key;
  return node;
}

/**
 * @param {string} content  Post markdown.
 * @returns {EditorNode[]}
 */
export function parseNodes(content) {
  const lines = (content || "").split("\n");
  const nodes = [];
  let textBuf = [];
  // Non-null while inside a :::{.carousel-block} fence: { paths, raw, key }.
  let carousel = null;

  const flushText = () => {
    const text = textBuf.join("\n").trim();
    if (text) {
      const fenceMatch = text.match(/^:::\{\.([^}]+)\}\n([\s\S]*)\n:::$/);
      if (fenceMatch) {
        nodes.push({ type: "text", text: fenceMatch[2], blockClass: fenceMatch[1] });
      } else {
        nodes.push({ type: "text", text });
      }
    }
    textBuf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (carousel) {
      carousel.raw.push(line);
      if (trimmed === ":::") {
        nodes.push(carouselNode(carousel.paths, carousel.key));
        carousel = null;
      } else if (IMAGE_PATH_RE.test(trimmed)) {
        carousel.paths.push(trimmed);
      }
      continue;
    }

    const fence = matchCarouselFenceOpen(trimmed);
    if (fence) {
      flushText();
      carousel = { paths: [], raw: [line], key: fence.key };
    } else if (IMAGE_PATH_RE.test(trimmed)) {
      flushText();
      nodes.push({ type: "image", path: trimmed });
    } else if (trimmed === "---") {
      flushText();
    } else {
      textBuf.push(line);
    }
  }

  if (carousel) {
    // Unterminated fence — keep the raw lines as text rather than lose them.
    textBuf.push(...carousel.raw);
    carousel = null;
  }
  flushText();
  return nodes;
}

/**
 * @param {EditorNode[]} nodes
 * @returns {string}
 */
export function serializeNodes(nodes) {
  return nodes
    .map((n) => {
      if (n.type === "image") return n.path;
      if (n.type === "carousel") return serializeCarousel(n.paths, n.key);
      if (n.blockClass) return `:::{.${n.blockClass}}\n${n.text}\n:::\n---`;
      return n.text + "\n---";
    })
    .join("\n");
}

/** The first image path in markdown content, or null. */
export function firstImagePath(content) {
  const match = (content || "").match(FIRST_IMAGE_IN_TEXT_RE);
  return match ? match[1] : null;
}

/* ---------------------------------------------------------------------------
 * Node operations
 *
 * What the editor calls to compose carousels. Every one of them takes a node
 * list and returns a node list, never mutating the one it was given; a call
 * that changes nothing returns the very array it was handed, so a caller can
 * test for a no-op with `===` and skip the re-render.
 * ------------------------------------------------------------------------ */

/**
 * Every block key already spoken for in a document.
 *
 * @param {EditorNode[]} nodes
 * @returns {Set<string>}
 */
function carouselKeys(nodes) {
  const keys = new Set();
  for (const n of nodes || []) {
    if (n.type === "carousel" && n.key) keys.add(n.key);
  }
  return keys;
}

/**
 * A fresh block key — `c-` and four hex digits, the `#c-7f3a` the fence
 * carries. Short because a person reads it in raw markdown; uniqueness comes
 * from checking `taken`, not from length.
 *
 * @param {Set<string>} [taken]  Keys this one must avoid.
 * @returns {string}
 */
export function newCarouselKey(taken) {
  const used = taken || new Set();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  let key = `c-${hex()}`;
  // The counter differs on every pass, so the search is finite against a finite
  // `taken` — retrying the random part alone would not be.
  for (let n = 2; used.has(key); n += 1) key = `c-${hex()}-${n}`;
  return key;
}

/**
 * The indices `groupIntoCarousel` will actually fold in: deduped, in range, in
 * document order, and naming a node that carries slides. Anything else the
 * caller listed is left exactly where it is.
 *
 * @param {EditorNode[]} nodes
 * @param {number[]} indices
 * @returns {number[]}
 */
function groupableIndices(nodes, indices) {
  return [...new Set(indices || [])]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < nodes.length)
    .sort((a, b) => a - b)
    .filter((i) => nodes[i].type === "image" || nodes[i].type === "carousel");
}

/**
 * The slides the nodes at `wanted` contribute to one carousel, and the key to
 * give it — the first grouped carousel's, when one of them already had one.
 *
 * @param {EditorNode[]} nodes
 * @param {number[]} wanted
 * @returns {{paths: string[], key: string|undefined}}
 */
function collectSlides(nodes, wanted) {
  const paths = [];
  let key;
  for (const i of wanted) {
    const node = nodes[i];
    if (node.type === "carousel") {
      paths.push(...(node.paths || []));
      if (!key && node.key) key = node.key;
    } else if (node.path) {
      paths.push(node.path);
    }
  }
  return { paths, key };
}

/**
 * Fold the nodes at `indices` into one carousel, in document order, at the
 * position of the first of them. Images contribute their path and carousels
 * their slides, so the same call groups loose photos and merges a photo into an
 * existing carousel; an index naming anything else is left where it is.
 *
 * The result is keyed: an editor-made carousel has to be addressable by the
 * studio from the moment it exists. It reuses the first grouped carousel's key
 * when there is one, rather than orphaning that block's design document.
 *
 * @param {EditorNode[]} nodes
 * @param {number[]} indices
 * @returns {EditorNode[]}
 */
export function groupIntoCarousel(nodes, indices) {
  const list = nodes || [];
  const wanted = groupableIndices(list, indices);
  if (!wanted.length) return list;
  if (wanted.length === 1 && list[wanted[0]].type === "carousel") return list;

  const { paths, key } = collectSlides(list, wanted);
  const carousel = carouselNode(paths, key || newCarouselKey(carouselKeys(list)));
  const at = wanted[0];
  const dropped = new Set(wanted.slice(1));
  return list.map((n, i) => (i === at ? carousel : n)).filter((_, i) => !dropped.has(i));
}

/**
 * Replace the carousel at `i` with one image node per slide, order preserved —
 * the exact inverse of grouping those images. The block key is dropped with the
 * node; there is no longer a block for it to name.
 *
 * @param {EditorNode[]} nodes
 * @param {number} i
 * @returns {EditorNode[]}
 */
export function ungroupCarousel(nodes, i) {
  const list = nodes || [];
  const node = list[i];
  if (!node || node.type !== "carousel") return list;
  const images = (node.paths || []).map(
    (path) => /** @type {EditorNode} */ ({ type: "image", path }),
  );
  return [...list.slice(0, i), ...images, ...list.slice(i + 1)];
}

/**
 * Add `path` to the carousel at `i`, at slide index `at` — appended when `at`
 * is omitted, clamped to the slide count otherwise.
 *
 * @param {EditorNode[]} nodes
 * @param {number} i
 * @param {string} path
 * @param {number} [at]
 * @returns {EditorNode[]}
 */
export function insertPathIntoCarousel(nodes, i, path, at) {
  const list = nodes || [];
  const node = list[i];
  if (!node || node.type !== "carousel" || !path) return list;
  const paths = [...(node.paths || [])];
  const pos = at === undefined || at === null ? paths.length : Math.max(0, Math.min(paths.length, at));
  paths.splice(pos, 0, path);
  return list.map((n, j) => (j === i ? { ...n, paths } : n));
}

/**
 * Drop the first slide matching `path` from the carousel at `i`. A carousel
 * with no slides left is removed outright — an empty fence renders as an empty
 * div, and the editor would show a card with nothing in it.
 *
 * @param {EditorNode[]} nodes
 * @param {number} i
 * @param {string} path
 * @returns {EditorNode[]}
 */
export function removePathFromCarousel(nodes, i, path) {
  const list = nodes || [];
  const node = list[i];
  if (!node || node.type !== "carousel") return list;
  const paths = [...(node.paths || [])];
  const at = paths.indexOf(path);
  if (at < 0) return list;
  paths.splice(at, 1);
  if (!paths.length) return [...list.slice(0, i), ...list.slice(i + 1)];
  return list.map((n, j) => (j === i ? { ...n, paths } : n));
}

/**
 * Give every carousel after the first bearing a given key a fresh one. Copying
 * a fence in Text mode copies its key with it, and two blocks answering to the
 * same key would share one design document — the studio would open the wrong
 * carousel, and rendering one would overwrite the other.
 *
 * Called by the editor immediately after every `parseNodes`, never from inside
 * it: the parser has to stay deterministic for the round trip to hold.
 *
 * @param {EditorNode[]} nodes
 * @returns {EditorNode[]}
 */
export function dedupeCarouselKeys(nodes) {
  const list = nodes || [];
  const taken = carouselKeys(list);
  const seen = new Set();
  let changed = false;
  const out = list.map((n) => {
    if (n.type !== "carousel" || !n.key) return n;
    if (!seen.has(n.key)) {
      seen.add(n.key);
      return n;
    }
    const key = newCarouselKey(taken);
    taken.add(key);
    changed = true;
    return { ...n, key };
  });
  return changed ? out : list;
}
