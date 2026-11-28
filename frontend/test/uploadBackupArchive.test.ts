import test from "node:test";
import assert from "node:assert/strict";
import { uploadBackupArchive } from "../src/api/system.ts";

// FakeXHR replays one canned response when send() is called.
function installFakeXHR(status: number, responseText: string): () => void {
  const prev = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  class FakeXHR {
    status = 0;
    responseText = "";
    withCredentials = false;
    upload = { addEventListener() {} };
    private listeners: Record<string, () => void> = {};
    open() {}
    setRequestHeader() {}
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
    send() {
      this.status = status;
      this.responseText = responseText;
      queueMicrotask(() => this.listeners.load?.());
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR;
  return () => { (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = prev; };
}

const file = new File(["x"], "backup.tar.gz", { type: "application/gzip" });

test("uploadBackupArchive", async (t) => {
  await t.test("rejects with the server detail on an error", async () => {
    const restore = installFakeXHR(400, JSON.stringify({ detail: "invalid archive: not a gzip file" }));
    try {
      await assert.rejects(uploadBackupArchive(file), { message: "invalid archive: not a gzip file" });
    } finally { restore(); }
  });

  await t.test("rejects with the status code when the body has no detail", async () => {
    const restore = installFakeXHR(502, "<html>bad gateway</html>");
    try {
      await assert.rejects(uploadBackupArchive(file), { message: "Upload failed (502)" });
    } finally { restore(); }
  });

  await t.test("resolves with the body on success", async () => {
    const ok = { status: "ok", filename: "b.tar.gz", sha256: "abc", message: "Uploaded" };
    const restore = installFakeXHR(200, JSON.stringify(ok));
    try {
      assert.deepEqual(await uploadBackupArchive(file), ok);
    } finally { restore(); }
  });
});
