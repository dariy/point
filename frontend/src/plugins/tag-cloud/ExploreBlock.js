/**
 * ExploreBlock — homepage widget showing top tags as plain pills.
 * Replaces the weighted TagCloud.
 */

import { Component } from "../../components/Component.js";
import { html } from "../../utils/helpers.js";
import { getNavTags } from "../../store.js";
import { buildTagIndex, parseTagUrl } from "../../utils/tagLinks.js";
import { setupTagFlyout } from "../../utils/tagFlyout.js";
import { ViewContext } from "../../utils/viewContext.js";

/**
 * @typedef {object} ExploreBlockProps
 * @property {import('../../api/pages.js').TagCloudItem[]} [tags]
 */

/** @extends {Component<ExploreBlockProps>} */
export class ExploreBlock extends Component {
  render() {
    const { tags = [] } = this.props;
    if (!tags.length) return html``;

    const items = tags
      .slice(0, 20) // Limit to top 20
      .map(
        (t) => html`
        <a href="/tags/${t.slug}" class="tag-link"
           title="${t.name} (${String(t.count)} posts)">
          ${t.name}
          <span class="count">${String(t.count)}</span>
        </a>`,
      );

    return html`
      <section class="explore-block" aria-labelledby="explore-title">
        <div class="explore-header">
          <h2 id="explore-title" class="explore-title">Explore</h2>
          <a href="/tags" class="all-tags-link">All tags &rarr;</a>
        </div>
        <nav class="explore-tags" aria-label="Top tags">
          ${items}
        </nav>
      </section>`;
  }

  afterRender() {
    this._cleanupFlyout?.();
    const container = this.$(".explore-tags");
    if (!container) return;
    const navTags = getNavTags() || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupFlyout = setupTagFlyout(container, tagIndex, (url) => {
      const { tag, navPath } = parseTagUrl(url);
      ViewContext.update({ tag, navPath, postSlug: null, query: null });
    });
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
  }
}
