#!/usr/bin/env node
/**
 * Acceptance test for the static demo.
 *
 * Walks every route with a real browser against a statically-served build and
 * fails on:
 *
 *   1. ANY request to /api/ — the demo's defining property is that it needs no
 *      backend, and a single leaked call means some path still expects one.
 *   2. Console errors.
 *   3. Being bounced to /light/login while authenticated, which is what happens
 *      when a handler returns 401: client.js raises api:unauthorized and app.js
 *      escalates it to a hard navigation.
 *
 * Run against a served build with the backend STOPPED:
 *   npx serve -s demo/dist -l 3000
 *   node demo/scripts/test.mjs --base=http://localhost:3000
 */

import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://localhost:3000";

const PUBLIC_ROUTES = ["/", "/tags", "/search"];
const ADMIN_ROUTES = [
  "/light",
  "/light/posts",
  "/light/posts/new",
  "/light/media",
  "/light/tags",
  "/light/themes",
  "/light/plugins",
  "/light/settings",
  "/light/security",
  "/light/system",
];

// Console noise that is expected and not a defect.
const IGNORED_CONSOLE = [
  /Failed to load resource.*404/i, // media intentionally absent from the build
  /favicon/i,
];

const failures = [];
const apiCalls = [];

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/") || path.startsWith("/comments/")) {
      apiCalls.push(`${req.method()} ${path}`);
    }
  });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => consoleErrors.push(`uncaught: ${err.message}`));

  const visit = async (route, { expectAdmin = false } = {}) => {
    consoleErrors.length = 0;
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30000 });
    // Give lazily-imported page chunks a moment to mount and fetch.
    await page.waitForTimeout(700);

    const landed = new URL(page.url()).pathname;
    if (expectAdmin && landed === "/light/login") {
      failures.push(`${route} → bounced to /light/login (a handler returned 401)`);
    }

    const bodyText = (await page.locator("#app").innerText().catch(() => "")).trim();
    if (bodyText.length === 0) {
      failures.push(`${route} → #app rendered empty`);
    }
    if (/Failed to start the application/i.test(bodyText)) {
      failures.push(`${route} → bootstrap failed`);
    }

    for (const err of consoleErrors) {
      failures.push(`${route} → console error: ${err.slice(0, 200)}`);
    }

    console.log(
      `  ${failures.length ? " " : "✓"} ${route.padEnd(22)} ${landed.padEnd(22)} ${bodyText.slice(0, 48).replace(/\s+/g, " ")}`,
    );
  };

  console.log(`\nPublic routes (logged out)`);
  for (const route of PUBLIC_ROUTES) await visit(route);

  // Open a post from the grid. Cards are <article role="button"> with click
  // handlers and CSS background images — not anchors and not <img> — so this
  // has to click one rather than read an href.
  console.log(`\nPost detail`);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const cards = page.locator("article.post-card");
  const cardCount = await cards.count();
  if (cardCount === 0) {
    failures.push("home page rendered no post cards");
  } else {
    await cards.first().click();
    await page.waitForTimeout(1500);
    const landed = new URL(page.url()).pathname;
    if (!landed.startsWith("/posts/")) {
      failures.push(`clicking a post card went to ${landed}, not /posts/*`);
    } else {
      console.log(`  ✓ ${cardCount} card(s); opened ${landed}`);
      // Reload it to prove the SPA fallback serves a deep-linked nested path.
      await visit(landed);
    }
  }

  console.log(`\nLogin`);
  await page.goto(`${BASE}/light/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const pw = page.locator("#password-input");
  if ((await pw.count()) === 0) {
    failures.push("login page has no password input");
  } else {
    const prefilled = await pw.inputValue();
    if (prefilled !== "demo") {
      failures.push(`login password not prefilled (got "${prefilled}")`);
    }
    await pw.press("Enter");
    await page.waitForTimeout(1200);
    const after = new URL(page.url()).pathname;
    if (after === "/light/login") failures.push("login did not navigate away");
    console.log(`  ✓ logged in → ${after}`);
  }

  console.log(`\nAdmin routes (logged in)`);
  for (const route of ADMIN_ROUTES) await visit(route, { expectAdmin: true });

  // ── Mutation round-trip ────────────────────────────────────────────────
  //
  // The demo claims edits take effect. Verify one end to end rather than
  // trusting the handler in isolation.
  console.log(`\nMutation round-trip`);
  await page.goto(`${BASE}/light/tags`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const tagCountBefore = await page.evaluate(async () => {
    const res = await fetch("/api/tags");
    return (await res.json()).tags.length;
  });
  const created = await page.evaluate(async () => {
    const res = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo Round Trip" }),
    });
    return res.json();
  });
  const tagCountAfter = await page.evaluate(async () => {
    const res = await fetch("/api/tags");
    return (await res.json()).tags.length;
  });
  if (tagCountAfter !== tagCountBefore + 1) {
    failures.push(
      `tag create did not persist in-memory (${tagCountBefore} → ${tagCountAfter})`,
    );
  } else {
    console.log(`  ✓ created tag #${created.id}, ${tagCountBefore} → ${tagCountAfter}`);
  }

  // ── The post editor loads its post ─────────────────────────────────────
  //
  // The route walk cannot see this: an unhandled endpoint fails soft with an
  // empty 200, so the edit form renders — with every field blank. Assert the
  // fields actually carry the post, which is what `GET /api/posts/:id` is for.
  console.log(`\nPost editor`);
  const editHref = await page.evaluate(async () => {
    const res = await fetch("/api/posts?per_page=1");
    const id = (await res.json()).posts?.[0]?.id;
    return id ? `/light/posts/${id}/edit` : null;
  });
  if (!editHref) {
    failures.push("no post to open in the editor");
  } else {
    await page.goto(`${BASE}${editHref}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const filled = await page.evaluate(() => ({
      title: document.getElementById("title-input")?.value || "",
      slug: document.getElementById("slug-input")?.value || "",
      excerpt: document.getElementById("excerpt-editor")?.value || "",
    }));
    const empty = Object.entries(filled)
      .filter(([, v]) => !v.trim())
      .map(([k]) => k);
    if (empty.length) {
      failures.push(`${editHref} → editor field(s) blank: ${empty.join(", ")}`);
    } else {
      console.log(`  ✓ ${editHref} loaded: "${filled.title}" (${filled.excerpt.length}-char excerpt)`);
    }
  }

  // ── Admin actions that repaint the page ────────────────────────────────
  //
  // Both of these are one click that has to change the page around it, and both
  // are answered by the mock standing in for work the Go server does to files
  // (see demo/README.md). A regression in either is invisible from the route
  // walk above — the page still renders, it just stops responding.
  console.log(`\nAdmin actions`);

  await page.goto(`${BASE}/light/plugins`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const enabledCount = () =>
    page.evaluate(() => document.querySelectorAll(".plugin-card.is-enabled").length);
  const offRegions = () =>
    page.evaluate(() => document.querySelectorAll(".pmap-region.is-off").length);
  const beforePreset = { rows: await enabledCount(), off: await offRegions() };
  await page.locator('.preset-pill:has-text("Minimalistic")').click();
  await page.waitForTimeout(900);
  const afterPreset = { rows: await enabledCount(), off: await offRegions() };
  if (afterPreset.rows >= beforePreset.rows || afterPreset.off <= beforePreset.off) {
    failures.push(
      `applying a preset did not change the catalog or the site map ` +
        `(enabled ${beforePreset.rows}→${afterPreset.rows}, dimmed regions ${beforePreset.off}→${afterPreset.off})`,
    );
  } else {
    console.log(
      `  ✓ preset applied: ${beforePreset.rows}→${afterPreset.rows} enabled, ` +
        `${beforePreset.off}→${afterPreset.off} dimmed map regions`,
    );
  }

  await page.goto(`${BASE}/light/themes`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const themeTitle = () =>
    page.evaluate(
      () =>
        (document.getElementById("point-theme")?.textContent || "").match(
          /theme-title: "([^"]+)"/,
        )?.[1] || "none",
    );
  const beforeTheme = await themeTitle();
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll(".theme-card")]
      .map((c) => c.querySelector(".theme-name")?.textContent.trim())
      .filter(Boolean),
  );
  const other =
    listed.find((n) => n.toLowerCase() !== beforeTheme.toLowerCase()) || null;
  if (!other) {
    failures.push("themes page offered no second theme to activate");
  } else {
    await page.locator(`.theme-card:has-text("${other}") .set-active-btn`).click();
    await page.waitForTimeout(900);
    const afterTheme = await themeTitle();
    if (afterTheme.toLowerCase() !== other.toLowerCase()) {
      failures.push(
        `activating "${other}" left theme.css on "${afterTheme}" — the injected stylesheet did not swap`,
      );
    } else {
      console.log(`  ✓ theme switched live: ${beforeTheme} → ${afterTheme}`);
    }

    // The theme is a site-wide setting, so it has to survive the walk out of
    // the admin to the public site — which is a full page load, and the store
    // is re-seeded by every one of those. Without the stored name the visitor
    // watches their theme revert the moment they go to look at it.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const publicTheme = await themeTitle();
    if (publicTheme.toLowerCase() !== other.toLowerCase()) {
      failures.push(
        `after activating "${other}" the public site loaded "${publicTheme}" — the theme did not survive the page load`,
      );
    } else {
      console.log(`  ✓ theme held on the public site across a full load`);
    }
  }

  // The catalogue is built from frontend/themes/ rather than recorded, so every
  // shipped theme is offered. A missing one means build-themes.mjs did not run
  // and the fixture's frozen list is being served instead.
  const shipped = await page.evaluate(async () => {
    const res = await fetch("/assets/themes/index.json");
    return res.ok ? (await res.json()).map((t) => t.name) : [];
  });
  const offered = new Set(listed.map((n) => n.toLowerCase()));
  const absent = shipped.filter((n) => !offered.has(n.toLowerCase()));
  if (absent.length) {
    failures.push(`themes shipped but not listed: ${absent.join(", ")}`);
  } else {
    console.log(`  ✓ all ${shipped.length} shipped themes offered`);
  }

  await browser.close();

  // ── Report ─────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(66)}`);
  if (apiCalls.length) {
    console.log(`\nFAIL — ${apiCalls.length} network call(s) to the API:`);
    [...new Set(apiCalls)].slice(0, 30).forEach((c) => console.log(`  ${c}`));
  } else {
    console.log(`\nPASS — zero network requests to /api/ or /comments/`);
  }

  if (failures.length) {
    console.log(`\nFAIL — ${failures.length} issue(s):`);
    failures.slice(0, 40).forEach((f) => console.log(`  ${f}`));
  } else {
    console.log(`PASS — all routes rendered, no console errors`);
  }

  process.exit(apiCalls.length || failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
