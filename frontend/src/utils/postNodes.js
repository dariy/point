/**
 * The visual editor's document model.
 *
 * A post's content is markdown, but the visual editor edits it as a flat list
 * of nodes — an image is a bare `/YYYY/MM/name.jpg` path on its own line, and
 * everything between images is one text node. `---` separates blocks and is a
 * pure serialization artefact, so it never becomes a node.
 *
 * The pair is a round trip: `serializeNodes(parseNodes(md))` is the same
 * document, which is what lets the editor switch between Text and Visual mode
 * without a canonical form on either side.
 */

/** A bare media path on its own line — how the visual editor stores an image. */
export const IMAGE_PATH_RE = /^\/\d{4}\/\d{2}\/.+$/;

/**
 * The first media path in raw markdown, wherever it sits — bare, in a link, in
 * quotes. Used to pick the image an AI analysis should run on when the editor
 * is in Text mode; the extension list is what keeps it off a video.
 */
const FIRST_IMAGE_IN_TEXT_RE =
  /(?:^|["'\s(])(\/\d{4}\/\d{2}\/.+?\.(?:jpe?g|png|webp|gif|avif|heic|tiff|bmp))(?:["'\s)]|$)/i;

export function parseNodes(content) {
  const lines = (content || "").split("\n");
  const nodes = [];
  let textBuf = [];

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
    if (IMAGE_PATH_RE.test(trimmed)) {
      flushText();
      nodes.push({ type: "image", path: trimmed });
    } else if (trimmed === "---") {
      flushText();
    } else {
      textBuf.push(line);
    }
  }
  flushText();
  return nodes;
}

export function serializeNodes(nodes) {
  return nodes
    .map((n) => {
      if (n.type === "image") return n.path;
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
