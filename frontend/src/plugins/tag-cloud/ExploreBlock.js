// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.12.
/**
 * ExploreBlock — homepage widget showing top tags as plain pills.
 * Replaces the weighted TagCloud.
 *
 * Props:
 *   tags  {Array<{ id, name, slug, count }>}
 */

import { Component } from "../../components/Component.js";
import { html } from "../../utils/helpers.js";
import { store } from "../../store.js";
import { buildTagIndex, parseTagUrl } from "../../utils/tagLinks.js";
import { setupTagFlyout } from "../../utils/tagFlyout.js";
import { ViewContext } from "../../utils/viewContext.js";

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
    const navTags = store.get("navTags") || [];
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
