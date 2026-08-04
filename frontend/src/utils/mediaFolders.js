/**
 * Media folder helpers — shared by the desktop folder tree and the narrow-screen
 * folder chip strip (both in MediaBrowser).
 *
 * Media is filed by upload date, so a "folder" is always either a year
 * ("2026") or a year/month ("2026/08"). Keeping the grouping and the chip
 * derivation here — pure, DOM-free — means the two navigations can never
 * disagree about what folders exist, and the drill-down rules are testable.
 */

export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "08" → "Aug"; anything unparseable is passed through unchanged. */
export function monthLabel(month) {
  return MONTH_NAMES[parseInt(month, 10) - 1] || month;
}

/**
 * Group the flat folder list from the API into years, newest year first.
 *
 * @param {Array<{year: string, month: string, path: string}>} folders
 * @returns {{years: string[], byYear: Object<string, Array>}}
 */
export function groupFoldersByYear(folders = []) {
  const byYear = {};
  for (const f of folders) {
    if (!byYear[f.year]) byYear[f.year] = [];
    byYear[f.year].push(f);
  }
  const years = Object.keys(byYear).sort((a, b) => b - a);
  return { years, byYear };
}

/**
 * Chips for the narrow-screen folder strip — one level of the tree at a time,
 * because a phone has room for a row, not a hierarchy.
 *
 *   at the root     All media | 2026 | 2025 | …
 *   inside a year   ‹ All | 2026 | Jan | Feb | …
 *
 * The year stays visible while its months are shown so the strip reads as a
 * path rather than a jump; going up is the back chip (or the breadcrumbs the
 * page header already renders).
 *
 * @param {Array} folders           folder list from getMediaFolders()
 * @param {string|null} selectedFolder  "", "2026" or "2026/08"
 * @returns {Array<{folder: string, label: string, active: boolean, kind: string}>}
 */
export function folderChips(folders = [], selectedFolder = null) {
  const { years, byYear } = groupFoldersByYear(folders);
  const year = selectedFolder ? String(selectedFolder).split("/")[0] : null;

  if (!year || !byYear[year]) {
    return [
      { folder: "", label: "All media", active: !selectedFolder, kind: "all" },
      ...years.map((y) => ({
        folder: y,
        label: y,
        active: false,
        kind: "year",
      })),
    ];
  }

  return [
    { folder: "", label: "‹ All", active: false, kind: "back" },
    { folder: year, label: year, active: selectedFolder === year, kind: "year" },
    ...byYear[year].map((f) => ({
      folder: f.path,
      label: monthLabel(f.month),
      active: selectedFolder === f.path,
      kind: "month",
    })),
  ];
}
