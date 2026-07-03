import { MediaViewer } from '../../components/shared/MediaViewer.js';

// Standard immersive viewer (header + footer chrome). The Sheet viewer is a
// separate plugin (immersive-sheet); whichever is enabled claims the
// post-viewer slot, so the choice is made by enabling/disabling plugins.
export function mount(el, ctx) {
  document.body.classList.remove("immersive-overlay-sheet");
  const comp = new MediaViewer(el, { ...ctx, sheetMode: false });
  comp.mount();
  return comp;
}
