import { Component } from '../Component.js';
import { getTimeline, getTimelineLocations } from '../../api/timeline.js';
import { GestureController } from '../../utils/gestures.js';
import { renderTagLink } from '../../utils/tags.js';

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
      isLoading: true
    };
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
        isLoading: false
      });

      if (this._unmounted) return;
      const { initialRange, initialYear } = this.props;
      if (initialRange) {
        const { from, to } = initialRange;
        if (from === payload.extent.min && to === payload.extent.max) {
          this._initCollapsed();
        } else {
          this._centerOnYear((from + to) / 2);
          if (this.props.mode === 'filter') this._emitRange();
        }
      } else if (initialYear) {
        const year = parseInt(initialYear, 10);
        const pill = payload.pills.find((p) => p.year === year);
        if (pill) {
          this._centerOnYear(pill.year);
          if (this.props.mode === 'filter') this._emitRange();
        }
      } else {
        this._initCollapsed();
      }
    } catch (err) {
      if (err.status !== 404) {
        console.error('Timeline fetch failed:', err);
      }
      if (!this._unmounted) {
        this.unmount();
      }
    }
  }

  render() {
    if (this.state.isLoading || this.state.pills.length === 0) {
      return '';
    }

    return `
      <div class="timeline-container" role="region" aria-label="Date timeline">
        <div class="timeline-track-wrapper">
          <svg class="timeline-track" width="100%" height="56">
            <line class="timeline-axis-line" x1="0" y1="40" x2="100%" y2="40"></line>
            <line class="timeline-center-indicator" x1="50%" y1="26" x2="50%" y2="52"></line>
            <g class="timeline-axis-ticks"></g>
            <g class="timeline-pills-mount"></g>
          </svg>
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
    if (this._onMouseMove) window.removeEventListener('mousemove', this._onMouseMove);
    if (this._onMouseUp) window.removeEventListener('mouseup', this._onMouseUp);
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  _wireGestures() {
    const trackWrapper = this.$('.timeline-track-wrapper');
    if (!trackWrapper) return;

    // Stop touch events from bubbling to parent gesture controllers (page swipe navigation).
    trackWrapper.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    trackWrapper.addEventListener('touchmove',  (e) => e.stopPropagation(), { passive: true });

    this._gestureController = new GestureController(trackWrapper, {
      onPanMove: (dx, dy) => {
        if (Math.abs(dy) > Math.abs(dx)) {
          this._applyVerticalZoom(dy);
        } else {
          this._onPan(dx);
        }
      },
      onPinchMove: (scale, cx) => this._onZoom(scale, cx),
      onTap: (x, y) => this._onTap(x, y),
      onSwipeMove: (dx, dy) => {
        const dxDelta = dx - (this._swipeDxBase || 0);
        this._swipeDxBase = dx;
        const dyDelta = dy - (this._swipeDyBase || 0);
        this._swipeDyBase = dy;
        if (Math.abs(dy) > Math.abs(dx)) {
          this._applyVerticalZoom(dyDelta);
        } else {
          this._onPan(dxDelta);
        }
      },
      onSwipeCancel: () => { this._swipeDxBase = 0; this._swipeDyBase = 0; },
      onSwipeCommit: () => { this._swipeDxBase = 0; this._swipeDyBase = 0; },
    });

    trackWrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      this._onZoom(delta, e.offsetX);
    }, { passive: false });

    // Mouse drag support
    let isDragging = false;
    let hasDragged = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastX = 0;
    let lastY = 0;

    trackWrapper.addEventListener('mousedown', (e) => {
      if (e.target.closest('.timeline-nav-btn')) return;
      isDragging = true;
      hasDragged = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      lastX = e.clientX;
      lastY = e.clientY;
      trackWrapper.classList.add('grabbing');
    }, true);

    this._onMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(e.clientX - dragStartX) > 4 || Math.abs(e.clientY - dragStartY) > 4) {
        hasDragged = true;
      }
      lastX = e.clientX;
      lastY = e.clientY;
      if (Math.abs(dy) > Math.abs(dx)) {
        this._applyVerticalZoom(dy);
      } else {
        this._onPan(dx);
      }
    };

    this._onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      trackWrapper.classList.remove('grabbing');
    };

    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);

    trackWrapper.addEventListener('click', (e) => {
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
      const cluster = e.target.closest('.timeline-cluster');
      if (cluster) {
        this._expandCluster(cluster);
        return;
      }
      const pill = e.target.closest('.timeline-pill-group');
      if (pill) {
        this._onPillClick(pill);
      }
    });

    this.$('.timeline-nav-btn.prev')?.addEventListener('click', () => {
      const track = this.$('.timeline-track');
      this._onPan(track.clientWidth * 0.5);
    });
    this.$('.timeline-nav-btn.next')?.addEventListener('click', () => {
      const track = this.$('.timeline-track');
      this._onPan(-track.clientWidth * 0.5);
    });

    trackWrapper.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this._closePopover();
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const focusable = Array.from(this.$$('.timeline-pill-btn, .timeline-cluster-btn'));
        const idx = focusable.indexOf(document.activeElement);
        if (idx !== -1) {
          e.preventDefault();
          const nextIdx = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
          if (nextIdx >= 0 && nextIdx < focusable.length) {
            focusable[nextIdx].focus();
            this._ensureVisible(focusable[nextIdx]);
          }
        }
      }
    });
  }

  _ensureVisible(el) {
    const trackWrapper = this.$('.timeline-track-wrapper');
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
    setTimeout(() => this._ignoreNextClick = false, 500);

    const target = document.elementFromPoint(x, y);
    const cluster = target?.closest('.timeline-cluster');
    if (cluster) {
      this._expandCluster(cluster);
      return;
    }
    const pill = target?.closest('.timeline-pill-group');
    if (pill) {
      this._onPillClick(pill);
      return;
    }
  }

  _expandCluster(el) {
    const minYear = parseInt(el.dataset.min, 10);
    const maxYear = parseInt(el.dataset.max, 10);

    if (this.props.mode === 'filter') {
      this._centerOnYear((minYear + maxYear) / 2);
      this._emitRange();
      return;
    }

    const clusterPills = this.state.pills.filter((p) => p.year >= minYear && p.year <= maxYear);
    if (clusterPills.length <= 4) {
      this._openClusterPopover(el, clusterPills);
    } else {
      this._zoomToFit(minYear, maxYear);
    }
  }

  _zoomToFit(minYear, maxYear) {
    const { extent } = this.state;
    const track = this.$('.timeline-track');
    if (!track) return;
    const trackWidth = track.clientWidth;

    const usableWidth = trackWidth - 2 * EDGE_PAD;
    const yearSpan = (maxYear - minYear) || 1;
    const extentSpan = (extent.max - extent.min) || 1;
    const targetZoom = (0.6 * extentSpan) / yearSpan;

    const midYear = (minYear + maxYear) / 2;
    const progress = (midYear - extent.min) / extentSpan;
    const targetPanX = (trackWidth / 2) - EDGE_PAD - (progress * usableWidth * targetZoom);

    const clampedZoom = Math.max(0.001, targetZoom);
    const maxPanX = trackWidth / 2 - EDGE_PAD;
    const minPanX = maxPanX - usableWidth * clampedZoom;
    this.state.zoom = clampedZoom;
    this.state.panX = Math.min(maxPanX, Math.max(minPanX, targetPanX));
    this._layout();

    this._debounceEmitRange();
  }

  _onPillClick(el) {
    const slug = el.dataset.slug;
    const pill = this.state.pills.find((p) => p.slug === slug);
    if (!pill) return;

    if (this.props.mode === 'filter') {
      this._centerOnYear(pill.year);
      this._emitRange();
    } else {
      this._openPopover(el, pill);
    }
  }

  async _openPopover(el, pill) {
    this._closePopover();

    const popoverEl = document.createElement('div');
    popoverEl.className = 'timeline-popover loading';
    popoverEl.innerHTML = '<div class="timeline-popover-spinner"></div>';
    document.body.appendChild(popoverEl);
    this.state.popover = popoverEl;

    this._anchorPopover(el, popoverEl);

    try {
      const locations = await getTimelineLocations({
        tag: pill.slug,
        context: this.props.context,
        limit: 10
      });

      if (this._unmounted || this.state.popover !== popoverEl) return;

      popoverEl.classList.remove('loading');

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
        const items = locations.map((loc) => `
          <li>
            ${renderTagLink(loc)}
            <span class="count">${loc.post_count}</span>
          </li>
        `).join('');
        popoverEl.innerHTML = `<ul class="timeline-popover-list">${yearItem}${items}</ul>`;
      }
      
      this._anchorPopover(el, popoverEl);
    } catch (err) {
      if (this._unmounted || this.state.popover !== popoverEl) return;
      console.error('Failed to load locations:', err);
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
        document.addEventListener('click', this._popoverCloseHandler);
        window.addEventListener('scroll', this._popoverScrollHandler, { passive: true });
      }
    }, 0);
  }

  _openClusterPopover(el, clusterPills) {
    this._closePopover();
    const popoverEl = document.createElement('div');
    popoverEl.className = 'timeline-popover cluster-popover';
    const items = clusterPills.map((p) => `
      <li>
        <button class="timeline-pill-btn sub-pill" data-slug="${p.slug}">${p.name}</button>
      </li>
    `).join('');
    popoverEl.innerHTML = `<ul class="timeline-popover-list">${items}</ul>`;
    document.body.appendChild(popoverEl);
    this.state.popover = popoverEl;
    this._anchorPopover(el, popoverEl);

    popoverEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.timeline-pill-btn');
      if (btn) {
        const slug = btn.dataset.slug;
        const pill = this.state.pills.find((p) => p.slug === slug);
        if (!pill) return;
        if (this.props.mode === 'filter') {
          this._closePopover();
          this._centerOnYear(pill.year);
          this._emitRange();
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
        document.addEventListener('click', this._popoverCloseHandler);
        window.addEventListener('scroll', this._popoverScrollHandler, { passive: true });
      }
    }, 0);
  }

  _closePopover() {
    if (this.state.popover) {
      this.state.popover.remove();
      this.state.popover = null;
    }
    if (this._popoverCloseHandler) {
      document.removeEventListener('click', this._popoverCloseHandler);
      this._popoverCloseHandler = null;
    }
    if (this._popoverScrollHandler) {
      window.removeEventListener('scroll', this._popoverScrollHandler);
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
      popoverEl.classList.add('flipped');
    } else {
      popoverEl.classList.remove('flipped');
    }

    popoverEl.style.top = `${top + window.scrollY}px`;
    popoverEl.style.left = `${Math.max(8, Math.min(window.innerWidth - popoverRect.width - 8, left))}px`;
  }

  _initCollapsed() {
    const track = this.$('.timeline-track');
    if (!track) return;
    // Zoom so close to 0 that all pills map to the same X and collapse into one cluster.
    this.state.zoom = 0.0001;
    this.state.panX = track.clientWidth / 2 - EDGE_PAD;
    this._layout();
    if (this.props.mode === 'filter') this._emitRange();
  }

  _centerOnYear(year) {
    const track = this.$('.timeline-track');
    if (!track) return;
    const trackWidth = track.clientWidth;
    const { extent, zoom } = this.state;
    const usableWidth = trackWidth - 2 * EDGE_PAD;
    if (extent.max === extent.min || usableWidth === 0) return;

    const progress = (year - extent.min) / (extent.max - extent.min);
    const currentX = EDGE_PAD + progress * usableWidth * zoom + this.state.panX;
    const newPanX = this.state.panX + (trackWidth / 2 - currentX);
    const maxPanX = trackWidth / 2 - EDGE_PAD;
    const minPanX = maxPanX - usableWidth * zoom;
    this.state.panX = Math.max(minPanX, Math.min(maxPanX, newPanX));
    this._layout();
  }

  _snapToCenterPill() {
    const item = this._findCenteredItem();
    if (!item) return;
    const year = item.type === 'cluster' ? (item.minYear + item.maxYear) / 2 : item.year;
    this._centerOnYear(year);
  }

  _findCenteredItem() {
    if (!this._lastCollision || !this._getX) return null;
    const track = this.$('.timeline-track');
    if (!track) return null;
    const centerX = track.clientWidth / 2;
    const { visible, clusters } = this._lastCollision;
    const getX = this._getX;

    let nearest = null;
    let nearestDist = Infinity;

    for (const p of visible) {
      const dist = Math.abs(getX(p.year) - centerX);
      if (dist < nearestDist) { nearestDist = dist; nearest = { ...p, type: 'pill' }; }
    }
    for (const c of clusters) {
      const dist = Math.abs(getX((c.minYear + c.maxYear) / 2) - centerX);
      if (dist < nearestDist) { nearestDist = dist; nearest = { ...c, type: 'cluster' }; }
    }
    return nearest;
  }

  _debounceEmitRange() {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => {
      this._snapToCenterPill();
      if (this.props.mode === 'filter') this._emitRange();
    }, 200);
  }

  _emitRange() {
    if (!this.props.onRangeChange) return;
    const item = this._findCenteredItem();
    if (!item) return;

    let from, to;
    if (item.type === 'cluster') {
      from = item.minYear;
      to = item.maxYear;
    } else {
      from = item.year;
      to = item.is_decade ? from + 9 : from;
    }
    this.props.onRangeChange({ from, to, source: 'center' });
  }

  _applyVerticalZoom(dy) {
    if (Math.abs(dy) < 0.5) return;
    // down (dy > 0) = zoom in, up (dy < 0) = zoom out
    const scaleDelta = Math.exp(dy * 0.015);
    const track = this.$('.timeline-track');
    const cx = track ? track.clientWidth / 2 : 0;
    this._onZoom(scaleDelta, cx);
  }

  _computeMaxZoom() {
    const { pills, extent } = this.state;
    const track = this.$('.timeline-track');
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

    const pillWidth = this._measurePillWidth('2024');
    return (pillWidth * 4 / 3) * yearSpan / (usableWidth * minYearGap);
  }

  _onZoom(scaleDelta, anchorX) {
    const { zoom, panX } = this.state;
    const track = this.$('.timeline-track');
    if (!track) return;
    const trackWidth = track.clientWidth;

    const maxZoom = this._computeMaxZoom();
    const newZoom = Math.max(0.001, Math.min(maxZoom, zoom * scaleDelta));
    if (newZoom === zoom) return;

    const usableWidth = trackWidth - 2 * EDGE_PAD;
    const progressAtAnchor = (anchorX - EDGE_PAD - panX) / (usableWidth * zoom);
    const newPanX = anchorX - EDGE_PAD - (progressAtAnchor * usableWidth * newZoom);

    this.state.zoom = newZoom;
    const maxPanXz = trackWidth / 2 - EDGE_PAD;
    this.state.panX = Math.min(maxPanXz, Math.max(maxPanXz - usableWidth * newZoom, newPanX));
    this._layout();

    this._gestureController.setZoomed(newZoom > 1);
    this._debounceEmitRange();
  }

  _onPan(dx) {
    const { panX, zoom } = this.state;
    const track = this.$('.timeline-track');
    if (!track) return;
    const trackWidth = track.clientWidth;

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
    const track = this.$('.timeline-track');
    if (!track) return;

    const trackWidth = track.clientWidth;
    if (trackWidth === 0) return;

    const mount = this.$('.timeline-pills-mount');
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
      if (dist < nearestDist) { nearestDist = dist; centeredKey = p.slug; }
    }
    for (const c of clusters) {
      const dist = Math.abs(getX((c.minYear + c.maxYear) / 2) - centerX);
      if (dist < nearestDist) { nearestDist = dist; centeredKey = `cluster-${c.minYear}-${c.maxYear}`; }
    }

    let html = '';

    clusters.forEach((c) => {
      const midYear = (c.minYear + c.maxYear) / 2;
      const x = getX(midYear);
      const clusterKey = `cluster-${c.minYear}-${c.maxYear}`;
      const activeClass = centeredKey === clusterKey ? ' active' : '';
      const label = c.minYear === c.maxYear ? String(c.minYear) : `${c.minYear}–${c.maxYear}`;
      html += [
        `<g class="timeline-cluster${activeClass}" transform="translate(${x}, 0)" data-min="${c.minYear}" data-max="${c.maxYear}">`,
        `<foreignObject x="-40" y="10" width="80" height="36">`,
        `<div class="timeline-cluster-wrapper" xmlns="http://www.w3.org/1999/xhtml">`,
        `<button class="timeline-cluster-btn" aria-label="${c.minYear} to ${c.maxYear}, ${c.pills.length} dates.">${label}</button>`,
        `</div></foreignObject></g>`,
      ].join('');
    });

    visible.forEach((p) => {
      const x = getX(p.year);
      const activeClass = centeredKey === p.slug ? ' active' : '';
      html += [
        `<g class="timeline-pill-group${activeClass}" transform="translate(${x}, 0)" data-slug="${p.slug}">`,
        `<foreignObject x="-40" y="10" width="80" height="36">`,
        `<div class="timeline-pill-wrapper" xmlns="http://www.w3.org/1999/xhtml">`,
        `<button class="timeline-pill-btn" aria-label="${p.name}, ${p.post_count} posts.">${p.name}</button>`,
        `</div></foreignObject></g>`,
      ].join('');
    });

    mount.innerHTML = html;

    this._updateTicks(trackWidth, getX);
    this._updateNavButtons(trackWidth, getX);
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
          currentCluster = { pills: [lastPill, p], minYear: lastPill.year, maxYear: p.year };
        } else {
          currentCluster.pills.push(p);
          currentCluster.maxYear = p.year;
        }
        const clusterLabel = currentCluster.minYear === currentCluster.maxYear
          ? String(currentCluster.minYear) : `${currentCluster.minYear}–${currentCluster.maxYear}`;
        lastRight = getX((currentCluster.minYear + currentCluster.maxYear) / 2) +
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
    if (!this._canvas) this._canvas = document.createElement('canvas');
    const ctx = this._canvas.getContext('2d');
    ctx.font = '14px system-ui, -apple-system, sans-serif';
    const metrics = ctx.measureText(name);
    return metrics.width + 24;
  }

  _updateTicks(trackWidth, getX) {
    const { extent } = this.state;
    const ticksMount = this.$('.timeline-axis-ticks');
    if (!ticksMount) return;

    const startDecade = Math.floor(extent.min / 10) * 10;
    const endDecade = Math.ceil(extent.max / 10) * 10;
    let ticksHtml = '';

    for (let y = startDecade; y <= endDecade; y += 10) {
      const x = getX(y);
      if (x >= 0 && x <= trackWidth) {
        ticksHtml += `<line class="timeline-tick" x1="${x}" y1="38" x2="${x}" y2="42"></line>`;
      }
    }
    ticksMount.innerHTML = ticksHtml;
  }

  _updateNavButtons(trackWidth, getX) {
    const { extent } = this.state;
    const prevBtn = this.$('.timeline-nav-btn.prev');
    const nextBtn = this.$('.timeline-nav-btn.next');
    if (!prevBtn || !nextBtn) return;

    const minX = getX(extent.min);
    const maxX = getX(extent.max);

    prevBtn.classList.toggle('visible', minX < EDGE_PAD - 5);
    nextBtn.classList.toggle('visible', maxX > trackWidth - EDGE_PAD + 5);
  }

}
