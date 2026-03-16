/**
 * Tag cloud sidebar widget for the homepage.
 *
 * Props:
 *   tags  {Array<{ id, name, slug, post_count, weight }>}
 *         weight is 0–1; higher = larger font size in cloud
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';


export class TagCloud extends Component {
  render() {
    const { tags = [] } = this.props;
    if (!tags.length) return '';

    const items = tags.map((t) => `
        <li>
          <a href="/tag/${escapeHtml(t.slug)}" class="tag-link"
             title="${escapeHtml(t.name)} (${escapeHtml(String(t.count))} posts)">
            ${escapeHtml(t.name)}
            <span class="count">${escapeHtml(String(t.count))}</span>
          </a>
        </li>`).join('');

    return `
      <nav class="tag-cloud-strip" aria-label="Tag cloud">
        <ul class="tag-cloud">${items}</ul>
      </nav>`;
  }
}
