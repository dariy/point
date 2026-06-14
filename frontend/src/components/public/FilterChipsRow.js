import { Component } from '../Component.js';
import { ViewContext } from '../../utils/viewContext.js';
import { escapeHtml } from '../../utils/helpers.js';

export class FilterChipsRow extends Component {
  render() {
    const vc = ViewContext.current();
    if (vc.isDefault()) return '';

    const { total = 0 } = this.props;

    const chips = [];
    const ariaLabels = [];

    if (vc.tag) {
      chips.push(`
        <span class="filter-chip">
          <span class="filter-chip-label">${escapeHtml(vc.tag)}</span>
          <button class="filter-chip-remove" data-facet="tag" aria-label="Remove tag filter" type="button">&times;</button>
        </span>
      `);
      ariaLabels.push(vc.tag);
    }

    if (vc.years && !this.props.timelineVisible) {
      const yearStr = vc.years[0] === vc.years[1] ? String(vc.years[0]) : `${vc.years[0]} \u2013 ${vc.years[1]}`;
      chips.push(`
        <span class="filter-chip">
          <span class="filter-chip-label">${escapeHtml(yearStr)}</span>
          <button class="filter-chip-remove" data-facet="years" aria-label="Remove timeline filter" type="button">&times;</button>
        </span>
      `);
      ariaLabels.push(`from ${vc.years[0]} to ${vc.years[1]}`);
    }

    if (vc.query) {
      chips.push(`
        <span class="filter-chip">
          <span class="filter-chip-label">&ldquo;${escapeHtml(vc.query)}&rdquo;</span>
          <button class="filter-chip-remove" data-facet="query" aria-label="Remove search filter" type="button">&times;</button>
        </span>
      `);
      ariaLabels.push(`search for ${vc.query}`);
    }

    const ariaLiveText = `Showing ${ariaLabels.join(', ')} \u2014 ${total} post${total !== 1 ? 's' : ''}`;

    return `
      <div class="filter-chips-row" aria-live="polite">
        <span class="sr-only">${escapeHtml(ariaLiveText)}</span>
        <div class="filter-chips-container" aria-hidden="true">
          ${chips.join('')}
          <button class="filter-chip-clear" type="button">Clear all</button>
          <span class="filter-chip-count">&middot; ${total} post${total !== 1 ? 's' : ''}</span>
        </div>
      </div>
    `;
  }

  afterRender() {
    const row = this.$('.filter-chips-row');
    if (!row) return;

    row.querySelectorAll('.filter-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const facet = btn.dataset.facet;
        ViewContext.update({ [facet]: null });
      });
    });

    const clearBtn = row.querySelector('.filter-chip-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        ViewContext.update({ tag: null, years: null, query: null });
      });
    }
  }
}
