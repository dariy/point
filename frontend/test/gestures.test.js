import { test, describe, before } from "node:test";
import assert from "node:assert";
import "../src/utils/PointBus.js";

describe("GestureController", () => {
  let GestureController;
  let mockElement;

  before(async () => {
    mockElement = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const mod = await import("../src/utils/gestures.js");
    GestureController = mod.GestureController;
  });

  test("should initialize touchmove listener with passive: false", () => {
    const listeners = [];
    mockElement.addEventListener = (event, handler, options) => {
      listeners.push({ event, options });
    };

    new GestureController(mockElement);

    // We specifically want to verify touchmove is NOT passive because it calls preventDefault()
    const touchmove = listeners.find((l) => l.event === "touchmove");
    assert.strictEqual(touchmove.options.passive, false);
  });
});
