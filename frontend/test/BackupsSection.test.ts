import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach, afterEach } from "node:test";
import { setupDOM, must } from "./helpers/dom.ts";
import { BackupsSection } from "../src/components/light/sections/BackupsSection.ts";
import * as gestures from "../src/core/gestures.ts";

test("BackupsSection", async (t) => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  await t.test("renders and handles basic UI", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);

    const section = new BackupsSection(root);
    section.state = {
      backups: [{ filename: "backup.zip", size: 1024, created_at: "2024-01-01T00:00:00Z" }],
      loading: false,
      uploading: false,
      uploadPct: 0
    };

    const html = String(section.render());
    assert.ok(html.includes("backup.zip"));
    
    section._load = async () => {};
    section._syncPoll = () => {};
    root.innerHTML = html;
    section.afterRender();

    const dlBtn = root.querySelector(".download-backup-btn");
    assert.ok(dlBtn);
    
    // click upload btn
    const uploadInput = must(root.querySelector<HTMLInputElement>("#upload-backup-input"));
    let clickFired = false;
    uploadInput.addEventListener('click', () => { clickFired = true; });
    const uploadBtn = must(root.querySelector<HTMLElement>("#upload-backup-btn"));
    uploadBtn.click();
    assert.ok(clickFired);
    
    const file = new File([''], "test.zip", { type: "application/zip" });
    // mock files array
    Object.defineProperty(uploadInput, 'files', { value: [file] });
    uploadInput.dispatchEvent(new Event('change'));

    root.remove();
  });
});

test("BackupsSection actions", async (t) => {
  let dom = setupDOM();
  const root = document.createElement("div");
  document.body.appendChild(root);

  const section = new BackupsSection(root);
  section.state = {
    backups: [{ filename: "backup.zip", size: 1024, created_at: "2024-01-01T00:00:00Z" }],
    loading: false,
    uploading: false,
    uploadPct: 0
  };

  root.innerHTML = String(section.render());
  section._load = async () => {};
  section._syncPoll = () => {};
  
  // mock methods
  section._handleRestore = async () => {};
  section._handleDelete = async () => {};
  section._handleDownload = () => {};
  section.afterRender();

  // Test click handlers
  must(root.querySelector<HTMLElement>(".restore-backup-btn")).click();
  must(root.querySelector<HTMLElement>(".delete-backup-btn")).click();
  must(root.querySelector<HTMLElement>(".download-backup-btn")).click();
  must(root.querySelector<HTMLElement>("#create-backup-btn")).click();
  must(root.querySelector<HTMLElement>("#restart-server-btn")).click();

  // A change to any cadence control saves the settings. Stub the save and
  // assert it ran: the control has to be one that render() emits, or the
  // dispatch below goes nowhere and the assertion is the only thing that says so.
  let saved = 0;
  section._saveSettings = async () => { saved++; };
  const keepInput = root.querySelector("#bk-keep");
  assert.ok(keepInput, "render() should emit the 'keep last' control");
  keepInput.dispatchEvent(new Event('change'));
  assert.strictEqual(saved, 1, "changing a cadence control should save the settings");

  root.remove();
  dom.cleanup();
});

test("BackupsSection export block", async () => {
  const dom = setupDOM();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const section = new BackupsSection(root);
  const base = { backups: [], loading: false, uploading: false, uploadPct: 0 };

  // No export yet: the start button only.
  section.state = { ...base, exportStatus: { running: false, last: null } };
  let out = String(section.render());
  assert.ok(out.includes('id="start-export-btn"'));
  assert.ok(out.includes("Export site"));
  assert.ok(!out.includes("download-export-btn"));

  // A running export disables the button.
  section.state = { ...base, exportStatus: { running: true, last: null } };
  out = String(section.render());
  assert.match(out, /id="start-export-btn"[^>]*disabled/);
  assert.ok(out.includes("Exporting…"));

  // A finished export shows its counts, the missing files and a download.
  section.state = { ...base, exportStatus: { running: false, last: {
    filename: "point-export_20261126_120000.tar.gz", size: 2048, created_at: "2026-11-26T12:00:00Z",
    counts: { posts: 3, pages: 1, media: 5, tags: 2 }, missing: ["originals/a.jpg"], missing_count: 1, duration_ms: 10,
  } } };
  out = String(section.render());
  assert.ok(out.includes("point-export_20261126_120000.tar.gz"));
  assert.ok(out.includes("3 posts · 1 pages · 5 media · 2 tags"));
  assert.ok(out.includes("1 originals missing on disk"));
  root.innerHTML = out;
  section._load = async () => {};
  let downloaded = "";
  let started = 0;
  section._handleExportDownload = (f: string) => { downloaded = f; };
  section._handleStartExport = async () => { started++; };
  section.afterRender();
  must(root.querySelector<HTMLElement>(".download-export-btn")).click();
  assert.strictEqual(downloaded, "point-export_20261126_120000.tar.gz");
  must(root.querySelector<HTMLElement>("#start-export-btn")).click();
  assert.strictEqual(started, 1);

  // A failed export shows the error and no download.
  section.state = { ...base, exportStatus: { running: false, last: {
    created_at: "2026-11-26T12:00:00Z", counts: { posts: 0, pages: 0, media: 0, tags: 0 },
    missing_count: 0, error: "db snapshot: disk full", duration_ms: 1,
  } } };
  out = String(section.render());
  assert.ok(out.includes("The last export failed: db snapshot: disk full"));
  assert.ok(!out.includes("download-export-btn"));

  root.remove();
  dom.cleanup();
});
