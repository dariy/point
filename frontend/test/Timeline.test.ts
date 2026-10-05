import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { mock, memoryStorage, nodeList } from './helpers/mock.ts';
import { StubElement, StubClassList, asElement, asStub, type Listener } from './helpers/stubElement.ts';

type TimelineCtor = typeof import('../src/plugins/timeline/index.ts').Timeline;
type TimelineProps = NonNullable<ConstructorParameters<TimelineCtor>[1]>;
type TimelineInstance = InstanceType<TimelineCtor>;
type CenteredItem = NonNullable<ReturnType<TimelineInstance['_findCenteredItem']>>;
type PillInfo = Parameters<TimelineInstance['_makePillBtn']>[0];
type TimelinePill = Parameters<TimelineInstance['_openPopover']>[1];
type PillCluster = NonNullable<TimelineInstance['_lastCollision']>['clusters'][number];

/** A cluster as _findCenteredItem reports it. */
const cluster = (c: PillCluster & { type: 'cluster' }) => c;

/** What navigator.vibrate was called with. */
let vibrateCalls: number[] = [];
/** What matchMedia reports for prefers-reduced-motion. */
let prefersReducedMotion = false;

/** Set document.activeElement, which the DOM types keep read-only. */
function setActive(el: Element | null) {
  Object.assign(document, { activeElement: el });
}

/** A classList that records nothing and reports no class, as the old stub did. */
const inertClassList = () => Object.assign(new StubClassList(), { toggle: () => false, contains: () => false });

/** A track element: the box Timeline measures and listens on. */
const trackStub = (left = 0) => new StubElement({
  clientWidth: 1000,
  getBoundingClientRect: () => ({ left, top: 0, width: 1000, height: 100 }),
  classList: inertClassList(),
  querySelectorAll: () => [],
});

/**
 * An element from document.createElement. It has no innerHTML, so a test can
 * see that nothing was written as markup. Attributes are plain properties.
 */
function createElement(tag: string): HTMLElement {
  const el: HTMLElement = mock<HTMLElement>({
    appendChild: <T extends Node>(n: T) => n,
    remove: () => {},
    classList: mock<DOMTokenList>({ add: () => {}, remove: () => {}, toggle: () => false, contains: () => false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => nodeList<Element>([]),
    dataset: {},
    style: mock<CSSStyleDeclaration>({}),
    setAttribute: (name: string, val: string) => { Reflect.set(el, name, val); },
    getAttribute: (name: string) => Reflect.get(el, name),
    getBoundingClientRect: () => mock<DOMRect>({ left: 0, top: 0, width: 1000, height: 100 }),
    children: mock<HTMLCollection>({ length: 0 }),
    focus: () => { setActive(el); },
  });
  if (tag === 'canvas') {
    Object.assign(el, { getContext: () => ({ measureText: () => ({ width: 50 }) }), font: '' });
  }
  return el;
}

describe('Timeline Component', () => {
  let Timeline: TimelineCtor;
  let container: StubElement;
  let props: TimelineProps;

  before(async () => {
    globalThis.document = mock<Document>({
      createElement,
      head: mock<HTMLHeadElement>({ appendChild: <T extends Node>(n: T) => n }),
      body: mock<HTMLElement>({ appendChild: <T extends Node>(n: T) => n, classList: mock<DOMTokenList>({ remove: () => {} }) }),
      documentElement: mock<HTMLElement>({ dataset: { theme: 'light' } }),
      addEventListener: () => {},
      removeEventListener: () => {},
      activeElement: null
    });
    globalThis.window = mock<typeof window>({
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: (query: string) => mock<MediaQueryList>({
        matches: prefersReducedMotion,
        media: query
      }),
      scrollY: 0,
      innerWidth: 1024,
      performance: mock<Performance>({ now: () => Date.now() }),
      requestAnimationFrame: (cb: FrameRequestCallback) => Number(setTimeout(cb, 16)),
      cancelAnimationFrame: (id: number) => clearTimeout(id)
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        vibrate: (ms: number) => { vibrateCalls.push(ms); }
      },
      configurable: true,
      writable: true
    });
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.localStorage = memoryStorage();
    globalThis.requestAnimationFrame = (cb) => Number(setTimeout(cb, 16));
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

    const mod = await import('../src/plugins/timeline/index.ts');
    Timeline = mod.Timeline;
  });

  beforeEach(() => {
    container = new StubElement({
      querySelector: () => trackStub(),
      querySelectorAll: () => [],
    });
    props = {
        mode: 'filter',
        onRangeChange: () => {}
    };
  });

  test('does NOT emit while a drag is in progress (commits on release)', (t, done) => {
    // Emitting mid-drag navigates + re-renders the host page, remounting the
    // timeline and killing the in-flight gesture. The range must commit only
    // once the drag settles — never while _isDragging is true.
    const timeline = new Timeline(asElement(container), props);
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
    const timeline = new Timeline(asElement(container), props);
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
    const announcer = new StubElement({ textContent: '' });
    const originalQS = container.querySelector;
    container.querySelector = (selector) => {
        if (selector === '#timeline-live-announcer') return announcer;
        return originalQS(selector);
    };

    const timeline = new Timeline(asElement(container), props);
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
    const announcer = new StubElement({ textContent: '' });
    const originalQS = container.querySelector;
    container.querySelector = (selector) => {
        if (selector === '#timeline-live-announcer') return announcer;
        return originalQS(selector);
    };

    const timeline = new Timeline(asElement(container), props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 5 },
        { year: 2022, name: '2022', slug: '2022', post_count: 3 }
    ];
    timeline.state.extent = { min: 2020, max: 2025 };
    timeline._getX = (y) => 500;
    timeline._lastCollision = { 
        visible: [], 
        clusters: [cluster({
            type: 'cluster',
            minYear: 2021,
            maxYear: 2022,
            pills: timeline.state.pills
        })] 
    };

    timeline._settled = true;
    timeline._announceRange();

    assert.strictEqual(announcer.textContent, 'Showing 2021 to 2022, 8 posts');
  });

  test('should update aria-live announcer for all years', (t) => {
    const announcer = new StubElement({ textContent: '' });
    const originalQS = container.querySelector;
    container.querySelector = (selector) => {
        if (selector === '#timeline-live-announcer') return announcer;
        return originalQS(selector);
    };

    const timeline = new Timeline(asElement(container), props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 5 },
        { year: 2022, name: '2022', slug: '2022', post_count: 3 }
    ];
    timeline.state.extent = { min: 2021, max: 2022 };
    timeline._getX = () => 500;
    timeline._lastCollision = { 
        visible: [], 
        clusters: [cluster({
            type: 'cluster',
            minYear: 2021,
            maxYear: 2022,
            pills: timeline.state.pills,
            isAllYears: true
        })] 
    };

    timeline._settled = true;
    timeline._announceRange();

    assert.strictEqual(announcer.textContent, 'Showing all years, 8 posts');
  });

  describe('Accessibility & Keyboard', () => {
    test('Escape key resets zoom when no popover is open', (t) => {
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];
      timeline.state.extent = { min: 2021, max: 2021 };
      timeline.state.zoom = 5;
      
      const handlers: Record<string, Listener> = {};
      const originalQS = container.querySelector;
      container.querySelector = (sel) => {
          const el = must(originalQS(sel));
          if (sel === '.timeline-track-wrapper') {
              el.addEventListener = (name, cb) => { handlers[name] = cb; };
          }
          return el;
      };

      timeline.afterRender();
      
      assert.ok(handlers.keydown, 'keydownHandler should be assigned');
      must(handlers.keydown)({ key: 'Escape', preventDefault: () => {} });
      
      assert.strictEqual(timeline.state.zoom, 0.0001, 'Zoom should be reset to collapsed state');
    });

    test('Home and End keys jump to extents', (t) => {
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];
      timeline.state.extent = { min: 2000, max: 2020 };
      timeline.state.zoom = 1;
      timeline.state.panX = 0;
      
      const handlers: Record<string, Listener> = {};
      const originalQS = container.querySelector;
      container.querySelector = (sel) => {
          const el = must(originalQS(sel));
          if (sel === '.timeline-track-wrapper') {
              el.addEventListener = (name, cb) => { handlers[name] = cb; };
          }
          return el;
      };

      timeline.afterRender();
      
      assert.ok(handlers.keydown, 'keydownHandler should be assigned');
      must(handlers.keydown)({ key: 'Home', preventDefault: () => {} });
      must(handlers.keydown)({ key: 'End', preventDefault: () => {} });
    });

    test('Arrow keys announce focus', (t) => {
      const announcer = new StubElement({ textContent: '' });
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];
      
      const handlers: Record<string, Listener> = {};
      const originalQS = container.querySelector;
      container.querySelector = (sel) => {
          if (sel === '#timeline-live-announcer') return announcer;
          const el = must(originalQS(sel));
          if (sel === '.timeline-track-wrapper') {
              el.addEventListener = (name, cb) => { handlers[name] = cb; };
          }
          return el;
      };

      const btn1: HTMLElement = mock<HTMLElement>({
          focus: () => { setActive(btn1); },
          getBoundingClientRect: () => mock<DOMRect>({ left: 100, top: 0, width: 50, height: 20 }),
          addEventListener: () => {},
          removeEventListener: () => {}
      });
      const btn2: HTMLElement = mock<HTMLElement>({
          focus: () => { setActive(btn2); },
          getAttribute: (name: string) => name === 'aria-label' ? '2021, 5 posts' : null,
          getBoundingClientRect: () => mock<DOMRect>({ left: 500, top: 0, width: 50, height: 20 }),
          addEventListener: () => {},
          removeEventListener: () => {}
      });
      timeline.$$ = () => nodeList([btn1, btn2]);
      setActive(btn1);

      timeline.afterRender();
      
      assert.ok(handlers.keydown, 'keydownHandler should be assigned');
      must(handlers.keydown)({ key: 'ArrowRight', preventDefault: () => {} });
      
      assert.strictEqual(document.activeElement, btn2);
      assert.strictEqual(announcer.textContent, '2021, 5 posts');
    });

    test('Popover has role dialog and focus management', async (t) => {
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2021, slug: '2021', post_count: 5 }];

      let focused = false;
      const pillEl = asElement(new StubElement({
          getBoundingClientRect: () => ({ top: 100, left: 100, width: 50, height: 20 }),
          querySelector: () => new StubElement({ focus: () => { focused = true; } })
      }));

      const originalCreateElement = document.createElement;
      let popover: HTMLElement | undefined;
      document.createElement = (tag: string) => {
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
      assert.strictEqual(must(popover).getAttribute('role'), 'dialog');
      
      timeline._closePopover();
      assert.strictEqual(timeline.state.popover, null);
      assert.ok(focused, 'Focus should return to trigger element');
      
      document.createElement = originalCreateElement;
    });
  });

  describe('Haptic Feedback', () => {
    beforeEach(() => {
      vibrateCalls = [];
      prefersReducedMotion = false;
    });

    test('vibrates on snap when centered item changes', () => {
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline.state.pills = [{ year: 2020, post_count: 5 }];
      timeline.state.extent = { min: 2000, max: 2040 };
      
      // Mock _findCenteredItem to return a pill
      timeline._findCenteredItem = () => mock<CenteredItem>({ type: 'pill', year: 2020 });
      timeline._centerOnYear = () => {};

      // First snap (from null to 2020) - should NOT vibrate
      timeline._snapToCenterPill();
      assert.strictEqual(vibrateCalls.length, 0, 'Should not vibrate on first snap');
      assert.strictEqual(timeline._lastCenteredYear, 2020);

      // Second snap to different year
      timeline._findCenteredItem = () => mock<CenteredItem>({ type: 'pill', year: 2021 });
      timeline._snapToCenterPill();
      assert.strictEqual(vibrateCalls.length, 1, 'Should vibrate on year change');
      assert.strictEqual(vibrateCalls[0], 10);
      assert.strictEqual(timeline._lastCenteredYear, 2021);

      // Third snap to SAME year
      timeline._snapToCenterPill();
      assert.strictEqual(vibrateCalls.length, 1, 'Should not vibrate if year is same');
    });

    test('respects prefers-reduced-motion', () => {
      prefersReducedMotion = true;
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline._lastCenteredYear = 2020;
      timeline._centerOnYear = () => {};
      timeline._findCenteredItem = () => mock<CenteredItem>({ type: 'pill', year: 2021 });

      timeline._snapToCenterPill();
      assert.strictEqual(vibrateCalls.length, 0, 'Should not vibrate when reduced motion is on');
    });
  });

  describe('Touch Gestures', () => {
    // Builds a wired-up timeline whose track elements report `rectLeft` as their
    // viewport offset, then exposes the live GestureController callbacks.
    function makeTimeline(rectLeft = 0) {
      const customContainer = new StubElement({
        querySelector: () => trackStub(rectLeft),
        querySelectorAll: () => [],
      });
      const timeline = new Timeline(asElement(customContainer), { mode: 'filter', onRangeChange: () => {} });
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

      const opts = must(timeline._gestureController)._opts;
      must(opts.onSwipeMove)(2, 80); // predominantly vertical
      assert.strictEqual(panned, false, 'vertical swipe must not pan the timeline');

      must(opts.onSwipeCommit)('down');
      assert.strictEqual(momentum, false, 'vertical commit must not start momentum');
      assert.strictEqual(emitted, false, 'vertical swipe must not emit a range change');
    });

    test('horizontal swipe pans the timeline', () => {
      const timeline = makeTimeline();
      let panArg = null;
      timeline._onPan = (dx) => { panArg = dx; };

      must(must(timeline._gestureController)._opts.onSwipeMove)(80, 5);
      assert.strictEqual(panArg, 80, 'horizontal swipe should pan by dx');
    });

    test('horizontal commit drives momentum', () => {
      const timeline = makeTimeline();
      let momentum = false;
      timeline._applyMomentum = () => { momentum = true; };

      must(must(timeline._gestureController)._opts.onSwipeCommit)('left');
      assert.strictEqual(momentum, true, 'horizontal commit should start momentum');
    });

    test('pinch zoom anchors relative to the track, not the viewport', () => {
      const timeline = makeTimeline(200); // track sits 200px from the viewport left
      let anchor = null;
      timeline._onZoom = (_scale, anchorX) => { anchor = anchorX; };

      must(must(timeline._gestureController)._opts.onPinchMove)(1.2, 300, 0); // pinch center at clientX 300
      assert.strictEqual(anchor, 100, 'anchor should be clientX minus the track left offset');
    });
  });

  describe('Density histogram', () => {
    // Capture the html written into the histogram mount and pull out each bar's
    // `left:` pixel position so we can assert the bars actually spread out.
    function renderHistogram(timeline: TimelineInstance) {
      const mount = new StubElement();
      const host = asStub(timeline.container);
      const originalQS = host.querySelector;
      host.querySelector = (sel) =>
        sel === '#histogram-mount' ? mount : originalQS.call(host, sel);

      const trackWidth = 1000;
      const { extent, zoom, panX } = timeline.state;
      const EDGE_PAD = 48;
      const getX = (year: number) => {
        if (extent.max === extent.min) return trackWidth / 2;
        const progress = (year - extent.min) / (extent.max - extent.min);
        return EDGE_PAD + progress * (trackWidth - 2 * EDGE_PAD) * zoom + panX;
      };
      timeline._layout();
      timeline._updateHistogram(trackWidth, getX);
      host.querySelector = originalQS;

      return [...mount.innerHTML.matchAll(/left:\s*([\d.]+)px/g)].map((m) =>
        parseFloat(m[1] ?? ''),
      );
    }

    function fourYearTimeline() {
      const timeline = new Timeline(asElement(container), props);
      timeline.state.isLoading = false;
      timeline.state.pills = [
        { year: 2018, name: '2018', slug: '2018', post_count: 3 },
        { year: 2019, name: '2019', slug: '2019', post_count: 8 },
        { year: 2020, name: '2020', slug: '2020', post_count: 5 },
        { year: 2021, name: '2021', slug: '2021', post_count: 2 },
      ];
      timeline.state.extent = { min: 2018, max: 2021 };
      timeline.state.panX = 0;
      return timeline;
    }

    test('spreads bars across the full extent in the collapsed state', () => {
      const timeline = fourYearTimeline();
      // Collapsed: zoom ~0, so the shared getX maps every year onto the center pixel.
      timeline.state.zoom = 0.0001;

      const positions = renderHistogram(timeline);
      assert.strictEqual(positions.length, 4, 'all four years should render a bar');
      const unique = new Set(positions);
      assert.strictEqual(unique.size, 4, 'collapsed bars must not stack onto one pixel');
      // Spread monotonically left→right across the track, not piled at center (~500).
      assert.deepStrictEqual([...positions], [...positions].sort((a, b) => a - b));
      assert.ok(positions[positions.length - 1] - positions[0] > 400, 'bars should span the width');
    });

    test('uses the live projection when zoomed in', () => {
      const timeline = fourYearTimeline();
      timeline.state.zoom = 1; // not collapsed → bars follow getX

      const positions = renderHistogram(timeline);
      assert.strictEqual(positions.length, 4);
      assert.strictEqual(new Set(positions).size, 4, 'zoomed bars track their year positions');
    });
  });

  describe('Tag names are never parsed as markup', () => {
    // Tag names and slugs come from user content, so any path that puts them on
    // the page has to treat them as text — an injected <img onerror> in a tag
    // name must render as characters, not run.
    const XSS = '<img src=x onerror="alert(1)">';

    test('pill labels go through textContent, not innerHTML', () => {
      const timeline = new Timeline(asElement(container), props);
      const btn = timeline._makePillBtn(mock<PillInfo>({
        type: 'pill',
        data: mock<TimelinePill>({ year: 2020, name: XSS, slug: 'evil', post_count: 1 }),
      }));

      assert.strictEqual(btn.textContent, XSS, 'the name should land as literal text');
      assert.strictEqual(btn.innerHTML, undefined, 'nothing may be written as markup');
    });

    test('cluster labels go through textContent, not innerHTML', () => {
      const timeline = new Timeline(asElement(container), props);
      const btn = timeline._makePillBtn(mock<PillInfo>({
        type: 'cluster',
        data: { label: XSS, minYear: 2018, maxYear: 2020, pills: [] },
      }));

      assert.strictEqual(btn.textContent, XSS);
      assert.strictEqual(btn.innerHTML, undefined);
    });

    test('the cluster popover escapes pill names and slugs', () => {
      const timeline = new Timeline(asElement(container), props);
      timeline.state.pills = [];
      const trigger = document.createElement('button');

      timeline._openClusterPopover(trigger, [
        mock<TimelinePill>({ name: XSS, slug: '" onclick="alert(1)', year: 2020, post_count: 1 }),
      ]);

      const html = timeline.state.popover.innerHTML;
      assert.ok(!html.includes('<img'), 'the tag name must not reach the DOM as a tag');
      assert.ok(html.includes('&lt;img'), 'the name should still be shown, escaped');

      const slugAttr = html.match(/data-slug="([^"]*)"/);
      assert.ok(slugAttr, 'the slug should stay inside one quoted attribute');
      assert.ok(
        !slugAttr[1]?.includes('"') && slugAttr[1]?.includes('&quot;'),
        'a quote in the slug must not break out of the attribute',
      );
    });
  });
});
