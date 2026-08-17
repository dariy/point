package main

// Serving media bytes from /YYYY/MM/filename — visibility enforcement, variant
// selection and the cache headers each outcome earns. The route itself is
// registered in routes.go.

import (
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// checksumRe matches the 8-char hex checksum embedded in a media filename,
// e.g. "video_89017c29.mp4" → "89017c29".
var checksumRe = regexp.MustCompile(`_([0-9a-f]{8})\.[^.]+$`)

// neutralizeSVG locks down the response when the file being served is an SVG.
//
// SVG is the only allowlisted upload format a browser will execute script from:
// navigating straight to /2026/07/x.svg renders it as a document, in this
// origin. Uploads are scanned for active content (services.ScanSVG) and
// admin-only, but neither is a reason to let the served bytes rely on the
// site-wide CSP staying exactly as it is today — one regression there would
// turn a stored file into stored XSS.
//
// The per-response policy denies everything and sandboxes the document, so
// nothing in the SVG runs regardless of the global policy. Embedding via <img>
// is unaffected: that context never executes script and ignores this header.
func neutralizeSVG(c echo.Context, path string) {
	if !strings.EqualFold(filepath.Ext(path), ".svg") {
		return
	}
	c.Response().Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; sandbox")
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
}

// notFoundCacheControl is the header for media 404s. A 404 is never cached on
// the same terms as a hit: the reasons a media URL 404s are all transient
// (bytes not yet written, a stale or unmounted media volume, a post not yet
// published), so a long TTL outlives the cause and keeps serving 404s from the
// edge after the origin recovers — an s-maxage=86400 404 cached during a
// storage fault once kept a site's images broken for the rest of the day.
//
// A short shared TTL still collapses a repeated hammering of one dead URL (a
// hotlinked image, a retrying crawler) into one origin hit per colo per
// minute, while bounding post-recovery staleness to that same minute. Note it
// buys nothing against a flood of *distinct* nonexistent paths — each is its
// own cache key and misses to the origin — which is a rate-limiting problem,
// not a caching one.
const notFoundCacheControl = "public, max-age=30, s-maxage=60"

// serveSimplifiedMedia handles /YYYY/MM/filename for media files.
//
// Access rules:
//   - Authenticated users (session cookie present) may access any file.
//   - Unauthenticated users may only access files where media.is_public = 1.
//   - Files not found in the media table return 404.
//
// Variant selection:
//   - ?thumb=<size> serves an on-demand square thumbnail (e.g. the atlas
//     cloud's 128px chips), generated and cached lazily from the original.
//   - ?thumb (no value) serves the stored thumbnail (media/thumbnails/…) when one exists.
//   - No query param serves the original (media/originals/…).
//
// Non-numeric year/month segments are SPA routes — index.html is served instead.
func serveSimplifiedMedia(storagePath, indexHTMLContent string, repo repository.Repository, mediaSvc *services.MediaService, s3Presigner *services.S3Presigner, settings *services.SettingsService, chunks map[string]string, cssMap map[string]bool) echo.HandlerFunc {
	return func(c echo.Context) error {
		year := c.Param("year")
		month := c.Param("month")
		filename := c.Param("filename")

		// Validate year/month are numeric — non-numeric means this is an SPA route.
		yearInt, yearErr := strconv.Atoi(year)
		monthInt, monthErr := strconv.Atoi(month)
		if yearErr != nil || monthErr != nil || yearInt < 1000 || yearInt > 9999 || monthInt < 1 || monthInt > 12 {
			if indexHTMLContent != "" {
				script, hash := pluginManifestScript(c.Request().Context(), settings, chunks, cssMap)
				htmlStr := strings.Replace(indexHTMLContent, "</head>", script+"\n</head>", 1)

				csp := c.Response().Header().Get("Content-Security-Policy")
				csp = strings.Replace(csp, "script-src", "script-src 'sha256-"+hash+"'", 1)
				c.Response().Header().Set("Content-Security-Policy", csp)

				return c.HTML(http.StatusOK, htmlStr)
			}
			return c.JSON(http.StatusServiceUnavailable, map[string]string{
				"detail": "Frontend not available — build the frontend first",
			})
		}

		// Sanitize year and month by reconstructing them from the validated integers.
		// This ensures they contain only digits and satisfies static analysis.
		year = strconv.Itoa(yearInt)
		month = fmt.Sprintf("%02d", monthInt)

		// Prevent path traversal in the filename segment.
		if filename == "" || filename == "." || strings.Contains(filename, "..") || strings.ContainsAny(filename, "/\\") {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid path")
		}

		isAuthenticated := c.Get("user") != nil

		// Resolve the media record from the DB using the original_path key.
		origRelPath := "originals/" + year + "/" + month + "/" + filename
		ctx := c.Request().Context()
		media, err := repo.GetMediaByPath(ctx, origRelPath)
		if err != nil {
			// DB record not found — try the checksum-glob fallback to handle
			// renamed files, then retry the DB lookup with the resolved name.
			dir := filepath.Join(storagePath, "media", "originals", year, month)
			if m := checksumRe.FindStringSubmatch(filename); m != nil {
				matches, _ := filepath.Glob(filepath.Join(dir, "*_"+m[1]+".*"))
				if len(matches) == 1 {
					resolvedName := filepath.Base(matches[0])
					resolvedPath := "originals/" + year + "/" + month + "/" + resolvedName
					media, err = repo.GetMediaByPath(ctx, resolvedPath)
				}
			}
			if err != nil {
				// Briefly cacheable: this is the branch a scan of nonexistent
				// paths lands in, so repeated hits on one dead URL should not
				// each reach the DB. The short TTL bounds how long a 404 keyed
				// on the .jpg extension is served stale after the file appears.
				c.Response().Header().Set("Cache-Control", notFoundCacheControl)
				return echo.NewHTTPError(http.StatusNotFound, "media not found")
			}
		}

		// Enforce visibility: unauthenticated clients cannot access private media.
		if media.IsPublic == 0 && !isAuthenticated {
			// The one 404 that stays uncacheable. Unlike the others, this
			// response is authentication-dependent: the same URL serves the
			// bytes to a logged-in owner. A shared cache does not vary on
			// cookies for image extensions, so letting an anonymous 404 into
			// the edge would serve it back to the owner and black out their own
			// private media. no-store also keeps publishing a hidden post from
			// being masked by a stale 404 (see the DB-miss branch above).
			c.Response().Header().Set("Cache-Control", "no-store")
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		// Public media is edge-cacheable so a CDN absorbs traffic without
		// hitting the origin: s-maxage lets a shared cache serve it for a day,
		// while a short browser max-age bounds client staleness. Media can be
		// renamed/replaced/unpublished at the same URL, so a change requires a
		// manual edge purge (rare, operator-driven) — we deliberately trade
		// no-cache revalidation for full offload. Private media must never be
		// cached by a shared cache, or an authenticated preview response could
		// leak hidden media to the edge for unauthenticated requests to reuse.
		if media.IsPublic != 0 {
			if checksumRe.MatchString(filename) {
				// Content-addressed: the filename carries a checksum of the bytes,
				// so replacing the image produces a different URL and this one can
				// be cached forever. The trade-off is unpublishing — a client that
				// already fetched the file keeps its copy until the year is up, so
				// visibility changes are not retroactive for cached bytes. That is
				// the same bargain the existing s-maxage=86400 edge cache makes.
				c.Response().Header().Set("Cache-Control", immutableCacheControl)
			} else {
				c.Response().Header().Set("Cache-Control", "public, max-age=300, s-maxage=86400")
			}
		} else {
			c.Response().Header().Set("Cache-Control", "private, no-store")
		}

		// Determine which file to serve.
		thumbVals, wantThumb := c.Request().URL.Query()["thumb"]
		if wantThumb {
			// `?thumb=<size>` requests an on-demand square thumbnail; a bare
			// `?thumb` serves the stored thumbnail variant. An unsupported size is
			// rejected, but a generation failure (e.g. an undecodable image) falls
			// through to the original below so the image still renders. A bare
			// `?thumb` whose stored thumbnail is absent (no path, outside the media
			// dir, or file missing) likewise falls through to the original rather
			// than 404ing, so the image still renders.
			if sizeStr := thumbVals[0]; sizeStr != "" {
				n, convErr := strconv.Atoi(sizeStr)
				if convErr != nil || !services.AllowedSquareThumbSize(n) {
					return echo.NewHTTPError(http.StatusBadRequest, "invalid thumbnail size")
				}
				if thumbFile, genErr := mediaSvc.SquareThumbnail(ctx, media, n); genErr == nil {
					return c.File(thumbFile)
				}
			} else if media.ThumbnailPath.Valid {
				thumbFile := filepath.Clean(filepath.Join(storagePath, "media", media.ThumbnailPath.String))

				// Security: ensure the resolved file is within the media storage
				// directory before serving it; otherwise fall through to the original.
				if strings.HasPrefix(thumbFile, filepath.Join(storagePath, "media")) {
					if _, err := os.Stat(thumbFile); err == nil {
						return c.File(thumbFile)
					}
				}
			}

			// Falling through to the original is only a graceful degradation when
			// the original is itself a still. For a video or audio file the caller
			// asked for a thumbnail and would get an <img> pointed at a media
			// stream — a broken image that costs a full download. 404 instead;
			// the UI drops back to a type glyph on error.
			if strings.EqualFold(media.FileType, "video") || strings.EqualFold(media.FileType, "audio") {
				// Replace the hit TTL set above, which for a content-addressed
				// filename is immutable — a year of cached 404 for a thumbnail
				// that a later reupload could well make available.
				c.Response().Header().Set("Cache-Control", notFoundCacheControl)
				return echo.NewHTTPError(http.StatusNotFound, "no thumbnail for this media")
			}
		}

		// Serve original — try exact path first, then checksum-glob fallback.
		origDir := filepath.Join(storagePath, "media", "originals", year, month)
		origFile := filepath.Clean(filepath.Join(origDir, filepath.Base(filename)))

		// Security: ensure the resolved file is within the expected originals directory.
		if !strings.HasPrefix(origFile, filepath.Join(storagePath, "media", "originals")) {
			c.Response().Header().Set("Cache-Control", notFoundCacheControl)
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		if _, err := os.Stat(origFile); err == nil {
			neutralizeSVG(c, origFile)

			s3Enabled := c.Request().Header.Get("X-Point-Direct-S3") == "1"
			if s3Enabled && s3Presigner != nil {
				relPath, err := filepath.Rel(storagePath, origFile)
				if err == nil {
					// filepath.Rel uses os-specific separators, but S3 requires forward slashes.
					// We can assume Linux here since point runs on Linux in Docker, but let's be safe.
					relPath = filepath.ToSlash(relPath)

					url, presignErr := s3Presigner.PresignGetObject(c.Request().Context(), relPath)
					if presignErr == nil {
						c.Response().Header().Set("X-S3-Presigned-Url", url)
						// Determine the correct Content-Type before bypassing
						contentType := mime.TypeByExtension(filepath.Ext(origFile))
						if contentType != "" {
							c.Response().Header().Set("Content-Type", contentType)
						}
						return c.NoContent(http.StatusOK)
					} else {
						// log error, fall back to disk
						log.Printf("S3 presign error: %v", presignErr)
					}
				}
			}

			return c.File(origFile)
		}
		if m := checksumRe.FindStringSubmatch(filename); m != nil {
			matches, _ := filepath.Glob(filepath.Join(origDir, "*_"+m[1]+".*"))
			if len(matches) == 1 {
				matchFile := filepath.Clean(filepath.Join(origDir, filepath.Base(matches[0])))
				// Security: double-check the globbed file prefix.
				if strings.HasPrefix(matchFile, filepath.Join(storagePath, "media", "originals")) {
					neutralizeSVG(c, matchFile)
					return c.File(matchFile)
				}
			}
		}

		// The DB record exists and is public, so the long hit TTL (up to
		// immutable) was already set above — but the bytes are missing from
		// disk. That is a transient storage fault (an unmounted or stale media
		// volume), not a property of the URL, so the hit TTL must be replaced
		// rather than inherited: left alone it outlives the fault by up to a
		// day and keeps serving 404s from the edge long after the file is
		// readable again.
		c.Response().Header().Set("Cache-Control", notFoundCacheControl)
		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
}
