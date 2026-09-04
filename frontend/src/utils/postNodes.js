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
 * The pair is a round trip: `serializeNodes(parseNodes(md))` is the same
 * document, which is what lets the editor switch between Text and Visual mode
 * without a canonical form on either side.
 */

/** A bare media path on its own line — how the visual editor stores an image. */
export const IMAGE_PATH_RE = /^\/\d{4}\/\d{2}\/.+$/;

/** The class on the fenced div that wraps a carousel's slides. */
export const CAROUSEL_BLOCK_CLASS = "carousel-block";

const CAROUSEL_FENCE_OPEN = `:::{.${CAROUSEL_BLOCK_CLASS}}`;

/**
 * The first media path in raw markdown, wherever it sits — bare, in a link, in
 * quotes. Used to pick the image an AI analysis should run on when the editor
 * is in Text mode; the extension list is what keeps it off a video.
 */
const FIRST_IMAGE_IN_TEXT_RE =
  /(?:^|["'\s(])(\/\d{4}\/\d{2}\/.+?\.(?:jpe?g|png|webp|gif|avif|heic|tiff|bmp))(?:["'\s)]|$)/i;

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
 * @returns {string}
 */
export function carouselFence(paths) {
  return `${CAROUSEL_FENCE_OPEN}\n\n${(paths || []).join("\n\n")}\n\n:::`;
}

/** Serialize a carousel node back to its fenced div, blank line between paths. */
function serializeCarousel(paths) {
  return carouselFence(paths);
}

export function parseNodes(content) {
  const lines = (content || "").split("\n");
  const nodes = [];
  let textBuf = [];
  // Non-null while inside a :::{.carousel-block} fence: { paths, raw }.
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
        nodes.push({ type: "carousel", paths: carousel.paths });
        carousel = null;
      } else if (IMAGE_PATH_RE.test(trimmed)) {
        carousel.paths.push(trimmed);
      }
      continue;
    }

    if (trimmed === CAROUSEL_FENCE_OPEN) {
      flushText();
      carousel = { paths: [], raw: [line] };
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

export function serializeNodes(nodes) {
  return nodes
    .map((n) => {
      if (n.type === "image") return n.path;
      if (n.type === "carousel") return serializeCarousel(n.paths);
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
