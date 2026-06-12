import { Component } from "../Component.js";
import { getTimeline, getTimelineLocations } from "../../api/timeline.js";
import { GestureController } from "../../utils/gestures.js";
import { renderTagLink } from "../../utils/tags.js";
import { escapeHtml } from "../../utils/helpers.js";

const EDGE_PAD = 48;

/**
 * Timeline component — horizontal date-tag navigation control.
 *
 * Props:
 *   context        {string}   Optional context tag slug
 *   mode           {string}   'popover' (default) or 'filter'
 *   onRangeChange  {function} Callback for filter mode {from, to, source}
 */
export class Timeline extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      pills: [],
      extent: { min: 0, max: 0 },
      zoom: 1,
      panX: 0,
      popover: null,
      isLoading: true,
    };
    this._lastLiveEmit = 0;
  }

  /**
   * Overridden mount to handle async data fetching.
   */
  mount() {
    this._fetchData();
  }

  async _fetchData() {
    try {
      const payload = await getTimeline({ context: this.props.context });
      if (this._unmounted) return;

      if (!payload || !payload.pills || payload.pills.length === 0) {
        this.unmount();
        return;
      }

      this.setState({
        pills: payload.pills,
        extent: payload.extent,
        isLoading: false,
      });

      if (this._unmounted) return;
      const { initialRange, initialYear } = this.props;
      if (initialRange) {
        const { from, to } = initialRange;
        if (from === payload.extent.min && to === payload.extent.max) {
          this._initCollapsed();
        } else {
          this._centerOnYear((from + to) / 2);
          if (this.props.mode === "filter") this._emitRange();
        }
      } else if (initialYear) {
        const year = parseInt(initialYear, 10);
        const pill = payload.pills.find((p) => p.year === year);
        if (pill) {
          this._centerOnYear(pill.year);
          if (this.props.mode === "filter") this._emitRange();
        }
      } else {
        this._initCollapsed();
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error("Timeline fetch failed:", err);
      }
      if (!this._unmounted) {
        this.unmount();
      }
    }
  }

  render() {
    if (this.state.isLoading || this.state.pills.length === 0) {
      return "";
    }

    return `
      <div class="timeline-container" role="region" aria-label="Date timeline">
        <div id="range-chip-mount" class="timeline-range-chip-mount"></div>
        <div class="timeline-track-wrapper">
          <div class="timeline-track">
            <div class="timeline-axis">
              <div id="histogram-mount" class="timeline-histogram"></div>
              <div class="timeline-axis-ticks"></div>
            </div>
            <div class="timeline-center-indicator"></div>
            <div class="timeline-pills-mount"></div>
          </div>
          <button class="timeline-nav-btn prev" aria-label="Scroll left">‹</button>
          <button class="timeline-nav-btn next" aria-label="Scroll right">›</button>
        </div>
      </div>
    `;
  }

  afterRender() {
    if (this.state.isLoading || this.state.pills.length === 0) {
      return;
    }

    this._resizeObserver = new ResizeObserver(() => this._layout());
    this._resizeObserver.observe(this.container);

    this._wireGestures();

    // Initial layout
    this._layout();
  }

  beforeUnmount() {
    this._resizeObserver?.disconnect();
    this._abortController?.abort();
    this._gestureController?.destroy?.();
    this._closePopover();
    clearTimeout(this._emitTimer);
    this._cancelAnimation();
    if (this._onMouseMove)
      window.removeEventListener("mousemove", this._onMouseMove);
    if (this._onMouseUp) window.removeEventListener("mouseup", this._onMouseUp);
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  _wireGestures() {
    const trackWrapper = this.$(".timeline-track-wrapper");
    if (!trackWrapper) return;

    let touchDragged = false;

    this._gestureController = new GestureController(trackWrapper, {
      onPanMove: (dx, _dy) => {
        touchDragged = true;
        this._isDragging = true;
        this._onPan(dx);
      },
      onPinchMove: (scale, cx) => this._onZoom(scale, cx),
      onTap: (x, y) => this._onTap(x, y),
      onSwipeMove: (dx, dy) => {
        touchDragged = true;
        this._isDragging = true;
        const dxDelta = dx - (this._swipeDxBase || 0);
        this._swipeDxBase = dx;
        this._swipeDyBase = dy;
        this._onPan(dxDelta);
      },
      onSwipeCancel: () => {
        this._swipeDxBase = 0;
        this._swipeDyBase = 0;
        if (touchDragged) {
          this._ignoreNextClick = true;
          setTimeout(() => {
            this._ignoreNextClick = false;
          }, 500);
        }
        const wasDragging = touchDragged;
        touchDragged = false;
        this._isDragging = false;
        if (wasDragging) {
          clearTimeout(this._emitTimer);
          this._snapToCenterPill(() => {
            if (this.props.mode === "filter") this._emitRange();
          });
        }
      },
      onSwipeCommit: () => {
        this._swipeDxBase = 0;
        this._swipeDyBase = 0;
        this._ignoreNextClick = true;
        setTimeout(() => {
          this._ignoreNextClick = false;
        }, 500);
        touchDragged = false;
        this._isDragging = false;
        clearTimeout(this._emitTimer);
        this._snapToCenterPill(() => {
          if (this.props.mode === "filter") this._emitRange();
        });
      },
    });

    let wheelHintTimeout = null;

    trackWrapper.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd + wheel = zoom
          e.preventDefault();
          const delta = e.deltaY > 0 ? 1.1 : 1 / 1.1;
          const rect = trackWrapper.getBoundingClientRect();
          this._onZoom(delta, e.clientX - rect.left);
          return;
        }

        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          // Shift + wheel or horizontal trackpad scroll = pan
          e.preventDefault();
          const panAmount = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
          this._onPan(-panAmount);
          return;
        }

        // Plain vertical wheel passes through to scroll the page. Show hint.
        if (Math.abs(e.deltaY) > 5) {
          if (!this._zoomHint) {
            this._zoomHint = document.createElement("div");
            this._zoomHint.className = "timeline-zoom-hint";
            this._zoomHint.textContent = "Use ⌘/Ctrl + scroll to zoom";
            this.container.appendChild(this._zoomHint);
          }
          this._zoomHint.classList.add("visible");
          
          clearTimeout(wheelHintTimeout);
          wheelHintTimeout = setTimeout(() => {
            this._zoomHint.classList.remove("visible");
          }, 1500);
        }
      },
      { passive: false },
    );

    // Mouse drag support
    let isDragging = false;
    let hasDragged = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastX = 0;

    trackWrapper.addEventListener(
      "mousedown",
      (e) => {
        if (e.target.closest(".timeline-nav-btn")) return;
        isDragging = true;
        this._isDragging = true;
        hasDragged = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        lastX = e.clientX;
        trackWrapper.classList.add("grabbing");
      },
      true,
    );

    this._onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      if (
        Math.abs(e.clientX - dragStartX) > 4 ||
        Math.abs(e.clientY - dragStartY) > 4
      ) {
        hasDragged = true;
      }
      lastX = e.clientX;
      this._onPan(dx);
    };

    this._onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      this._isDragging = false;
      trackWrapper.classList.remove("grabbing");
      if (hasDragged) {
        clearTimeout(this._emitTimer);
        this._snapToCenterPill(() => {
          if (this.props.mode === "filter") this._emitRange();
        });
      }
    };

    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);

    trackWrapper.addEventListener("click", (e) => {
      if (this._ignoreNextClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (hasDragged) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const cluster = e.target.closest(".timeline-cluster");
      if (cluster) {
        this._expandCluster(cluster);
        return;
      }
      const pill = e.target.closest(".timeline-pill-group");
      if (pill) {
        this._onPillClick(pill);
      }
    });

    this.$(".timeline-nav-btn.prev")?.addEventListener("click", () => {
      const track = this.$(".timeline-track");
      this._onPan(track.clientWidth * 0.5);
    });
    this.$(".timeline-nav-btn.next")?.addEventListener("click", () => {
      const track = this.$(".timeline-track");
      this._onPan(-track.clientWidth * 0.5);
    });

    trackWrapper.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this._closePopover();
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const focusable = Array.from(
          this.$$(".timeline-pill-btn, .timeline-cluster-btn"),
        );
        const idx = focusable.indexOf(document.activeElement);
        if (idx !== -1) {
          e.preventDefault();
          const nextIdx = e.key === "ArrowRight" ? idx + 1 : idx - 1;
          if (nextIdx >= 0 && nextIdx < focusable.length) {
            focusable[nextIdx].focus();
            this._ensureVisible(focusable[nextIdx]);
          }
        }
      }
    });
  }

  _ensureVisible(el) {
    const trackWrapper = this.$(".timeline-track-wrapper");
    const rect = el.getBoundingClientRect();
    const trackRect = trackWrapper.getBoundingClientRect();

    if (rect.left < trackRect.left + 40) {
      this._onPan(trackRect.left - rect.left + 60);
    } else if (rect.right > trackRect.right - 40) {
      this._onPan(trackRect.right - rect.right - 60);
    }
  }

  _onTap(x, y) {
    this._ignoreNextClick = true;
    setTimeout(() => (this._ignoreNextClick = false), 500);

    const target = document.elementFromPoint(x, y);
    const cluster = target?.closest(".timeline-cluster");
    if (cluster) {
      this._expandCluster(cluster);
      return;
    }
    const pill = target?.closest(".timeline-pill-group");
    if (pill) {
      this._onPillClick(pill);
      return;
    }
  }

  _expandCluster(el) {
    const minYear = parseInt(el.dataset.min, 10);
    const maxYear = parseInt(el.dataset.max, 10);

    if (this.props.mode === "filter") {
      this._centerOnYear((minYear + maxYear) / 2, true, () => {
        this.props.onRangeChange?.({
          from: minYear,
          to: maxYear,
          source: "center",
        });
      });
      return;
    }

    const clusterPills = this.state.pills.filter(
      (p) => p.year >= minYear && p.year <= maxYear,
    );
    if (clusterPills.length <= 4) {
      this._openClusterPopover(el, clusterPills);
    } else {
      this._zoomToFit(minYear, maxYear, true);
    }
  }

  _zoomToFit(minYear, maxYear, animate = false, onComplete = null) {
    const { extent } = this.state;
    const track = this.$(".timeline-track");
    if (!track) {
      if (onComplete) onComplete();
      return;
    }
    const trackWidth = track.clientWidth;

    const usableWidth = trackWidth - 2 * EDGE_PAD;
    const yearSpan = maxYear - minYear || 1;
    const extentSpan = extent.max - extent.min || 1;
    const targetZoom = (0.6 * extentSpan) / yearSpan;

    const midYear = (minYear + maxYear) / 2;
    const progress = (midYear - extent.min) / extentSpan;
    const targetPanX =
      trackWidth / 2 - EDGE_PAD - progress * usableWidth * targetZoom;

    const clampedZoom = Math.max(0.001, targetZoom);
    const maxPanX = trackWidth / 2 - EDGE_PAD;
    const minPanX = maxPanX - usableWidth * clampedZoom;
    const clampedPanX = Math.min(maxPanX, Math.max(minPanX, targetPanX));

    if (animate) {
      this._animateTo(clampedPanX, clampedZoom, 320, onComplete);
    } else {
      this.state.zoom = clampedZoom;
      this.state.panX = clampedPanX;
      this._layout();
      if (onComplete) onComplete();
    }

    this._debounceEmitRange();
  }

  _onPillClick(el) {
    const slug = el.dataset.slug;
    const pill = this.state.pills.find((p) => p.slug === slug);
    if (!pill) return;

    if (this.props.mode === "filter") {
      this._centerOnYear(pill.year, true, () => {
        const from = pill.year;
        const to = pill.is_decade ? from + 9 : from;
        this.props.onRangeChange?.({ from, to, source: "center" });
      });
    } else {
      this._openPopover(el, pill);
    }
  }

  async _openPopover(el, pill) {
    this._closePopover();

    const popoverEl = document.createElement("div");
    popoverEl.className = "timeline-popover loading";
    popoverEl.innerHTML = '<div class="timeline-popover-spinner"></div>';
    document.body.appendChild(popoverEl);
    this.state.popover = popoverEl;

    this._anchorPopover(el, popoverEl);

    try {
      const locations = await getTimelineLocations({
        tag: pill.slug,
        context: this.props.context,
        limit: 10,
      });

      if (this._unmounted || this.state.popover !== popoverEl) return;

      popoverEl.classList.remove("loading");

      const yearItem = `
        <li class="timeline-popover-year">
          ${renderTagLink(pill)}
          <span class="count">${pill.post_count}</span>
        </li>
      `;

      if (locations.length === 0) {
        popoverEl.innerHTML = `
          <ul class="timeline-popover-list">${yearItem}</ul>
          <p class="timeline-popover-empty" style="margin-top: 8px;">No locations recorded for this date.</p>
        `;
      } else {
        const items = locations
          .map(
            (loc) => `
          <li>
            ${renderTagLink(loc)}
            <span class="count">${loc.post_count}</span>
          </li>
        `,
          )
          .join("");
        popoverEl.innerHTML = `<ul class="timeline-popover-list">${yearItem}${items}</ul>`;
      }

      this._anchorPopover(el, popoverEl);
    } catch (err) {
      if (this._unmounted || this.state.popover !== popoverEl) return;
      console.error("Failed to load locations:", err);
      popoverEl.innerHTML = '<p class="error">Failed to load locations.</p>';
    }

    this._popoverCloseHandler = (e) => {
      if (!popoverEl.contains(e.target) && !el.contains(e.target)) {
        this._closePopover();
      }
    };
    this._popoverScrollHandler = () => this._closePopover();
    setTimeout(() => {
      if (!this._unmounted) {
        document.addEventListener("click", this._popoverCloseHandler);
        window.addEventListener("scroll", this._popoverScrollHandler, {
          passive: true,
        });
      }
    }, 0);
  }

  _openClusterPopover(el, clusterPills) {
    this._closePopover();
    const popoverEl = document.createElement("div");
    popoverEl.className = "timeline-popover cluster-popover";
    const items = clusterPills
      .map(
        (p) => `
      <li>
        <button class="timeline-pill-btn sub-pill" data-slug="${p.slug}">${p.name}</button>
      </li>
    `,
      )
      .join("");
    popoverEl.innerHTML = `<ul class="timeline-popover-list">${items}</ul>`;
    document.body.appendChild(popoverEl);
    this.state.popover = popoverEl;
    this._anchorPopover(el, popoverEl);

    popoverEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".timeline-pill-btn");
      if (btn) {
        const slug = btn.dataset.slug;
        const pill = this.state.pills.find((p) => p.slug === slug);
        if (!pill) return;
        if (this.props.mode === "filter") {
          this._closePopover();
          this._centerOnYear(pill.year, true, () => {
            this._emitRange();
          });
        } else {
          this._openPopover(el, pill);
        }
      }
    });

    this._popoverCloseHandler = (e) => {
      if (!popoverEl.contains(e.target) && !el.contains(e.target)) {
        this._closePopover();
      }
    };
    this._popoverScrollHandler = () => this._closePopover();
    setTimeout(() => {
      if (!this._unmounted) {
        document.addEventListener("click", this._popoverCloseHandler);
        window.addEventListener("scroll", this._popoverScrollHandler, {
          passive: true,
        });
      }
    }, 0);
  }

  _closePopover() {
    if (this.state.popover) {
      this.state.popover.remove();
      this.state.popover = null;
    }
    if (this._popoverCloseHandler) {
      document.removeEventListener("click", this._popoverCloseHandler);
      this._popoverCloseHandler = null;
    }
    if (this._popoverScrollHandler) {
      window.removeEventListener("scroll", this._popoverScrollHandler);
      this._popoverScrollHandler = null;
    }
  }

  _anchorPopover(pillEl, popoverEl) {
    const rect = pillEl.getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();

    let top = rect.top - popoverRect.height - 12;
    let left = rect.left + rect.width / 2 - popoverRect.width / 2;

    if (top < 0) {
      top = rect.bottom + 12;
      popoverEl.classList.add("flipped");
    } else {
      popoverEl.classList.remove("flipped");
    }

    popoverEl.style.top = `${top + window.scrollY}px`;
    popoverEl.style.left = `${Math.max(8, Math.min(window.innerWidth - popoverRect.width - 8, left))}px`;
  }

  _animateTo(targetPanX, targetZoom, duration, onComplete = null) {
    this._cancelAnimation();
    const startPanX = this.state.panX;
    const startZoom = this.state.zoom;
    const startTime = performance.now();

    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

    const step = (now) => {
      if (this._unmounted) return;
      const t = Math.min(1, (now - startTime) / duration);
      const e = easeOut(t);
      this.state.panX = startPanX + (targetPanX - startPanX) * e;
      this.state.zoom = startZoom + (targetZoom - startZoom) * e;
      this._layout();
      if (t < 1) {
        this._animRaf = requestAnimationFrame(step);
      } else {
        this._animRaf = null;
        if (onComplete) onComplete();
      }
    };

    this._animRaf = requestAnimationFrame(step);
  }

  _cancelAnimation() {
    if (this._animRaf) {
      cancelAnimationFrame(this._animRaf);
      this._animRaf = null;
    }
  }

  _initCollapsed() {
    const track = this.$(".timeline-track");
    if (!track) return;
    // Zoom so close to 0 that all pills map to the same X and collapse into one cluster.
    this.state.zoom = 0.0001;
    this.state.panX = track.clientWidth / 2 - EDGE_PAD;
    this._layout();
  }

  _centerOnYear(year, animate = false, onComplete = null) {
    const track = this.$(".timeline-track");
    if (!track) {
      if (onComplete) onComplete();
      return;
    }
    const trackWidth = track.clientWidth;
    const { extent, zoom } = this.state;
    const usableWidth = trackWidth - 2 * EDGE_PAD;
    if (extent.max === extent.min || usableWidth === 0) {
      if (onComplete) onComplete();
      return;
    }

    const progress = (year - extent.min) / (extent.max - extent.min);
    const currentX = EDGE_PAD + progress * usableWidth * zoom + this.state.panX;
    const newPanX = this.state.panX + (trackWidth / 2 - currentX);
    const maxPanX = trackWidth / 2 - EDGE_PAD;
    const minPanX = maxPanX - usableWidth * zoom;
    const clampedPanX = Math.max(minPanX, Math.min(maxPanX, newPanX));

    if (animate) {
      this._animateTo(clampedPanX, zoom, 320, onComplete);
    } else {
      this.state.panX = clampedPanX;
      this._layout();
      if (onComplete) onComplete();
    }
  }

  _snapToCenterPill(onComplete = null) {
    const item = this._findCenteredItem();
    if (!item) {
      if (onComplete) onComplete();
      return;
    }
    const year =
      item.type === "cluster" ? (item.minYear + item.maxYear) / 2 : item.year;
    this._centerOnYear(year, true, onComplete);
  }

  _findCenteredItem() {
    if (!this._lastCollision || !this._getX) return null;
    const track = this.$(".timeline-track");
    if (!track) return null;
    const centerX = track.clientWidth / 2;
    const { visible, clusters } = this._lastCollision;
    const getX = this._getX;

    let nearest = null;
    let nearestDist = Infinity;

    for (const p of visible) {
      const dist = Math.abs(getX(p.year) - centerX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { ...p, type: "pill" };
      }
    }
    for (const c of clusters) {
      const dist = Math.abs(getX((c.minYear + c.maxYear) / 2) - centerX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { ...c, type: "cluster" };
      }
    }
    return nearest;
  }

  _debounceEmitRange() {
    clearTimeout(this._emitTimer);

    // Live refresh while dragging/zooming (throttled)
    if (this._isDragging && this.props.mode === "filter") {
      const now = Date.now();
      if (now - this._lastLiveEmit > 100) {
        this._emitRange();
        this._lastLiveEmit = now;
      }
    }

    this._emitTimer = setTimeout(() => {
      if (this._isDragging) {
        if (this.props.mode === "filter") {
          this._emitRange();
          this._lastLiveEmit = Date.now();
        }
        return;
      }
      this._snapToCenterPill(() => {
        if (this.props.mode === "filter" && !this._isDragging) {
          this._emitRange();
        }
      });
    }, 150);
  }

  _emitRange() {
    if (!this.props.onRangeChange) return;
    const item = this._findCenteredItem();
    if (!item) return;

    let from, to;
    if (item.type === "cluster") {
      from = item.minYear;
      to = item.maxYear;
    } else {
      from = item.year;
      to = item.is_decade ? from + 9 : from;
    }
    this.props.onRangeChange({ from, to, source: "center" });
  }

  _computeMaxZoom() {
    const { pills, extent } = this.state;
    const track = this.$(".timeline-track");
    if (!track || pills.length < 2) return 20;

    const usableWidth = track.clientWidth - 2 * EDGE_PAD;
    const yearSpan = extent.max - extent.min;
    if (yearSpan === 0 || usableWidth === 0) return 1;

    const sorted = pills.map((p) => p.year).sort((a, b) => a - b);
    let minYearGap = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      minYearGap = Math.min(minYearGap, sorted[i] - sorted[i - 1]);
    }
    if (!isFinite(minYearGap) || minYearGap === 0) return 20;

    const pillWidth = this._measurePillWidth("2024");
    return (((pillWidth * 4) / 3) * yearSpan) / (usableWidth * minYearGap);
  }

  _onZoom(scaleDelta, anchorX) {
    this._cancelAnimation();
    const { zoom, panX } = this.state;
    const track = this.$(".timeline-track");
    if (!track) return;
    const trackWidth = track.clientWidth;

    const MIN_ZOOM = 0.001;

    // In collapsed state, first zoom-in jumps to fit-all; zoom-out is a no-op.
    if (zoom < MIN_ZOOM) {
      if (scaleDelta <= 1) return;
      this._zoomToFit(this.state.extent.min, this.state.extent.max);
      this._gestureController.setZoomed(this.state.zoom > 1);
      return;
    }

    const maxZoom = this._computeMaxZoom();
    const rawZoom = zoom * scaleDelta;

    // Zooming out past the minimum snaps back to the collapsed state.
    if (rawZoom < MIN_ZOOM) {
      this._initCollapsed();
      this._gestureController.setZoomed(false);
      return;
    }

    const newZoom = Math.max(MIN_ZOOM, Math.min(maxZoom, rawZoom));
    if (newZoom === zoom) return;

    const usableWidth = trackWidth - 2 * EDGE_PAD;
    const progressAtAnchor = (anchorX - EDGE_PAD - panX) / (usableWidth * zoom);
    const newPanX =
      anchorX - EDGE_PAD - progressAtAnchor * usableWidth * newZoom;

    this.state.zoom = newZoom;
    const maxPanXz = trackWidth / 2 - EDGE_PAD;
    this.state.panX = Math.min(
      maxPanXz,
      Math.max(maxPanXz - usableWidth * newZoom, newPanX),
    );
    this._layout();

    this._gestureController.setZoomed(newZoom > 1);
    this._debounceEmitRange();
  }

  _onPan(dx) {
    this._cancelAnimation();
    const { panX, zoom } = this.state;
    const track = this.$(".timeline-track");
    if (!track) return;
    const trackWidth = track.clientWidth;

    // In collapsed state the pan range is ~0px; any real drag expands to fit-all instead.
    if (zoom < 0.001) {
      if (Math.abs(dx) > 1) {
        this._zoomToFit(this.state.extent.min, this.state.extent.max);
        this._gestureController.setZoomed(this.state.zoom > 1);
      }
      return;
    }

    const usableWidth = trackWidth - 2 * EDGE_PAD;
    const maxPanX = trackWidth / 2 - EDGE_PAD;
    const minPanX = maxPanX - usableWidth * zoom;

    this.state.panX = Math.max(minPanX, Math.min(maxPanX, panX + dx));
    this._layout();
    this._debounceEmitRange();
  }

  _layout() {
    if (this._unmounted) return;
    const { pills, extent, zoom, panX } = this.state;
    const track = this.$(".timeline-track");
    if (!track) return;

    const trackWidth = track.clientWidth;
    if (trackWidth === 0) return;

    const mount = this.$(".timeline-pills-mount");
    if (!mount) return;

    const usableWidth = trackWidth - 2 * EDGE_PAD;
    const getX = (year) => {
      if (extent.max === extent.min) return trackWidth / 2;
      const progress = (year - extent.min) / (extent.max - extent.min);
      return EDGE_PAD + progress * usableWidth * zoom + panX;
    };

    this._getX = getX;
    const { visible, clusters } = this._collide(pills, getX);
    this._lastCollision = { visible, clusters };

    // Find the pill/cluster nearest to the center of the track
    const centerX = trackWidth / 2;
    let centeredKey = null;
    let nearestDist = Infinity;
    for (const p of visible) {
      const dist = Math.abs(getX(p.year) - centerX);
      if (dist < nearestDist) {
        nearestDist = dist;
        centeredKey = p.slug;
      }
    }
    for (const c of clusters) {
      const dist = Math.abs(getX((c.minYear + c.maxYear) / 2) - centerX);
      if (dist < nearestDist) {
        nearestDist = dist;
        centeredKey = `cluster-${c.minYear}-${c.maxYear}`;
      }
    }

    this._patchPillsMount(mount, visible, clusters, getX, centeredKey);

    this._updateTicks(trackWidth, getX);
    this._updateNavButtons(trackWidth, getX);
    this._updateRangeChip();
    this._updateHistogram(trackWidth, getX);
  }

  _patchPillsMount(mount, visible, clusters, getX, centeredKey) {
    const elKey = (el) =>
      el.dataset.slug
        ? `p:${el.dataset.slug}`
        : `c:${el.dataset.min}-${el.dataset.max}`;

    const existing = new Map();
    for (const el of [...mount.children]) existing.set(elKey(el), el);

    const desired = new Map();
    for (const c of clusters) {
      desired.set(`c:${c.minYear}-${c.maxYear}`, {
        x: getX((c.minYear + c.maxYear) / 2),
        active: centeredKey === `cluster-${c.minYear}-${c.maxYear}`,
        type: "cluster",
        data: c,
      });
    }
    for (const p of visible) {
      desired.set(`p:${p.slug}`, {
        x: getX(p.year),
        active: centeredKey === p.slug,
        type: "pill",
        data: p,
      });
    }

    for (const [k, el] of existing) {
      if (!desired.has(k)) el.remove();
    }
    for (const [k, info] of desired) {
      if (existing.has(k)) {
        const el = existing.get(k);
        el.style.left = `${info.x}px`;
        el.classList.toggle("active", info.active);
      } else {
        const el = this._makePillEl(info);
        mount.appendChild(el);
      }
    }
  }

  _makePillEl(info) {
    const wrap = document.createElement("div");
    const btn = document.createElement("button");
    if (info.type === "cluster") {
      const c = info.data;
      const label =
        c.minYear === c.maxYear
          ? String(c.minYear)
          : `${c.minYear}–${c.maxYear}`;
      wrap.className = "timeline-cluster";
      wrap.dataset.min = c.minYear;
      wrap.dataset.max = c.maxYear;
      btn.className = "timeline-cluster-btn";
      btn.setAttribute(
        "aria-label",
        `${c.minYear} to ${c.maxYear}, ${c.pills.length} dates.`,
      );
      btn.textContent = label;
    } else {
      const p = info.data;
      wrap.className = "timeline-pill-group";
      wrap.dataset.slug = p.slug;
      btn.className = "timeline-pill-btn";
      btn.setAttribute("aria-label", `${p.name}, ${p.post_count} posts.`);
      btn.textContent = p.name;
    }
    wrap.appendChild(btn);
    return wrap;
  }

  _collide(pills, getX) {
    const minGap = 8;
    const sorted = [...pills].sort((a, b) => a.year - b.year);
    const result = { visible: [], clusters: [] };

    let currentCluster = null;
    let lastRight = -Infinity;

    for (const p of sorted) {
      const x = getX(p.year);
      const width = this._measurePillWidth(p.name);
      const left = x - width / 2;
      const right = x + width / 2;

      if (left < lastRight + minGap) {
        if (!currentCluster) {
          const lastPill = result.visible.pop();
          currentCluster = {
            pills: [lastPill, p],
            minYear: lastPill.year,
            maxYear: p.year,
          };
        } else {
          currentCluster.pills.push(p);
          currentCluster.maxYear = p.year;
        }
        const clusterLabel =
          currentCluster.minYear === currentCluster.maxYear
            ? String(currentCluster.minYear)
            : `${currentCluster.minYear}–${currentCluster.maxYear}`;
        lastRight =
          getX((currentCluster.minYear + currentCluster.maxYear) / 2) +
          this._measurePillWidth(clusterLabel) / 2;
      } else {
        if (currentCluster) {
          result.clusters.push(currentCluster);
          currentCluster = null;
        }
        result.visible.push(p);
        lastRight = right;
      }
    }
    if (currentCluster) result.clusters.push(currentCluster);

    return result;
  }

  _measurePillWidth(name) {
    if (!this._canvas) this._canvas = document.createElement("canvas");
    const ctx = this._canvas.getContext("2d");
    ctx.font = "14px system-ui, -apple-system, sans-serif";
    const metrics = ctx.measureText(name);
    return metrics.width + 24;
  }

  _updateTicks(trackWidth, getX) {
    const { extent } = this.state;
    const ticksMount = this.$(".timeline-axis-ticks");
    if (!ticksMount) return;

    const startDecade = Math.floor(extent.min / 10) * 10;
    const endDecade = Math.ceil(extent.max / 10) * 10;
    let ticksHtml = "";

    for (let y = startDecade; y <= endDecade; y += 10) {
      const x = getX(y);
      if (x >= -50 && x <= trackWidth + 50) {
        ticksHtml += `<div class="timeline-tick" style="left: ${x}px"></div>`;
      }
    }
    ticksMount.innerHTML = ticksHtml;
  }

  _updateNavButtons(trackWidth, getX) {
    const { extent } = this.state;
    const prevBtn = this.$(".timeline-nav-btn.prev");
    const nextBtn = this.$(".timeline-nav-btn.next");
    if (!prevBtn || !nextBtn) return;

    const minX = getX(extent.min);
    const maxX = getX(extent.max);

    prevBtn.classList.toggle("visible", minX < EDGE_PAD - 5);
    nextBtn.classList.toggle("visible", maxX > trackWidth - EDGE_PAD + 5);
  }

  _updateRangeChip() {
    if (this.props.mode !== "filter") return;
    const mount = this.$("#range-chip-mount");
    if (!mount) return;

    const item = this._findCenteredItem();
    if (!item) {
      mount.innerHTML = "";
      return;
    }

    let from, to;
    if (item.type === "cluster") {
      from = item.minYear;
      to = item.maxYear;
    } else {
      from = item.year;
      to = item.is_decade ? from + 9 : from;
    }

    const yearStr = from === to ? String(from) : `${from} \u2013 ${to}`;
    
    // Calculate post count in range
    const count = this.state.pills
      .filter(p => p.year >= from && p.year <= to)
      .reduce((sum, p) => sum + p.post_count, 0);

    const isFullExtent = from === this.state.extent.min && to === this.state.extent.max;
    const removeBtn = !isFullExtent ? `<button class="timeline-range-chip-remove" title="Reset range" aria-label="Reset range">&times;</button>` : "";

    mount.innerHTML = `
      <div class="timeline-range-chip">
        <span class="label">${escapeHtml(yearStr)} &middot; ${count} post${count !== 1 ? 's' : ''}</span>
        ${removeBtn}
      </div>
    `;

    mount.querySelector(".timeline-range-chip-remove")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._initCollapsed();
      this._emitRange();
    });
  }

  _updateHistogram(trackWidth, getX) {
    const mount = this.$("#histogram-mount");
    if (!mount) return;

    const { pills } = this.state;
    if (!pills.length) return;

    const maxCount = Math.max(...pills.map(p => p.post_count), 1);
    
    // Find active range from centered item
    const item = this._findCenteredItem();
    let activeFrom = -Infinity, activeTo = Infinity;
    if (item) {
      if (item.type === "cluster") {
        activeFrom = item.minYear;
        activeTo = item.maxYear;
      } else {
        activeFrom = item.year;
        activeTo = item.is_decade ? item.year + 9 : item.year;
      }
    }

    let html = "";
    pills.forEach(p => {
      const x = getX(p.year);
      if (x < -20 || x > trackWidth + 20) return;

      const height = Math.max(2, Math.round((p.post_count / maxCount) * 24));
      const isActive = p.year >= activeFrom && p.year <= activeTo;
      const cls = isActive ? "is-active" : "";
      
      html += `<div class="timeline-hist-bar ${cls}" style="left: ${x}px; height: ${height}px"></div>`;
    });

    mount.innerHTML = html;
  }
}
