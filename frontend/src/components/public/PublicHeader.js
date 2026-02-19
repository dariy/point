/**
 * Public site header — blog title, subtitle, main navigation, theme toggle.
 *
 * Props:
 *   settings    {object}  Public blog settings (blog_title, blog_subtitle)
 *   currentPath {string}  Current pathname for active nav highlighting
 */

import { Component } from '../Component.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';

export class PublicHeader extends Component {
  render() {
    const { settings = {}, currentPath = '/' } = this.props;
    const title = escapeHtml(settings.blog_title || 'Photo Blog');
    const subtitle = escapeHtml(settings.blog_subtitle || '');

    const nav = [
      { href: '/',    label: 'Home' },
      { href: '/tags', label: 'Tags' },
      { href: '/map',  label: 'Map' },
    ];

    const navLinks = nav.map(({ href, label }) => {
      const active = currentPath === href ? ' class="nav-link active" aria-current="page"' : ' class="nav-link"';
      return `<li><a href="${escapeHtml(href)}"${active}>${escapeHtml(label)}</a></li>`;
    }).join('');

    return `
      <header class="site-header">
        <div class="header-inner">
          <div class="header-brand">
            <a href="/" class="site-title-link">
              <h1 class="site-title">${title}</h1>
              ${subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
            </a>
          </div>
          <nav class="site-nav" aria-label="Main navigation">
            <ul>${navLinks}</ul>
          </nav>
          <div class="header-actions">
            <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme" type="button">
              <span class="theme-icon-light" aria-hidden="true">☀</span>
              <span class="theme-icon-dark" aria-hidden="true">☾</span>
            </button>
          </div>
        </div>
      </header>`;
  }

  afterRender() {
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
