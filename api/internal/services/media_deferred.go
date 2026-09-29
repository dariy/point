package services

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"point-api/internal/models"

	"github.com/disintegration/imaging"
	exif "github.com/dsoprea/go-exif/v3"
	exifcommon "github.com/dsoprea/go-exif/v3/common"
	jpegstructure "github.com/dsoprea/go-jpeg-image-structure/v2"

	// Registers AVIF with image.Decode and image.DecodeConfig. libavif and
	// dav1d compiled to WASM, run on wazero: the binary stays CGO-free.
	_ "github.com/gen2brain/avif"
	// Pure Go HEVC and HEIC decoder (MIT). The import also registers HEIC
	// with image.DecodeConfig, which the pixel guard uses.
	"github.com/gen2brain/h265/heic"
)

// AVIF and HEIC decodes are slow: a 24 MP AVIF takes 3–5 s on WASM. Uploads
// of these types do not wait for the decode. The upload reads the size from
// the header (which also runs the pixel guard), stores the row, and a
// goroutine builds the ladder. For HEIC it also writes a full-size JPEG and
// points the row at it; the HEIC file stays beside the JPEG as the archival
// original.

// deferredDecodeTimeout bounds one background decode and its writes.
const deferredDecodeTimeout = 5 * time.Minute

// heicJPEGQuality is the quality of the full-size JPEG cut from a HEIC. It is
// the file a visitor downloads as the original, so it is set higher than the
// ladder quality.
const heicJPEGQuality = 92

// heifArchiveExts are the extensions an archival HEIC file can carry beside
// its JPEG.
var heifArchiveExts = []string{".heic", ".HEIC", ".heif", ".HEIF"}

// isDeferredDecode reports whether an upload of mimeType decodes in the
// background.
func isDeferredDecode(mimeType string) bool {
	return mimeType == "image/avif" || isHEIF(mimeType)
}

func isHEIF(mimeType string) bool {
	return mimeType == "image/heic" || mimeType == "image/heif"
}

// isHEIFData reports whether data is a HEIC or HEIF file, from its ftyp box.
func isHEIFData(data []byte) bool {
	return len(data) >= 12 && bytes.Equal(data[4:8], []byte("ftyp")) && isHEIF(sniffISOBMFF(data, ""))
}

// safeHEIFDecode decodes a HEIC with its clap, irot and imir transforms, so
// the image is upright. The decoder registered with image.Decode skips them:
// an iPhone photo stores the sensor pixels and an irot box.
func safeHEIFDecode(r io.Reader) (img image.Image, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Warn("recovered panic during heic decode",
				"panic", rec, "stack", string(debug.Stack()))
			err = fmt.Errorf("heic decode panic: %v", rec)
		}
	}()
	return heic.Decode(r, heic.Options{AutoRotate: true})
}

// deferredHeader is the synchronous part of a deferred upload: the pixel guard
// and the size from the header. An unreadable header gives zero values, as a
// failed decode does on the other paths.
func (s *MediaService) deferredHeader(content []byte) (width, height int64, err error) {
	cfg, err := s.checkPixels(content)
	if err != nil {
		return 0, 0, err
	}
	return int64(cfg.Width), int64(cfg.Height), nil
}

// startDeferred runs finishDeferred in the background. It shares the
// variantFlight key of Variant, so a thumbnail request that arrives during the
// decode waits for this decode instead of a second one.
func (s *MediaService) startDeferred(media models.Medium, content []byte) {
	s.deferred.Add(1)
	go func() {
		defer s.deferred.Done()
		ctx, cancel := context.WithTimeout(context.Background(), deferredDecodeTimeout)
		defer cancel()
		key := strconv.FormatInt(media.ID, 10)
		_, _, _ = s.variantFlight.Do(key, func() (any, error) {
			if err := s.finishDeferred(ctx, media, content); err != nil {
				slog.Warn("deferred image decode failed", "media_id", media.ID, "path", media.OriginalPath, "error", err)
			}
			return nil, nil
		})
	}()
}

// WaitDeferred blocks until every background decode has finished. Tests use
// it.
func (s *MediaService) WaitDeferred() {
	s.deferred.Wait()
}

func (s *MediaService) finishDeferred(ctx context.Context, media models.Medium, content []byte) error {
	src, err := s.decodeImage(ctx, content)
	if err != nil {
		return err
	}
	icc := extractICC(content)
	if !isHEIF(media.MimeType) {
		s.backfillDimensions(ctx, media, src)
		return s.writeLadder(ctx, media.OriginalPath, src, icc, "", UploadMaxVariantSize)
	}
	return s.convertHEIF(ctx, media, content, src, icc)
}

// convertHEIF writes the full-size JPEG of a HEIC, with its ICC profile and
// its EXIF, cuts the ladder from it, and points the row at it. The row keeps
// the HEIC checksum, so a second upload of the same HEIC finds this row.
func (s *MediaService) convertHEIF(ctx context.Context, media models.Medium, content []byte, src image.Image, icc []byte) error {
	jpgRel := strings.TrimSuffix(media.OriginalPath, filepath.Ext(media.OriginalPath)) + ".jpg"
	jpgFull := filepath.Clean(filepath.Join(s.mediaBase(), jpgRel))
	if !strings.HasPrefix(jpgFull, s.mediaBase()+string(filepath.Separator)) {
		return fmt.Errorf("invalid media path")
	}
	if _, err := os.Stat(jpgFull); err == nil {
		return fmt.Errorf("jpeg already exists: %s", jpgRel)
	}

	var buf bytes.Buffer
	if err := imaging.Encode(&buf, src, imaging.JPEG, imaging.JPEGQuality(heicJPEGQuality)); err != nil {
		return err
	}
	enc := buf.Bytes()
	if len(icc) > 0 {
		out := make([]byte, 0, len(enc)+len(icc)+64)
		out = append(out, enc[:2]...)
		out = append(out, iccSegments(icc)...)
		enc = append(out, enc[2:]...)
	}
	if withExif, err := withHEIFExif(enc, content); err != nil {
		slog.Warn("heic exif not copied to jpeg", "media_id", media.ID, "error", err)
	} else {
		enc = withExif
	}

	tmp := jpgFull + ".tmp"
	//nolint:gosec // G703: path is composed from the storage root, not from input
	if err := os.WriteFile(tmp, enc, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, jpgFull); err != nil {
		_ = os.Remove(tmp)
		return err
	}

	if err := s.writeLadder(ctx, jpgRel, src, icc, "", UploadMaxVariantSize); err != nil {
		slog.Warn("thumbnail ladder generation failed", "path", jpgRel, "error", err)
	}

	// The header size is before irot, so a portrait iPhone photo stored it
	// swapped. The decoded size is the upright one.
	b := src.Bounds()
	if err := s.repo.SetMediaDimensions(ctx, media.ID, int64(b.Dx()), int64(b.Dy())); err != nil {
		slog.Warn("media dimensions update failed", "media_id", media.ID, "error", err)
	}

	filename := strings.TrimSuffix(media.Filename, filepath.Ext(media.Filename)) + ".jpg"
	if err := s.repo.ReplaceMediaOriginal(ctx, media.ID, filename, jpgRel, "image/jpeg", int64(len(enc))); err != nil {
		_ = os.Remove(jpgFull)
		s.removeAllVariants(jpgRel)
		return err
	}
	// No rung cleanup for the HEIC path: VariantRelPath drops the extension,
	// so the HEIC and its JPEG share their rungs.

	oldContentPath := strings.TrimPrefix(media.OriginalPath, "originals")
	newContentPath := strings.TrimPrefix(jpgRel, "originals")
	if _, err := s.repo.ReplacePostContentPath(ctx, oldContentPath, newContentPath); err != nil {
		slog.Warn("post content path update failed", "media_id", media.ID, "error", err)
	}
	if s.cache != nil {
		if err := s.cache.InvalidatePublicPages(ctx); err != nil {
			slog.Warn("page cache invalidation failed", "media_id", media.ID, "error", err)
		}
	}
	return nil
}

// withHEIFExif copies the EXIF block of a HEIC into a JPEG as an APP1 segment.
// Orientation is set to 1: the decoder has already applied the rotation, and a
// browser would rotate the JPEG a second time.
func withHEIFExif(jpeg, heif []byte) ([]byte, error) {
	rawExif, err := exif.SearchAndExtractExif(heif)
	if err != nil {
		return nil, err
	}
	im, err := exifcommon.NewIfdMappingWithStandard()
	if err != nil {
		return nil, err
	}
	_, index, err := exif.Collect(im, exif.NewTagIndex(), rawExif)
	if err != nil {
		return nil, err
	}
	rootIb := exif.NewIfdBuilderFromExistingChain(index.RootIfd)
	if err := rootIb.SetStandardWithName("Orientation", []uint16{1}); err != nil {
		return nil, err
	}

	intfc, err := jpegstructure.NewJpegMediaParser().ParseBytes(jpeg)
	if err != nil {
		return nil, err
	}
	sl := intfc.(*jpegstructure.SegmentList)
	if err := sl.SetExif(rootIb); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := sl.Write(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// heifArchive returns the media-relative path of the archival HEIC beside a
// converted JPEG, or "" when there is none.
func (s *MediaService) heifArchive(media models.Medium) string {
	if media.MimeType != "image/jpeg" {
		return ""
	}
	stem := strings.TrimSuffix(media.OriginalPath, filepath.Ext(media.OriginalPath))
	for _, ext := range heifArchiveExts {
		if _, err := os.Stat(filepath.Join(s.mediaBase(), stem+ext)); err == nil {
			return stem + ext
		}
	}
	return ""
}

// removeHEIFArchive deletes the archival HEIC beside a converted JPEG. Every
// path that deletes an original calls it.
func (s *MediaService) removeHEIFArchive(media models.Medium) {
	if archive := s.heifArchive(media); archive != "" {
		_ = os.Remove(filepath.Join(s.mediaBase(), archive))
	}
}
