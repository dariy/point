/**
 * Pagination component.
 *
 * Props:
 *   page     {number}   Current page (1-indexed)
 *   pages    {number}   Total pages
 *   total    {number}   Total items
 *   compact  {boolean}  Show the item count as a tooltip instead of a label
 *                       (for tight housings like the footer's centre slot)
 *   onPage   {Function} Called with new page number when user navigates
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

export class Pagination extends Component {
  render() {
    const { page, pages, total, compact } = this.props;
    if (!pages || pages <= 1) return '';

    const items = this._buildItems(page, pages);

    const buttons = items.map((item) => {
      if (item === '…') {
        return `<span class="page-ellipsis" aria-hidden="true">…</span>`;
      }
      const active = item === page ? ' class="page-btn active" aria-current="page"' : ' class="page-btn"';
      return `<button${active} data-page="${escapeHtml(item)}" type="button">${escapeHtml(item)}</button>`;
    }).join('');

    const prevDisabled = page <= 1 ? ' disabled' : '';
    const nextDisabled = page >= pages ? ' disabled' : '';

    const info = compact
      ? ''
      : `<span class="page-info" aria-live="polite">${escapeHtml(total)} items</span>`;
    const title = compact ? ` title="${escapeHtml(total)} items"` : '';

    return `
      <nav class="pagination"${title} aria-label="Page navigation">
        <button class="page-btn page-prev" data-page="${escapeHtml(page - 1)}" type="button"${prevDisabled} aria-label="Previous page">&#8592;</button>
        <span class="page-numbers">${buttons}</span>
        <button class="page-btn page-next" data-page="${escapeHtml(page + 1)}" type="button"${nextDisabled} aria-label="Next page">&#8594;</button>
        ${info}
      </nav>`;
  }

  afterRender() {
    this.container.querySelectorAll('.page-btn:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page, 10);
        if (p >= 1 && p <= this.props.pages && this.props.onPage) {
          this.props.onPage(p);
        }
      });
    });
  }

  /**
   * Build a compact page number array with ellipsis gaps.
   * e.g. [1, '…', 4, 5, 6, '…', 10]
   */
  _buildItems(page, pages) {
    if (pages <= 7) {
      return Array.from({ length: pages }, (_, i) => i + 1);
    }
    const items = [];
    const addRange = (from, to) => {
      for (let i = from; i <= to; i++) items.push(i);
    };
    items.push(1);
    if (page > 3) items.push('…');
    addRange(Math.max(2, page - 1), Math.min(pages - 1, page + 1));
    if (page < pages - 2) items.push('…');
    items.push(pages);
    return items;
  }
}
