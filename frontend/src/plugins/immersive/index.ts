import type { MediaViewerProps } from '../../components/shared/MediaViewer.ts';
import { MediaViewer } from '../../components/shared/MediaViewer.ts';

// Standard immersive viewer (header + footer chrome). The Sheet viewer is a
// separate plugin (immersive-sheet); whichever is enabled claims the
// post-viewer slot, so the choice is made by enabling/disabling plugins.
export function mount(el: HTMLElement, ctx: MediaViewerProps) {
  document.body.classList.remove("immersive-overlay-sheet");
  const comp = new MediaViewer(el, { ...ctx, sheetMode: false });
  comp.mount();
  return comp;
}
