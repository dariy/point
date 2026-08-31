/**
 * The post's own tags as a horizontally scrollable strip — the markup, the
 * scroll-arrow wiring, and the touch handling that keeps a swipe on the strip
 * from being read as a swipe on the card underneath it.
 *
 * Used by PostCard and PostContent. The flyout each tag opens on hover or
 * long-press lives in tagFlyout.js; the <a> itself comes from tagLinks.js.
 */

import { CHEVRON_SVG } from './icons.js';
import { html, raw } from './helpers.js';
import { renderTagLink } from './tagLinks.js';
import { setupTagFlyout } from './tagFlyout.js';

/**
 * The post's own tags, as a horizontally scrollable strip.
 *
 * Page endpoints expand each post's tags with their ancestors so a post can be
 * matched against a whole subtree (see expandPostTagsWithAncestors), and mark
 * those extras `inherited`. A card must show what the post is tagged with, not
 * that closure — otherwise one photo of a fern lists location/country/city/…
 * while the post page lists three tags.
 */
export function renderTagStrip(postTags) {
  const visibleTags = (postTags || []).filter((t) => !t.inherited);
  // renderTagLink still returns a hand-escaped string; raw() until tagLinks.js
  // moves to html`` with the rest of the tags subsystem.
  const tagsHtml = visibleTags.map((t) => renderTagLink(t)).join('');
  // Falsy, not html``: RawHtml('') is a String object and therefore truthy,
  // and PostContent gates its wrapper <div> on this result.
  if (!tagsHtml) return '';
  return html`
    <div class="tag-strip-track">
      <button class="tags-scroll-btn tags-scroll-btn--left" aria-label="Scroll left" type="button">${raw(CHEVRON_SVG)}</button>
      <div class="tag-strip-scroll" aria-label="Tags">${raw(tagsHtml)}</div>
      <button class="tags-scroll-btn tags-scroll-btn--right" aria-label="Scroll right" type="button">${raw(CHEVRON_SVG)}</button>
    </div>`;
}

export function setupScrollableStrip(trackEl, scrollEl) {
  if (!trackEl || !scrollEl) return () => {};
  const btnLeft  = trackEl.querySelector('.tags-scroll-btn--left');
  const btnRight = trackEl.querySelector('.tags-scroll-btn--right');
  const overlay = trackEl.closest('.post-card')?.querySelector('.post-card-content.overlay');

  // On a card whose overlay is still transparent — touch, before the reveal tap —
  // the arrows are invisible but still hit-testable, so a tap meant to reveal the
  // card would land on one and scroll a strip nobody can see. Decline those and
  // let the click bubble to the card's own reveal handler.
  const isRevealed = () => !overlay || getComputedStyle(overlay).opacity !== '0';
  const update = () => {
    const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
    trackEl.classList.toggle('has-scroll-left',  scrollLeft > 1);
    trackEl.classList.toggle('has-scroll-right', scrollLeft < scrollWidth - clientWidth - 1);
  };
  // The strip can live inside a fully clickable post card — once an arrow acts on
  // a click, stop it reaching the card's "navigate to post" handler.
  const scrollBy = (dx) => (e) => {
    if (!isRevealed()) return;
    e.preventDefault();
    e.stopPropagation();
    scrollEl.scrollBy({ left: dx, behavior: 'smooth' });
  };
  const onLeft  = scrollBy(-200);
  const onRight = scrollBy(200);
  btnLeft?.addEventListener('click',  onLeft);
  btnRight?.addEventListener('click', onRight);
  scrollEl.addEventListener('scroll', update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(scrollEl);
  requestAnimationFrame(update);
  return () => {
    btnLeft?.removeEventListener('click',  onLeft);
    btnRight?.removeEventListener('click', onRight);
    scrollEl.removeEventListener('scroll', update);
    ro.disconnect();
  };
}

export function setupTagStrip(container, tagIndex, navigateFn, hostEl = null) {
  const track = container.querySelector('.tag-strip-track');
  const tagsEl = container.querySelector('.tag-strip-scroll');
  if (!tagsEl) return () => {};
  const cleanups = [];
  const stop = (e) => e.stopPropagation();
  tagsEl.addEventListener('touchstart', stop, { passive: true });
  tagsEl.addEventListener('touchmove',  stop, { passive: true });
  cleanups.push(() => {
    tagsEl.removeEventListener('touchstart', stop);
    tagsEl.removeEventListener('touchmove',  stop);
  });
  cleanups.push(setupScrollableStrip(track, tagsEl));
  cleanups.push(setupTagFlyout(tagsEl, tagIndex, navigateFn, hostEl));
  return () => cleanups.forEach(fn => fn());
}
