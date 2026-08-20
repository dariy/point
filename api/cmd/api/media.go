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

// requestedVariantSize reads which thumbnail rung a media request asks for, or
// 0 for the original.
//
// `?s=<n>` is the current form. `?thumb` and `?thumb=<n>` keep working with no
// data migration behind them: posts.thumbnail_path rows and published post
// content already carry them, and a bare `?thumb` predates the ladder entirely
// so it resolves to the default rung. A size off the ladder is rejected rather
// than clamped — accepting arbitrary sizes would let one crawler fill the disk.
func requestedVariantSize(c echo.Context) (int, error) {
	q := c.Request().URL.Query()
	raw := ""
	if v, ok := q["s"]; ok {
		raw = v[0]
	} else if v, ok := q["thumb"]; ok {
		if v[0] == "" {
			return services.DefaultVariantSize, nil
		}
		raw = v[0]
	} else {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || !services.AllowedVariantSize(n) {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "invalid thumbnail size")
	}
	return n, nil
}

// mediaCacheControl picks the Cache-Control for a media hit.
//
// Private media must never reach a shared cache: an authenticated preview
// response cached at the edge would be replayed to anonymous requests.
//
// For public media the question is what may be pinned, and a URL is only safe
// to pin when changing the bytes changes the URL. Two things do that:
//
//   - a content-addressed filename (…_<checksum>.ext), for the source;
//   - `v=<generation>`, for a derived variant — a rebuild writes a fresh token,
//     which moves every variant URL the site emits at once.
//
// A variant needs both to earn `immutable`. The token alone is not enough: a
// source can be replaced in place — a re-captured poster, an EXIF write —
// without its URL moving, and the variant follows it. The checksum alone is not
// enough either: the variant is derived, and a rebuild changes how it is
// derived (jpeg_quality, the ladder itself) while the source's checksum stands.
// With both, a year at the edge is still a bet that no one replaces a
// content-addressed file in place without rebuilding.
//
// Everything else gets a short browser TTL and a day at the edge, which is what
// the engine served before the ladder existed. A stale or absent `v` is never
// an error: a service worker can hold a page shell that emits last week's
// token, and a 400 or 404 there would black out its images.
func mediaCacheControl(isPublic bool, filename string, servedVariant, genCurrent bool) string {
	if !isPublic {
		return "private, no-store"
	}
	contentAddressed := checksumRe.MatchString(filename)
	if servedVariant {
		switch {
		case !genCurrent:
			return publicShortCacheControl
		case contentAddressed:
			return immutableCacheControl
		default:
			return publicVariantCacheControl
		}
	}
	// The original. Its bytes are not a function of the generation token, so
	// only the filename decides.
	if contentAddressed {
		return immutableCacheControl
	}
	return publicShortCacheControl
}

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

// publicShortCacheControl is the default for public media: a CDN absorbs the
// traffic for a day while a short browser max-age bounds client staleness.
// Media can be renamed, replaced or unpublished at the same URL, so a change
// needs a manual edge purge — a deliberate trade of revalidation for offload.
const publicShortCacheControl = "public, max-age=300, s-maxage=86400"

// publicVariantCacheControl is for a derived variant whose generation token is
// current but whose source filename is not content-addressed. A rebuild moves
// the token and so the URL, which is what lets the edge hold it for a year;
// the browser TTL stays a day so a client that missed the new token recovers
// without waiting one out.
const publicVariantCacheControl = "public, max-age=86400, s-maxage=31536000"

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
//   - ?s=<size> serves a rung of the thumbnail ladder (services.VariantSizes),
//     generated and cached lazily under media/variants/<size>/ on first request.
//     A size off the ladder is a 400.
//   - ?thumb and ?thumb=<size> are the pre-ladder spelling, kept working
//     because published post content carries them; see requestedVariantSize.
//   - ?v=<generation> is the cache-busting token. It never selects a file, only
//     how long the response may be cached; see mediaCacheControl.
//   - No size serves the original (media/originals/…), as does a size at or
//     above the source's longest side.
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
				script, hash := bootstrapScript(c.Request().Context(), settings, chunks, cssMap)
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

		// Resolve the variant before anything is decided about caching: whether
		// this response can be pinned depends on which file ends up served and
		// on the generation token, neither of which is known from the URL path.
		variantSize, sizeErr := requestedVariantSize(c)
		if sizeErr != nil {
			return sizeErr
		}

		servedVariant := ""
		if variantSize > 0 {
			if f, genErr := mediaSvc.Variant(ctx, media, variantSize); genErr == nil {
				servedVariant = f
			} else if strings.EqualFold(media.FileType, "video") || strings.EqualFold(media.FileType, "audio") {
				// Falling through to the original is graceful degradation only
				// when the original is itself a still. For a video or audio
				// file the caller asked for a thumbnail and would get an <img>
				// pointed at a media stream — a broken image that costs a full
				// download. 404 instead; the UI drops back to a type glyph.
				c.Response().Header().Set("Cache-Control", notFoundCacheControl)
				return echo.NewHTTPError(http.StatusNotFound, "no thumbnail for this media")
			}
			// Any other failure — a source below this rung, an undecodable
			// image, an SVG — falls through to the original, which still
			// renders.
		}

		gen := c.Request().URL.Query().Get("v")
		c.Response().Header().Set("Cache-Control", mediaCacheControl(
			media.IsPublic != 0,
			filename,
			servedVariant != "",
			gen != "" && gen == mediaSvc.ThumbnailGeneration(ctx),
		))

		if servedVariant != "" {
			return c.File(servedVariant)
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
