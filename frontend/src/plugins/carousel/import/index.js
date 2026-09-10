/**
 * carousel/import/index.js — the import adapter registry.
 *
 * One place that knows what Point can import, so the import dialog builds its
 * file input and its error messages from a list rather than from a switch it has
 * to be kept in step with. Adding a format is an entry here.
 *
 * The adapter shape is deliberately wider than PPTX needs: `takesList` exists
 * because an SVG has no concept of a deck, so that importer takes an *ordered
 * list* of files where this one takes a single archive. Discovering that after
 * writing the dialog against a single-file assumption is the rework this flag
 * avoids.
 *
 * Every adapter returns `{ template, report }` and throws `ImportError` — see
 * `adapter.js`, which is also where the parts they share live.
 */

import { importPptx } from './pptx.js';
import { importSvg } from './svg.js';

export { ImportError, ASSET_LIMITS } from './adapter.js';

/**
 * @typedef {object} ImportAdapter
 * @property {string} format matches `TEMPLATE_ORIGINS` in `document.js`
 * @property {string} label what the picker calls it
 * @property {string[]} extensions lower-case, with the dot
 * @property {string} accept the `<input type="file" accept>` value
 * @property {boolean} takesList `true` when one template comes from many files
 * @property {(input: *, options?: *) => Promise<{template: import('../document.js').CarouselTemplate,
 *   report: import('./adapter.js').ImportReport}>} read
 */

/** @type {ImportAdapter} */
const PPTX = {
  format: 'pptx',
  label: 'PowerPoint or Canva (.pptx)',
  extensions: ['.pptx'],
  accept:
    '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation',
  takesList: false,
  read: importPptx,
};

/**
 * One SVG per slide, in filename order — which is why {@link ImportAdapter} has
 * `takesList`. Every design tool worth importing from exports SVG: Figma,
 * Illustrator, Sketch and XD are all proprietary on disk, and Canva offers it
 * beside the PPTX above.
 *
 * @type {ImportAdapter}
 */
const SVG = {
  format: 'svg',
  label: 'Figma, Illustrator, Sketch or Canva (.svg)',
  extensions: ['.svg'],
  accept: '.svg,image/svg+xml',
  takesList: true,
  read: importSvg,
};

/** Every format Point imports, in the order a picker should offer them. */
export const IMPORTERS = [PPTX, SVG];

/** One `accept` value for a file input that takes any of them. */
export const IMPORT_ACCEPT = IMPORTERS.map((a) => a.accept).join(',');

/**
 * The adapter for a filename, or `null` when nothing here reads it.
 *
 * Matched on the extension rather than on the browser's MIME guess: a `.pptx`
 * arrives as `application/vnd.openxmlformats-…` from a file input, as
 * `application/zip` from some archivers, and as `''` from a drag out of a
 * download manager, so the extension is the only field that is reliably there.
 *
 * @param {string} filename
 * @returns {ImportAdapter|null}
 */
export function adapterFor(filename) {
  const name = String(filename || '').toLowerCase();
  return IMPORTERS.find((a) => a.extensions.some((ext) => name.endsWith(ext))) || null;
}
