import test from "node:test";
import assert from "node:assert/strict";
import { linkify as _linkify } from "../src/utils/helpers.ts";

// linkify returns the RawHtml html`` produces; assert.equal wants a primitive.
const linkify = (...a: Parameters<typeof _linkify>) => String(_linkify(...a));
import { beforeEach, afterEach } from "node:test";
import { setupDOM } from "./helpers/dom.ts";

test("helpers", async (t) => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  await t.test("linkify", async (t) => {
    await t.test("turns http/https links into html tags", () => {
      assert.equal(
        linkify("check out http://example.com/foo"),
        'check out <a href="http://example.com/foo" target="_blank" rel="noopener noreferrer">http://example.com/foo</a>'
      );
      assert.equal(
        linkify("and https://example.com"),
        'and <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>'
      );
    });

    await t.test("trims trailing punctuation", () => {
      assert.equal(
        linkify("go to https://example.com."),
        'go to <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>.'
      );
      assert.equal(
        linkify("link: https://example.com,"),
        'link: <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>,'
      );
      assert.equal(
        linkify("(https://example.com)"),
        '(<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>)'
      );
    });

    await t.test("escapes non-link content", () => {
      assert.equal(
        linkify("<script>alert(1)</script> https://example.com"),
        '&lt;script&gt;alert(1)&lt;/script&gt; <a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>'
      );
    });

    await t.test("adds https prefix if domain has no protocol but has www", () => {
      assert.equal(
        linkify("www.example.com/foo"),
        '<a href="https://www.example.com/foo" target="_blank" rel="noopener noreferrer">www.example.com/foo</a>'
      );
    });
});

  await t.test("debounce", async (t) => {
    let count = 0;
    const { debounce } = await import("../src/utils/helpers.ts");
    const fn = debounce(() => count++, 10);
    fn();
    fn();
    fn();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(count, 1);
  });

  await t.test("throttle", async (t) => {
    let count = 0;
    const { throttle } = await import("../src/utils/helpers.ts");
    const fn = throttle(() => count++, 10);
    fn(); // executes immediately
    fn(); // ignored
    fn(); // ignored
    assert.equal(count, 1);
    await new Promise(r => setTimeout(r, 20));
    fn(); // executes
    assert.equal(count, 2);
  });

  await t.test("createElement", async (t) => {
    const { createElement } = await import("../src/utils/helpers.ts");
    const el = createElement("div", { id: "test", class: "foo" }, "hello");
    assert.equal(el.tagName, "DIV");
    assert.equal(el.id, "test");
    assert.equal(el.className, "foo");
    assert.equal(el.textContent, "hello");
  });

  await t.test("clearElement", async (t) => {
    const { clearElement } = await import("../src/utils/helpers.ts");
    const el = document.createElement("div");
    el.innerHTML = "<span>hello</span>";
    clearElement(el);
    assert.equal(el.innerHTML, "");
  });

  await t.test("dropBrokenImages", async (t) => {
    const { dropBrokenImages } = await import("../src/utils/helpers.ts");
    const root = document.createElement("div");
    const img = document.createElement("img");
    root.appendChild(img);
    document.body.appendChild(root);
    dropBrokenImages(root);
    img.dispatchEvent(new Event("error", { bubbles: true }));
    assert.equal(root.innerHTML, "");
    root.remove();
  });

  await t.test("navigate", async (t) => {
    const { navigate } = await import("../src/utils/helpers.ts");
    let navEvent: unknown = null;
    const handler = (e: Event) => navEvent = (e as CustomEvent).detail;
    window.addEventListener("app:navigate", handler);
    navigate("/foo", { replace: true });
    assert.deepEqual(navEvent, { path: "/foo", replace: true });
    navigate("/tags/paris?view=map", { state: { fromPost: "a-post", sheet: "open" } });
    window.removeEventListener("app:navigate", handler);
    assert.deepEqual(navEvent, { path: "/tags/paris?view=map", replace: false, state: { fromPost: "a-post", sheet: "open" } });
  });

  await t.test("setCanonical / removeCanonical", async (t) => {
    const { setCanonical, removeCanonical } = await import("../src/utils/helpers.ts");
    setCanonical("https://example.com/foo");
    let link = document.querySelector('link[rel="canonical"]');
    assert.ok(link);
    assert.equal(link.getAttribute("href"), "https://example.com/foo");
    
    setCanonical("https://example.com/bar");
    link = document.querySelector('link[rel="canonical"]');
    assert.equal(link?.getAttribute("href"), "https://example.com/bar");
    
    removeCanonical();
    assert.ok(!document.querySelector('link[rel="canonical"]'));
  });

  await t.test("normalizeSettings", async (t) => {
    const { normalizeSettings } = await import("../src/utils/helpers.ts");
    assert.deepEqual(normalizeSettings({}), {});
    assert.deepEqual(normalizeSettings({ 
      posts_per_page: "10", 
      enable_comments: "true",
      show_author: "0",
      normal_string: "hello"
    }), {
      posts_per_page: 10,
      enable_comments: true,
      show_author: false,
      normal_string: "hello"
    });
  });
  await t.test("setupLongPress", async (t) => {
    const { setupLongPress } = await import("../src/utils/helpers.ts");
    const { PRESS_SLOP_PX } = await import("../src/utils/pointerMode.ts");
    const { fire } = await import("./helpers/dom.ts");

    /** A link with a press on it; `fired` counts the presses that fired. */
    const mount = () => {
      const el = document.createElement("a");
      el.setAttribute("href", "/tags/kyoto");
      document.body.appendChild(el);
      const state = { fired: 0, clicks: 0 };
      el.addEventListener("click", () => { state.clicks++; });
      const cleanup = setupLongPress(el, () => { state.fired++; }, { delay: 400 });
      return { el, state, cleanup };
    };
    const pen = { pointerType: "pen", pointerId: 7, button: 0 };
    /**
     * A click as a browser delivers it. linkedom has no capture phase, so the
     * document's capture listeners would run last; this runs them first, and
     * goes on to `el` only when they did not stop the event.
     */
    const clickFrom = (el: Element, detail: number) => {
      const evt = new globalThis.Event("click", { cancelable: true });
      Object.assign(evt, { detail });
      document.dispatchEvent(evt);
      if (!evt.cancelBubble) fire(el, "click", { detail });
      return evt;
    };

    assert.equal(PRESS_SLOP_PX, 10);

    await t.test("a pen press that moves 4 px fires", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", { ...pen, clientX: 100, clientY: 100 });
      fire(el, "pointermove", { ...pen, clientX: 104, clientY: 100 });
      t.mock.timers.tick(400);
      assert.equal(state.fired, 1);
    });

    await t.test("a pen press that moves 12 px is cancelled", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", { ...pen, clientX: 100, clientY: 100 });
      fire(el, "pointermove", { ...pen, clientX: 112, clientY: 100 });
      t.mock.timers.tick(400);
      assert.equal(state.fired, 0);
    });

    await t.test("only the pointer that started the press can move or end it", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", { ...pen, clientX: 100, clientY: 100 });
      fire(el, "pointermove", { ...pen, pointerId: 8, clientX: 200, clientY: 100 });
      fire(el, "pointerup", { ...pen, pointerId: 8 });
      t.mock.timers.tick(400);
      assert.equal(state.fired, 1);
    });

    await t.test("pointerup and pointercancel cancel the press", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", pen);
      fire(el, "pointerup", pen);
      fire(el, "pointerdown", pen);
      fire(el, "pointercancel", pen);
      t.mock.timers.tick(400);
      assert.equal(state.fired, 0);
    });

    await t.test("a touch or pen press blocks the system menu; a mouse right-click keeps it", () => {
      const { el } = mount();
      fire(el, "pointerdown", pen);
      assert.equal(fire(el, "contextmenu").defaultPrevented, true);
      fire(el, "pointerdown", { pointerType: "touch", pointerId: 1, button: 0 });
      assert.equal(fire(el, "contextmenu").defaultPrevented, true);
      fire(el, "pointerdown", { pointerType: "mouse", pointerId: 1, button: 2 });
      assert.equal(fire(el, "contextmenu", { pointerType: "mouse" }).defaultPrevented, false);
    });

    await t.test("a mouse right-click does not start a press", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", { pointerType: "mouse", pointerId: 1, button: 2 });
      t.mock.timers.tick(400);
      assert.equal(state.fired, 0);
    });

    await t.test("the click that ends a fired press is cancelled; the next tap is not", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", pen);
      t.mock.timers.tick(400);
      fire(el, "pointerup", pen);
      const ending = clickFrom(el, 1);
      assert.equal(state.fired, 1);
      assert.equal(state.clicks, 0, "no click handler runs");
      assert.equal(ending.defaultPrevented, true, "the link does not navigate");

      fire(el, "pointerdown", pen);
      fire(el, "pointerup", pen);
      const tap = clickFrom(el, 1);
      assert.equal(state.clicks, 1);
      assert.equal(tap.defaultPrevented, false);
    });

    await t.test("a lift with no click does not cost the next tap", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", pen);
      t.mock.timers.tick(400);
      fire(el, "pointercancel", pen);
      const other = document.createElement("button");
      document.body.appendChild(other);
      fire(other, "pointerdown", pen);
      const tap = clickFrom(el, 1);
      assert.equal(state.clicks, 1);
      assert.equal(tap.defaultPrevented, false);
    });

    await t.test("a keyboard click is never cancelled", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state } = mount();
      fire(el, "pointerdown", pen);
      t.mock.timers.tick(400);
      clickFrom(el, 0);
      assert.equal(state.clicks, 1);
    });

    await t.test("the element shows no iOS callout", () => {
      const { el } = mount();
      assert.equal(el.style.getPropertyValue("-webkit-touch-callout"), "none");
    });

    await t.test("cleanup removes the press", (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { el, state, cleanup } = mount();
      cleanup();
      fire(el, "pointerdown", pen);
      t.mock.timers.tick(400);
      assert.equal(state.fired, 0);
    });
  });
});
