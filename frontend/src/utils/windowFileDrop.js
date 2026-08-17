/**
 * Drop a file anywhere on the window to upload it.
 *
 * Listeners sit on the document rather than on one drop zone, so the whole page
 * is the target — dragging a photo from the desktop onto the editor should work
 * wherever the pointer happens to be.
 *
 * Two things make that safe:
 *   - the page's own drags (reordering blocks, the media browser) are ignored,
 *     tracked by dragstart/dragend rather than guessed at from the event target
 *   - dragenter/dragleave are counted, because they fire for every nested
 *     element the pointer crosses; only a count back to zero is a real leave
 */

/**
 * Attach the handlers and return a function that removes them.
 * `onFile(file)` is called once per dropped image or video.
 */
export function attachWindowFileDrop({ onFile }) {
  let dragCount = 0;
  let internalDrag = false;

  const hasFiles = (e) => {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes("Files");
  };

  const onDragStart = () => { internalDrag = true; };
  const onDragEnd = () => { internalDrag = false; };

  const onDragEnter = (e) => {
    if (internalDrag || !hasFiles(e)) return;
    dragCount++;
    document.body.classList.add("drag-active");
  };
  const onDragLeave = (e) => {
    if (internalDrag || !hasFiles(e)) return;
    dragCount--;
    if (dragCount === 0) document.body.classList.remove("drag-active");
  };
  // Without preventDefault the browser navigates to the dropped file.
  const onDragOver = (e) => {
    if (!internalDrag) e.preventDefault();
  };
  const onDrop = (e) => {
    if (internalDrag) return;
    e.preventDefault();
    dragCount = 0;
    document.body.classList.remove("drag-active");
    Array.from(e.dataTransfer.files)
      .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
      .forEach((f) => onFile(f));
  };

  const handlers = [
    ["dragstart", onDragStart],
    ["dragend", onDragEnd],
    ["dragenter", onDragEnter],
    ["dragleave", onDragLeave],
    ["dragover", onDragOver],
    ["drop", onDrop],
  ];
  for (const [type, fn] of handlers) document.addEventListener(type, fn);

  return () => {
    for (const [type, fn] of handlers) document.removeEventListener(type, fn);
    document.body.classList.remove("drag-active");
  };
}
