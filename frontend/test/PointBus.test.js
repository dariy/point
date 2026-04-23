import { test, describe } from 'node:test';
import assert from 'node:assert';
import '../src/utils/PointBus.js'; // This will attach to global.window.Point in the test env

describe('PointBus', () => {
  test('should emit and receive events', () => {
    let received = null;
    window.Point.on('test:event', (data) => {
      received = data;
    });

    window.Point.emit('test:event', { foo: 'bar' });
    assert.deepStrictEqual(received, { foo: 'bar' });
  });

  test('should unsubscribe from events', () => {
    let count = 0;
    const handler = () => count++;

    window.Point.on('test:unsub', handler);
    window.Point.emit('test:unsub');
    assert.strictEqual(count, 1);

    window.Point.off('test:unsub', handler);
    window.Point.emit('test:unsub');
    assert.strictEqual(count, 1);
  });

  test('should support multiple listeners', () => {
    let a = false, b = false;
    window.Point.on('test:multi', () => a = true);
    window.Point.on('test:multi', () => b = true);

    window.Point.emit('test:multi');
    assert.strictEqual(a, true);
    assert.strictEqual(b, true);
  });
});
