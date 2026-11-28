import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDOM, must } from "./helpers/dom.ts";
import { jsonResponse } from "./helpers/fetch.ts";
import type { FakeReply } from "./helpers/fetch.ts";
import { BackupsSection } from "../src/components/light/sections/BackupsSection.ts";
import { getExport, startExport, authorizeExportDownload, exportDownloadUrl, getImport, uploadImportArchive } from "../src/api/system.ts";
import type { ExportStatus, ImportStatus } from "../src/api/system.ts";
import { getToast, setToast } from "../src/store.ts";

// The portable export and import UI of BackupsSection, and the API calls it
// makes (NF-13). The render of each state is in BackupsSection.test.ts; this
// file covers the flows: start and poll an export, download it, upload and
// poll an import, and the refusals the server sends.

const zero = { posts: 0, pages: 0, media: 0, tags: 0 };
const ok = (body: unknown): FakeReply => ({ ok: true, status: 200, body });
const fail = (status: number, detail: string): FakeReply => ({ ok: false, status, body: { detail } });

/** A fake fetch: route(method, url) gives the reply. Each request is recorded. */
function serve(route: (method: string, url: string, body: unknown) => FakeReply) {
  const seen: string[] = [];
  globalThis.fetch = async (input, opts) => {
    const method = opts?.method ?? "GET";
    const url = String(input);
    seen.push(`${method} ${url}`);
    const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined;
    return jsonResponse(route(method, url, body));
  };
  return seen;
}

interface XHRScript {
  status: number;
  responseText: string;
  /** Upload progress events (loaded, total) to fire before load. */
  progress?: Array<[number, number]>;
  /** Fire "error" (a network failure) and not "load". */
  networkError?: boolean;
}

/** A fake XMLHttpRequest that replays script and records what was sent. */
function installFakeXHR(script: XHRScript) {
  const sent: { method?: string; url?: string; headers: Record<string, string>; body?: unknown; withCredentials?: boolean } = { headers: {} };
  const prev = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  class FakeXHR {
    status = 0;
    responseText = "";
    withCredentials = false;
    private uploadListeners: Record<string, (e: ProgressEvent) => void> = {};
    upload = { addEventListener: (type: string, fn: (e: ProgressEvent) => void) => { this.uploadListeners[type] = fn; } };
    private listeners: Record<string, () => void> = {};
    open(method: string, url: string) { sent.method = method; sent.url = url; }
    setRequestHeader(k: string, v: string) { sent.headers[k] = v; }
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
    send(body: unknown) {
      sent.body = body;
      sent.withCredentials = this.withCredentials;
      queueMicrotask(() => {
        for (const [loaded, total] of script.progress ?? []) {
          this.uploadListeners.progress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
        }
        if (script.networkError) { this.listeners.error?.(); return; }
        this.status = script.status;
        this.responseText = script.responseText;
        this.listeners.load?.();
      });
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
  return { sent, restore: () => { (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = prev; } };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const archive = () => new File(["x"], "point-export.tar.gz", { type: "application/gzip" });

/** Fill the open password prompt and confirm it. */
function confirmPrompt(password: string) {
  const input = must(document.querySelector<HTMLInputElement>("#prompt-input"), "prompt input");
  input.value = password;
  const dialog = must(input.closest<HTMLElement>(".modal, [role=dialog]") ?? document.body.lastElementChild as HTMLElement | null, "prompt dialog");
  must(dialog.querySelector<HTMLElement>(".btn-primary"), "confirm button").click();
}

const toastMessage = () => (getToast() as { message?: string; type?: string } | null)?.message;
const toastType = () => (getToast() as { message?: string; type?: string } | null)?.type;

describe("portable export and import API", () => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  test("the export calls use the export endpoints, with the filename encoded", async () => {
    const seen = serve((method, url, body) => {
      if (url.endsWith("/authorize-download")) {
        assert.deepEqual(body, { current_name: "pwhash" });
        return ok({ token: "t1" });
      }
      return ok(method === "POST" ? { status: "started" } : { running: false, last: null });
    });
    assert.deepEqual(await getExport(), { running: false, last: null });
    assert.deepEqual(await startExport(), { status: "started" });
    assert.deepEqual(await authorizeExportDownload("a b.tar.gz", "pwhash"), { token: "t1" });
    assert.deepEqual(seen, [
      "GET /api/system/export",
      "POST /api/system/export",
      "POST /api/system/export/a%20b.tar.gz/authorize-download",
    ]);
    assert.equal(exportDownloadUrl("a b.tar.gz", "t&1"), "/api/system/export/a%20b.tar.gz/download?token=t%261");
  });

  test("getImport reads the import status", async () => {
    const seen = serve(() => ok({ running: false, progress: null, last: null, empty: true }));
    assert.equal((await getImport()).empty, true);
    assert.deepEqual(seen, ["GET /api/system/import"]);
  });

  test("uploadImportArchive streams the file with the password and reports progress", async () => {
    const { sent, restore } = installFakeXHR({ status: 202, responseText: JSON.stringify({ status: "started" }), progress: [[1, 4], [4, 4]] });
    try {
      const fractions: number[] = [];
      const file = archive();
      assert.deepEqual(await uploadImportArchive(file, "pwhash", f => fractions.push(f)), { status: "started" });
      assert.deepEqual(fractions, [0.25, 1]);
      assert.equal(sent.method, "POST");
      assert.equal(sent.url, "/api/system/import");
      assert.equal(sent.headers["Content-Type"], "application/gzip");
      assert.equal(sent.headers["X-Confirm-Password"], "pwhash");
      assert.equal(sent.withCredentials, true);
      assert.equal(sent.body, file);
    } finally { restore(); }
  });

  test("uploadImportArchive gives the status 'started' for a success with no body", async () => {
    const { restore } = installFakeXHR({ status: 202, responseText: "" });
    try {
      assert.deepEqual(await uploadImportArchive(archive(), "pwhash"), { status: "started" });
    } finally { restore(); }
  });

  // The server refuses before it starts. Each refusal reaches the user as the
  // server says it.
  for (const [status, detail] of [
    [409, "this site already has posts or media: import goes into an empty site only"],
    [413, "the archive is larger than the import limit"],
    [400, "the archive has a sparse file: posts/a.md"],
    [400, "the archive has export format version 2"],
  ] as const) {
    test(`uploadImportArchive rejects with the server detail (${status}: ${detail})`, async () => {
      const { restore } = installFakeXHR({ status, responseText: JSON.stringify({ detail }) });
      try {
        await assert.rejects(uploadImportArchive(archive(), "pwhash"), { message: detail });
      } finally { restore(); }
    });
  }

  test("uploadImportArchive rejects with the message, else the status code", async () => {
    let x = installFakeXHR({ status: 401, responseText: JSON.stringify({ message: "wrong password" }) });
    try {
      await assert.rejects(uploadImportArchive(archive(), "pwhash"), { message: "wrong password" });
    } finally { x.restore(); }
    x = installFakeXHR({ status: 502, responseText: "<html>bad gateway</html>" });
    try {
      await assert.rejects(uploadImportArchive(archive(), "pwhash"), { message: "Import failed (502)" });
    } finally { x.restore(); }
  });

  test("uploadImportArchive rejects on a network failure", async () => {
    const { restore } = installFakeXHR({ status: 0, responseText: "", networkError: true });
    try {
      await assert.rejects(uploadImportArchive(archive(), "pwhash"), { message: "Upload failed" });
    } finally { restore(); }
  });
});

describe("BackupsSection export and import flows", () => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  let root: HTMLElement;
  let section: BackupsSection | undefined;
  beforeEach(() => {
    dom = setupDOM();
    setToast(null);
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    section?.unmount();
    section = undefined;
    setToast(null);
    dom?.cleanup();
  });

  /** A section with the state of a loaded page, rendered into root. */
  function loaded(exportStatus: ExportStatus | null, importStatus: ImportStatus | null) {
    const s = new BackupsSection(root);
    s.state = { ...s.state, loading: false, backups: [], exportStatus, importStatus };
    s._load = async () => {};
    s.mount();
    section = s;
    return s;
  }

  const lastExport = (created_at: string, extra: object = {}) => ({
    filename: `point-export_${created_at}.tar.gz`, size: 10, created_at, counts: zero, missing_count: 0, duration_ms: 1, ...extra,
  });

  test("load reads the export and the import status", async () => {
    const exportStatus = { running: false, last: lastExport("2026-11-26T12:00:00Z") };
    const importStatus = { running: false, progress: null, last: null, empty: true };
    serve((_m, url) => {
      if (url === "/api/system/export") return ok(exportStatus);
      if (url === "/api/system/import") return ok(importStatus);
      if (url.startsWith("/api/system/backups")) return ok([]);
      return ok({});
    });
    const s = new BackupsSection(root);
    section = s;
    s.mount();
    await tick();
    await tick();
    assert.deepEqual(s.state.exportStatus, exportStatus);
    assert.deepEqual(s.state.importStatus, importStatus);
    assert.ok(root.querySelector(".download-export-btn"), "the last export can be downloaded");
    assert.ok(root.querySelector("#start-import-btn"), "the import block is shown");
    assert.equal(s._exportPollTimer, null, "no poll: no export runs");
    assert.equal(s._importPollTimer, null, "no poll: no import runs");
  });

  test("load shows no import block when the import status fails", async () => {
    serve((_m, url) => (url === "/api/system/import" || url === "/api/system/export" ? fail(500, "boom") : ok([])));
    const s = new BackupsSection(root);
    section = s;
    s.mount();
    await tick();
    await tick();
    assert.equal(s.state.importStatus, null);
    assert.equal(root.querySelector("#start-import-btn"), null);
    assert.ok(root.querySelector("#start-export-btn"), "the export can still start");
  });

  test("Start export polls until a new result replaces the old one, then says it is ready", async () => {
    let status: ExportStatus = { running: false, last: lastExport("2026-11-25T00:00:00Z") };
    const seen = serve(method => (method === "POST" ? ok({ status: "started" }) : ok(status)));
    const s = loaded(status, null);

    // The job starts a moment after the request: the old result comes back,
    // so the section keeps polling and the button stays disabled.
    await s._handleStartExport();
    assert.deepEqual(seen, ["POST /api/system/export", "GET /api/system/export"]);
    assert.equal(toastMessage(), "Export started…");
    assert.ok(s._exportAwaiting, "waits for a new result");
    assert.ok(s._exportPollTimer, "polls");
    assert.match(root.innerHTML, /id="start-export-btn"[^>]*disabled/);
    assert.ok(root.innerHTML.includes("Exporting…"));

    // The export runs.
    status = { running: true, last: status.last };
    await s._refreshExport();
    assert.ok(s._exportPollTimer, "polls while it runs");

    // A new result: the poll stops, and the user is told.
    status = { running: false, last: lastExport("2026-11-26T00:00:00Z") };
    await s._refreshExport();
    assert.equal(s._exportAwaiting, null);
    assert.equal(s._exportPollTimer, null);
    assert.equal(toastMessage(), "Export is ready to download.");
    assert.equal(toastType(), "success");
    assert.doesNotMatch(root.innerHTML, /id="start-export-btn"[^>]*disabled/);
    assert.ok(root.innerHTML.includes("point-export_2026-11-26T00:00:00Z.tar.gz"));
  });

  test("a failed export ends the wait with an error toast", async () => {
    let status: ExportStatus = { running: false, last: null };
    serve(method => (method === "POST" ? ok({ status: "started" }) : ok(status)));
    const s = loaded(status, null);
    await s._handleStartExport();
    assert.ok(s._exportAwaiting);
    status = { running: false, last: { created_at: "2026-11-26T00:00:00Z", counts: zero, missing_count: 0, error: "disk full", duration_ms: 1 } };
    await s._refreshExport();
    assert.equal(s._exportAwaiting, null);
    assert.equal(toastMessage(), "Export failed.");
    assert.equal(toastType(), "error");
    assert.ok(root.innerHTML.includes("The last export failed: disk full"));
  });

  test("the wait ends after 30 seconds with no new result, and no toast", async () => {
    const status: ExportStatus = { running: false, last: lastExport("2026-11-25T00:00:00Z") };
    serve(() => ok(status));
    const s = loaded(status, null);
    s._exportAwaiting = { since: Date.now() - 31000, prev: status.last!.created_at };
    await s._refreshExport();
    assert.equal(s._exportAwaiting, null);
    assert.equal(s._exportPollTimer, null);
    assert.equal(getToast(), null);
  });

  test("a failed poll keeps the last status and polls again", async () => {
    const status: ExportStatus = { running: true, last: null };
    serve(() => fail(500, "boom"));
    const s = loaded(status, null);
    await s._refreshExport();
    assert.deepEqual(s.state.exportStatus, status);
    assert.ok(s._exportPollTimer, "still polls");
  });

  test("Start export says when an export already runs, or the server message", async () => {
    serve(() => fail(409, "an export is running"));
    let s = loaded({ running: false, last: null }, null);
    await s._handleStartExport();
    assert.equal(toastMessage(), "An export is already in progress.");
    assert.equal(s.state.startingExport, false);
    assert.equal(s._exportAwaiting, null);
    s.unmount();

    serve(() => fail(500, "the data folder is full"));
    root.innerHTML = "";
    s = loaded({ running: false, last: null }, null);
    await s._handleStartExport();
    assert.equal(toastMessage(), "the data folder is full");
    assert.equal(toastType(), "error");
  });

  test("Download export asks for the password, then streams the archive with a one-time token", async () => {
    const seen = serve((_m, _url, body) => {
      assert.equal(typeof (body as { current_name?: string }).current_name, "string");
      assert.equal((body as { current_name: string }).current_name.length, 64, "the password is sent as sha256 hex");
      return ok({ token: "tok" });
    });
    const s = loaded({ running: false, last: lastExport("2026-11-26T00:00:00Z") }, null);
    const clicked: string[] = [];
    const proto = Object.getPrototypeOf(document.createElement("a")) as { click: () => void };
    const prevClick = proto.click;
    proto.click = function (this: HTMLAnchorElement) { clicked.push(`${this.getAttribute("href")} ${this.getAttribute("download")}`); };
    try {
      must(root.querySelector<HTMLElement>(".download-export-btn")).click();
      assert.ok(document.body.textContent?.includes('Confirm your password to download "point-export_2026-11-26T00:00:00Z.tar.gz"'));
      confirmPrompt("secret");
      await tick();
      await tick();
    } finally { proto.click = prevClick; }
    assert.deepEqual(seen, ["POST /api/system/export/point-export_2026-11-26T00%3A00%3A00Z.tar.gz/authorize-download"]);
    assert.deepEqual(clicked, [
      "/api/system/export/point-export_2026-11-26T00%3A00%3A00Z.tar.gz/download?token=tok point-export_2026-11-26T00:00:00Z.tar.gz",
    ]);
    assert.equal(document.querySelectorAll("a[download]").length, 0, "the link is removed");
    void s;
  });

  test("Download export with a wrong password says so and downloads nothing", async () => {
    serve(() => fail(403, "the password is not correct"));
    loaded({ running: false, last: lastExport("2026-11-26T00:00:00Z") }, null);
    must(root.querySelector<HTMLElement>(".download-export-btn")).click();
    confirmPrompt("wrong");
    await tick();
    await tick();
    assert.equal(toastMessage(), "the password is not correct");
    assert.equal(toastType(), "error");
  });

  test("an empty password does nothing", async () => {
    const seen = serve(() => ok({ token: "tok" }));
    loaded({ running: false, last: lastExport("2026-11-26T00:00:00Z") }, null);
    must(root.querySelector<HTMLElement>(".download-export-btn")).click();
    confirmPrompt("");
    await tick();
    assert.deepEqual(seen, []);
  });

  test("Import archive uploads with progress, then polls the import until it is done", async () => {
    let status: ImportStatus = { running: false, progress: null, last: null, empty: true };
    serve(() => ok(status));
    const pcts: number[] = [];
    const { sent, restore } = installFakeXHR({ status: 202, responseText: JSON.stringify({ status: "started" }), progress: [[1, 2], [2, 2]] });
    try {
      const s = loaded(null, { ...status });
      const realSetState = s.setState.bind(s);
      s.setState = (delta) => {
        if (delta.importUploading === true && typeof delta.importUploadPct === "number") pcts.push(delta.importUploadPct);
        realSetState(delta);
      };
      s._handleImport(archive());
      assert.ok(document.body.textContent?.includes('Import "point-export.tar.gz" into this site?'));
      status = { running: true, empty: false, last: null, progress: { phase: "check", total: zero, done: zero } };
      confirmPrompt("secret");
      // The prompt hashes the password, then the upload starts.
      for (let i = 0; i < 5 && !sent.body; i++) await tick();
      assert.ok(root.innerHTML.includes("Uploading archive… 0%") || pcts.length > 0, "the upload shows its progress");
      for (let i = 0; i < 5 && !s._importPollTimer; i++) await tick();
      assert.deepEqual(pcts, [0, 50, 100]);
      assert.equal(String(sent.headers["X-Confirm-Password"]).length, 64);
      assert.equal(toastMessage(), "Import started…");
      assert.equal(s._importAwaiting, true);
      assert.ok(s._importPollTimer, "polls while the import runs");
      assert.equal(s.state.importUploading, false);
      assert.ok(root.innerHTML.includes("Checking the archive…"));

      // The run moves on to the media, then finishes.
      status = { running: true, empty: false, last: null, progress: { phase: "finish", total: { ...zero, posts: 1 }, done: { ...zero, posts: 1 } } };
      await s._refreshImport();
      assert.ok(root.innerHTML.includes("Finishing…"));
      assert.ok(root.innerHTML.includes("width:100%"));
      status = { running: false, empty: false, progress: null, last: {
        started_at: "2026-11-27T12:00:00Z", exported_at: "2026-11-26T12:00:00Z", counts: { ...zero, posts: 1 }, problem_count: 0, duration_ms: 3,
      } };
      await s._refreshImport();
      assert.equal(toastMessage(), "Import is done.");
      assert.equal(toastType(), "success");
      assert.equal(s._importAwaiting, false);
      assert.equal(s._importPollTimer, null);
      assert.ok(root.innerHTML.includes("Imported 1 posts"));
      // The site is not empty now: a second import is blocked.
      assert.match(root.innerHTML, /id="start-import-btn"[^>]*disabled/);
    } finally { restore(); }
  });

  test("an import that fails after it starts ends with an error toast", async () => {
    let status: ImportStatus = { running: true, empty: true, last: null, progress: null };
    serve(() => ok(status));
    const s = loaded(null, status);
    s._importAwaiting = true;
    status = { running: false, empty: true, progress: null, last: {
      started_at: "2026-11-27T12:00:00Z", exported_at: "2026-11-26T12:00:00Z", counts: zero, problem_count: 0,
      error: "the archive is not complete", duration_ms: 1,
    } };
    await s._refreshImport();
    assert.equal(toastMessage(), "Import failed.");
    assert.equal(toastType(), "error");
    assert.ok(root.innerHTML.includes("The last import failed: the archive is not complete"));
  });

  for (const detail of [
    "this site already has posts or media: import goes into an empty site only",
    "the archive is larger than the import limit",
    "the archive has a sparse file: posts/a.md",
  ]) {
    test(`a refused import shows the refusal and leaves the upload state: ${detail}`, async () => {
      const status: ImportStatus = { running: false, progress: null, last: null, empty: true };
      const seen = serve(() => ok(status));
      const { restore } = installFakeXHR({ status: 409, responseText: JSON.stringify({ detail }) });
      try {
        const s = loaded(null, status);
        s._handleImport(archive());
        confirmPrompt("secret");
        for (let i = 0; i < 10 && seen.length === 0; i++) await tick();
        assert.equal(toastMessage(), detail);
        assert.equal(toastType(), "error");
        assert.equal(s._importAwaiting, false);
        assert.equal(s.state.importUploading, false);
        assert.equal(s._importPollTimer, null);
        assert.ok(!root.innerHTML.includes("Uploading archive"));
      } finally { restore(); }
    });
  }

  test("the file input starts the import with the chosen file", async () => {
    const s = loaded(null, { running: false, progress: null, last: null, empty: true });
    const files: string[] = [];
    s._handleImport = (f: File) => { files.push(f.name); };
    const input = must(root.querySelector<HTMLInputElement>("#import-archive-input"));
    Object.defineProperty(input, "files", { value: [archive()] });
    input.dispatchEvent(new Event("change"));
    assert.deepEqual(files, ["point-export.tar.gz"]);
  });

  test("unmount stops the export and the import poll", () => {
    const s = loaded({ running: true, last: null }, { running: true, progress: null, last: null, empty: false });
    s._syncExportPoll();
    s._syncImportPoll();
    assert.ok(s._exportPollTimer);
    assert.ok(s._importPollTimer);
    s.unmount();
    assert.equal(s._exportPollTimer, null);
    assert.equal(s._importPollTimer, null);
  });
});
