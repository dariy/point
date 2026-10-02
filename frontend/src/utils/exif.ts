/**
 * exif — shared EXIF metadata presentation for the public site.
 *
 * Renders a per-image info button that toggles a small overlay panel of camera
 * settings. Used by both the normal article layout (PostContent) and the
 * immersive media viewer (MediaViewer), so the EXIF affordance is consistent
 * wherever an image with camera data appears.
 *
 * Only a curated allowlist of fields is shown publicly — this deliberately
 * excludes GPS and any other sensitive EXIF tags that may live in the raw
 * metadata blob.
 *
 * Visibility is governed by the `exif_visibility` setting:
 *   'hide'  → never shown (default)
 *   'admin' → shown only to a logged-in admin
 *   'all'   → shown to everyone
 */

/** A raw EXIF metadata object, keyed by EXIF tag name. */
export type ExifMetadata = object;

/** One curated EXIF row as the overlay shows it. */
export interface ExifRow {
  label: string;
  value: string;
}

// Public field allowlist, in display order. fmt: optional value formatter.
const EXIF_FIELDS: Array<{ key: string, label: string, fmt: ((val: unknown) => string) | null }> = [
  { key: "ExposureTime", label: "Shutter", fmt: _fmtShutter },
  { key: "FNumber", label: "Aperture", fmt: _fmtFNumber },
  { key: "FocalLength", label: "Focal", fmt: _fmtFocal },
  { key: "ISOSpeedRatings", label: "ISO", fmt: _fmtISO },
  { key: "Make", label: "Make", fmt: null },
  { key: "Model", label: "Model", fmt: null },
];

function _evalFraction(val: unknown) {
  const s = String(val);
  const m = s.match(/^(-?\d+)\/(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  return parseFloat(s);
}

function _fmtShutter(val: unknown) {
  const s = String(val);
  // Keep fraction form if denominator > 1 (e.g. "1/200"), add "s"
  if (/^\d+\/\d+$/.test(s)) return `${s} s`;
  const n = _evalFraction(s);
  if (!Number.isFinite(n) || n <= 0) return s;
  return n >= 1 ? `${n} s` : `1/${Math.round(1 / n)} s`;
}

function _fmtFNumber(val: unknown) {
  const n = _evalFraction(val);
  if (!Number.isFinite(n)) return String(val);
  return `f/${Number(n.toFixed(1))}`;
}

function _fmtFocal(val: unknown) {
  const n = _evalFraction(val);
  if (!Number.isFinite(n)) return String(val);
  return `${Math.round(n)} mm`;
}

function _fmtISO(val: unknown) {
  return `ISO ${val}`;
}

/** True when EXIF should be shown for the given settings / current user. */
export function exifVisible(settings: { exif_visibility?: string } = {}, user: unknown = null) {
  const v = settings.exif_visibility || "hide";
  if (v === "hide") return false;
  if (v === "admin" && !user) return false;
  return true;
}

/** The curated, formatted rows present in this metadata object ([] if none). */
function _curatedRows(metadata: ExifMetadata | null | undefined): ExifRow[] {
  if (!metadata) return [];
  const fields = metadata as Record<string, unknown>;
  return EXIF_FIELDS.filter(
    ({ key }) => key in fields && fields[key] != null && fields[key] !== "",
  ).map(({ key, label, fmt }) => ({
    label,
    value: fmt ? fmt(fields[key]) : String(fields[key]),
  }));
}

/** True when a metadata object has at least one publicly-shown field. */
export function hasExif(metadata: ExifMetadata | null | undefined) {
  return _curatedRows(metadata).length > 0;
}

/**
 * The curated, formatted EXIF rows ([{label, value}]) for a metadata object,
 * honouring the public allowlist (GPS and other sensitive tags excluded).
 * Exposed for consumers that render EXIF inline rather than via the flyout
 * control (e.g. the immersive sheet overlay).
 */
export function curatedExifRows(metadata: ExifMetadata | null | undefined) {
  return _curatedRows(metadata);
}

/** Build a Map of public media path → metadata from a post's media array. */
export function buildExifMap(
  media: Array<{ path?: string, metadata?: ExifMetadata | null } | null> = [],
): Map<string, ExifMetadata> {
  const map = new Map<string, ExifMetadata>();
  for (const m of media) {
    if (m && m.path && m.metadata) map.set(m.path, m.metadata);
  }
  return map;
}

/**
 * Normalise an <img> src to the public media path used as the map key.
 *
 * The map is keyed by bare media path, while the src on the page names a rung of
 * the thumbnail ladder — `/2026/03/p.jpg?s=512&v=…`. `pathname` drops the query
 * along with the origin, which is the whole of the work; the hand-rolled branch
 * is only for a caller with no document to resolve against (node tests).
 */
export function normalizeSrc(src = "") {
  try {
    return new URL(src, window.location.origin).pathname;
  } catch {
    const s = String(src);
    const q = s.indexOf("?");
    return q >= 0 ? s.slice(0, q) : s;
  }
}

/** Resolve the metadata object for an image src, or null. */
export function metadataForSrc(map: Map<string, ExifMetadata>, src: string) {
  return map.get(normalizeSrc(src)) || null;
}

// ── DOM builders ───────────────────────────────────────────────────────────

/** Build a <table> of curated rows. */
function _buildTable(rows: ExifRow[]) {
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  rows.forEach(({ label, value }) => {
    const tr = document.createElement("tr");
    const tdK = document.createElement("td");
    tdK.textContent = label;
    const tdV = document.createElement("td");
    tdV.textContent = value;
    tr.append(tdK, tdV);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

/** Build the info button element ("i" glyph). */
function _buildButton(variant = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = variant ? `exif-info-btn exif-info-btn--${variant}` : "exif-info-btn";
  btn.setAttribute("aria-label", "Show camera data");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "ℹ"; // info glyph
  return btn;
}

/** Build the overlay panel shell (title + provided body element). */
function _buildOverlay(variant: string, body: Element) {
  const overlay = document.createElement("div");
  overlay.className = variant ? `exif-overlay exif-overlay--${variant}` : "exif-overlay";
  overlay.setAttribute("role", "complementary");
  overlay.setAttribute("aria-label", "Camera data");
  const title = document.createElement("div");
  title.className = "exif-overlay-title";
  title.textContent = "Camera data";
  overlay.append(title, body);
  return overlay;
}

/** Wire the button to toggle the overlay's visibility. */
function _wireToggle(btn: HTMLElement, overlay: HTMLElement) {
  btn.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    const visible = overlay.classList.toggle("is-visible");
    btn.classList.toggle("is-active", visible);
    btn.setAttribute("aria-expanded", String(visible));
  });
}

/**
 * Normal article layout: wrap an <img> in a positioned figure and attach a
 * per-image info button + overlay. No-op when there are no publicly-shown fields.
 */
export function attachExifToImage(img: Element, metadata: ExifMetadata | null | undefined) {
  const rows = _curatedRows(metadata);
  if (!rows.length || !img.parentNode) return;

  const figure = document.createElement("figure");
  figure.className = "media-exif-wrapper";
  img.parentNode.insertBefore(figure, img);
  figure.appendChild(img);

  const btn = _buildButton();
  const overlay = _buildOverlay("", _buildTable(rows));
  _wireToggle(btn, overlay);
  figure.append(btn, overlay);
}

/**
 * Immersive viewer: a single, reusable EXIF control rendered at the viewer
 * (wrapper) level — alongside the share button, where it sits above the site
 * header rather than being swallowed by it. `setMetadata` re-points the control
 * at the currently-visible slide and hides it when that slide has no EXIF.
 *
 * Returns { btn, overlay, setMetadata }.
 */
export function createImmersiveExifControl() {
  const btn = _buildButton("immersive");
  btn.classList.add("hidden");
  const tableMount = document.createElement("div");
  const overlay = _buildOverlay("immersive", tableMount);
  overlay.classList.add("hidden");
  _wireToggle(btn, overlay);

  function setMetadata(metadata: ExifMetadata | null | undefined) {
    const rows = _curatedRows(metadata);
    // Reset to a closed state on every slide change.
    overlay.classList.remove("is-visible");
    btn.classList.remove("is-active");
    btn.setAttribute("aria-expanded", "false");
    tableMount.textContent = "";
    if (!rows.length) {
      btn.classList.add("hidden");
      overlay.classList.add("hidden");
      return false;
    }
    tableMount.appendChild(_buildTable(rows));
    btn.classList.remove("hidden");
    overlay.classList.remove("hidden");
    return true;
  }

  return { btn, overlay, setMetadata };
}
