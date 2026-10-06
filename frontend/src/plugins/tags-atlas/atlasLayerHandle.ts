/**
 * atlasLayerHandle — the grab handle at the top of a post list.
 *
 * It tells the visitor that a map is available. GridPager mounts it when the
 * tags-atlas plugin is on; the gestures that move the layer come later.
 */

import { getAtlasLayerState, setAtlasLayerState } from './atlasLayerState.ts';
import type { AtlasLayerState } from './atlasLayerState.ts';

const CLASS = 'atlas-layer-handle';
export const BUTTON_CLASS = `${CLASS}__btn`;

interface HandleButton {
  label: string;
  to: AtlasLayerState;
  icon: string;
  side: 'start' | 'end';
}

/** The buttons a state shows. mapList has two; list and map each have one that restores mapList. */
export function buttonsFor(state: AtlasLayerState): HandleButton[] {
  if (state === 'mapList') {
    return [
      { label: 'Maximize map', to: 'map', icon: '▼', side: 'start' },
      { label: 'Maximize list', to: 'list', icon: '▲', side: 'end' },
    ];
  }
  return [{ label: 'Restore map and list', to: 'mapList', icon: state === 'map' ? '▲' : '▼', side: 'end' }];
}

function renderButtons(handle: HTMLElement): void {
  for (const old of handle.querySelectorAll(`.${BUTTON_CLASS}`)) old.remove();
  for (const b of buttonsFor(getAtlasLayerState())) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${BUTTON_CLASS} ${BUTTON_CLASS}--${b.side}`;
    btn.setAttribute('aria-label', b.label);
    btn.dataset.atlasTo = b.to;
    btn.textContent = b.icon;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setAtlasLayerState(b.to);
    });
    handle.append(btn);
  }
}

/**
 * Put a handle directly before `gridMount`. Reuses a handle this call made
 * earlier, so repeated calls leave one and keep its focus. Returns the handle.
 */
export function mountAtlasLayerHandle(gridMount: HTMLElement): HTMLElement | null {
  const parent = gridMount.parentElement;
  if (!parent) return null;
  const prior = gridMount.previousElementSibling;
  if (prior instanceof HTMLElement && prior.classList.contains(CLASS)) return prior;

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
  renderButtons(handle);
  new MutationObserver(() => renderButtons(handle)).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-atlas-layer'],
  });
  parent.insertBefore(handle, gridMount);
  return handle;
}
