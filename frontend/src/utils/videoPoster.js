/**
 * videoPoster — grab a still frame out of a video, in the browser.
 *
 * The server has no video decoder (the runtime image ships no ffmpeg and the
 * binary is built CGO-free), so a video's thumbnail has to come from the one
 * place a decoder already exists: the admin's browser. A <video> element is
 * pointed at the file, seeked past the opening frames, and painted onto a
 * canvas; the resulting JPEG is uploaded alongside the video and stored as its
 * thumbnail (see MediaService.SaveVideoPoster).
 *
 * Every failure path resolves to null rather than throwing — a codec the
 * browser cannot decode, a file that never loads, a tainted canvas. A video
 * without a poster falls back to the ▶ glyph it has always shown, so capture is
 * never allowed to fail an upload.
 */

/** Longest we wait for metadata, a seek, or a frame before giving up. */
const CAPTURE_TIMEOUT_MS = 15000;

/** Longest edge of the captured frame. The server downscales again to the
 *  configured thumbnail box; this just keeps the upload small. */
const MAX_EDGE = 1280;

const JPEG_QUALITY = 0.85;

/** True when this File/Blob is something we should try to capture from. */
export function isVideoFile(file) {
  return !!file && typeof file.type === "string" && file.type.startsWith("video/");
}

/** Resolve on the first of the named events, or reject on <video> error/timeout. */
function once(video, events, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      events.forEach((e) => video.removeEventListener(e, onEvent));
      video.removeEventListener("error", onError);
    };
    const onEvent = () => {
      if (done) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (done) return;
      cleanup();
      reject(new Error("video error"));
    };
    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);

    events.forEach((e) => video.addEventListener(e, onEvent));
    video.addEventListener("error", onError);
  });
}

/**
 * Pick the timestamp to grab. Many clips open on a black or blank frame, so
 * skip a little way in — but never past a very short clip's own end.
 */
function posterTime(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, duration / 2);
}

/**
 * Capture a poster frame from a video File/Blob (or a same-origin video URL).
 *
 * @param {File|Blob|string} source
 * @returns {Promise<Blob|null>} JPEG frame, or null if none could be captured.
 */
export async function captureVideoPoster(source) {
  if (typeof document === "undefined" || !source) return null;

  const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
  const video = document.createElement("video");

  try {
    // muted + playsInline keep mobile browsers willing to decode without a
    // user gesture; preload="auto" is needed because we want pixels, not just
    // metadata.
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = objectUrl || source;

    await once(video, ["loadedmetadata"], CAPTURE_TIMEOUT_MS);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const target = posterTime(video.duration);
    if (target > 0) {
      video.currentTime = target;
      await once(video, ["seeked"], CAPTURE_TIMEOUT_MS);
    } else {
      await once(video, ["loadeddata"], CAPTURE_TIMEOUT_MS);
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return await new Promise((resolve) => {
      // toBlob hands back null for a tainted canvas (a cross-origin video) as
      // well as for an encoder failure; both mean "no poster".
      try {
        canvas.toBlob((blob) => resolve(blob || null), "image/jpeg", JPEG_QUALITY);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
