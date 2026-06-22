import { MediaViewer } from './MediaViewer.js';
import { ImmersiveSheetViewer } from './ImmersiveSheetViewer.js';
import { store } from '../../store.js';

export function mount(el, ctx) {
  const settings = store.get("settings") || {};
  const mode = settings["plugin.immersive.mode"] || "classic";
  const sheetMode = mode === "sheet";
  
  document.body.classList.toggle("immersive-overlay-sheet", sheetMode);
  
  const ViewerClass = sheetMode ? ImmersiveSheetViewer : MediaViewer;
  return new ViewerClass(el, { ...ctx, sheetMode });
}
