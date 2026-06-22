import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { pluginHost } from "../src/core/pluginHost.js";

// Minimal enabled-only manifest mirroring window.__PLUGINS__. Entries without
// `entry` are enabled but not yet extracted into a chunk; entries with `entry`
// are built chunks that "claim" their slot.
const MANIFEST = [
  { id: "timeline", type: "slot", slot: "timeline" }, // no chunk yet
  { id: "tag-cloud", type: "slot", slot: "home-explore", entry: "/assets/js/p/tag-cloud-abc.js" },
  { id: "tags-atlas", type: "route", slot: "tags-route", routes: ["/tags"] }, // no chunk
  { id: "tags-map", type: "route", slot: "tags-route", routes: ["/tags"], entry: "/assets/js/p/tags-map-xyz.js" },
  { id: "media-library", type: "route", routes: ["/light/media"], entry: "/assets/js/p/media-1.js" },
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

  test("routes() lists route plugins with chunks, excluding tags-route", () => {
    const ids = pluginHost.routes().map((e) => e.id);
    assert.deepStrictEqual(ids, ["media-library"]);
    // tags-map has a chunk but is single-claim (tags-route) → excluded.
    assert.ok(!ids.includes("tags-map"));
    // tags-atlas/instagram have no chunk → excluded.
    assert.ok(!ids.includes("tags-atlas"));
    assert.ok(!ids.includes("instagram"));
  });

  test("claimRoute returns null when the chosen claimant has no chunk", async () => {
    const chosen = await pluginHost.claimRoute("tags-route", (entries) =>
      entries.find((e) => e.id === "tags-atlas"),
    );
    assert.strictEqual(chosen, null); // tags-atlas not yet a chunk
  });

  test("claimRoute imports the chosen claimant's chunk", async () => {
    const entry = "data:text/javascript,export default 'MAP_PAGE'";
    pluginHost.init([{ id: "tags-map", type: "route", slot: "tags-route", routes: ["/tags"], entry }]);
    const mod = await pluginHost.claimRoute("tags-route", (entries) =>
      entries.find((e) => e.id === "tags-map"),
    );
    assert.strictEqual(mod.default, "MAP_PAGE");
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
