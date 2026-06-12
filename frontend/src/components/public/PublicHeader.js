/**
 * Public site header — blog logo, optional breadcrumb, tag filter bar, nav buttons.
 *
 * Props:
 *   settings       {object}    Public blog settings (blog_title, blog_subtitle)
 *   currentPath    {string}    Current pathname for active nav highlighting
 *   navTags        {object[]}  Root tags with children for the filter bar
 *   currentTagSlug {string}    Active tag slug (for filter bar highlight)
 *   breadcrumb     {object[]}  Crumb items: { name, slug? }. Last item = current page (no slug).
 */

import { Component } from '../Component.js';
import { PublicHeaderTagsBar } from './PublicHeaderTagsBar.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, sharePost } from '../../utils/helpers.js';
import { listPosts } from '../../api/posts.js';
import { listTags } from '../../api/tags.js';
import { APP_LOGO_SVG, MAP_SVG, EDIT_SVG, SUN_SVG, MOON_SVG, LOCK_SVG, SEARCH_SVG, MENU_SVG, SHARE_SVG } from '../../utils/icons.js';
import { ViewContext } from '../../utils/viewContext.js';

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      currentPath = '/',
      navTags = [],
      breadcrumb = [],
      editUrl = null,
      showShare = false,
    } = this.props;

    const user = store.get('user');
    const title    = escapeHtml(settings.blog_title || 'Photo Blog');
    const subtitle = escapeHtml(settings.blog_subtitle || '');

    const shareButtonHtml = showShare
      ? `<button type="button" class="header-action-btn share-btn" title="Share" aria-label="Share">
           ${SHARE_SVG}
         </button>`
      : '';

    // Build breadcrumb nav rendered inside .site-branding
    let crumbHtml = '';
    if (breadcrumb.length) {
      // Popover lists all crumb items (shown when fold-current is active)
      const popoverItems = breadcrumb.map((crumb, i) => {
        const isLast = i === breadcrumb.length - 1;
        const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
        if (isLast) {
          return `<span class="popover-item is-current">${lockIcon}${escapeHtml(crumb.name)}</span>`;
        }
        const href = crumb.href || (crumb.slug ? `/tags/${escapeHtml(crumb.slug)}` : '/');
        return `<a href="${href}" class="popover-item">${lockIcon}${escapeHtml(crumb.name)}</a>`;
      }).join('');

      // Leading separator + crumb-pairs (each non-last crumb wrapped for fold toggling)
      const items = [
        `<span class="breadcrumb-separator" aria-hidden="true">/</span>`,
        ...breadcrumb.map((crumb, i) => {
          const isLast = i === breadcrumb.length - 1;
          const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
          if (isLast) {
            const tooltipAttr = crumb.tooltip ? ` title="${escapeHtml(crumb.tooltip)}"` : '';
            if (crumb.slug) {
              const href = `/tags/${escapeHtml(crumb.slug)}`;
              return `<a href="${href}" class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</a>`;
            }
            return `<span class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>`;
          }
          const href = crumb.href || (crumb.slug ? `/tags/${escapeHtml(crumb.slug)}` : '/');
          return `<span class="crumb-pair">
                    <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}">${lockIcon}${escapeHtml(crumb.name)}</a>
                    <span class="breadcrumb-separator" aria-hidden="true">/</span>
                  </span>`;
        }),
      ].join('');
      crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb">
        ${items}
        <div class="crumb-popover" id="crumb-popover">${popoverItems}</div>
      </nav>`;
    }

    // ICON BUTTON GUIDANCE
    // All icon-only buttons in the header use the `header-action-btn` class.
    //   <a class="header-action-btn" href="..." aria-label="...">  — for navigation
    //   <button class="header-action-btn" type="button" aria-label="...">  — for actions (no navigation)
    // The `.theme-toggle` class is kept as an alias and for sun/moon icon visibility logic.
    const editButtonHeader = (user && editUrl)
      ? `<a href="${escapeHtml(editUrl)}" class="header-action-btn edit-btn-header" title="Edit" aria-label="Edit post">
           ${EDIT_SVG}
         </a>`
      : '';

    const editButtonBurger = (user && editUrl)
      ? `<a href="${escapeHtml(editUrl)}" class="header-action-btn" title="Edit" aria-label="Edit post">
           ${EDIT_SVG}
         </a>`
      : '';

    const mapButtonHtml = (() => {
      const visibility = settings.map_mode || 'off';
      if (visibility === 'all' || (user && visibility === 'hidden')) {
        return `<a href="/map" class="header-action-btn${currentPath === '/map' ? ' active' : ''}"
                   aria-label="Map view">
                  ${MAP_SVG}
                </a>`;
      }
      return '';
    })();

    const vc = ViewContext.current();
    const searchPlaceholder = vc.tag ? `Search ${escapeHtml(vc.tag)}...` : "Search...";

    return `
      <div class="site-header-group">
        <div id="search-typeahead-mount" class="search-typeahead-mount"></div>
        <div class="site-header-inner">

          <div class="site-header">
            <div class="site-branding">
              <a href="/" class="site-title-link">
                <h1 class="site-title">
                  ${APP_LOGO_SVG}
                  <span class="site-title-text">${title}</span>
                </h1>
                ${!breadcrumb.length && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
              </a>
              ${crumbHtml}
              ${editButtonHeader}
            </div>
          </div>

          ${navTags.length ? '<div class="header-tags-bar" id="header-tags-mount"></div>' : ''}

          <nav class="site-nav" aria-label="Main navigation">

            <form class="header-search-form" id="header-search" role="search" action="/search" method="get">
              <input type="search" name="q" placeholder="${searchPlaceholder}" aria-label="Search posts" tabindex="-1">
              <button type="button" aria-label="Toggle search" class="header-action-btn search-toggle-btn">
                ${SEARCH_SVG}
              </button>
            </form>

            <!-- Normal nav items (hidden when fold-nav active) -->
            <div class="site-nav-items">
              ${mapButtonHtml}
              ${shareButtonHtml}
              <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme" type="button">
                <span class="icon-sun">${SUN_SVG}</span>
                <span class="icon-moon">${MOON_SVG}</span>
              </button>
            </div>

            <!-- Burger (shown when fold-nav active) -->
            <div class="nav-burger" id="nav-burger">
              <button class="header-action-btn burger-toggle" type="button" aria-label="Menu" aria-expanded="false">
                ${MENU_SVG}
              </button>
              <div class="burger-dropdown">
                <form class="burger-search-form" action="/search" method="get" role="search">
                  ${SEARCH_SVG}
                  <input type="search" name="q" placeholder="${searchPlaceholder}" autocomplete="off">
                </form>

                <div class="burger-tags-slot" id="burger-tags-slot"></div>

                <div class="burger-sitemap">
                  <a href="/tags" class="burger-link">All tags</a>
                  <a href="/map" class="burger-link">Map</a>
                  <a href="/light" class="burger-link">About</a>
                  ${user ? `<a href="/light" class="burger-link">Admin</a>` : ''}
                </div>

                <div class="burger-actions">
                  <button class="theme-toggle" id="burger-theme-toggle" type="button" aria-label="Toggle theme">
                    <span class="icon-sun">${SUN_SVG}</span>
                    <span class="icon-moon">${MOON_SVG}</span>
                  </button>
                  ${shareButtonHtml}
                  ${editButtonBurger}
                </div>
              </div>
            </div>

          </nav>

        </div>
      </div>`;
  }

  afterRender() {
    const { navTags = [], currentTagSlug = '' } = this.props;

    if (navTags.length) {
      this.mountChild(PublicHeaderTagsBar, '#header-tags-mount', { navTags, currentTagSlug });
    }

    this.container.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const settings = store.get('settings') || {};
        sharePost({
          title: settings.blog_title || document.title,
          url: window.location.href
        });
      });
    });

    this._group = this.$('.site-header-group');
    this._inner = this.$('.site-header-inner');

    // Theme toggles (header + burger share the same handler)
    const toggleTheme = () => {
      const current = store.get('theme') || 'auto';
      store.set('theme', current === 'dark' ? 'light' : 'dark');
    };
    this.$('#theme-toggle')?.addEventListener('click', toggleTheme);
    this.$('#burger-theme-toggle')?.addEventListener('click', toggleTheme);

    // Header search (expandable)
    const searchForm = this.$('#header-search');
    if (searchForm) {
      const input = searchForm.querySelector('input[type="search"]');
      const toggleBtn = searchForm.querySelector('.search-toggle-btn');

      const closeSearch = () => {
        searchForm.classList.remove('is-active');
        input.tabIndex = -1;
        input.blur();
      };

      const submitSearch = () => {
        const q = input.value.trim();
        if (q) {
          this._saveRecentSearch(q);
          ViewContext.update({ query: q });
          input.value = '';
        }
        this._hideTypeahead();
        closeSearch();
      };

      let debounceTimer = null;
      input.addEventListener('input', () => {
        const q = input.value.trim();
        clearTimeout(debounceTimer);
        if (q.length >= 2) {
          debounceTimer = setTimeout(() => this._showTypeahead(q, input), 300);
        } else {
          this._hideTypeahead();
        }
      });

      input.addEventListener('focus', () => {
        if (!input.value.trim()) this._showRecentSearches(input);
      });

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!searchForm.classList.contains('is-active')) {
          searchForm.classList.add('is-active');
          const tagsBar = document.getElementById('header-tags-mount');
          if (tagsBar) {
            const formRect = searchForm.getBoundingClientRect();
            const tagsRect = tagsBar.getBoundingClientRect();
            input.style.setProperty('--search-width', `${formRect.right - tagsRect.left}px`);
          }
          input.tabIndex = 0;
          input.focus();
        } else {
          submitSearch();
        }
      });

      searchForm.addEventListener('submit', (e) => { e.preventDefault(); submitSearch(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
      document.addEventListener('click', (e) => {
        if (searchForm.classList.contains('is-active') && !searchForm.contains(e.target)) closeSearch();
      });
    }

    // Burger search (always-visible full-width input)
    const burgerSearchForm = this.$('.burger-search-form');
    if (burgerSearchForm) {
      burgerSearchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = burgerSearchForm.querySelector('input[type="search"]').value.trim();
        if (q) ViewContext.update({ query: q });
        this._closeBurger();
      });
    }

    // Burger toggle + outside-click close
    const navBurger = this.$('#nav-burger');
    if (navBurger) {
      const burgerBtn = navBurger.querySelector('.burger-toggle');
      burgerBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = navBurger.classList.contains('is-open');
        navBurger.classList.toggle('is-open', !isOpen);
        burgerBtn.setAttribute('aria-expanded', String(!isOpen));
        
        if (!isOpen) {
          const input = navBurger.querySelector('input[type="search"]');
          if (input) setTimeout(() => input.focus(), 100);
        }
      });

      document.addEventListener('click', (e) => {
        if (!navBurger.contains(e.target)) this._closeBurger();
      });
    }

    // Crumb popover (fold-current step)
    const crumbCurrent = this.$('.breadcrumb-current');
    const crumbPopover = this.$('#crumb-popover');
    if (crumbCurrent && crumbPopover) {
      crumbCurrent.addEventListener('click', (e) => {
        if (!this._group?.classList.contains('fold-current')) return;
        e.preventDefault();
        e.stopPropagation();
        const isOpen = crumbPopover.classList.contains('is-open');
        if (!isOpen) {
          const rect = crumbCurrent.getBoundingClientRect();
          crumbPopover.style.top  = `${rect.bottom + 4}px`;
          crumbPopover.style.left = `${rect.left}px`;
        }
        crumbPopover.classList.toggle('is-open', !isOpen);
      });

      document.addEventListener('click', (e) => {
        if (!crumbPopover.contains(e.target) && e.target !== crumbCurrent) {
          crumbPopover.classList.remove('is-open');
        }
      });
    }

    // ResizeObserver drives the progressive fold
    this._ro = new ResizeObserver(() => this._updateFold());
    this._ro.observe(this._group);
    this._updateFold();
  }

  _saveRecentSearch(q) {
    const recent = JSON.parse(localStorage.getItem('recentSearches') || '[]');
    const next = [q, ...recent.filter(s => s !== q)].slice(0, 5);
    localStorage.setItem('recentSearches', JSON.stringify(next));
  }

  async _showTypeahead(q, input) {
    this._typeaheadActive = true;
    const vc = ViewContext.current();
    const params = { q, limit: 3, status: 'published' };
    if (vc.tag) params.tag = vc.tag;

    try {
      const [postsData, tagsData] = await Promise.all([
        listPosts(params),
        listTags({ q, limit: 5, include_empty: false })
      ]);

      if (!this._typeaheadActive) return;
      this._renderTypeaheadResults(q, postsData.posts || [], tagsData.tags || [], input);
    } catch (err) {
      console.error('Typeahead failed:', err);
    }
  }

  _showRecentSearches(input) {
    const recent = JSON.parse(localStorage.getItem('recentSearches') || '[]');
    if (!recent.length) return;
    this._renderTypeaheadResults('', [], [], input, recent);
  }

  _renderTypeaheadResults(q, posts, tags, input, recent = []) {
    const mount = document.getElementById('search-typeahead-mount');
    if (!mount) return;

    const inputRect = input.getBoundingClientRect();
    mount.style.top = `${inputRect.bottom + 4}px`;
    mount.style.left = `${inputRect.left}px`;
    mount.style.width = `${inputRect.width}px`;
    mount.classList.add('is-open');

    let html = '';
    if (recent.length) {
      html += `<div class="typeahead-section"><div class="typeahead-label">Recent</div>`;
      recent.forEach(s => {
        html += `<a href="#" class="typeahead-item recent-item" data-q="${escapeHtml(s)}">${escapeHtml(s)}</a>`;
      });
      html += `</div>`;
    } else {
      if (tags.length) {
        html += `<div class="typeahead-section"><div class="typeahead-label">Tags</div>`;
        tags.forEach(t => {
          html += `<a href="/tags/${t.slug}" class="typeahead-item tag-item">
            <span class="name">${escapeHtml(t.name)}</span>
            <span class="count">${t.post_count}</span>
          </a>`;
        });
        html += `</div>`;
      }
      if (posts.length) {
        html += `<div class="typeahead-section"><div class="typeahead-label">Posts</div>`;
        posts.forEach(p => {
          html += `<a href="/posts/${p.slug}" class="typeahead-item post-item">${escapeHtml(p.title)}</a>`;
        });
        html += `</div>`;
      }
      html += `<a href="#" class="typeahead-item search-all" data-q="${escapeHtml(q)}">Search everything for &ldquo;${escapeHtml(q)}&rdquo;</a>`;
    }

    mount.innerHTML = html;

    mount.querySelectorAll('.typeahead-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const searchQ = item.dataset.q;
        if (searchQ) {
          this._saveRecentSearch(searchQ);
          ViewContext.update({ query: searchQ });
          input.value = '';
        } else {
          navigate(item.getAttribute('href'));
        }
        this._hideTypeahead();
      });
    });
  }

  _hideTypeahead() {
    this._typeaheadActive = false;
    const mount = document.getElementById('search-typeahead-mount');
    mount?.classList.remove('is-open');
  }

  _closeBurger() {
    const navBurger = this.$('#nav-burger');
    if (!navBurger) return;
    navBurger.classList.remove('is-open');
    navBurger.querySelector('.burger-toggle')?.setAttribute('aria-expanded', 'false');
  }

  _overflows(inner) {
    void inner.offsetWidth; // force reflow

    // When a tags strip is present, treat any clipped pill as overflow.
    // This fires fold-nav as soon as tags can't all be shown — not just when
    // the nav physically exits the container boundary.
    const tagsStrip = inner.querySelector('.tag-strip-scroll');
    if (tagsStrip && tagsStrip.scrollWidth > tagsStrip.clientWidth + 2) return true;

    // Fallback (no tags, or all tags fit): check if the nav exits the container.
    // scrollWidth is unreliable on overflow:visible flex containers in Chrome,
    // so compare bounding rects instead.
    const innerRight = inner.getBoundingClientRect().right;
    const navEl = inner.querySelector('.site-nav');
    if (navEl) return navEl.getBoundingClientRect().right > innerRight + 1;
    const headerEl = inner.querySelector('.site-header');
    return headerEl ? headerEl.getBoundingClientRect().right > innerRight + 1 : false;
  }

  _moveTags(target) {
    const tagsMount = document.getElementById('header-tags-mount');
    if (!tagsMount) return;
    if (target === 'burger') {
      const slot = document.getElementById('burger-tags-slot');
      if (slot && !slot.contains(tagsMount)) slot.appendChild(tagsMount);
    } else {
      const bar = this._group?.querySelector('.header-tags-bar');
      if (bar && !bar.contains(tagsMount)) bar.appendChild(tagsMount);
    }
  }

  _resetFold() {
    const group = this._group;
    if (!group) return;
    // Move tags back to header before measuring
    this._moveTags('header');
    group.classList.remove('fold-title', 'fold-nav', 'fold-tags', 'fold-current');
    group.querySelectorAll('.crumb-pair.folded').forEach((p) => p.classList.remove('folded'));
    this._closeBurger();
    group.querySelector('#crumb-popover')?.classList.remove('is-open');
  }

  _updateFold() {
    const inner = this._inner;
    const group = this._group;
    if (!inner || !group) return;

    this._resetFold();
    if (!this._overflows(inner)) return;

    // Step 1: hide site-title text
    group.classList.add('fold-title');
    if (!this._overflows(inner)) return;

    // Step 2: fold breadcrumb pairs left to right
    const pairs = [...group.querySelectorAll('.crumb-pair')];
    for (const pair of pairs) {
      pair.classList.add('folded');
      if (!this._overflows(inner)) return;
    }

    // Step 3: collapse nav to burger
    group.classList.add('fold-nav');
    if (!this._overflows(inner)) return;

    // Step 4: move tags into burger
    this._moveTags('burger');
    group.classList.add('fold-tags');
    if (!this._overflows(inner)) return;

    // Step 5: last resort — ellipsis on breadcrumb-current
    group.classList.add('fold-current');
  }

  beforeRender() {
    this._ro?.disconnect();
    this._ro = null;
  }

  beforeUnmount() {
    this._ro?.disconnect();
  }
}
