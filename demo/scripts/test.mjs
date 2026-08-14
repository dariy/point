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
 *   4. Behaviour the route walk cannot see: an edit surviving the walk out of
 *      the admin (and a reload still resetting it), the scheduled queue left of
 *      page 1, and the hidden posts and place staying hidden — from a guest,
 *      and from the owner with revelio off.
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

/** The demo's hidden place — demo/world.mjs PRIVATE_LOCATION. */
const HIDDEN_TAG = "mirandela";

/** What the client adds to every request with revelio off (utils/revelio.js). */
const REVELIO_OFF = { headers: { "X-Point-Revelio": "off" } };

/**
 * Call the mocked API from inside the page.
 *
 * The mock answers `fetch`, so this exercises the same interception the app
 * does. `withStatus` returns the status alongside the body, for the checks
 * where a 404 is the correct answer rather than a failure.
 */
async function api(page, path, init = {}, withStatus = false) {
  return page.evaluate(
    async ([p, i, s]) => {
      const res = await fetch(p, i);
      const text = await res.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      return s ? { status: res.status, ...body } : body;
    },
    [path, init, withStatus],
  );
}

const pageHasText = (page, text) =>
  page.evaluate((t) => document.body.innerText.includes(t), text);

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

  // ── Edits outlive a page load ──────────────────────────────────────────
  //
  // The store is module state, and the walk from the admin out to the public
  // site is a full page load. Without the content snapshot the visitor's own
  // edit is undone by the very navigation taken to go and look at it — while a
  // reload still has to reset, because that is the demo's way back to pristine.
  console.log(`\nEdit persistence`);
  const target = await api(page, "/api/pages/home");
  const post = target.posts?.[0];
  if (!post) {
    failures.push("home feed returned no post to edit");
  } else {
    const EDITED = "Edited Inside The Demo";
    await api(page, `/api/posts/${post.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: EDITED }),
    });

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    if (!(await pageHasText(page, EDITED))) {
      failures.push(
        `a post renamed in the admin reverted on the walk out to the public site — the edit did not survive the page load`,
      );
    } else {
      console.log(`  ✓ renamed post #${post.id} held across a full load`);
    }

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    if (await pageHasText(page, EDITED)) {
      failures.push("a reload left the edit in place — the demo no longer resets");
    } else {
      console.log(`  ✓ reload re-seeded from the fixture`);
    }
  }

  // ── Hidden content, and the switch that conceals it ────────────────────
  //
  // The archive carries posts a guest may not have — hidden ones, ones filed
  // under the hidden place, and the scheduled queue. Three things have to hold
  // at once: the owner sees them, a guest does not, and the owner can put
  // themselves in the guest's position without logging out (revelio).
  console.log(`\nVisibility`);

  // From pristine. Everything above this point has been logging in, applying a
  // plugin preset and activating themes, and all three outlive a page load on
  // purpose — so the demo's own reset control is what puts a guest back in the
  // browser, with the full plugin set the footer's revelio button lives in.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.__DEMO_RESET__?.());
  await page.waitForTimeout(1600);
  const guest = {
    home: await api(page, "/api/pages/home"),
    tags: await api(page, "/api/tags"),
    hiddenTag: await api(page, `/api/pages/tags/${HIDDEN_TAG}`, {}, true),
    graph: await api(page, "/api/pages/graph"),
  };
  const guestSees = (payload) =>
    (payload.tags || []).some((t) => t.slug === HIDDEN_TAG);

  if (guest.home.pagination?.min_page !== 1) {
    failures.push(
      `a guest's feed reaches page ${guest.home.pagination?.min_page} — the scheduled queue must not exist for them`,
    );
  }
  if (guest.home.posts?.some((p) => p.status !== "published")) {
    failures.push("a guest's feed carried a post that is not published");
  }
  if (guestSees(guest.tags) || guestSees(guest.graph)) {
    failures.push(`the hidden place is listed for a guest (tags or atlas)`);
  }
  if (guest.hiddenTag.status !== 404) {
    failures.push(
      `/tags/${HIDDEN_TAG} answered ${guest.hiddenTag.status} to a guest, want 404`,
    );
  }
  console.log(
    `  ✓ guest: ${guest.home.pagination?.total} post(s), no queue, no hidden place`,
  );

  // Logged in.
  await page.goto(`${BASE}/light/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator("#password-input").press("Enter");
  await page.waitForTimeout(1200);

  const owner = {
    home: await api(page, "/api/pages/home"),
    queue: await api(page, "/api/pages/home?page=0"),
    tags: await api(page, "/api/tags"),
    graph: await api(page, "/api/pages/graph"),
  };
  if (!(owner.home.pagination?.total > guest.home.pagination?.total)) {
    failures.push(
      `the owner's feed holds ${owner.home.pagination?.total} post(s) and a guest's ${guest.home.pagination?.total} — the hidden ones are not being revealed`,
    );
  }
  if (owner.home.pagination?.min_page !== 0) {
    failures.push(
      `the owner's feed reports min_page ${owner.home.pagination?.min_page}, so the paginator cannot reach the queue`,
    );
  }
  if (!owner.queue.pagination?.scheduled || !owner.queue.posts?.length) {
    failures.push("page 0 did not return the scheduled queue");
  } else {
    const dates = owner.queue.posts.map((p) => p.scheduled_at);
    const sorted = [...dates].sort();
    if (dates.join() !== sorted.join()) {
      failures.push(`the queue is not soonest-first: ${dates.join(" ")}`);
    }
    if (dates.some((d) => !d)) {
      failures.push("a queued post has no scheduled_at, so its card cannot be dated");
    }
    console.log(`  ✓ owner: queue of ${owner.queue.posts.length} on page 0, soonest first`);
  }
  if (!guestSees(owner.tags) || !guestSees(owner.graph)) {
    failures.push("the hidden place is missing from the owner's own tag list or atlas");
  }

  // Revelio: the owner asking to be answered as a guest. The switch lives in
  // the public footer, so drive the real control rather than the header — the
  // header is this test's own doing, the button is the visitor's.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  // The footer's actions live in a drawer behind "More Actions", collapsed to
  // zero width until it is opened — so this is two clicks for a visitor and has
  // to be two here.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await page.locator("#footer-slider-btn").click().catch(() => {});
  await page.waitForTimeout(500);
  const toggle = page.locator("#revelio-toggle");
  const lockedCards = () =>
    page.evaluate(() => document.querySelectorAll(".post-card.is-hidden").length);
  const revealedLocks = await lockedCards();
  if ((await toggle.count()) === 0) {
    failures.push("no revelio control in the public footer while signed in");
  } else {
    await toggle.click();
    await page.waitForTimeout(1200);

    // The switch re-renders in the same document (router.refresh()), so the
    // page in front of the visitor has to change — not just the answers to the
    // requests made after it.
    if ((await toggle.getAttribute("aria-pressed")) !== "false") {
      failures.push("the revelio button did not flip to the concealed state");
    }
    const concealedLocks = await lockedCards();
    if (revealedLocks === 0) {
      failures.push(
        "no hidden post on the owner's first page, so concealing it proves nothing — check the fixture's visibility mix",
      );
    } else if (concealedLocks !== 0) {
      failures.push(
        `${concealedLocks} hidden post(s) still on the page after concealing (was ${revealedLocks})`,
      );
    }
    const concealed = {
      home: await api(page, "/api/pages/home", REVELIO_OFF),
      tags: await api(page, "/api/tags", REVELIO_OFF),
      me: await api(page, "/api/auth/me", REVELIO_OFF, true),
    };
    if (concealed.home.pagination?.total !== guest.home.pagination?.total) {
      failures.push(
        `with revelio off the feed holds ${concealed.home.pagination?.total} post(s), but a real guest gets ${guest.home.pagination?.total}`,
      );
    }
    if (guestSees(concealed.tags)) {
      failures.push("revelio off still lists the hidden place");
    }
    // The admin API is behind AuthMiddleware, which the header never reaches.
    // If this 401s the app concludes the visitor is signed out and the control
    // that turns revelio back on goes with the rest of the admin UI.
    if (concealed.me.status !== 200) {
      failures.push(
        `revelio off returned ${concealed.me.status} from /api/auth/me — it narrowed the admin API, which is one-way`,
      );
    }
    if (!(await pageHasText(page, "Reveal"))) {
      // The button's own label flips; not a failure on its own, just noted.
    }
    console.log(`  ✓ revelio off renders the guest's site, admin API still answers`);
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
