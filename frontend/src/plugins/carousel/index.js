/**
 * Carousel Studio — the admin slide-builder shell.
 *
 * Route: /light/carousel?post=<id>. The path carries no `:id` because plugin
 * admin routes are merged verbatim from the manifest and filtered on the
 * `/light` prefix, and the page title is derived from the last path segment
 * (frontend/src/app.js) — a `:postId` segment would title the page ":postId".
 * The target post arrives as a query param instead.
 *
 * This is the skeleton: it renders the studio chrome and resolves the target
 * post. Geometry, the document model and the slice / frame / layer tools land
 * in later beads — see docs/features/carousel-studio.md.
 */

import { Component } from "../../components/Component.js";
import {
  adminLayoutTemplate,
  setupAdminLayout,
} from "../../components/light/AdminLayout.js";
import { html } from "../../utils/helpers.js";

/** The post id from `?post=`, or null when absent/malformed. */
function readPostId(query) {
  const raw = /** @type {{ post?: string }} */ (query || {}).post;
  return raw != null && /^[0-9]+$/.test(String(raw)) ? Number(raw) : null;
}

export default class CarouselStudioPage extends Component {
  /**
   * @param {HTMLElement} container
   * @param {object} [props]
   */
  constructor(container, props = {}) {
    super(container, props);
    this.state = { postId: readPostId(this.props.query) };
  }

  render() {
    const { postId } = this.state;
    const content = postId
      ? html`
          <section class="carousel-studio" data-post-id="${String(postId)}">
            <p class="carousel-studio__lead">
              Building slides for
              <a href="/light/posts/${String(postId)}/edit">this post</a>.
              The canvas tools are on their way.
            </p>
            <div class="carousel-studio__stage" aria-hidden="true"></div>
          </section>`
      : html`
          <section class="carousel-studio carousel-studio--empty">
            <p class="empty-state">
              Open the studio from a post's editor menu — it needs a post to
              build slides for.
            </p>
          </section>`;

    return adminLayoutTemplate({
      title: "Carousel Studio",
      content,
    });
  }

  afterRender() {
    setupAdminLayout(this, { currentPath: "/light/carousel" });
  }
}
