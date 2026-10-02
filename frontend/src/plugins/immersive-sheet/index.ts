import type { MediaViewerProps } from '../../components/shared/MediaViewer.ts';
import { ImmersiveSheetViewer } from '../immersive/ImmersiveSheetViewer.ts';

// Sheet immersive viewer (full-screen photo, swipe-up details sheet). Shares the
// viewer code with the Standard immersive plugin; esbuild code-splitting dedupes
// the common modules into a chunk. Enabled/disabled on the admin Plugins page.
export function mount(el: HTMLElement, ctx: MediaViewerProps) {
  document.body.classList.add("immersive-overlay-sheet");
  const comp = new ImmersiveSheetViewer(el, { ...ctx, sheetMode: true });
  comp.mount();
  return comp;
}
