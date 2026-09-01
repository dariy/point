// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach, afterEach } from "node:test";
import { setupDOM } from "./helpers/dom.js";
import { BackupsSection } from "../src/components/light/sections/BackupsSection.js";
import * as gestures from "../src/core/gestures.js";

test("BackupsSection", async (t) => {
  let dom;
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

    const html = section.render();
    assert.ok(html.includes("backup.zip"));
    
    section._load = async () => {};
    section._syncPoll = () => {};
    root.innerHTML = html;
    section.afterRender();

    const dlBtn = root.querySelector(".download-backup-btn");
    assert.ok(dlBtn);
    
    // click upload btn
    const uploadInput = root.querySelector("#upload-backup-input");
    let clickFired = false;
    uploadInput.addEventListener('click', () => { clickFired = true; });
    const uploadBtn = root.querySelector("#upload-backup-btn");
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

  root.innerHTML = section.render();
  section._load = async () => {};
  section._syncPoll = () => {};
  
  // mock methods
  section._handleRestore = (f, p) => {};
  section._handleDelete = (f) => {};
  section._handleDownload = (f) => {};
  section.afterRender();

  // Test click handlers
  root.querySelector(".restore-backup-btn").click();
  root.querySelector(".delete-backup-btn").click();
  root.querySelector(".download-backup-btn").click();
  root.querySelector("#create-backup-btn").click();
  root.querySelector("#restart-server-btn").click();

  // Settings mock
  section._saveSetting = async () => {};
  const settingsInput = root.querySelector("input[name='schedule']");
  if (settingsInput) {
    settingsInput.dispatchEvent(new Event('change'));
  }

  root.remove();
  dom.cleanup();
});
