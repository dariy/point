/**
 * duplicateUpload — the exact-duplicate question at upload (NF-16).
 *
 * The server compares the SHA-256 of an upload with media.checksum. With
 * `on_duplicate: 'ask'` a match comes back as a 409 that carries the existing
 * media, and this module asks the user: "Use the existing file" (restored
 * from the trash if it is there) or "Upload again" (a second copy). A batch
 * asks once for all of its matches.
 */

import { Modal } from "../components/shared/Modal.ts";
import { html } from "./helpers.ts";
import { duplicateOf, getMedia, restoreMedia, uploadMedia } from "../api/media.ts";
import type { Media } from "../api/media.ts";

/** The user's answer. Null when the dialog is closed with no choice. */
export type DuplicateChoice = "existing" | "again" | null;

/**
 * Ask what to do with uploads that are already in the library.
 *
 * @param duplicates - one entry per matched upload: its file name and the existing media
 * @returns the choice, which applies to every entry
 */
export function askDuplicate(duplicates: Array<{ filename: string, existing: Media }>): Promise<DuplicateChoice> {
  const trashed = duplicates.filter(d => d.existing.deleted_at).length;
  const one = duplicates.length === 1;
  const message = one
    ? `"${duplicates[0].filename}" is already in the library${trashed ? ", in the trash" : ""}.`
    : `${duplicates.length} files are already in the library${trashed ? ` (${trashed} in the trash)` : ""}.`;
  const hint = one
    ? "Use the existing file, or upload a second copy."
    : "Use the existing files, or upload a second copy of each.";

  return new Promise(resolve => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    let done = false;
    const finish = (choice: DuplicateChoice) => {
      if (done) return;
      done = true;
      modal.unmount();
      mount.remove();
      resolve(choice);
    };
    const modal = new Modal(mount, {
      title: one ? "File already in the library" : "Files already in the library",
      footer: html`
        <button class="btn btn-secondary" id="duplicate-again-btn">Upload again</button>
        <button class="btn btn-primary" id="duplicate-existing-btn">${one ? "Use the existing file" : "Use the existing files"}</button>
      `,
      onClose: () => finish(null),
    });
    modal.mount();
    const body = modal.getBodyMount();
    if (body) {
      for (const text of [message, hint]) {
        const p = document.createElement("p");
        p.textContent = text;
        body.appendChild(p);
      }
    }
    modal.$("#duplicate-again-btn")?.addEventListener("click", () => finish("again"));
    modal.$("#duplicate-existing-btn")?.addEventListener("click", () => finish("existing"));
  });
}

/** The existing media, taken out of the trash first when it is there. */
export async function useExisting(existing: Media): Promise<Media> {
  if (!existing.deleted_at) return existing;
  await restoreMedia(existing.id);
  return getMedia(existing.id);
}

/**
 * Upload one file and ask when the library already has it.
 *
 * @returns the media to use (new or existing), or null when the user closed the question
 */
export async function uploadAskingOnDuplicate(
  file: File,
  meta: { alt_text?: string, caption?: string, post_id?: number } = {},
): Promise<Media | null> {
  try {
    return await uploadMedia(file, meta, "ask");
  } catch (err) {
    const existing = duplicateOf(err);
    if (!existing) throw err;
    const choice = await askDuplicate([{ filename: file.name, existing }]);
    if (choice === "existing") return useExisting(existing);
    if (choice === "again") return uploadMedia(file, meta, "new");
    return null;
  }
}

/** The outcome of a batch upload. */
export interface BatchUploadResult {
  /** New and reused media, in the order of the files. */
  media: Media[];
  /** Files that failed with an error. */
  failed: number;
  /** Exact matches the batch found; their outcome follows `choice`. */
  duplicates: number;
  /** The answer for the duplicates; null when there were none or the user closed the question. */
  choice: DuplicateChoice;
}

/**
 * Upload files one by one and ask one question for all exact matches.
 */
export async function uploadBatchAskingOnDuplicate(
  files: File[],
  meta: { post_id?: number } = {},
): Promise<BatchUploadResult> {
  const slots: Array<Media | null> = [];
  const duplicates: Array<{ index: number, file: File, filename: string, existing: Media }> = [];
  let failed = 0;
  for (const file of files) {
    try {
      slots.push(await uploadMedia(file, meta, "ask"));
    } catch (err) {
      const existing = duplicateOf(err);
      if (existing) duplicates.push({ index: slots.length, file, filename: file.name, existing });
      else failed++;
      slots.push(null);
    }
  }

  let choice: DuplicateChoice = null;
  if (duplicates.length) {
    choice = await askDuplicate(duplicates);
    for (const d of duplicates) {
      if (!choice) break;
      try {
        slots[d.index] = choice === "existing" ? await useExisting(d.existing) : await uploadMedia(d.file, meta, "new");
      } catch {
        failed++;
      }
    }
  }
  return {
    media: slots.filter((m): m is Media => m !== null),
    failed,
    duplicates: duplicates.length,
    choice,
  };
}
