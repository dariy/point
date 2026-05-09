import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import '../src/utils/PointBus.js';

describe('BaseWebComponent', () => {
  let BaseWebComponent;

  before(async () => {
    // Mock CustomElementRegistry
    global.customElements = {
      define: () => {}
    };
    // Mock HTMLElement
    global.HTMLElement = class {
      constructor() {
        this.attachShadow = () => ({
          innerHTML: ''
        });
      }
    };

    const mod = await import('../src/components/BaseWebComponent.js');
    BaseWebComponent = mod.BaseWebComponent;
  });

  test('should subscribe and unsubscribe from PointBus in lifecycle', () => {
    let received = null;
    class TestComp extends BaseWebComponent {
      render() { return '<div></div>'; }
    }

    const comp = new TestComp();
    comp.subscribeBus('test:event', (data) => {
      received = data;
    });

    // Simulate mount
    comp.connectedCallback();
    window.Point.emit('test:event', 'foo');
    assert.strictEqual(received, 'foo');

    // Simulate unmount
    comp.disconnectedCallback();
    received = null;
    window.Point.emit('test:event', 'bar');
    assert.strictEqual(received, null);
  });
});
