import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { pluginHost } from "../src/core/pluginHost.js";

// Minimal enabled-only manifest mirroring window.__PLUGINS__. Entries without
// `entry` are enabled but not yet extracted into a chunk; entries with `entry`
// are built chunks that "claim" their slot.
const MANIFEST = [
  { id: "timeline", type: "slot", slot: "timeline" }, // no chunk yet
  { id: "tag-cloud", type: "slot", slot: "home-explore", entry: "/assets/js/p/tag-cloud-abc.js" },
  { id: "tags-graph", type: "route", slot: "tags-route", routes: ["/tags"] }, // no chunk
  { id: "tags-atlas", type: "route", slot: "map-route", routes: ["/map"] }, // no chunk
  { id: "tags-map", type: "route", slot: "map-route", routes: ["/map"], entry: "/assets/js/p/tags-map-xyz.js" },
  // Stand-in for any route plugin that owns an admin page and has a chunk.
  { id: "example-admin-route", type: "route", routes: ["/light/example"], entry: "/assets/js/p/example-1.js" },
  // Slot plugin that also owns an admin route (and some API prefixes).
  { id: "nav-menu", type: "slot", slot: "nav-menu", routes: ["/light/menu", "/api/nav-menu"], entry: "/assets/js/p/nav-menu-x.js" },
  { id: "instagram", type: "service", routes: ["/api/instagram"] },
];

describe("PluginHost", () => {
  beforeEach(() => pluginHost.init(MANIFEST));

  test("size and isEnabled reflect the manifest", () => {
    assert.strictEqual(pluginHost.size, MANIFEST.length);
    assert.ok(pluginHost.isEnabled("timeline"));
    assert.ok(pluginHost.isEnabled("instagram"));
    assert.ok(!pluginHost.isEnabled("does-not-exist"));
  });

  test("a slot is only claimed once a plugin has a built chunk", () => {
    // timeline is enabled but has no chunk → not claimed.
    assert.ok(!pluginHost.hasSlot("timeline"));
    assert.deepStrictEqual(pluginHost.slotEntries("timeline"), []);
    // tag-cloud has a chunk → claims home-explore.
    assert.ok(pluginHost.hasSlot("home-explore"));
    assert.strictEqual(pluginHost.slotEntries("home-explore").length, 1);
  });

  test("routes() lists plugins with chunks that own a /light route, excluding the claim slots", () => {
    const ids = pluginHost.routes().map((e) => e.id);
    // example-admin-route (route) and nav-menu (slot plugin owning /light/menu) both qualify.
    assert.deepStrictEqual(ids, ["example-admin-route", "nav-menu"]);
    // tags-map has a chunk but is single-claim (map-route) → excluded.
    assert.ok(!ids.includes("tags-map"));
    // tags-graph/tags-atlas/instagram have no chunk → excluded.
    assert.ok(!ids.includes("tags-graph"));
    assert.ok(!ids.includes("tags-atlas"));
    assert.ok(!ids.includes("instagram"));
  });

  test("claimRoute returns null when the chosen claimant has no chunk", async () => {
    const chosen = await pluginHost.claimRoute("map-route", (entries) =>
      entries.find((e) => e.id === "tags-atlas"),
    );
    assert.strictEqual(chosen, null); // tags-atlas not yet a chunk
  });

  test("claimRoute imports the chosen claimant's chunk", async () => {
    const entry = "data:text/javascript,export default 'MAP_PAGE'";
    pluginHost.init([{ id: "tags-map", type: "route", slot: "map-route", routes: ["/map"], entry }]);
    const mod = await pluginHost.claimRoute("map-route", (entries) =>
      entries.find((e) => e.id === "tags-map"),
    );
    assert.strictEqual(mod.default, "MAP_PAGE");
  });

  test("the two viz slots are claimed independently", async () => {
    const graph = "data:text/javascript,export default 'GRAPH_PAGE'";
    const map = "data:text/javascript,export default 'MAP_PAGE'";
    pluginHost.init([
      { id: "tags-graph", type: "route", slot: "tags-route", routes: ["/tags"], entry: graph },
      { id: "tags-map", type: "route", slot: "map-route", routes: ["/map"], entry: map },
    ]);
    assert.strictEqual((await pluginHost.claimRoute("tags-route")).default, "GRAPH_PAGE");
    assert.strictEqual((await pluginHost.claimRoute("map-route")).default, "MAP_PAGE");
  });

  test("fill imports and invokes each claiming plugin's mount", async () => {
    const entry = "data:text/javascript,export function mount(el, ctx) { return ctx.tags.length; }";
    pluginHost.init([{ id: "tag-cloud", type: "slot", slot: "home-explore", entry }]);
    const results = await pluginHost.fill("home-explore", {}, { tags: [1, 2, 3] });
    assert.deepStrictEqual(results, [3]);
  });

  test("an empty/absent manifest is inert", () => {
    pluginHost.init([]);
    assert.strictEqual(pluginHost.size, 0);
    assert.ok(!pluginHost.hasSlot("home-explore"));
    assert.deepStrictEqual(pluginHost.routes(), []);
  });
});
