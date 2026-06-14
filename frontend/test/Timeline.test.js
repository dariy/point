import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('Timeline Component', () => {
  let Timeline;
  let container;
  let props;

  before(async () => {
    // Mock global dependencies
    global.document = {
      createElement: (tag) => {
          const el = {
            appendChild: () => {},
            remove: () => {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelector: (sel) => el._querySelector?.(sel) || null,
            querySelectorAll: (sel) => el._querySelectorAll?.(sel) || [],
            dataset: {},
            style: {},
            setAttribute: (name, val) => { el[name] = val; },
            getAttribute: (name) => el[name],
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 100 }),
            children: [],
            focus: () => { global.document.activeElement = el; }
          };
          if (tag === 'canvas') {
              el.getContext = () => ({ measureText: () => ({ width: 50 }) });
              el.font = '';
          }
          return el;
      },
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, classList: { remove: () => {} } },
      documentElement: { dataset: { theme: 'light' } },
      addEventListener: () => {},
      removeEventListener: () => {},
      activeElement: null
    };
    global.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: (query) => ({ 
        matches: global.prefersReducedMotion || false,
        media: query 
      }),
      scrollY: 0,
      innerWidth: 1024,
      performance: { now: () => Date.now() },
      requestAnimationFrame: (cb) => setTimeout(cb, 16),
      cancelAnimationFrame: (id) => clearTimeout(id)
    };
    global.vibrateCalls = [];
    Object.defineProperty(global, 'navigator', {
      value: {
        vibrate: (ms) => { global.vibrateCalls.push(ms); }
      },
      configurable: true,
      writable: true
    });
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    global.localStorage = {
      getItem: () => null,
      setItem: () => {}
    };
    global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
    global.cancelAnimationFrame = (id) => clearTimeout(id);

    const mod = await import('../src/components/public/Timeline.js');
    Timeline = mod.Timeline;
  });

  beforeEach(() => {
    container = {
      querySelector: (selector) => {
          const base = {
              clientWidth: 1000,
              addEventListener: () => {},
              removeEventListener: () => {},
              getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 100 }),
              classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
              querySelector: () => null,
              querySelectorAll: () => [],
              appendChild: () => {},
              children: [],
              setAttribute: () => {},
              dataset: {},
              style: {}
          };
          if (selector === '.timeline-track') return base;
          if (selector === '.timeline-track-wrapper') return base;
          if (selector === '.timeline-pills-mount') return base;
          if (selector === '#histogram-mount') return base;
          if (selector === '.timeline-axis-ticks') return base;
          return base;
      },
      querySelectorAll: () => [],
      appendChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    props = {
        mode: 'filter',
        onRangeChange: () => {}
    };
  });

  test('does NOT emit while a drag is in progress (commits on release)', (t, done) => {
    // Emitting mid-drag navigates + re-renders the host page, remounting the
    // timeline and killing the in-flight gesture. The range must commit only
    // once the drag settles — never while _isDragging is true.
    const timeline = new Timeline(container, props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2020, name: '2020', slug: '2020', post_count: 1 },
        { year: 2021, name: '2021', slug: '2021', post_count: 1 },
        { year: 2022, name: '2022', slug: '2022', post_count: 1 }
    ];
    timeline.state.extent = { min: 2020, max: 2022 };
    timeline.state.zoom = 1;
    timeline.state.panX = 0;
    timeline._getX = (y) => 500;
    timeline._lastCollision = { visible: timeline.state.pills, clusters: [] };

    let emitted = false;
    timeline.props.onRangeChange = () => { emitted = true; };

    timeline._isDragging = true;
    // Even repeated calls during the drag must stay silent.
    timeline._debounceEmitRange();
    timeline._debounceEmitRange();
    timeline._debounceEmitRange();

    setTimeout(() => {
        try {
            assert.strictEqual(emitted, false, 'Must not emit while dragging');
            done();
        } catch (e) {
            done(e);
        }
    }, 300);
  });

  test('commits the range once after the drag settles', (t, done) => {
    const timeline = new Timeline(container, props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 1 }
    ];
    timeline.state.extent = { min: 2021, max: 2021 };
    timeline._getX = () => 500;
    timeline._lastCollision = { visible: timeline.state.pills, clusters: [] };
    // Snap resolves synchronously so we measure the commit, not the animation.
    timeline._centerOnYear = (year, animate, onComplete) => { if (onComplete) onComplete(); };

    let emittedCount = 0;
    timeline.props.onRangeChange = () => { emittedCount++; };

    // Drag released: _isDragging is false, the debounced settle fires once.
    timeline._isDragging = false;
    timeline._debounceEmitRange();

    setTimeout(() => {
        try {
            assert.strictEqual(emittedCount, 1, 'Should emit exactly once on settle');
            done();
        } catch (e) {
            done(e);
        }
    }, 300);
  });

  test('should update aria-live announcer on settle', (t) => {
    const announcer = { textContent: '' };
    const originalQS = container.querySelector;
    container.querySelector = (selector) => {
        if (selector === '#timeline-live-announcer') return announcer;
        return originalQS(selector);
    };

    const timeline = new Timeline(container, props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 5 }
    ];
    timeline.state.extent = { min: 2021, max: 2021 };
    timeline._getX = () => 500;
    timeline._lastCollision = { visible: timeline.state.pills, clusters: [] };

    timeline._settled = true;
    timeline._announceRange();

    assert.strictEqual(announcer.textContent, 'Showing 2021, 5 posts');
  });

  test('should update aria-live announcer for clusters', (t) => {
    const announcer = { textContent: '' };
    const originalQS = container.querySelector;
    container.querySelector = (selector) => {
        if (selector === '#timeline-live-announcer') return announcer;
        return originalQS(selector);
    };

    const timeline = new Timeline(container, props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 5 },
        { year: 2022, name: '2022', slug: '2022', post_count: 3 }
    ];
    timeline.state.extent = { min: 2020, max: 2025 };
    timeline._getX = (y) => 500;
    timeline._lastCollision = { 
        visible: [], 
        clusters: [{
            type: 'cluster',
            minYear: 2021,
            maxYear: 2022,
            pills: timeline.state.pills
        }] 
    };

    timeline._settled = true;
    timeline._announceRange();

    assert.strictEqual(announcer.textContent, 'Showing 2021 to 2022, 8 posts');
  });

  test('should update aria-live announcer for all years', (t) => {
    const announcer = { textContent: '' };
    const originalQS = container.querySelector;
    container.querySelector = (selector) => {
        if (selector === '#timeline-live-announcer') return announcer;
        return originalQS(selector);
    };

    const timeline = new Timeline(container, props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 5 },
        { year: 2022, name: '2022', slug: '2022', post_count: 3 }
    ];
    timeline.state.extent = { min: 2021, max: 2022 };
    timeline._getX = () => 500;
    timeline._lastCollision = { 
        visible: [], 
        clusters: [{
            type: 'cluster',
            minYear: 2021,
            maxYear: 2022,
            pills: timeline.state.pills,
            isAllYears: true
        }] 
    };

    timeline._settled = true;
    timeline._announceRange();

    assert.strictEqual(announcer.textContent, 'Showing all years, 8 posts');
  });

  describe('Accessibility & Keyboard', () => {
    test('Escape key resets zoom when no popover is open', (t) => {
      const timeline = new Timeline(container, props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];
      timeline.state.extent = { min: 2021, max: 2021 };
      timeline.state.zoom = 5;
      
      let keydownHandler;
      const originalQS = container.querySelector;
      container.querySelector = (sel) => {
          const el = originalQS(sel);
          if (sel === '.timeline-track-wrapper') {
              el.addEventListener = (name, cb) => { if (name === 'keydown') keydownHandler = cb; };
          }
          return el;
      };

      timeline.afterRender();
      
      assert.ok(keydownHandler, 'keydownHandler should be assigned');
      keydownHandler({ key: 'Escape', preventDefault: () => {} });
      
      assert.strictEqual(timeline.state.zoom, 0.0001, 'Zoom should be reset to collapsed state');
    });

    test('Home and End keys jump to extents', (t) => {
      const timeline = new Timeline(container, props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];
      timeline.state.extent = { min: 2000, max: 2020 };
      timeline.state.zoom = 1;
      timeline.state.panX = 0;
      
      let keydownHandler;
      const originalQS = container.querySelector;
      container.querySelector = (sel) => {
          const el = originalQS(sel);
          if (sel === '.timeline-track-wrapper') {
              el.addEventListener = (name, cb) => { if (name === 'keydown') keydownHandler = cb; };
          }
          return el;
      };

      timeline.afterRender();
      
      assert.ok(keydownHandler, 'keydownHandler should be assigned');
      keydownHandler({ key: 'Home', preventDefault: () => {} });
      keydownHandler({ key: 'End', preventDefault: () => {} });
    });

    test('Arrow keys announce focus', (t) => {
      const announcer = { textContent: '' };
      const timeline = new Timeline(container, props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];
      
      let keydownHandler;
      const originalQS = container.querySelector;
      container.querySelector = (sel) => {
          if (sel === '#timeline-live-announcer') return announcer;
          const el = originalQS(sel);
          if (sel === '.timeline-track-wrapper') {
              el.addEventListener = (name, cb) => { if (name === 'keydown') keydownHandler = cb; };
          }
          return el;
      };

      const btn1 = { 
          focus: () => { global.document.activeElement = btn1; },
          getBoundingClientRect: () => ({ left: 100, top: 0, width: 50, height: 20 }),
          addEventListener: () => {},
          removeEventListener: () => {}
      };
      const btn2 = { 
          focus: () => { global.document.activeElement = btn2; },
          getAttribute: (name) => name === 'aria-label' ? '2021, 5 posts' : null,
          getBoundingClientRect: () => ({ left: 500, top: 0, width: 50, height: 20 }),
          addEventListener: () => {},
          removeEventListener: () => {}
      };
      timeline.$$ = () => [btn1, btn2];
      global.document.activeElement = btn1;

      timeline.afterRender();
      
      assert.ok(keydownHandler, 'keydownHandler should be assigned');
      keydownHandler({ key: 'ArrowRight', preventDefault: () => {} });
      
      assert.strictEqual(global.document.activeElement, btn2);
      assert.strictEqual(announcer.textContent, '2021, 5 posts');
    });

    test('Popover has role dialog and focus management', async (t) => {
      const timeline = new Timeline(container, props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];

      const pillEl = { 
          getBoundingClientRect: () => ({ top: 100, left: 100, width: 50, height: 20 }),
          querySelector: () => ({ focus: () => { pillEl.focused = true; } })
      };
      
      const originalCreateElement = global.document.createElement;
      let popover;
      global.document.createElement = (tag) => {
          const el = originalCreateElement(tag);
          if (tag === 'div') {
              const originalSetAttribute = el.setAttribute;
              el.setAttribute = (name, val) => {
                  if (name === 'role' && val === 'dialog') popover = el;
                  originalSetAttribute.call(el, name, val);
              };
          }
          return el;
      };

      await timeline._openPopover(pillEl, timeline.state.pills[0]);
      
      assert.ok(popover, 'Popover should be created with role dialog');
      assert.strictEqual(popover.getAttribute('role'), 'dialog');
      
      timeline._closePopover();
      assert.strictEqual(timeline.state.popover, null);
      assert.ok(pillEl.focused, 'Focus should return to trigger element');
      
      global.document.createElement = originalCreateElement;
    });
  });

  describe('Haptic Feedback', () => {
    beforeEach(() => {
      global.vibrateCalls = [];
      global.prefersReducedMotion = false;
    });

    test('vibrates on snap when centered item changes', () => {
      const timeline = new Timeline(container, props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2020, post_count: 5 }];
      timeline.state.extent = { min: 2000, max: 2040 };
      
      // Mock _findCenteredItem to return a pill
      timeline._findCenteredItem = () => ({ type: 'pill', year: 2020 });
      timeline._centerOnYear = () => {};

      // First snap (from null to 2020) - should NOT vibrate
      timeline._snapToCenterPill();
      assert.strictEqual(global.vibrateCalls.length, 0, 'Should not vibrate on first snap');
      assert.strictEqual(timeline._lastCenteredYear, 2020);

      // Second snap to different year
      timeline._findCenteredItem = () => ({ type: 'pill', year: 2021 });
      timeline._snapToCenterPill();
      assert.strictEqual(global.vibrateCalls.length, 1, 'Should vibrate on year change');
      assert.strictEqual(global.vibrateCalls[0], 10);
      assert.strictEqual(timeline._lastCenteredYear, 2021);

      // Third snap to SAME year
      timeline._snapToCenterPill();
      assert.strictEqual(global.vibrateCalls.length, 1, 'Should not vibrate if year is same');
    });

    test('respects prefers-reduced-motion', () => {
      global.prefersReducedMotion = true;
      const timeline = new Timeline(container, props);
      timeline.state.isLoading = false;
      timeline._lastCenteredYear = 2020;
      timeline._centerOnYear = () => {};
      timeline._findCenteredItem = () => ({ type: 'pill', year: 2021 });

      timeline._snapToCenterPill();
      assert.strictEqual(global.vibrateCalls.length, 0, 'Should not vibrate when reduced motion is on');
    });
  });

  describe('Touch Gestures', () => {
    // Builds a wired-up timeline whose track elements report `rectLeft` as their
    // viewport offset, then exposes the live GestureController callbacks.
    function makeTimeline(rectLeft = 0) {
      const el = () => ({
        clientWidth: 1000,
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ left: rectLeft, top: 0, width: 1000, height: 100 }),
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        children: [],
        setAttribute: () => {},
        dataset: {},
        style: {},
      });
      const customContainer = {
        querySelector: () => el(),
        querySelectorAll: () => [],
        appendChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const timeline = new Timeline(customContainer, { mode: 'filter', onRangeChange: () => {} });
      timeline.state.isLoading = false;
      timeline.state.pills = [
        { year: 2020, name: '2020', slug: '2020', post_count: 1 },
        { year: 2021, name: '2021', slug: '2021', post_count: 1 },
        { year: 2022, name: '2022', slug: '2022', post_count: 1 },
      ];
      timeline.state.extent = { min: 2020, max: 2022 };
      timeline.state.zoom = 1;
      timeline.state.panX = 0;
      timeline.afterRender();
      return timeline;
    }

    test('vertical swipe scrolls the page without panning or filtering', () => {
      const timeline = makeTimeline();
      let panned = false, momentum = false, emitted = false;
      timeline._onPan = () => { panned = true; };
      timeline._applyMomentum = () => { momentum = true; };
      timeline.props.onRangeChange = () => { emitted = true; };

      const opts = timeline._gestureController._opts;
      opts.onSwipeMove(2, 80); // predominantly vertical
      assert.strictEqual(panned, false, 'vertical swipe must not pan the timeline');

      opts.onSwipeCommit('down');
      assert.strictEqual(momentum, false, 'vertical commit must not start momentum');
      assert.strictEqual(emitted, false, 'vertical swipe must not emit a range change');
    });

    test('horizontal swipe pans the timeline', () => {
      const timeline = makeTimeline();
      let panArg = null;
      timeline._onPan = (dx) => { panArg = dx; };

      timeline._gestureController._opts.onSwipeMove(80, 5);
      assert.strictEqual(panArg, 80, 'horizontal swipe should pan by dx');
    });

    test('horizontal commit drives momentum', () => {
      const timeline = makeTimeline();
      let momentum = false;
      timeline._applyMomentum = () => { momentum = true; };

      timeline._gestureController._opts.onSwipeCommit('left');
      assert.strictEqual(momentum, true, 'horizontal commit should start momentum');
    });

    test('pinch zoom anchors relative to the track, not the viewport', () => {
      const timeline = makeTimeline(200); // track sits 200px from the viewport left
      let anchor = null;
      timeline._onZoom = (_scale, anchorX) => { anchor = anchorX; };

      timeline._gestureController._opts.onPinchMove(1.2, 300); // pinch center at clientX 300
      assert.strictEqual(anchor, 100, 'anchor should be clientX minus the track left offset');
    });
  });
});
