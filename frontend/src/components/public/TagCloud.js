/**
 * Tag cloud sidebar widget for the homepage.
 *
 * Props:
 *   tags  {Array<{ id, name, slug, post_count, weight }>}
 *         weight is 0–1; higher = larger font size in cloud
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

/** Map weight (0–1) to a CSS font-size step. */
function weightClass(weight) {
  if (weight >= 0.9) return 'tag-weight-5';
  if (weight >= 0.7) return 'tag-weight-4';
  if (weight >= 0.5) return 'tag-weight-3';
  if (weight >= 0.3) return 'tag-weight-2';
  return 'tag-weight-1';
}

export class TagCloud extends Component {
  render() {
    const { tags = [] } = this.props;
    if (!tags.length) return '';

    const items = tags.map((t) => {
      const cls = weightClass(t.weight ?? 0);
      return `
        <li>
          <a href="/tag/${escapeHtml(t.slug)}" class="tag-cloud-link ${cls}"
             title="${escapeHtml(t.name)} (${escapeHtml(String(t.post_count))} posts)">
            ${escapeHtml(t.name)}
            <span class="tag-cloud-count">${escapeHtml(String(t.post_count))}</span>
          </a>
        </li>`;
    }).join('');

    return `
      <aside class="tag-cloud-widget" aria-label="Tag cloud">
        <h2 class="widget-title">Tags</h2>
        <ul class="tag-cloud">${items}</ul>
      </aside>`;
  }
}
