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
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { APP_LOGO_SVG, MAP_SVG, EDIT_SVG, SUN_SVG, MOON_SVG, LOCK_SVG, SEARCH_SVG } from '../../utils/icons.js';

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      currentPath = '/',
      navTags = [],
      breadcrumb = [],
      editUrl = null,
    } = this.props;

    const user = store.get('user');
    const title    = escapeHtml(settings.blog_title || 'Photo Blog');
    const subtitle = escapeHtml(settings.blog_subtitle || '');

    // Build breadcrumb nav rendered inside .site-branding
    let crumbHtml = '';
    if (breadcrumb.length) {
      // Leading separator mirrors the gaps between crumb items
      const items = [
        `<span class="breadcrumb-separator" aria-hidden="true">/</span>`,
        ...breadcrumb.map((crumb, i) => {
          const isLast = i === breadcrumb.length - 1;
          

          const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
          if (isLast) {
            const tooltipAttr = crumb.tooltip ? ` title="${escapeHtml(crumb.tooltip)}"` : '';
            if (crumb.slug) {
              const href = `/tag/${escapeHtml(crumb.slug)}`;
              return `<a href="${href}" class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</a>`;
            }
            return `<span class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>`;
          }
          const href = crumb.href || (crumb.slug ? `/tag/${escapeHtml(crumb.slug)}` : '/');
          return `<a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}">${lockIcon}${escapeHtml(crumb.name)}</a>
                  <span class="breadcrumb-separator" aria-hidden="true">/</span>`;
        }),
      ].join('');
      crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb">${items}</nav>`;
    }

    // ICON BUTTON GUIDANCE
    // All icon-only buttons in the header use the `header-action-btn` class.
    //   <a class="header-action-btn" href="..." aria-label="...">  — for navigation
    //   <button class="header-action-btn" type="button" aria-label="...">  — for actions (no navigation)
    // The `.theme-toggle` class is kept as an alias and for sun/moon icon visibility logic.
    const editButton = (user && editUrl)
      ? `<a href="${escapeHtml(editUrl)}" class="header-action-btn" title="Edit" aria-label="Edit post">
           ${EDIT_SVG}
         </a>`
      : '';

    return `
      <div class="site-header-group">
        <div class="site-header-inner">

          <div class="site-header">
            <div class="site-branding">
              <a href="/" class="site-title-link">
                <h1 class="site-title">
                  ${APP_LOGO_SVG}
                  ${title}
                </h1>
                ${!breadcrumb.length && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
              </a>
              ${crumbHtml}
              ${editButton}
            </div>
          </div>

          ${navTags.length ? '<div class="header-tags-bar" id="header-tags-mount"></div>' : ''}

          <nav class="site-nav" aria-label="Main navigation">
            <form class="header-search-form" id="header-search" role="search" action="/search" method="get">
              <input type="search" name="q" placeholder="Search..." aria-label="Search posts" tabindex="-1">
              <button type="button" aria-label="Toggle search" class="header-action-btn search-toggle-btn">
                ${SEARCH_SVG}
              </button>
            </form>
            ${(() => {
              const visibility = settings.map_mode || 'off';
              if (visibility === 'all' || (user && visibility === 'hidden')) {
                return `
                  <a href="/map" class="header-action-btn${currentPath === '/map' ? ' active' : ''}"
                     aria-label="Map view">
                    ${MAP_SVG}
                  </a>`;
              }
              return '';
            })()}
            <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme" type="button">
              <span class="icon-sun">${SUN_SVG}</span>
              <span class="icon-moon">${MOON_SVG}</span>
            </button>
          </nav>

        </div>
      </div>`;
  }

  afterRender() {
    const { navTags = [], currentTagSlug = '' } = this.props;

    if (navTags.length) {
      this.mountChild(PublicHeaderTagsBar, '#header-tags-mount', { navTags, currentTagSlug });
    }

    const btn = this.$('#theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = store.get('theme') || 'auto';
        const next = current === 'dark' ? 'light' : 'dark';
        store.set('theme', next);
      });
    }

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
          navigate(`/search?q=${encodeURIComponent(q)}`);
          input.value = '';
        }
        closeSearch();
      };

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!searchForm.classList.contains('is-active')) {
          searchForm.classList.add('is-active');
          const tagsBar = document.getElementById('header-tags-mount');
          if (tagsBar) {
            const formRect = searchForm.getBoundingClientRect();
            const tagsRect = tagsBar.getBoundingClientRect();
            const desiredWidth = formRect.right - tagsRect.left;
            input.style.setProperty('--search-width', `${desiredWidth}px`);
          }
          input.tabIndex = 0;
          input.focus();
        } else {
          submitSearch();
        }
      });

      searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitSearch();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeSearch();
        }
      });

      document.addEventListener('click', (e) => {
        if (searchForm.classList.contains('is-active') && !searchForm.contains(e.target)) {
          closeSearch();
        }
      });
    }
  }
}
