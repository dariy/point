import { Slideshow } from './Slideshow.js';

// Auto-advancing slideshow for the MediaViewer. Mounted into the
// `.media-viewer-wrapper` via the `slideshow` slot when a post has >1 media
// (see MediaViewer.afterRender). The viewer hands us a tiny controller —
// { count, index(), goTo(i), activeVideo() } — and nothing else.
export function mount(wrapper, ctx) {
  if (!wrapper || !ctx || typeof ctx.goTo !== 'function') return null;
  const show = new Slideshow(wrapper, ctx);
  return { unmount: () => show.unmount() };
}
