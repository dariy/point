/**
 * ExploreBlock — homepage widget showing top tags as plain pills.
 * Replaces the weighted TagCloud.
 *
 * Props:
 *   tags  {Array<{ id, name, slug, count }>}
 */

import { Component } from "../Component.js";
import { escapeHtml } from "../../utils/helpers.js";
import { store } from "../../store.js";
import { buildTagIndex, setupTagFlyout } from "../../utils/tags.js";
import { ViewContext } from "../../utils/viewContext.js";

export class ExploreBlock extends Component {
  render() {
    const { tags = [] } = this.props;
    if (!tags.length) return "";

    const items = tags
      .slice(0, 20) // Limit to top 20
      .map(
        (t) => `
        <a href="/tags/${escapeHtml(t.slug)}" class="tag-link"
           title="${escapeHtml(t.name)} (${escapeHtml(String(t.count))} posts)">
          ${escapeHtml(t.name)}
          <span class="count">${escapeHtml(String(t.count))}</span>
        </a>`,
      )
      .join("");

    return `
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
      const slug = url.replace('/tags/', '');
      ViewContext.update({ tag: slug, postSlug: null, query: null });
    });
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
  }
}
