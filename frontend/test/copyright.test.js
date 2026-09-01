import test from "node:test";
import assert from "node:assert/strict";
import { renderCopyright as render } from "../src/utils/copyright.js";

// renderCopyright returns the RawHtml html`` produces; String() to compare.
const renderCopyright = (settings) => String(render(settings));

test("renderCopyright", async (t) => {
  await t.test("defaults to author with powered by engine", () => {
    const html = renderCopyright({ author_name: "Alice" });
    assert.match(html, /© <a href="\/light">Alice<\/a>, powered by/);
  });

  await t.test("defaults to no author when missing", () => {
    const html = renderCopyright({});
    assert.match(html, /© powered by/);
  });

  await t.test("uses about_post_id for author link", () => {
    const html = renderCopyright({ author_name: "Alice", about_post_id: "123" });
    assert.match(html, /© <a href="\/posts\/123">Alice<\/a>/);
  });

  await t.test("custom template replaces tokens", () => {
    const html = renderCopyright({ author_name: "Bob", footer_copyright: "Hello {{author_name}} from {{engine}}" });
    assert.match(html, /Hello <a href="\/light">Bob<\/a> from <a href="https:\/\/github\.com/);
  });

  await t.test("unknown tokens are left alone but escaped", () => {
    const html = renderCopyright({ footer_copyright: "Hi {{unknown_token}}" });
    assert.equal(html, "Hi {{unknown_token}}");
  });

  await t.test("renders markdown links", () => {
    const html = renderCopyright({ footer_copyright: "[My link](/foo)" });
    assert.equal(html, '<a href="/foo">My link</a>');
  });

  await t.test("renders external links with target=_blank", () => {
    const html = renderCopyright({ footer_copyright: "[External](https://example.com)" });
    assert.equal(html, '<a href="https://example.com" target="_blank" rel="noopener noreferrer">External</a>');
  });

  await t.test("rejects bad urls and renders as literal text", () => {
    const html = renderCopyright({ footer_copyright: "[Bad](javascript:alert(1))" });
    assert.equal(html, "[Bad](javascript:alert(1))");
  });

  await t.test("rejects protocol-relative urls", () => {
    const html = renderCopyright({ footer_copyright: "[Hack](//evil.com)" });
    assert.equal(html, "[Hack](//evil.com)");
  });

  await t.test("an ampersand in a link url is escaped once, not twice", () => {
    const html = renderCopyright({ footer_copyright: "[Shop](https://example.com/?a=1&b=2)" });
    assert.equal(
      html,
      '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Shop</a>',
    );
  });

  await t.test("escapes literal text", () => {
    const html = renderCopyright({ footer_copyright: "<script>alert(1)</script>" });
    assert.equal(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
