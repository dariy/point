/**
 * shareDrafts — save one queued offline share (the share target's IndexedDB
 * backlog) as a draft post.
 *
 * The editor is open when this runs, so an exact duplicate gets the same
 * question as the media library (NF-16): "Use the existing file" or "Upload
 * again". The question is asked once per draft. A closed question leaves the
 * matched files out of the draft; nothing comes back from the trash with no
 * question.
 */

import { createPost, updatePost } from "../api/posts.ts";
import { uploadBatchAskingOnDuplicate } from "./duplicateUpload.ts";
import type { ShareEntry } from "./idb.ts";

/**
 * Create a draft for a share entry and put its uploaded media in it.
 *
 * @returns the draft id and the number of matched files left out
 * @throws when the draft cannot be made, or when an upload fails (the draft
 *   then keeps the files that did upload)
 */
export async function saveShareDraft(entry: ShareEntry): Promise<{ postId: number, skipped: number }> {
  const title = entry.title || entry.files.map(f => f.name).join(", ") || "Shared photo";
  const post = await createPost({ title, status: "draft", content: "" });
  const files = entry.files.map(f => new File([new Blob([f.data], { type: f.type })], f.name, { type: f.type }));
  const { media, failed, duplicates, choice } = await uploadBatchAskingOnDuplicate(files, { post_id: post.id });
  await updatePost(post.id, { content: media.map(m => m.path).join("\n") });
  if (failed) throw new Error(`${failed} file(s) could not be uploaded`);
  return { postId: post.id, skipped: choice === null ? duplicates : 0 };
}
