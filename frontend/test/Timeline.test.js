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
          if (tag === 'canvas') {
              return { getContext: () => ({ measureText: () => ({ width: 50 }) }), font: '' };
          }
          return {
            appendChild: () => {},
            remove: () => {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelector: () => null,
            querySelectorAll: () => [],
            dataset: {},
            style: {},
            setAttribute: () => {},
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 100 }),
            children: []
          };
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
      matchMedia: () => ({ matches: false }),
      scrollY: 0,
      innerWidth: 1024,
      performance: { now: () => Date.now() },
      requestAnimationFrame: (cb) => setTimeout(cb, 16),
      cancelAnimationFrame: (id) => clearTimeout(id)
    };
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };

    // Mock API
    // (Skipping direct assignment to read-only module export)

    const mod = await import('../src/components/public/Timeline.js');
    Timeline = mod.Timeline;
  });

  beforeEach(() => {
    container = {
      querySelector: (selector) => {
          if (selector === '.timeline-track') return { clientWidth: 1000 };
          if (selector === '.timeline-track-wrapper') return { 
              addEventListener: () => {},
              getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 100 }),
              classList: { add: () => {}, remove: () => {} }
          };
          return {
              appendChild: () => {},
              innerHTML: '',
              children: []
          };
      },
      querySelectorAll: () => []
    };
    props = {
        mode: 'filter',
        onRangeChange: () => {}
    };
  });

  test('should emit range change while dragging if mode is filter', (t, done) => {
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
    // Mock getX and lastCollision so emitRange works
    timeline._getX = (y) => 500;
    timeline._lastCollision = { visible: timeline.state.pills, clusters: [] };

    let emitted = false;
    timeline.props.onRangeChange = () => { emitted = true; };

    timeline._isDragging = true;
    timeline._debounceEmitRange();

    setTimeout(() => {
        try {
            assert.strictEqual(emitted, true, 'Should emit even while dragging');
            done();
        } catch (e) {
            done(e);
        }
    }, 300);
  });

  test('should throttle live updates during drag', (t, done) => {
    const timeline = new Timeline(container, props);
    timeline.state.isLoading = false;
    timeline.state.pills = [
        { year: 2021, name: '2021', slug: '2021', post_count: 1 }
    ];
    timeline.state.extent = { min: 2021, max: 2021 };
    timeline._getX = () => 500;
    timeline._lastCollision = { visible: timeline.state.pills, clusters: [] };

    let emittedCount = 0;
    timeline.props.onRangeChange = () => { emittedCount++; };

    timeline._isDragging = true;
    
    // Call multiple times rapidly
    timeline._debounceEmitRange(); // 1st call (immediate live emit)
    timeline._debounceEmitRange(); // 2nd call (throttled)
    timeline._debounceEmitRange(); // 3rd call (throttled)

    setTimeout(() => {
        try {
            // Should have 1 from immediate live emit, and 1 from the final debounce timeout
            assert.strictEqual(emittedCount, 2, 'Should throttle to 2 emissions (1 live + 1 final)');
            done();
        } catch (e) {
            done(e);
        }
    }, 300);
  });
});
