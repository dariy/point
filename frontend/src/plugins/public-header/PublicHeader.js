/**
 * Public site header — blog logo, unified breadcrumb (tag path + active
 * facets), and nav buttons.
 *
 * Props:
 *   settings        {object}    Public blog settings (blog_title, blog_subtitle)
 *   currentPath     {string}    Current pathname for active nav highlighting
 *   navTags         {object[]}  Root tags with children (used for "site" crumb dropdown)
 *   currentTagSlug  {string}    Active tag slug (for flyout highlight)
 *   breadcrumb      {object[]}  Tag-ancestry crumbs: { name, slug?, href?, is_hidden?, tooltip? }.
 *                               Last item = current tag (may have a slug for a self-link).
 *   total           {number}    Post / result count shown as trailing count crumb.
 *   timelineVisible {boolean}   When true, suppress the year facet crumb (timeline shows it).
 *   slot            {string}    Optional HTML inserted as a middle header item
 *                               (between breadcrumb and action buttons; wraps to its
 *                               own full-width row on mobile), e.g. a page control.
 */

import { Component } from '../../components/Component.js';
import { store } from '../../store.js';
import { pluginHost } from '../../core/pluginHost.js';
import { escapeHtml, navigate, sharePost } from '../../utils/helpers.js';
import { listPosts } from '../../api/posts.js';
import { listTags } from '../../api/tags.js';
import { APP_LOGO_SVG, EDIT_SVG, SUN_SVG, MOON_SVG, SEARCH_SVG, MENU_SVG, SHARE_SVG, EXPAND_SVG, ARTICLE_SVG } from '../../utils/icons.js';
import { ViewContext } from '../../utils/viewContext.js';
import { hideFlyout } from '../../utils/tags.js';

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      breadcrumb = [],
      editUrl = null,
      showShare = false,
      immersive = false,
      onToggleImmersive = null,
      slot = '',
    } = this.props;

    const user = store.get('user');
    const subtitle = escapeHtml(settings.blog_subtitle || '');

    const shareButtonHtml = showShare
      ? `<button type="button" class="header-action-btn share-btn" title="Share" aria-label="Share">
           ${SHARE_SVG}
         </button>`
      : '';

    const immersiveToggleHtml = onToggleImmersive
      ? `<button type="button" class="header-action-btn immersive-toggle-btn"
                 title="${immersive ? 'Article view' : 'Immersive mode'}"
                 aria-label="${immersive ? 'Article view' : 'Immersive mode'}">
           ${immersive ? ARTICLE_SVG : EXPAND_SVG}
         </button>`
      : '';

    const vc = ViewContext.current();

    const crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb"></nav>`;

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
                </h1>
                ${!breadcrumb.length && !vc.years && !vc.query && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
              </a>
              ${crumbHtml}
              ${(immersiveToggleHtml || shareButtonHtml || editButtonHeader)
                ? `<div class="branding-actions">
                ${immersiveToggleHtml}
                ${shareButtonHtml}
                ${editButtonHeader}
              </div>`
                : ''}
            </div>
          </div>

          ${slot ? `<div class="site-nav-slot">${slot}</div>` : ''}

          <nav class="site-nav" aria-label="Main navigation">

            <form class="header-search-form" id="header-search" role="search" action="/search" method="get">
              <input type="search" name="q" placeholder="${searchPlaceholder}" aria-label="Search posts" tabindex="-1">
              <button type="button" aria-label="Toggle search" class="header-action-btn search-toggle-btn">
                ${SEARCH_SVG}
              </button>
            </form>

            <!-- Normal nav items (hidden when fold-nav active) -->
            <div class="site-nav-items"></div>

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

                <div class="burger-sitemap"></div>

                <div class="burger-actions">
                  <button class="theme-toggle" id="burger-theme-toggle" type="button" aria-label="Toggle theme">
                    <span class="icon-sun">${SUN_SVG}</span>
                    <span class="icon-moon">${MOON_SVG}</span>
                  </button>
                  ${immersiveToggleHtml}
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
    const { onToggleImmersive } = this.props;

    this.container.querySelectorAll('.immersive-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        onToggleImmersive?.();
      });
    });

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

    // Shell slots inside the header. The breadcrumbs and nav-menu are rendered
    // inline by core today; once those features are extracted into plugin chunks
    // (Phase 4) the host fills their regions here. No-op until a chunk claims the
    // slot, so behavior is unchanged.
    if (pluginHost.hasSlot('breadcrumbs')) {
      pluginHost.fill('breadcrumbs', this.$('.site-breadcrumb'), { ...this.props, group: this._group });
    }
    if (pluginHost.hasSlot('nav-menu')) {
      pluginHost.fill('nav-menu', this.$('.site-nav'), { ...this.props });
    }

    // Theme toggle in the burger menu (the primary toggle now lives in the footer)
    this.$('#burger-theme-toggle')?.addEventListener('click', () => {
      const current = store.get('theme') || 'auto';
      store.set('theme', current === 'dark' ? 'light' : 'dark');
    });



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
          // Expand the search input to fill up to the breadcrumb's left edge
          const breadcrumbEl = this.$('.site-breadcrumb');
          if (breadcrumbEl) {
            const formRect = searchForm.getBoundingClientRect();
            const bcRect = breadcrumbEl.getBoundingClientRect();
            input.style.setProperty('--search-width', `${formRect.right - bcRect.left}px`);
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

    const innerRight = inner.getBoundingClientRect().right;
    const navEl = inner.querySelector('.site-nav');

    const content = inner.querySelector('.site-breadcrumb');

    if (content) {
      const cRect = content.getBoundingClientRect();
      const nRect = navEl ? navEl.getBoundingClientRect() : null;
      
      const sameRow = nRect ? Math.abs(nRect.top - cRect.top) < cRect.height : true;
      
      if (nRect) {
         const limit = sameRow ? nRect.left : innerRight;
         return cRect.right > limit - 1;
      }
      return cRect.right > innerRight + 1;
    }

    // Fallback: nav (or header) exits the container boundary.
    if (navEl) return navEl.getBoundingClientRect().right > innerRight + 1;
    const headerEl = inner.querySelector('.site-header');
    return headerEl ? headerEl.getBoundingClientRect().right > innerRight + 1 : false;
  }

  _resetFold() {
    const group = this._group;
    if (!group) return;
    group.classList.remove('fold-title', 'fold-nav', 'fold-current');
    group.querySelectorAll('.crumb-pair.folded').forEach((p) => {
      p.classList.remove('folded', 'show-ellipsis');
    });
    this._closeBurger();
    group.querySelector('#crumb-popover')?.classList.remove('is-open');
  }

  _updateFold() {
    const inner = this._inner;
    const group = this._group;
    if (!inner || !group) return;

    this._resetFold();
    if (!this._overflows(inner)) return;

    // Step 1: hide site subtitle
    group.classList.add('fold-title');
    if (!this._overflows(inner)) return;

    // Step 2: fold breadcrumb pairs left to right (excluding site title)
    // Drop facet pairs first, then tag pairs
    const allPairs = [...group.querySelectorAll('.crumb-pair')];
    const facetPairs = allPairs.filter(p => p.classList.contains('crumb-facet-pair'));
    const tagPairs = allPairs.filter(p => !p.classList.contains('crumb-facet-pair') && p.id !== 'site-crumb-pair');
    const sitePair = allPairs.find(p => p.id === 'site-crumb-pair');

    const checkEllipsis = () => {
      const allFolded = group.querySelectorAll('.crumb-pair.folded');
      allFolded.forEach(p => p.classList.remove('show-ellipsis'));
      if (allFolded.length > 0) {
        allFolded[allFolded.length - 1].classList.add('show-ellipsis');
      }
    };

    // Fold facet pairs
    for (const pair of facetPairs) {
      pair.classList.add('folded');
      checkEllipsis();
      if (!this._overflows(inner)) return;
    }

    // Fold tag pairs left to right
    for (const pair of tagPairs) {
      pair.classList.add('folded');
      checkEllipsis();
      if (!this._overflows(inner)) return;
    }

    // Step 3: fold site title if it still overflows
    if (sitePair) {
      sitePair.classList.add('folded');
      checkEllipsis();
      if (!this._overflows(inner)) return;
    }

    // Step 4: collapse nav to burger
    group.classList.add('fold-nav');
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
    hideFlyout();
  }
}
