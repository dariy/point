/**
 * VisualEditor — visual image-sequence editor for immersive posts.
 */

import { Component } from "../Component.js";
import { html } from "../../utils/helpers.js";
import { updateMedia, reextractMediaEXIF } from "../../api/media.js";
import { setToast } from "../../store.js";
import { setupTextareaMaximizer } from "../../utils/textareaMaximizer.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { thumbAttrs } from "../../utils/mediaUrl.js";
import { attachPointerReorder } from "../../utils/pointerReorder.js";
import {
  carouselFence,
  groupIntoCarousel,
  ungroupCarousel,
} from "../../utils/postNodes.js";

// .ve-thumb is a fixed 80x56 box (--ve-thumb-width/-height). data-full still
// points at the original: the card's lightbox (see _bindLightbox) opens the
// full image, not the rung the card painted.
const VE_THUMB_SIZES = "80px";

// What a click inside a card already means, so card selection never takes it:
// the thumbnail opens the lightbox, the path starts a rename, the handle owns
// the reorder gesture, and every control does what it says.
const VE_CARD_CONTROLS =
  "button, input, textarea, a, label, .ve-thumb, .ve-path, .ve-rename-form, .ve-exif-panel, .ve-handle";

/**
 * @typedef {object} VisualEditorProps
 * @property {import('../../utils/postNodes.js').EditorNode[]} [nodes]  The
 *   document, in order. Text edits are written into these nodes in place.
 * @property {Record<string, import('../../api/media.js').Media>} [mediaByPath]
 *   Media records keyed by path, for each image card's EXIF panel.
 * @property {(nodes: import('../../utils/postNodes.js').EditorNode[]) => void} [onChange]
 *   Called with the new list on any structural change.
 * @property {() => void} [onInput]  Called after an in-place text edit.
 * @property {(index: number) => void} [onAddMedia]  Open the picker to insert at `index`.
 * @property {((block: string) => void)|null} [onEditCarousel]  Open the carousel
 *   studio on one card's block, addressed by its key or — for a carousel typed
 *   by hand, whose fence has no key yet — by its 1-based position among the
 *   post's carousels. null hides the entry point.
 * @property {(oldPath: string, newFilename: string) => Promise<void>} [onRename]
 *   Inline rename of an image card's file.
 */

/** @extends {Component<VisualEditorProps>} */
export class VisualEditor extends Component {
  /**
   * The cards the selection bar acts on, held as the NODE OBJECTS themselves.
   *
   * Every structural change re-renders this component through setProps() with
   * a freshly built array, so an index-keyed selection would silently retarget
   * — grouping cards 2 and 3 leaves "2 and 3" pointing at whatever slid up into
   * those slots. The node ops build their result with map()/slice(), so an
   * untouched node keeps its identity across the change and a Set of nodes does
   * not. Entries whose node has left the list are dropped in
   * _syncSelectionUI(), which is also what makes the set safe to keep across
   * renders.
   *
   * @type {Set<import('../../utils/postNodes.js').EditorNode>}
   */
  _selected = new Set();

  /**
   * The node a shift-click measures its range from — the last card clicked
   * without shift. Null when there is none.
   * @type {import('../../utils/postNodes.js').EditorNode|null}
   */
  _anchor = null;

  render() {
    const { nodes = [] } = this.props;

    // How the studio is told which carousel a card's button opens: the node's
    // key, or its position among the post's carousels while it has none. The
    // count runs over the whole list, so it matches the fence order the studio
    // reads out of the saved content.
    let carouselCount = 0;

    const insertZone = (index) =>
      html`<div class="ve-insert-zone" data-insert-at="${index}">
         <div class="ve-insert-actions">
           <button class="ve-insert-btn ve-insert-text" type="button" title="Insert text node">+ Text</button>
           <button class="ve-insert-btn ve-insert-media" type="button" title="Insert media node">+ Media</button>
         </div>
       </div>`;

    const cards = nodes
      .map((node, i) => {
        if (node.type === "image") {
          const filename = node.path.split("/").pop();
          const mediaByPath = this.props.mediaByPath || {};
          const media = mediaByPath[node.path];
          const mediaId = media ? String(media.id) : "";

          const exifBtn = mediaId
            ? html`<button class="ve-exif-toggle btn btn-sm" data-media-id="${mediaId}" type="button" title="Edit EXIF">\u2139</button>`
            : "";
          const exifPanel = mediaId
            ? html`<div class="ve-exif-panel" data-media-id="${mediaId}" hidden>
               ${this._renderVeExifRows(media)}
               <div class="exif-actions">
                 <button class="btn btn-sm ve-exif-add-btn" type="button">+ Add field</button>
                 <button class="btn btn-sm ve-exif-save-btn" data-media-id="${mediaId}" type="button">Save EXIF</button>
                 <button class="btn btn-sm ve-exif-reextract-btn" data-media-id="${mediaId}" type="button">Re-extract</button>
               </div>
             </div>`
            : "";

          return html`
          ${insertZone(i)}
          <div class="ve-card" data-index="${i}">
            <button class="ve-handle" type="button"
                    aria-label="Move ${filename}"
                    title="Drag to reorder \u2014 or the arrow keys">
              <span class="ve-handle-dots" aria-hidden="true"></span>
            </button>
            <img class="ve-thumb" ${thumbAttrs(node.path, {
              sizes: VE_THUMB_SIZES,
              width: media?.width,
              height: media?.height,
            })}
                 alt="${filename}"
                 data-full="${node.path}"
                 loading="lazy" decoding="async">
            <div class="ve-card-row">
              <span class="ve-path">${node.path}</span>
              ${exifBtn}
              <button class="ve-remove" data-index="${i}" type="button"
                      aria-label="Remove image" title="Remove">&times;</button>
            </div>
            ${exifPanel}
          </div>`;
        } else if (node.type === "carousel") {
          // Read-only card. Editing slides is Carousel Studio's job, not the
          // editor's — but the card must show every path it holds so a Visual
          // mode round-trip (see serializeNodes) never silently drops one.
          const paths = node.paths || [];
          // Counted for every carousel, keyed ones included: the position has
          // to be the one the studio finds by scanning the post's fences.
          carouselCount += 1;
          const block = node.key || String(carouselCount);
          const mediaByPath = this.props.mediaByPath || {};
          const thumbs = paths
            .map((path, slideIdx) => {
              const media = mediaByPath[path];
              return html`
              <div class="ve-slide" data-index="${slideIdx}">
                <button class="ve-slide-handle" type="button"
                        aria-label="Move slide ${slideIdx + 1} of ${paths.length}"
                        title="Drag to reorder — or the arrow keys">
                  <span class="ve-handle-dots" aria-hidden="true"></span>
                </button>
                <img class="ve-thumb" ${thumbAttrs(path, {
                  sizes: VE_THUMB_SIZES,
                  width: media?.width,
                  height: media?.height,
                })}
                     alt="${path.split("/").pop()}"
                     data-full="${path}"
                     loading="lazy" decoding="async">
              </div>`;
            });
          return html`
          ${insertZone(i)}
          <div class="ve-card ve-card--carousel" data-index="${i}">
            <button class="ve-handle" type="button"
                    aria-label="Move carousel of ${paths.length} ${paths.length === 1 ? "slide" : "slides"}"
                    title="Drag to reorder \u2014 or the arrow keys">
              <span class="ve-handle-dots" aria-hidden="true"></span>
            </button>
            <div class="ve-carousel-body">
              <div class="ve-carousel-head">
                <span class="ve-carousel-label" aria-hidden="true">▦</span>
                <span class="ve-carousel-count">Carousel · ${paths.length} ${paths.length === 1 ? "slide" : "slides"}</span>
                <div class="ve-carousel-actions">
                  <button class="ve-carousel-ungroup btn btn-sm" type="button" data-index="${i}"
                          title="Split this carousel back into separate photos">Ungroup</button>
                  ${this.props.onEditCarousel
                    ? html`<button class="ve-carousel-edit btn btn-sm" type="button" data-block="${block}">Edit in Studio</button>`
                    : ""}
                </div>
              </div>
              <div class="ve-carousel-strip">${thumbs}</div>
            </div>
            <button class="ve-remove" data-index="${i}" type="button"
                    aria-label="Remove carousel block" title="Remove">&times;</button>
          </div>`;
        } else {
          return html`
          ${insertZone(i)}
          <div class="ve-card ve-card--text" data-index="${i}">
            <button class="ve-handle" type="button"
                    aria-label="Move text block"
                    title="Drag to reorder \u2014 or the arrow keys">
              <span class="ve-handle-dots" aria-hidden="true"></span>
            </button>
            <span class="ve-text-icon" aria-hidden="true">¶</span>
            <div class="ve-text-body">
              <input class="ve-block-class" type="text" placeholder="Block class (optional)"
                     value="${node.blockClass || ""}" aria-label="Block class">
              <textarea class="ve-text-area" placeholder="Add text\u2026" rows="1">${node.text || ""}</textarea>
            </div>
            <button class="ve-remove" data-index="${i}" type="button"
                    aria-label="Remove text block" title="Remove">&times;</button>
          </div>`;
        }
      });

    const empty =
      nodes.length === 0
        ? html`<p class="ve-empty">No content yet. Use the buttons to add text or media.</p>`
        : "";

    return html`
      <div class="ve-root">
        ${this._renderSelectionBar()}
        <div class="ve-list" id="ve-list">
          ${cards}
          ${insertZone(nodes.length)}
          ${empty}
        </div>
      </div>`;
  }

  afterRender() {
    this._bindSelection();
    this._bindUngroup();
    this._bindRemove();
    this._bindCarouselEdit();
    this._bindReorder();
    this._bindLightbox();
    this._bindInlineRename();
    this._bindInsertZones();
    this._bindTextCards();
    this._bindVeExif();
    setupTextareaMaximizer(this.container);
  }

  // ── Selection ──────────────────────────────────────────────────────────

  /**
   * The bar the selection acts from. Emitted on every pass and starting empty
   * and hidden: _syncSelectionUI() is the one owner of what it says, so there
   * is no second copy of that rule here to drift out of step with it.
   * @returns {import('../../utils/helpers.js').RawHtml}
   */
  _renderSelectionBar() {
    return html`
      <div class="ve-selection-bar" role="toolbar" aria-label="Selected cards" hidden>
        <span class="ve-selection-count" aria-live="polite"></span>
        <button class="ve-make-carousel btn btn-sm" type="button"
                title="Fold the selected photos into one carousel block">Make carousel</button>
        <button class="ve-selection-clear btn btn-sm" type="button">Clear</button>
      </div>`;
  }

  /**
   * Which cards a click may select: the ones that can become carousel slides.
   *
   * A text card is refused rather than selected-and-ignored. `groupIntoCarousel`
   * would leave it exactly where it is, so including one in a selection would
   * paint it as part of the group and then visibly not fold it in. Carousel
   * cards ARE selectable: grouping a photo with a carousel merges it into that
   * block, keeping the block's key and therefore its design document.
   *
   * @param {import('../../utils/postNodes.js').EditorNode} [node]
   * @returns {boolean}
   */
  _isSelectable(node) {
    return Boolean(node) && (node.type === "image" || node.type === "carousel");
  }

  /**
   * The selected nodes' positions in the current list, in document order, with
   * entries whose node has left the list pruned from the set as a side effect.
   *
   * One pass does both because they answer the same question: a node still in
   * `nodes` is live, and anything else in `_selected` is a card that a group,
   * an ungroup or a remove has already retired.
   *
   * @param {import('../../utils/postNodes.js').EditorNode[]} nodes
   * @returns {number[]}
   */
  _selectedIndices(nodes) {
    /** @type {Set<import('../../utils/postNodes.js').EditorNode>} */
    const live = new Set();
    const indices = [];
    (nodes || []).forEach((node, i) => {
      if (!this._selected.has(node)) return;
      live.add(node);
      indices.push(i);
    });
    this._selected = live;
    if (this._anchor && !live.has(this._anchor)) this._anchor = null;
    return indices;
  }

  /**
   * Whether "Make carousel" would change anything — the exact set
   * `groupIntoCarousel` refuses, restated as a predicate so the button is
   * absent rather than inert. Only selectable nodes can be in the selection, so
   * the one refusal left is a lone card that is already a carousel.
   *
   * @param {import('../../utils/postNodes.js').EditorNode[]} nodes
   * @param {number[]} indices
   * @returns {boolean}
   */
  _canGroup(nodes, indices) {
    if (!indices.length) return false;
    return !(indices.length === 1 && nodes[indices[0]].type === "carousel");
  }

  /**
   * Paint the selection onto the DOM the current render produced.
   *
   * The sole owner of `.is-selected` and of the bar's contents, called from
   * afterRender() as well as from the click handler — which is what carries a
   * selection across the setProps() re-render every structural change triggers,
   * without render() holding a second copy of the rule.
   */
  _syncSelectionUI() {
    const nodes = this.props.nodes || [];
    const indices = this._selectedIndices(nodes);
    const selected = new Set(indices);

    this.$$(".ve-card").forEach((card) => {
      const i = parseInt(card.dataset.index, 10);
      card.classList.toggle("is-selected", selected.has(i));
    });

    const bar = this.$(".ve-selection-bar");
    if (!bar) return;
    bar.hidden = indices.length === 0;
    const count = this.$(".ve-selection-count");
    if (count) {
      count.textContent = `${indices.length} selected`;
    }
    const make = this.$(".ve-make-carousel");
    if (make) make.hidden = !this._canGroup(nodes, indices);
  }

  /** Drop the whole selection and repaint. */
  _clearSelection() {
    if (!this._selected.size && !this._anchor) return;
    this._selected = new Set();
    this._anchor = null;
    this._syncSelectionUI();
  }

  /**
   * Add every selectable card between two positions, inclusive. A text card
   * caught in the middle of the range is stepped over rather than picked up.
   *
   * @param {import('../../utils/postNodes.js').EditorNode[]} nodes
   * @param {number} from
   * @param {number} to
   */
  _selectRange(nodes, from, to) {
    for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
      if (this._isSelectable(nodes[i])) this._selected.add(nodes[i]);
    }
  }

  /**
   * Take or drop one card, and leave the anchor on it. The anchor is cleared
   * along with the last selected card, so the next shift-click has nothing
   * stale to measure a range from.
   *
   * @param {import('../../utils/postNodes.js').EditorNode} node
   */
  _toggleOne(node) {
    if (this._selected.delete(node)) {
      this._anchor = this._selected.size ? node : null;
      return;
    }
    this._selected.add(node);
    this._anchor = node;
  }

  /**
   * Answer a click on a card: toggle it, or — with shift held and an anchor to
   * measure from — take the range between them.
   *
   * A plain click toggles rather than replaces: building a group of photos is
   * the whole point of the selection, and requiring a modifier to add the
   * second one would make the common case the awkward one.
   *
   * @param {number} index  Position of the clicked card.
   * @param {boolean} shift
   */
  _toggleSelection(index, shift) {
    const nodes = this.props.nodes || [];
    const node = nodes[index];
    if (!this._isSelectable(node)) return;

    const anchorIndex = this._anchor ? nodes.indexOf(this._anchor) : -1;
    if (shift && anchorIndex !== -1) this._selectRange(nodes, anchorIndex, index);
    else this._toggleOne(node);
    this._syncSelectionUI();
  }

  /**
   * The card a click on `target` selects: the card it landed in, unless it
   * landed on something that already answers a click.
   *
   * @param {EventTarget|null} target
   * @returns {HTMLElement|null}
   */
  _selectionTarget(target) {
    const el = /** @type {HTMLElement} */ (target);
    if (!el?.closest || el.closest(VE_CARD_CONTROLS)) return null;
    return /** @type {HTMLElement} */ (el.closest(".ve-card"));
  }

  _bindSelection() {
    const list = this.$("#ve-list");
    if (list) {
      // Shift-click also extends the browser's own text selection, which paints
      // a smear across the page behind the cards it just picked. Suppressing it
      // has to happen on mousedown — by click the range is already made. The
      // handle is one of VE_CARD_CONTROLS, so it is never a selection target and
      // its own press is left entirely to the reorder gesture.
      list.addEventListener("mousedown", (e) => {
        if (!(/** @type {MouseEvent} */ (e).shiftKey)) return;
        if (this._selectionTarget(e.target)) e.preventDefault();
      });

      list.addEventListener("click", (e) => {
        const el = /** @type {HTMLElement} */ (e.target);
        if (el.closest(VE_CARD_CONTROLS)) return;

        const card = this._selectionTarget(el);
        if (!card) {
          this._clearSelection();
          return;
        }
        this._toggleSelection(
          parseInt(card.dataset.index, 10),
          Boolean(/** @type {MouseEvent} */ (e).shiftKey),
        );
      });
    }

    this.$(".ve-make-carousel")?.addEventListener("click", () => this._makeCarousel());
    this.$(".ve-selection-clear")?.addEventListener("click", () => this._clearSelection());

    this._syncSelectionUI();
  }

  _bindUngroup() {
    this.$$(".ve-carousel-ungroup").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._ungroup(parseInt(btn.dataset.index, 10));
      });
    });
  }

  // ── Grouping ────────────────────────────────────────────────────

  /**
   * Announce a structural change and offer the way back.
   *
   * `before` is a snapshot of the list as it was, held in this closure rather
   * than pushed onto a history stack: the offer is scoped to one toast, and
   * Toast.js already spends the button on the first press, so there is no stack
   * to keep, invalidate, or apply twice.
   *
   * @param {string} message
   * @param {import('../../utils/postNodes.js').EditorNode[]} before
   */
  _changeToast(message, before) {
    setToast({
      message,
      type: "success",
      action: { label: "Undo", onAction: () => this._applyNodes(before) },
    });
  }

  /**
   * Hand a new list to the parent, with the selection dropped — the cards it
   * named are gone, or have become something else.
   * @param {import('../../utils/postNodes.js').EditorNode[]} nodes
   */
  _applyNodes(nodes) {
    this._selected = new Set();
    this._anchor = null;
    this.props.onChange?.(nodes);
  }

  /**
   * Fold the selection into one carousel, in place. A single photo is a legal
   * carousel of one slide — it renders as a swipe track of one, and a photo can
   * be dragged into it afterwards.
   */
  _makeCarousel() {
    const nodes = this.props.nodes || [];
    const indices = this._selectedIndices(nodes);
    if (!this._canGroup(nodes, indices)) return;

    const before = [...nodes];
    const next = groupIntoCarousel(nodes, indices);
    if (next === nodes) return;

    const slides = indices.reduce(
      (n, i) => n + (nodes[i].type === "carousel" ? (nodes[i].paths || []).length : 1),
      0,
    );
    this._applyNodes(next);
    this._changeToast(`Carousel created from ${slides} ${slides === 1 ? "photo" : "photos"}.`, before);
  }

  /**
   * Turn one carousel's slides back into image cards, in place and in order.
   * @param {number} index
   */
  _ungroup(index) {
    const nodes = this.props.nodes || [];
    const node = nodes[index];
    if (!node || node.type !== "carousel") return;

    const before = [...nodes];
    const next = ungroupCarousel(nodes, index);
    if (next === nodes) return;

    const slides = (node.paths || []).length;
    this._applyNodes(next);
    this._changeToast(`Carousel ungrouped into ${slides} ${slides === 1 ? "photo" : "photos"}.`, before);
  }

  _renderVeExifRows(media) {
    const metadata = (media && media.metadata) || {};
    const rows = Object.entries(metadata)
      .map(
        ([k, v]) =>
          html`<tr>
        <td><input class="exif-key" value="${String(k)}" placeholder="Field name" aria-label="EXIF field name"></td>
        <td><input class="exif-val" value="${String(v)}" placeholder="Value" aria-label="EXIF value"></td>
        <td><button class="exif-delete-btn" type="button" title="Remove">\u00d7</button></td>
      </tr>`,
      );
    return html`<table class="exif-table"><thead><tr><th>Field</th><th>Value</th><th></th></tr></thead><tbody class="exif-rows">${rows}</tbody></table>`;
  }

  _bindVeExif() {
    this.$$(".ve-exif-toggle").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const panel = /** @type {HTMLElement} */ (
          btn.closest(".ve-card").querySelector(".ve-exif-panel"));
        if (panel) panel.hidden = !panel.hidden;
      });
    });

    const bindDelete = (scope) => {
      scope.querySelectorAll(".exif-delete-btn").forEach((b) => {
        b.addEventListener("click", () => b.closest("tr").remove());
      });
    };
    bindDelete(this.container);

    this.$$(".ve-exif-add-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tbody = btn.closest(".ve-exif-panel").querySelector(".exif-rows");
        const tr = document.createElement("tr");
        ["Field name", "Value"].forEach((placeholder, colIdx) => {
          const td = document.createElement("td");
          const input = document.createElement("input");
          input.className = colIdx === 0 ? "exif-key" : "exif-val";
          input.placeholder = placeholder;
          input.setAttribute("aria-label", `EXIF ${placeholder.toLowerCase()}`);
          td.appendChild(input);
          tr.appendChild(td);
        });
        const tdDel = document.createElement("td");
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "exif-delete-btn";
        delBtn.title = "Remove";
        delBtn.textContent = "\u00d7";
        delBtn.addEventListener("click", () => tr.remove());
        tdDel.appendChild(delBtn);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
    });

    this.$$(".ve-exif-save-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = parseInt(btn.dataset.mediaId, 10);
        const panel = btn.closest(".ve-exif-panel");
        const metadata = {};
        panel.querySelectorAll(".exif-rows tr").forEach((tr) => {
          const key = /** @type {HTMLInputElement} */ (tr.querySelector(".exif-key"))?.value.trim();
          const val = /** @type {HTMLInputElement} */ (tr.querySelector(".exif-val"))?.value.trim();
          if (key) metadata[key] = val;
        });
        try {
          await updateMedia(id, { metadata });
          setToast({ message: "EXIF saved.", type: "success" });
        } catch (err) {
          setToast({
            message: err.message || "Save failed.",
            type: "error",
          });
        }
      });
    });

    this.$$(".ve-exif-reextract-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mountEl = document.createElement("div");
        document.body.appendChild(mountEl);
        const dialog = new ConfirmDialog(mountEl, {
          title: "Re-extract EXIF",
          message: "Re-extract will overwrite manual EXIF edits. Continue?",
          confirmText: "Re-extract",
          variant: "danger",
          onConfirm: async () => {
            dialog.unmount();
            mountEl.remove();
            const id = parseInt(btn.dataset.mediaId, 10);
            try {
              const updated = await reextractMediaEXIF(id);
              const metadata = updated.metadata || {};
              const panel = btn.closest(".ve-exif-panel");
              const tbody = panel.querySelector(".exif-rows");
              while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
              Object.entries(metadata).forEach(([k, v]) => {
                const tr = document.createElement("tr");
                ["exif-key", "exif-val"].forEach((cls, i) => {
                  const td = document.createElement("td");
                  const input = document.createElement("input");
                  input.className = cls;
                  input.value = String(i === 0 ? k : v);
                  input.placeholder = i === 0 ? "Field name" : "Value";
                  td.appendChild(input);
                  tr.appendChild(td);
                });
                const tdDel = document.createElement("td");
                const delBtn = document.createElement("button");
                delBtn.type = "button";
                delBtn.className = "exif-delete-btn";
                delBtn.title = "Remove";
                delBtn.textContent = "\u00d7";
                delBtn.addEventListener("click", () => tr.remove());
                tdDel.appendChild(delBtn);
                tr.appendChild(tdDel);
                tbody.appendChild(tr);
              });
              const msg = Object.keys(metadata).length
                ? "EXIF re-extracted."
                : "No EXIF data found in this file.";
              setToast({ message: msg, type: "success" });
            } catch (err) {
              setToast({
                message: err.message || "Re-extract failed.",
                type: "error",
              });
            }
          },
          onCancel: () => {
            dialog.unmount();
            mountEl.remove();
          },
        });
        dialog.mount();
      });
    });
  }

  /**
   * Read current node state from DOM (capturing live textarea values)
   * and serialize to the plain-text content format.
   * Called by PostEditPage at save time.
   * @returns {string}
   */
  serializeNodes() {
    const nodes = this.props.nodes || [];
    return nodes
      .map((node, i) => {
        if (node.type === "image") return node.path;
        if (node.type === "carousel") {
          // Read-only in the editor: emit the paths and the block key back
          // untouched. The fence is postNodes.js's to write — a second copy of
          // the blank-line contract here is a second thing to get wrong.
          return carouselFence(node.paths || [], node.key);
        }
        const card = this.container.querySelector(
          `.ve-card[data-index="${i}"]`,
        );
        const ta = /** @type {HTMLTextAreaElement} */ (card?.querySelector(".ve-text-area"));
        const blockClassInput = /** @type {HTMLInputElement} */ (card?.querySelector(".ve-block-class"));
        const text = ta ? ta.value : node.text || "";
        const blockClass = (
          blockClassInput ? blockClassInput.value : node.blockClass || ""
        ).trim();
        if (blockClass) {
          return `:::{.${blockClass}}\n${text}\n:::\n---`;
        }
        return text + "\n---";
      })
      .join("\n");
  }

  _bindInsertZones() {
    this.$$(".ve-insert-text").forEach((btn) => {
      btn.addEventListener("click", () => {
        const zone = /** @type {HTMLElement} */ (btn.closest(".ve-insert-zone"));
        if (!zone) return;
        const at = parseInt(zone.dataset.insertAt, 10);
        const next = [...this.props.nodes];
        next.splice(at, 0, { type: "text", text: "" });
        this.props.onChange(next);
        // After parent re-renders via setProps, focus the new textarea
        requestAnimationFrame(() => {
          const cards = this.$$(".ve-card");
          /** @type {HTMLElement} */ (cards[at]?.querySelector(".ve-text-area"))?.focus();
        });
      });
    });

    this.$$(".ve-insert-media").forEach((btn) => {
      btn.addEventListener("click", () => {
        const zone = /** @type {HTMLElement} */ (btn.closest(".ve-insert-zone"));
        if (!zone) return;
        const at = parseInt(zone.dataset.insertAt, 10);
        if (this.props.onAddMedia) {
          this.props.onAddMedia(at);
        }
      });
    });
  }

  _bindTextCards() {
    this.$$(".ve-text-area").forEach((/** @type {HTMLTextAreaElement} */ ta) => {
      const resize = () => {
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      };
      resize();
      ta.addEventListener("input", () => {
        resize();
        const card = /** @type {HTMLElement} */ (ta.closest(".ve-card"));
        if (card) {
          const idx = parseInt(card.dataset.index, 10);
          if (this.props.nodes[idx]) {
            this.props.nodes[idx].text = ta.value;
          }
        }
        if (this.props.onInput) {
          this.props.onInput();
        }
      });
    });

    this.$$(".ve-block-class").forEach((/** @type {HTMLInputElement} */ input) => {
      input.addEventListener("input", () => {
        const card = /** @type {HTMLElement} */ (input.closest(".ve-card"));
        if (card) {
          const idx = parseInt(card.dataset.index, 10);
          if (this.props.nodes[idx]) {
            this.props.nodes[idx].blockClass = input.value;
          }
        }
        if (this.props.onInput) this.props.onInput();
      });
    });
  }

  _bindRemove() {
    this.$$(".ve-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(/** @type {HTMLElement} */ (e.currentTarget).dataset.index, 10);
        const next = [...this.props.nodes];
        next.splice(idx, 1);
        this.props.onChange(next);
      });
    });
  }

  _bindCarouselEdit() {
    if (!this.props.onEditCarousel) return;
    this.$$(".ve-carousel-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.props.onEditCarousel(btn.dataset.block || "");
      });
    });
  }

  // ── Reordering ─────────────────────────────────────────────────────────

  /**
   * Reordering, by pointer and by keyboard, over one commit.
   *
   * Pointer events rather than HTML5 drag-and-drop: DnD does not exist on iOS
   * Safari, so for the life of this component the handle was mouse-only. The
   * util owns the gesture — press, a line showing where the item would land,
   * release — and hands back the item the line came to rest behind; deciding
   * what that means for the model is this component's job, split across
   * _onReorderDrop() (which container, which model) and _moveNode()/
   * _moveSlide() (the index arithmetic) — the half a test can reach without a
   * layout engine.
   */
  _bindReorder() {
    const list = this.$("#ve-list");
    if (!list) return;

    // One gesture, two kinds of container: the top-level list (vertical) and
    // every carousel card's strip (horizontal). Strips are listed before the
    // list itself — attachPointerReorder's containers() is first-match-wins,
    // and a strip's rect sits inside the list's, so the list would otherwise
    // always win. Cards and slides share the gesture but not a model: onDrop
    // below routes each to its own mutation and refuses a drop that would
    // cross from one container kind to the other, since neither a slide
    // leaving its strip nor a card entering one is supported yet.
    //
    // afterRender() runs again on every render and the attachment is a set of
    // document-level listeners, so it has to be released with the render that
    // took it — otherwise every setState() leaves another live gesture behind.
    this.registerCleanup(
      attachPointerReorder({
        handleSelector: ".ve-handle, .ve-slide-handle",
        itemSelector: ".ve-card, .ve-slide",
        containers: () => [...this.$$(".ve-carousel-strip"), list],
        axis: (container) => (container.classList.contains("ve-carousel-strip") ? "x" : "y"),
        onDrop: (drop) => this._onReorderDrop(drop),
      }),
    );

    // Keyboard equivalent: the handle is a button, so the arrows are free.
    // Without it reordering would be a pointer-only feature, which is the same
    // hole in a different shape. A step with nowhere to go leaves the key to
    // the page, which is still free to scroll on it.
    this.on(list, "keydown", (e) => {
      const key = /** @type {KeyboardEvent} */ (e).key;
      const target = /** @type {HTMLElement} */ (e.target);

      const slideHandle = target.closest?.(".ve-slide-handle");
      if (slideHandle) {
        if (key !== "ArrowLeft" && key !== "ArrowRight") return;
        if (this._stepSlide(slideHandle.closest(".ve-slide"), key === "ArrowLeft" ? -1 : 1)) {
          e.preventDefault();
        }
        return;
      }

      if (key !== "ArrowUp" && key !== "ArrowDown") return;
      const handle = target.closest?.(".ve-handle");
      if (!handle) return;
      if (this._stepCard(handle.closest(".ve-card"), key === "ArrowUp" ? -1 : 1)) {
        e.preventDefault();
      }
    });
  }

  /**
   * What a drop means, once the util has reduced the gesture to an item, the
   * container it started and ended in, and the item it landed behind. Split
   * out of _bindReorder() so a test can reach it directly, the same way
   * _moveNode() is the half of card reordering a test can reach without a
   * layout engine — linkedom reports a zero rect for everything, so nothing
   * upstream of this point (the midpoint test, the drop line) is assertable.
   *
   * @param {{item: Element, from: Element, to: Element, afterEl: Element|null}} drop
   */
  _onReorderDrop({ item, from, to, afterEl }) {
    if (item.matches(".ve-slide")) {
      if (to !== from) return; // a slide cannot yet leave its strip
      const nodeIdx = this._cardIndex(item.closest(".ve-card--carousel"));
      this._moveSlide(nodeIdx, this._cardIndex(item), this._cardIndex(afterEl));
      return;
    }
    if (to !== from) return; // a card cannot yet enter a strip
    this._moveNode(this._cardIndex(item), this._cardIndex(afterEl));
  }

  /**
   * Move one card a single place in `dir` (-1 up, +1 down) and keep the
   * keyboard on it: the list is rebuilt around the move, so the handle that had
   * focus is a dead node and the next press would land on nothing.
   *
   * @param {Element|null} card
   * @param {-1|1} dir
   * @returns {boolean} false when there is nowhere to go, so the caller can
   *   leave the key alone.
   */
  _stepCard(card, dir) {
    const from = this._cardIndex(card);
    if (from === null) return false;
    const to = from + dir;
    if (to < 0 || to >= (this.props.nodes || []).length) return false;
    // Landing behind the card being stepped over — which, going up, is the one
    // before that, or the front of the list when there is none.
    this._moveNode(from, dir < 0 ? (to > 0 ? to - 1 : null) : to);
    /** @type {HTMLElement|null} */ (
      this.$$(".ve-card")[to]?.querySelector(".ve-handle")
    )?.focus();
    return true;
  }

  /**
   * Move one slide a single place in `dir` (-1 left, +1 right) within its own
   * strip — the strip's counterpart to _stepCard().
   *
   * @param {Element|null} slide
   * @param {-1|1} dir
   * @returns {boolean} false when there is nowhere to go.
   */
  _stepSlide(slide, dir) {
    const card = /** @type {HTMLElement|null} */ (slide)?.closest(".ve-card--carousel");
    const nodeIdx = this._cardIndex(card);
    const node = nodeIdx === null ? null : (this.props.nodes || [])[nodeIdx];
    if (!node) return false;

    const from = this._cardIndex(slide);
    if (from === null) return false;
    const to = from + dir;
    if (to < 0 || to >= (node.paths || []).length) return false;

    this._moveSlide(nodeIdx, from, dir < 0 ? (to > 0 ? to - 1 : null) : to);
    const newCard = this.$$(".ve-card")[nodeIdx];
    /** @type {HTMLElement|null} */ (
      newCard?.querySelectorAll(".ve-slide")[to]?.querySelector(".ve-slide-handle")
    )?.focus();
    return true;
  }

  /**
   * The node index a card element stands for; null for anything that is not a
   * card — including the null the drop line hands back when it came to rest at
   * the very front of the list. The same lookup answers for a slide within a
   * strip, since both read the same `data-index` convention.
   * @param {Element|null} el
   * @returns {number|null}
   */
  _cardIndex(el) {
    const raw = /** @type {HTMLElement|null} */ (el)?.dataset?.index;
    if (raw === undefined) return null;
    const i = Number(raw);
    return Number.isInteger(i) ? i : null;
  }

  /**
   * Move the node at `fromIdx` so it sits directly after `afterIdx` — or at the
   * front of the list, when that is null.
   *
   * Indices rather than elements, because both the gesture and the arrow keys
   * reduce to this pair: the geometry stays in the util, and what is left here
   * is arithmetic a test can assert. `afterIdx` names a position in the list AS
   * IT IS NOW, so once the moved node is spliced out everything behind it has
   * slid down one — that is the ±1.
   *
   * @param {number|null} fromIdx   The node to move.
   * @param {number|null} afterIdx  The node it should land behind, or null for first.
   */
  _moveNode(fromIdx, afterIdx) {
    const nodes = this.props.nodes || [];
    if (fromIdx === null || fromIdx < 0 || fromIdx >= nodes.length) return;
    // Released over itself: the drop line can come to rest directly behind the
    // card being dragged, which names that card as its own anchor.
    if (afterIdx === fromIdx) return;

    const insertAt = afterIdx === null ? 0 : afterIdx > fromIdx ? afterIdx : afterIdx + 1;
    // Dropped back where it started. Bailing here rather than handing back an
    // identical list keeps a nudge that changes nothing out of the autosave.
    if (insertAt === fromIdx) return;

    const next = [...nodes];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(insertAt, 0, moved);
    this.props.onChange?.(next);
  }

  /**
   * Move one carousel's slide so it sits directly after `afterIdx` — the
   * strip's counterpart to _moveNode(), operating on one node's `paths`
   * instead of the top-level list. Same ±1 arithmetic, same bails: an
   * out-of-range `fromIdx`, a drop on the slide's own anchor, and a drop that
   * changes nothing.
   *
   * @param {number|null} nodeIdx   The carousel node's index in `nodes`.
   * @param {number|null} fromIdx   The slide's index in `node.paths`.
   * @param {number|null} afterIdx  The slide it should land behind, or null for first.
   */
  _moveSlide(nodeIdx, fromIdx, afterIdx) {
    const node = nodeIdx === null ? null : (this.props.nodes || [])[nodeIdx];
    if (!node || node.type !== "carousel") return;

    const paths = node.paths || [];
    if (fromIdx === null || fromIdx < 0 || fromIdx >= paths.length) return;
    if (afterIdx === fromIdx) return;

    const insertAt = afterIdx === null ? 0 : afterIdx > fromIdx ? afterIdx : afterIdx + 1;
    if (insertAt === fromIdx) return;

    const nextPaths = [...paths];
    const [moved] = nextPaths.splice(fromIdx, 1);
    nextPaths.splice(insertAt, 0, moved);

    const nodes = this.props.nodes || [];
    const nextNodes = nodes.map((n, i) => (i === nodeIdx ? { ...n, paths: nextPaths } : n));
    this.props.onChange?.(nextNodes);
  }

  _bindInlineRename() {
    this.$$(".ve-path").forEach((span) => {
      span.addEventListener("click", () => {
        const card = /** @type {HTMLElement} */ (span.closest(".ve-card"));
        if (!card) return;
        const idx = parseInt(card.dataset.index, 10);
        const node = this.props.nodes[idx];
        if (!node || node.type !== "image") return;
        this._startRename(span, node.path);
      });
    });
  }

  _startRename(span, path) {
    const lastSlash = path.lastIndexOf("/");
    const prefix = path.slice(0, lastSlash + 1); // e.g. "/2026/02/"
    const fullName = path.slice(lastSlash + 1); // e.g. "photo.jpg"
    const lastDot = fullName.lastIndexOf(".");
    const base = lastDot !== -1 ? fullName.slice(0, lastDot) : fullName;
    const ext = lastDot !== -1 ? fullName.slice(lastDot) : "";

    const form = document.createElement("span");
    form.className = "ve-rename-form";

    const prefixEl = document.createElement("span");
    prefixEl.className = "ve-rename-prefix";
    prefixEl.textContent = prefix;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "ve-rename-input";
    input.value = base;

    const extEl = document.createElement("span");
    extEl.className = "ve-rename-ext";
    extEl.textContent = ext;

    form.appendChild(prefixEl);
    form.appendChild(input);
    form.appendChild(extEl);

    span.replaceWith(form);
    input.focus();
    // Optional: linkedom's input has focus() but no select(), and the rename is
    // reachable from a test only if starting one does not throw there.
    input.select?.();

    const cancel = () => {
      if (document.body.contains(form)) form.replaceWith(span);
    };

    let submitting = false;

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Sanitise: keep only letters, digits, hyphens, underscores and spaces.
        const newBase = input.value.trim().replace(/[^a-zA-Z0-9\-_ ]/g, "");
        if (!newBase || newBase === base) {
          cancel();
          return;
        }
        const promise = this.props.onRename?.(path, newBase + ext);
        if (!promise) {
          cancel();
          return;
        }
        submitting = true;
        input.disabled = true;
        promise.catch(() => {
          submitting = false;
          input.disabled = false;
          input.focus();
        });
      }
    });

    input.addEventListener("blur", () => {
      if (submitting) return;
      setTimeout(() => {
        if (!submitting && document.body.contains(form)) cancel();
      }, 150);
    });
  }

  _bindLightbox() {
    this.$$(".ve-thumb").forEach((img) => {
      img.addEventListener("click", () => {
        const full = img.dataset.full;
        if (!full) return;

        const overlay = document.createElement("div");
        overlay.className = "ve-lightbox";

        const fullImg = document.createElement("img");
        fullImg.src = full;
        fullImg.alt = "";
        overlay.appendChild(fullImg);
        document.body.appendChild(overlay);

        const close = () => {
          overlay.remove();
          document.removeEventListener("keydown", onKey);
        };
        overlay.addEventListener("click", close);
        const onKey = (e) => {
          if (e.key === "Escape") close();
        };
        document.addEventListener("keydown", onKey);
      });
    });
  }
}
