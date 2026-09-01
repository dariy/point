// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.11.
import { Component } from "../../Component.js";
import { store } from "../../../store.js";
import { html } from "../../../utils/helpers.js";

export class RebuildThumbnailsSection extends Component {
  render() {
    return html`
      <div class="section-block">
        <h3 class="section-subhead">Maintenance</h3>
        <button type="button" class="btn btn-secondary" id="rebuild-thumbnails-btn">Rebuild Thumbnails</button>
        <p class="form-hint" style="margin-top: 0.5rem;">Discard every generated thumbnail and build the ladder again in the background. Each image gets a fresh URL, so browsers and any cache in front of the site pick up the new files on their own.</p>
      </div>`;
  }

  afterRender() {
    const rebuildBtn = this.$("#rebuild-thumbnails-btn");
    if (rebuildBtn) {
      rebuildBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const btn = e.target;
        btn.disabled = true;
        const ogText = btn.textContent;
        btn.textContent = "Rebuilding…";
        try {
          const { rebuildThumbnails } = await import('../../../api/media.js');
          const res = await rebuildThumbnails();
          store.set("toast", { message: res.message || "Thumbnails rebuilt.", type: "success" });
        } catch (err) {
          console.error("[RebuildThumbnailsSection] rebuild error:", err);
          store.set("toast", { message: err.message || "Failed to rebuild thumbnails.", type: "error" });
        } finally {
          btn.disabled = false;
          btn.textContent = ogText;
        }
      });
    }
  }
}
