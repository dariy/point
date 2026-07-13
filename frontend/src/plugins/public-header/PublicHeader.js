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
import { APP_LOGO_SVG, EDIT_SVG, SUN_SVG, MOON_SVG, SEARCH_SVG, MENU_SVG, SHARE_SVG, EXPAND_SVG } from '../../utils/icons.js';
import { ViewContext } from '../../utils/viewContext.js';
import { hideFlyout } from '../../utils/tags.js';
import { HeaderFold } from '../../utils/headerFold.js';

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      breadcrumb = [],
      editUrl = null,
      showShare = false,
      onToggleImmersive = null,
      slot = '',
    } = this.props;

    const user = store.get('user');
    const subtitle = escapeHtml(settings.blog_subtitle || '');
    const logoHtml = settings.logo_url
      ? `<img class="app-logo" src="${escapeHtml(settings.logo_url)}" alt="${escapeHtml(settings.blog_title || 'Logo')}" decoding="async">`
      : APP_LOGO_SVG;

    const shareButtonHtml = showShare
      ? `<button type="button" class="header-action-btn share-btn" title="Share" aria-label="Share">
           ${SHARE_SVG}
         </button>`
      : '';

    const immersiveToggleHtml = onToggleImmersive
      ? `<button type="button" class="header-action-btn immersive-toggle-btn"
                 title="Immersive mode" aria-label="Immersive mode">
           ${EXPAND_SVG}
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

          <!-- Zone: identity — logo (+ subtitle); the textual blog title is the
               breadcrumb's site crumb, so "title → logo" folds in the context zone. -->
          <div class="site-identity">
            <a href="/" class="site-title-link">
              <h1 class="site-title">
                ${logoHtml}
              </h1>
              ${!breadcrumb.length && !vc.years && !vc.query && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
            </a>
          </div>

          <!-- Zone: context — breadcrumbs + count (the only elastic zone) -->
          ${crumbHtml}
          ${(immersiveToggleHtml || shareButtonHtml || editButtonHeader)
            ? `<div class="branding-actions">
            ${immersiveToggleHtml}
            ${shareButtonHtml}
            ${editButtonHeader}
          </div>`
            : ''}

          ${slot ? `<div class="site-nav-slot">${slot}</div>` : ''}

          <!-- Zone: nav — visible menu links (filled by the nav-menu plugin);
               folds into the burger as a whole (fold-nav). -->
          <nav class="site-nav" aria-label="Site menu">
            <div class="site-nav-items"></div>
          </nav>

          <!-- Zone: tools — search, burger; last to fold, never folds away. -->
          <div class="site-tools">

            <form class="header-search-form" id="header-search" role="search" action="/search" method="get">
              <input type="search" name="q" placeholder="${searchPlaceholder}" aria-label="Search posts" tabindex="-1">
              <button type="button" aria-label="Toggle search" class="header-action-btn search-toggle-btn">
                ${SEARCH_SVG}
              </button>
            </form>

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

          </div>

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

    // One fold controller owns the header's space; components and plugins
    // contribute ordered fold ops (see utils/headerFold.js for the order map).
    this._fold = new HeaderFold({
      observe: this._group,
      fits: () => this._rowFits(),
    });
    this._registerCoreFolds();

    // Shell slots inside the header. Slot content changes the row's width, so
    // each fill is followed by a relayout. The nav-menu plugin receives the
    // whole inner row: it renders into `.site-nav-items` and the burger slots,
    // and registers its own links → More fold stage (order 30) via `fold`.
    if (pluginHost.hasSlot('breadcrumbs')) {
      pluginHost.fill('breadcrumbs', this.$('.site-breadcrumb'), { ...this.props, group: this._group })
        .then(() => this._fold?.relayout());
    }
    if (pluginHost.hasSlot('nav-menu')) {
      pluginHost.fill('nav-menu', this._inner, { ...this.props, fold: this._fold })
        .then(() => this._fold?.relayout());
    }

    // Distraction-free toggle: the post list asks for it (distractionToggle);
    // mount it as the first icon in the nav action row. Its own mount keeps it
    // out of the fold logic and lets the plugin CSS keep it visible when
    // distraction-free hides the rest of the header.
    if (this.props.distractionToggle && pluginHost.hasSlot('post-list-tools')) {
      const tools = this.$('.site-tools');
      if (tools) {
        const holder = document.createElement('div');
        holder.className = 'distraction-tool';
        tools.insertBefore(holder, tools.firstChild);
        // Keep the mount so beforeUnmount can tear it down — the plugin sets
        // global state (body.distraction-free class, button portalled to body)
        // that survives our container clear and would otherwise lock the site
        // in full-screen mode when navigating off the list.
        pluginHost.fill('post-list-tools', holder, {}).then(comps => {
          if (this._unmounted) comps[0]?.unmount?.();
          else this._dfPlugin = comps[0];
        });
      }
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


    // Initial fold pass (HeaderFold's own ResizeObserver keeps it current).
    this._fold.relayout();
  }

  /**
   * Register the header's own fold stages. Order slots 30 (nav links → More)
   * belongs to the nav-menu plugin; see utils/headerFold.js for the full map.
   */
  _registerCoreFolds() {
    const group = this._group;
    const checkEllipsis = () => {
      const folded = group.querySelectorAll('.crumb-pair.folded');
      folded.forEach((p) => p.classList.remove('show-ellipsis'));
      if (folded.length) folded[folded.length - 1].classList.add('show-ellipsis');
    };

    // 10 — ornament: the subtitle goes first.
    this._fold.register(10, {
      reset: () => group.classList.remove('fold-title'),
      ops: () => [() => group.classList.add('fold-title')],
    });

    // 20 — history: facet pairs, then ancestor tag pairs, left to right. The
    // blog-title (site) pair is spared here; it folds at 50.
    this._fold.register(20, {
      reset: () => {
        group.querySelectorAll('.crumb-pair.folded').forEach((p) => {
          p.classList.remove('folded', 'show-ellipsis');
        });
        // A crumb dropdown anchored to a now-reflowing crumb would be
        // mispositioned; close it so it re-opens against the new layout.
        hideFlyout();
      },
      ops: () => {
        const pairs = [...group.querySelectorAll('.crumb-pair')];
        const facets = pairs.filter((p) => p.classList.contains('crumb-facet-pair'));
        const tags = pairs.filter(
          (p) => !p.classList.contains('crumb-facet-pair') && p.id !== 'site-crumb-pair',
        );
        return [...facets, ...tags].map((p) => () => {
          p.classList.add('folded');
          checkEllipsis();
        });
      },
    });

    // 40 — the nav zone collapses into the burger.
    this._fold.register(40, {
      // Don't close an open burger here: every relayout runs reset, and opening
      // the burger dropdown can itself trigger one (a scrollbar appearing shifts
      // the observed width), which would slam the menu shut the instant it
      // opens. When the nav genuinely un-folds, `.nav-burger` is display:none
      // via CSS, so a lingering is-open state stays invisible until it refolds.
      reset: () => group.classList.remove('fold-nav'),
      ops: () => [() => group.classList.add('fold-nav')],
    });

    // 50 — brand: the blog-title crumb folds, leaving the logo as the brand.
    // (Unfolding is covered by stage 20's reset, which unfolds every pair.)
    this._fold.register(50, {
      ops: () => {
        const sitePair = group.querySelector('#site-crumb-pair');
        return sitePair
          ? [() => { sitePair.classList.add('folded'); checkEllipsis(); }]
          : [];
      },
    });

    // 60 — last resort: ellipsize the current crumb (click opens the full path).
    this._fold.register(60, {
      reset: () => group.classList.remove('fold-current'),
      ops: () => [() => group.classList.add('fold-current')],
    });
  }

  /**
   * The row fits when the tools zone (always the last, rightmost zone) ends
   * inside the inner container and hasn't wrapped to a second row (the inner
   * row flex-wraps on narrow screens for the middle slot).
   */
  _rowFits() {
    const inner = this._inner;
    if (!inner) return true;
    void inner.offsetWidth; // force reflow before measuring
    const tools = inner.querySelector('.site-tools');
    const first = inner.firstElementChild;
    if (!tools || !first || tools === first) return true;
    const cs = getComputedStyle(inner);
    const right = inner.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0);
    const toolsRect = tools.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    if (toolsRect.top - firstRect.top > firstRect.height / 2) return false;
    return toolsRect.right <= right + 1;
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

  beforeRender() {
    this._fold?.destroy();
    this._fold = null;
  }

  beforeUnmount() {
    this._fold?.destroy();
    this._fold = null;
    hideFlyout();
    // Clears body.distraction-free and removes the button portalled to body.
    this._dfPlugin?.unmount?.();
    this._dfPlugin = null;
  }
}
