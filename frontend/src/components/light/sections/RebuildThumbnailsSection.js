import { Component } from "../../Component.js";
import { store } from "../../../store.js";

export class RebuildThumbnailsSection extends Component {
  render() {
    return `
      <div class="section-block">
        <h3 class="section-subhead">Maintenance</h3>
        <button type="button" class="btn btn-secondary" id="rebuild-thumbnails-btn">Rebuild Thumbnails</button>
        <p class="form-hint" style="margin-top: 0.5rem;">Regenerate thumbnails for all images with the current dimensions (this will bust the Cloudflare cache because the filenames change to match the dimensions).</p>
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
          const form = document.getElementById("plugin-settings-form");
          if (form) {
            const wInput = form.querySelector('[name="thumbnail_width"]');
            const hInput = form.querySelector('[name="thumbnail_height"]');
            if (wInput && hInput) {
              const { updateSettings } = await import('../../../api/settings.js');
              await updateSettings({
                thumbnail_width: wInput.value,
                thumbnail_height: hInput.value
              });
            }
          }
          const { rebuildThumbnails } = await import('../../../api/media.js');
          const stats = await rebuildThumbnails(false);
          store.set("toast", { message: `Rebuilt thumbnails. Processed: ${stats.processed}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`, type: "success" });
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
