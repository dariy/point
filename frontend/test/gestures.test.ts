import { test, describe, before } from "node:test";
import assert from "node:assert";
import type { GestureOptions, SwipeDir } from "../src/core/gestures.ts";
import { mock } from "./helpers/mock.ts";

type Handler = (event: Event) => void;

describe("GestureController", () => {
  let GestureController: typeof import("../src/core/gestures.ts").GestureController;
  let mockElement: HTMLElement;

  before(async () => {
    mockElement = mock<HTMLElement>({
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    if (typeof globalThis.window === "undefined") {
      globalThis.window = mock<typeof window>({ innerWidth: 1000 });
    }
    const mod = await import("../src/core/gestures.ts");
    GestureController = mod.GestureController;
  });

  test("should initialize touchmove listener with passive: false", () => {
    const listeners: { event: string; options?: boolean | AddEventListenerOptions }[] = [];
    mockElement.addEventListener = (event: string, _handler: unknown, options?: boolean | AddEventListenerOptions) => {
      listeners.push({ event, options });
    };

    new GestureController(mockElement);

    // We specifically want to verify touchmove is NOT passive because it calls preventDefault()
    const touchmove = listeners.find((l) => l.event === "touchmove");
    const options = touchmove?.options;
    assert.strictEqual(typeof options === "object" && options.passive, false);
  });

  describe("direction classification", () => {
    /** Build a controller wired to captured handlers + a record of emitted events. */
    function makeController(opts: GestureOptions = {}) {
      const handlers: Record<string, Handler> = {};
      const el = mock<HTMLElement>({
        addEventListener: (event: string, handler: Handler) => {
          handlers[event] = handler;
        },
        removeEventListener: () => {},
      });
      const commits: SwipeDir[] = [];
      const moves: [number, number][] = [];
      let cancelled = 0;
      const controller = new GestureController(el, {
        onSwipeCommit: (dir) => commits.push(dir),
        onSwipeMove: (dx, dy) => moves.push([dx, dy]),
        onSwipeCancel: () => {
          cancelled += 1;
        },
        ...opts,
      });
      return { controller, handlers, commits, moves, get cancelled() { return cancelled; } };
    }

    const touch = (x: number, y: number) => mock<Touch>({ clientX: x, clientY: y });
    const touchList = (...touches: Touch[]) => mock<TouchList>(Object.assign(touches, { item: (i: number) => touches[i] ?? null }));
    const moveEvent = (x: number, y: number) => mock<TouchEvent>({
      touches: touchList(touch(x, y)),
      cancelable: true,
      preventDefault() {},
    });

    /** Simulate a full drag from a centred start point to (start+dx, start+dy). */
    function drag({ commits, handlers }: ReturnType<typeof makeController>, dx: number, dy: number) {
      const sx = 500;
      const sy = 500;
      handlers.touchstart(mock<TouchEvent>({ touches: touchList(touch(sx, sy)), target: mock<Element>({ closest: () => null }) }));
      // A couple of incremental moves so commitment logic engages.
      handlers.touchmove(moveEvent(sx + dx / 2, sy + dy / 2));
      handlers.touchmove(moveEvent(sx + dx, sy + dy));
      handlers.touchend(mock<TouchEvent>({ changedTouches: touchList(touch(sx + dx, sy + dy)) }));
      return commits;
    }

    test("mostly horizontal drag commits a horizontal swipe", () => {
      const ctx = makeController();
      drag(ctx, -120, 20);
      assert.deepStrictEqual(ctx.commits, ["left"]);
    });

    test("mostly vertical drag commits a vertical swipe", () => {
      const ctx = makeController();
      drag(ctx, 20, -120);
      assert.deepStrictEqual(ctx.commits, ["up"]);
    });

    test("mostly diagonal drag fires no swipe action", () => {
      const ctx = makeController();
      drag(ctx, 100, 100); // 45° — neither axis dominates
      assert.deepStrictEqual(ctx.commits, []);
    });

    test("near-diagonal lean stays diagonal (does not flip horizontally)", () => {
      const ctx = makeController();
      // dx only 1.2× dy — below the 1.3 dominance ratio, so it is diagonal.
      drag(ctx, 120, 100);
      assert.deepStrictEqual(ctx.commits, []);
    });
  });
});
