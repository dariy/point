import { ImmersiveSheetViewer } from '../immersive/ImmersiveSheetViewer.js';

// Sheet immersive viewer (full-screen photo, swipe-up details sheet). Shares the
// viewer code with the Standard immersive plugin; esbuild code-splitting dedupes
// the common modules into a chunk. Enabled/disabled on the admin Plugins page.
export function mount(el, ctx) {
  document.body.classList.add("immersive-overlay-sheet");
  const comp = new ImmersiveSheetViewer(el, { ...ctx, sheetMode: true });
  comp.mount();
  return comp;
}
