// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import test from "node:test";
import assert from "node:assert/strict";
import { linkify as _linkify } from "../src/utils/helpers.js";

// linkify returns the RawHtml html`` produces; assert.equal wants a primitive.
const linkify = (...a) => String(_linkify(...a));
import { beforeEach, afterEach } from "node:test";
import { setupDOM } from "./helpers/dom.js";

test("helpers", async (t) => {
  let dom;
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
    const { debounce } = await import("../src/utils/helpers.js");
    const fn = debounce(() => count++, 10);
    fn();
    fn();
    fn();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(count, 1);
  });

  await t.test("throttle", async (t) => {
    let count = 0;
    const { throttle } = await import("../src/utils/helpers.js");
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
    const { createElement } = await import("../src/utils/helpers.js");
    const el = createElement("div", { id: "test", class: "foo" }, "hello");
    assert.equal(el.tagName, "DIV");
    assert.equal(el.id, "test");
    assert.equal(el.className, "foo");
    assert.equal(el.textContent, "hello");
  });

  await t.test("clearElement", async (t) => {
    const { clearElement } = await import("../src/utils/helpers.js");
    const el = document.createElement("div");
    el.innerHTML = "<span>hello</span>";
    clearElement(el);
    assert.equal(el.innerHTML, "");
  });

  await t.test("dropBrokenImages", async (t) => {
    const { dropBrokenImages } = await import("../src/utils/helpers.js");
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
    const { navigate } = await import("../src/utils/helpers.js");
    let navEvent = null;
    const handler = (e) => navEvent = e.detail;
    window.addEventListener("app:navigate", handler);
    navigate("/foo", { replace: true });
    window.removeEventListener("app:navigate", handler);
    assert.deepEqual(navEvent, { path: "/foo", replace: true });
  });

  await t.test("setCanonical / removeCanonical", async (t) => {
    const { setCanonical, removeCanonical } = await import("../src/utils/helpers.js");
    setCanonical("https://example.com/foo");
    let link = document.querySelector('link[rel="canonical"]');
    assert.ok(link);
    assert.equal(link.getAttribute("href"), "https://example.com/foo");
    
    setCanonical("https://example.com/bar");
    link = document.querySelector('link[rel="canonical"]');
    assert.equal(link.getAttribute("href"), "https://example.com/bar");
    
    removeCanonical();
    assert.ok(!document.querySelector('link[rel="canonical"]'));
  });

  await t.test("normalizeSettings", async (t) => {
    const { normalizeSettings } = await import("../src/utils/helpers.js");
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
});
