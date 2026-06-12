/**
 * Unified tag link renderer — the single source of truth for rendering
 * public-facing tag <a> elements across all components.
 *
 * Also owns the singleton flyout used for tag family display
 * (setupTagFlyout — shared across PostCard, PostContent, PublicFooter, etc.).
 */

import { escapeHtml, setupLongPress } from './helpers.js';
import { CHEVRON_SVG } from './icons.js';
import { store } from '../store.js';

// ── Hot-zone tracker ─────────────────────────────────────────────────────────

/**
 * Track document mousemove and fire onLeave once the cursor exits all elements
 * returned by getEls.
 */
export function createHotZone(getEls, onLeave, pad = 8) {
  const check = (e) => {
    const inside = getEls().some((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        e.clientX >= r.left  - pad &&
        e.clientX <= r.right + pad &&
        e.clientY >= r.top   - pad &&
        e.clientY <= r.bottom + pad
      );
    });
    if (!inside) { stop(); onLeave(); }
  };
  document.addEventListener('mousemove', check, { passive: true });
  function stop() { document.removeEventListener('mousemove', check); }
  return { stop };
}

// ── Flyout singleton ─────────────────────────────────────────────────────────

let _flyoutEl = null;
let _activeLink = null;
let _activeCard = null;
let _hotZone = null;
let _openTimer = null;
let _flyoutShowTime = 0;
let _flyoutDismiss = null;

function _getFlyoutEl() {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'tag-family-flyout hidden';
    document.body.appendChild(_flyoutEl);
  }
  return _flyoutEl;
}

function _showFlyout(anchorEl, slug, index, excludeEl, navigateFn) {
  const entry = index.get(slug);
  if (!entry) return;

  const ancestors = getTagAncestors(slug, index);
  const children = entry.children || [];

  const flyout = _getFlyoutEl();
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);

  const createItem = (t, className) => {
    const a = document.createElement('a');
    a.href = `/tags/${t.slug}`;
    a.className = `flyout-item ${className}`;
    a.innerHTML = `<span class="name">${escapeHtml(t.name)}</span> <span class="count">${t.count}</span>`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      _hideFlyout();
      navigateFn(a.href);
    });
    return a;
  };

  // 1. Ancestors
  if (ancestors.length) {
    const section = document.createElement('div');
    section.className = 'flyout-section flyout-ancestors';
    ancestors.forEach((t) => section.appendChild(createItem(t, 'ancestor-link')));
    flyout.appendChild(section);
  }

  // 2. Current Tag
  const currentSection = document.createElement('div');
  currentSection.className = 'flyout-section flyout-current';
  currentSection.innerHTML = `<span class="name">${escapeHtml(entry.tag.name)}</span> <span class="count">${entry.tag.count}</span>`;
  flyout.appendChild(currentSection);

  // 3. Children
  if (children.length) {
    const section = document.createElement('div');
    section.className = 'flyout-section flyout-children';
    children.forEach((t) => section.appendChild(createItem(t, 'child-link')));
    flyout.appendChild(section);
  }

  flyout.style.visibility = 'hidden';
  flyout.classList.remove('hidden');

  const isMobile = window.innerWidth < 640;
  if (isMobile) {
    flyout.classList.add('bottom-sheet');
    flyout.style.top = '';
    flyout.style.left = '';
  } else {
    flyout.classList.remove('bottom-sheet');
    const flyH = flyout.offsetHeight;
    const flyW = flyout.offsetWidth;
    const anchorRect = anchorEl.getBoundingClientRect();
    const gap = 8;
    
    let top = anchorRect.top - flyH - gap;
    if (top < 8) top = anchorRect.bottom + gap;
    
    let left = anchorRect.left + anchorRect.width / 2 - flyW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));
    
    flyout.style.top = `${top}px`;
    flyout.style.left = `${left}px`;
  }

  flyout.style.visibility = '';
  anchorEl.classList.add('is-flyout-open');
  anchorEl.classList.add('is-active');
  _flyoutShowTime = Date.now();
  _activeLink = anchorEl;
  _activeCard = anchorEl.closest('.post-card');
  if (_activeCard) _activeCard.classList.add('has-flyout-open');

  if (!isMobile) {
    _hotZone?.stop();
    _hotZone = createHotZone(() => [_activeCard, anchorEl, _flyoutEl], () => _hideFlyout());
  }

  if (_flyoutDismiss) document.removeEventListener('click', _flyoutDismiss);
  _flyoutDismiss = (e) => {
    if (!_flyoutEl || _flyoutEl.classList.contains('hidden')) return;
    if (_flyoutEl.contains(e.target)) return;
    if (excludeEl && excludeEl.contains(e.target)) return;
    _hideFlyout();
  };
  document.addEventListener('click', _flyoutDismiss);
}

function _hideFlyout() {
  _activeLink?.classList.remove('is-flyout-open');
  _activeLink?.classList.remove('is-active');
  if (_flyoutEl) {
    _flyoutEl.classList.add('hidden');
    _flyoutEl.classList.remove('bottom-sheet');
  }
  _activeLink = null;
  if (_activeCard) {
    _activeCard.classList.remove('has-flyout-open');
    _activeCard = null;
  }
  _hotZone?.stop();
  _hotZone = null;
  if (_flyoutDismiss) {
    document.removeEventListener('click', _flyoutDismiss);
    _flyoutDismiss = null;
  }
}

export function hideFlyout() { _hideFlyout(); }

export function setupTagFlyout(containerEl, tagIndex, navigateFn, hostEl = null) {
  if (!tagIndex) return () => {};

  const excludeEl = hostEl || containerEl;
  const cleanups = [];

  containerEl.querySelectorAll('.tag-link').forEach((link) => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http')) return;
    const slug = href.replace('/tags/', '').split('?')[0];

    // Desktop hover
    const onEnter = () => {
      clearTimeout(_openTimer);
      _openTimer = setTimeout(() => {
        _openTimer = null;
        if (_activeLink === link && _flyoutEl && !_flyoutEl.classList.contains('hidden')) return;
        _hideFlyout();
        _showFlyout(link, slug, tagIndex, excludeEl, navigateFn);
      }, 250);
    };
    link.addEventListener('mouseenter', onEnter);
    link.addEventListener('mouseleave', () => clearTimeout(_openTimer));
    cleanups.push(() => {
      link.removeEventListener('mouseenter', onEnter);
    });

    // Touch long-press
    cleanups.push(setupLongPress(link, () => {
      _hideFlyout();
      _showFlyout(link, slug, tagIndex, excludeEl, navigateFn);
    }, 350));

    // One click = navigate
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(_openTimer);
      _hideFlyout();
    });
  });

  const dismissOnScroll = () => {
    if (Date.now() - _flyoutShowTime < 300) return;
    _hideFlyout();
  };
  window.addEventListener('scroll', dismissOnScroll, { passive: true });

  return () => {
    cleanups.forEach(fn => fn());
    clearTimeout(_openTimer);
    window.removeEventListener('scroll', dismissOnScroll, { passive: true });
    _hideFlyout();
  };
}

export function setupScrollableStrip(trackEl, scrollEl) {
  if (!trackEl || !scrollEl) return () => {};
  const btnLeft  = trackEl.querySelector('.tags-scroll-btn--left');
  const btnRight = trackEl.querySelector('.tags-scroll-btn--right');
  const update = () => {
    const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
    trackEl.classList.toggle('has-scroll-left',  scrollLeft > 1);
    trackEl.classList.toggle('has-scroll-right', scrollLeft < scrollWidth - clientWidth - 1);
  };
  const onLeft  = () => scrollEl.scrollBy({ left: -200, behavior: 'smooth' });
  const onRight = () => scrollEl.scrollBy({ left:  200, behavior: 'smooth' });
  btnLeft?.addEventListener('click',  onLeft);
  btnRight?.addEventListener('click', onRight);
  scrollEl.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
  return () => {
    btnLeft?.removeEventListener('click',  onLeft);
    btnRight?.removeEventListener('click', onRight);
    scrollEl.removeEventListener('scroll', update);
  };
}

export function renderTagStrip(postTags, tagIndex) {
  const visibleTags = (postTags || []).filter((t) => {
    if (!tagIndex) return true;
    const entry = tagIndex.get(t.slug);
    return entry && entry.isLeaf;
  });
  const tagsHtml = visibleTags.map((t) => renderTagLink(t)).join('');
  if (!tagsHtml) return '';
  return `
    <div class="tag-strip-track">
      <button class="tags-scroll-btn tags-scroll-btn--left" aria-label="Scroll left" type="button">${CHEVRON_SVG}</button>
      <div class="tag-strip-scroll" aria-label="Tags">${tagsHtml}</div>
      <button class="tags-scroll-btn tags-scroll-btn--right" aria-label="Scroll right" type="button">${CHEVRON_SVG}</button>
    </div>`;
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

export function renderTagLink(tag, { active = false, extra = '', prefix = '', suffix = '' } = {}) {
  const name = typeof tag === 'string' ? tag : tag.name;
  const slug = typeof tag === 'string' ? tag : tag.slug;
  const href = (typeof tag === 'object' && tag.url) ? tag.url : `/tags/${slug}`;
  const classes = ['tag-link', active ? 'active' : '', extra].filter(Boolean).join(' ');
  const isExternal = /^https?:\/\//.test(href);
  const externalAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${escapeHtml(href)}" class="${classes}"${externalAttrs}>${prefix}${escapeHtml(name)}${suffix}</a>`;
}

export function buildTagIndex(navTags, parentSlug = null, map = new Map()) {
  for (const tag of navTags) {
    const children = (tag.children || []).map(c => ({ name: c.name, slug: c.slug, count: c.post_count }));
    map.set(tag.slug, { 
      tag: { name: tag.name, slug: tag.slug, count: tag.post_count }, 
      parentSlug, 
      isLeaf: !children.length, 
      children,
      showInAncestors: tag.show_in_ancestors !== false 
    });
    if (tag.children?.length) buildTagIndex(tag.children, tag.slug, map);
  }
  return map;
}

export function getTagAncestors(slug, index) {
  const ancestors = [];
  const visited = new Set([slug]);
  let entry = index.get(slug);
  while (entry?.parentSlug) {
    if (visited.has(entry.parentSlug)) break;
    visited.add(entry.parentSlug);
    entry = index.get(entry.parentSlug);
    if (entry && !entry.tag.slug.startsWith('_') && entry.showInAncestors !== false) {
      ancestors.unshift(entry.tag);
    }
  }
  return ancestors;
}
