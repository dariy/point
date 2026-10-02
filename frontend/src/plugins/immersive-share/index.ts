import { raw } from "../../utils/helpers.ts";
import { html, setHTML } from "../../utils/helpers.ts";
import { sharePost } from '../../utils/helpers.ts';
import { SHARE_SVG } from '../../utils/icons.ts';

// Floating share button for the MediaViewer (immersive viewer + lightbox).
// Mounted into the `.media-viewer-wrapper` via the `immersive-share` slot;
// disabling the plugin drops the button everywhere MediaViewer renders. CSS
// (.carousel-share-btn) stays in the global immersive styles.
export function mount(wrapper: HTMLElement, _ctx?: unknown) {
  if (!wrapper) return null;
  const btn = document.createElement('button');
  btn.className = 'header-action-btn share-btn carousel-share-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Share');
  setHTML(btn, html`${raw(SHARE_SVG)}`);
  const onClick = (e: Event) => {
    e.stopPropagation();
    sharePost({
      title: document.title,
      url: window.location.href
    });
  };
  btn.addEventListener('click', onClick);
  wrapper.appendChild(btn); // absolutely positioned, so DOM order is irrelevant

  return {
    unmount() {
      btn.removeEventListener('click', onClick);
      btn.remove();
    }
  };
}