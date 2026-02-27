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
import { escapeHtml } from '../../utils/helpers.js';
import { APP_LOGO_SVG, MAP_SVG, LOCK_SVG, EDIT_SVG } from '../../utils/icons.js';

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
          const lockIcon = (crumb.is_hidden || crumb.is_hidden_posts) ? LOCK_SVG : '';

          if (isLast) {
            const tooltipAttr = crumb.tooltip ? ` title="${escapeHtml(crumb.tooltip)}"` : '';
            if (crumb.slug) {
              const href = `/tag/${escapeHtml(crumb.slug)}`;
              return `<a href="${href}" class="breadcrumb-current"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</a>`;
            }
            return `<span class="breadcrumb-current"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>`;
          }
          const href = crumb.slug ? `/tag/${escapeHtml(crumb.slug)}` : '/';
          return `<a href="${href}" class="breadcrumb-link">${lockIcon}${escapeHtml(crumb.name)}</a>
                  <span class="breadcrumb-separator" aria-hidden="true">/</span>`;
        }),
      ].join('');
      crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb">${items}</nav>`;
    }

    const editButton = (user && editUrl)
      ? `<a href="${escapeHtml(editUrl)}" class="edit-button-link" title="Edit">
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
            <a href="/map" class="nav-link${currentPath === '/map' ? ' active' : ''}"
               aria-label="Map view">
              ${MAP_SVG}
            </a>
            <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme" type="button">
              <span class="icon-sun" aria-hidden="true">☀</span>
              <span class="icon-moon" aria-hidden="true">☾</span>
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
  }
}
