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

// Public field allowlist, in display order. fmt: optional value formatter.
const EXIF_FIELDS = [
  { key: "ExposureTime", label: "Shutter", fmt: _fmtShutter },
  { key: "FNumber", label: "Aperture", fmt: _fmtFNumber },
  { key: "FocalLength", label: "Focal", fmt: _fmtFocal },
  { key: "ISOSpeedRatings", label: "ISO", fmt: _fmtISO },
  { key: "Make", label: "Make", fmt: null },
  { key: "Model", label: "Model", fmt: null },
];

function _evalFraction(val) {
  const s = String(val);
  const m = s.match(/^(-?\d+)\/(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  return parseFloat(s);
}

function _fmtShutter(val) {
  const s = String(val);
  // Keep fraction form if denominator > 1 (e.g. "1/200"), add "s"
  if (/^\d+\/\d+$/.test(s)) return `${s} s`;
  const n = _evalFraction(s);
  if (!Number.isFinite(n) || n <= 0) return s;
  return n >= 1 ? `${n} s` : `1/${Math.round(1 / n)} s`;
}

function _fmtFNumber(val) {
  const n = _evalFraction(val);
  if (!Number.isFinite(n)) return String(val);
  return `f/${Number(n.toFixed(1))}`;
}

function _fmtFocal(val) {
  const n = _evalFraction(val);
  if (!Number.isFinite(n)) return String(val);
  return `${Math.round(n)} mm`;
}

function _fmtISO(val) {
  return `ISO ${val}`;
}

/** True when EXIF should be shown for the given settings / current user. */
export function exifVisible(settings = {}, user = null) {
  const v = settings.exif_visibility || "hide";
  if (v === "hide") return false;
  if (v === "admin" && !user) return false;
  return true;
}

/** The curated, formatted rows present in this metadata object ([] if none). */
function _curatedRows(metadata) {
  if (!metadata) return [];
  return EXIF_FIELDS.filter(
    ({ key }) => key in metadata && metadata[key] != null && metadata[key] !== "",
  ).map(({ key, label, fmt }) => ({
    label,
    value: fmt ? fmt(metadata[key]) : String(metadata[key]),
  }));
}

/** True when a metadata object has at least one publicly-shown field. */
export function hasExif(metadata) {
  return _curatedRows(metadata).length > 0;
}

/** Build a Map of public media path → metadata from a post's media array. */
export function buildExifMap(media = []) {
  const map = new Map();
  for (const m of media) {
    if (m && m.path && m.metadata) map.set(m.path, m.metadata);
  }
  return map;
}

/** Normalise an <img> src to the public media path used as the map key. */
export function normalizeSrc(src = "") {
  let s = src;
  try {
    s = new URL(src, window.location.origin).pathname;
  } catch {
    /* already a relative path */
  }
  return s.replace(/\?(?:thumb)$/, "");
}

/** Resolve the metadata object for an image src, or null. */
export function metadataForSrc(map, src) {
  return map.get(normalizeSrc(src)) || null;
}

// ── DOM builders ───────────────────────────────────────────────────────────

/** Build a <table> of curated rows. */
function _buildTable(rows) {
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
function _buildOverlay(variant, body) {
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
function _wireToggle(btn, overlay) {
  btn.addEventListener("click", (e) => {
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
export function attachExifToImage(img, metadata) {
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

  function setMetadata(metadata) {
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
