/**
 * atlasLayerHandle — the grab handle at the top of a post list.
 *
 * It tells the visitor that a map is available. GridPager mounts it when the
 * tags-atlas plugin is on; the gestures that move the layer come later.
 */

import { getAtlasLayerState } from './atlasLayerState.ts';

const CLASS = 'atlas-layer-handle';

/**
 * Put a handle directly before `gridMount`. Replaces a handle this call made
 * earlier, so repeated calls leave one. Returns the handle.
 */
export function mountAtlasLayerHandle(gridMount: HTMLElement): HTMLElement | null {
  const parent = gridMount.parentElement;
  if (!parent) return null;
  const prior = gridMount.previousElementSibling;
  if (prior?.classList.contains(CLASS)) prior.remove();

  const handle = document.createElement('div');
  handle.className = CLASS;
  handle.setAttribute('role', 'button');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', 'Map layer');
  handle.setAttribute('aria-expanded', String(getAtlasLayerState() !== 'list'));
  const grip = document.createElement('span');
  grip.className = `${CLASS}__grip`;
  grip.setAttribute('aria-hidden', 'true');
  handle.append(grip);
  parent.insertBefore(handle, gridMount);
  return handle;
}
