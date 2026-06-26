import { sharePost } from '../../utils/helpers.js';
import { SHARE_SVG } from '../../utils/icons.js';

// Floating share button for the MediaViewer (immersive viewer + lightbox).
// Mounted into the `.media-viewer-wrapper` via the `immersive-share` slot;
// disabling the plugin drops the button everywhere MediaViewer renders. CSS
// (.carousel-share-btn) stays in the global immersive styles.
export function mount(wrapper, _ctx) {
  if (!wrapper) return null;

  const btn = document.createElement('button');
  btn.className = 'header-action-btn share-btn carousel-share-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Share');
  btn.innerHTML = SHARE_SVG;

  const onClick = (e) => {
    e.stopPropagation();
    sharePost({ title: document.title, url: window.location.href });
  };
  btn.addEventListener('click', onClick);
  wrapper.appendChild(btn); // absolutely positioned, so DOM order is irrelevant

  return {
    unmount() {
      btn.removeEventListener('click', onClick);
      btn.remove();
    },
  };
}
