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

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      currentPath = '/',
      navTags = [],
      breadcrumb = [],
    } = this.props;

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
          const lockIcon = crumb.is_hidden ? `<span class="locker-icon" title="Hidden">🔒</span>` : '';

          if (isLast) {
            if (crumb.slug) {
              const href = `/tag/${escapeHtml(crumb.slug)}`;
              return `<a href="${href}" class="breadcrumb-current">${lockIcon}${escapeHtml(crumb.name)}</a>`;
            }
            return `<span class="breadcrumb-current">${lockIcon}${escapeHtml(crumb.name)}</span>`;
          }
          const href = crumb.slug ? `/tag/${escapeHtml(crumb.slug)}` : '/';
          return `<a href="${href}" class="breadcrumb-link">${lockIcon}${escapeHtml(crumb.name)}</a>
                  <span class="breadcrumb-separator" aria-hidden="true">/</span>`;
        }),
      ].join('');
      crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb">${items}</nav>`;
    }

    return `
      <div class="site-header-group">
        <div class="site-header-inner">

          <div class="site-header">
            <div class="site-branding">
              <a href="/" class="site-title-link">
                <h1 class="site-title">
                  <svg class="app-logo" viewBox="0 0 128 128" version="1.1" xmlns="http://www.w3.org/2000/svg">
                      <path class="logo-shape" d="M128 64A64 64 0 1 0 64 128h48a16 16 0 0 0 16-16V64z" />
                  </svg>
                  ${title}
                </h1>
                ${!breadcrumb.length && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
              </a>
              ${crumbHtml}
            </div>
          </div>

          ${navTags.length ? '<div class="header-tags-bar" id="header-tags-mount"></div>' : ''}

          <nav class="site-nav" aria-label="Main navigation">
            <a href="/map" class="nav-link${currentPath === '/map' ? ' active' : ''}"
               aria-label="Map view">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                   xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
                      fill="currentColor"/>
                <circle cx="12" cy="9" r="2.5" fill="white"/>
              </svg>
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
