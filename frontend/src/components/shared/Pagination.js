/**
 * Pagination component.
 *
 * Props:
 *   page     {number}   Current page
 *   pages    {number}   Last page
 *   minPage  {number}   First page — 1 normally. The home feed lowers it to 0
 *                       or below for the owner, where the non-positive pages
 *                       hold the scheduled queue (see pages/public/HomePage.js).
 *   total    {number}   Total items
 *   compact  {boolean}  Show the item count as a tooltip instead of a label
 *                       (for tight housings like the footer's centre slot)
 *   onPage   {Function} Called with new page number when user navigates
 */

import { Component } from '../Component.js';
import { html } from '../../utils/helpers.js';

export class Pagination extends Component {
  render() {
    const { page, pages, total, compact } = this.props;
    const minPage = this._minPage();
    if (!pages || pages - minPage < 1) return html``;

    const items = this._buildItems(page, pages, minPage);

    const buttons = items.map((item) => {
      if (item === '…') {
        return html`<span class="page-ellipsis" aria-hidden="true">…</span>`;
      }
      const classes = ['page-btn'];
      if (item === page) classes.push('active');
      // A scheduled page is not part of the published site; mark it so the
      // paginator reads as two halves rather than one odd run of numbers.
      if (item < 1) classes.push('page-scheduled');
      const current = item === page ? html` aria-current="page"` : '';
      return html`<button class="${classes.join(' ')}"${current} data-page="${item}" type="button">${item}</button>`;
    });

    const prevDisabled = page <= minPage ? html` disabled` : '';
    const nextDisabled = page >= pages ? html` disabled` : '';

    const info = compact
      ? ''
      : html`<span class="page-info" aria-live="polite">${total} items</span>`;
    const title = compact ? html` title="${total} items"` : '';

    return html`
      <nav class="pagination"${title} aria-label="Page navigation">
        <button class="page-btn page-prev" data-page="${page - 1}" type="button"${prevDisabled} aria-label="Previous page">&#8592;</button>
        <span class="page-numbers">${buttons}</span>
        <button class="page-btn page-next" data-page="${page + 1}" type="button"${nextDisabled} aria-label="Next page">&#8594;</button>
        ${info}
      </nav>`;
  }

  afterRender() {
    const minPage = this._minPage();
    this.container.querySelectorAll('.page-btn:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page, 10);
        if (p >= minPage && p <= this.props.pages && this.props.onPage) {
          this.props.onPage(p);
        }
      });
    });
  }

  /** First reachable page — 1 unless a caller opened the feed to the left. */
  _minPage() {
    const m = this.props.minPage;
    return Number.isInteger(m) && m < 1 ? m : 1;
  }

  /**
   * Build a compact page number array with ellipsis gaps.
   * e.g. [1, '…', 4, 5, 6, '…', 10]
   */
  _buildItems(page, pages, minPage = 1) {
    const span = pages - minPage + 1;
    if (span <= 7) {
      return Array.from({ length: span }, (_, i) => minPage + i);
    }
    const items = [];
    const addRange = (from, to) => {
      for (let i = from; i <= to; i++) items.push(i);
    };
    items.push(minPage);
    if (page > minPage + 2) items.push('…');
    addRange(Math.max(minPage + 1, page - 1), Math.min(pages - 1, page + 1));
    if (page < pages - 2) items.push('…');
    items.push(pages);
    return items;
  }
}
