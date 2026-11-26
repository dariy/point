package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"point-api/internal/repository"
)

// The portable export is one .tar.gz that another program, or the import of a
// new instance, can read without the engine. It holds:
//
//	manifest.json                       format, version, instance version, counts
//	tags.json                           all tags with their parent links
//	posts/<slug>.md                     front matter + post body
//	media/originals/<YYYY>/<MM>/<file>  the original file
//	media/originals/<YYYY>/<MM>/<file>.json  the sidecar of that file
//
// It reads a VACUUM INTO snapshot of the database, so the content is one
// consistent state, and it streams each file into the archive. Derived files
// (thumbnails, variants, the page cache) stay out, as in the backup.
// docs/features/export.md describes the format.

// ExportFormat is the "format" field of the export manifest.
const ExportFormat = "point-export"

// ExportFormatVersion is the export format this build writes. An import
// refuses a higher version.
const ExportFormatVersion = 1

// exportDirName is the directory under <data>/backups that holds exports. The
// backup skips <data>/backups, so an export never goes into a backup.
const exportDirName = "exports"

// exportFilePrefix starts the name of each export archive.
const exportFilePrefix = "point-export_"

// exportResultFile, in the exports directory, stores the last export result.
const exportResultFile = "export.json"

// exportMaxMissing limits the missing files a result lists. The count is
// always complete.
const exportMaxMissing = 20

// healthTaskExport is the HealthRegistry key for the export.
const healthTaskExport = "portable export"

// ErrExportInProgress is returned when an export is requested while one is
// already running.
var ErrExportInProgress = kindSentinel(ErrConflict, "an export is already in progress")

// exportManifest is the manifest.json of an export archive.
type exportManifest struct {
	Format          string                  `json:"format"`
	Version         int                     `json:"version"`
	InstanceVersion string                  `json:"instance_version"`
	CreatedAt       time.Time               `json:"created_at"`
	Counts          repository.ExportCounts `json:"counts"`
}

// exportFrontMatter is the YAML front matter of posts/<slug>.md.
type exportFrontMatter struct {
	Title           string     `yaml:"title"`
	Slug            string     `yaml:"slug"`
	Type            string     `yaml:"type"`
	Status          string     `yaml:"status"`
	Formatter       string     `yaml:"formatter"`
	Featured        bool       `yaml:"featured,omitempty"`
	CreatedAt       time.Time  `yaml:"created_at"`
	UpdatedAt       time.Time  `yaml:"updated_at"`
	PublishedAt     *time.Time `yaml:"published_at,omitempty"`
	ScheduledAt     *time.Time `yaml:"scheduled_at,omitempty"`
	Tags            []string   `yaml:"tags"`
	Thumbnail       string     `yaml:"thumbnail,omitempty"`
	Excerpt         string     `yaml:"excerpt,omitempty"`
	MetaDescription string     `yaml:"meta_description,omitempty"`
	ImmersiveMode   string     `yaml:"immersive_mode,omitempty"`
	Css             string     `yaml:"css,omitempty"`
}

// exportMediaSidecar is media/<original path>.json.
type exportMediaSidecar struct {
	Filename     string    `json:"filename"`
	OriginalPath string    `json:"original_path"`
	FileType     string    `json:"file_type"`
	MimeType     string    `json:"mime_type"`
	FileSize     int64     `json:"file_size"`
	Width        *int64    `json:"width,omitempty"`
	Height       *int64    `json:"height,omitempty"`
	UploadedAt   time.Time `json:"uploaded_at"`
	Checksum     string    `json:"checksum"`
	AltText      string    `json:"alt_text,omitempty"`
	Caption      string    `json:"caption,omitempty"`
	// Exif is the media metadata (EXIF and IPTC fields) as the instance
	// shows it; OriginalExif is the metadata read from the file at upload.
	Exif         json.RawMessage `json:"exif,omitempty"`
	OriginalExif json.RawMessage `json:"original_exif,omitempty"`
	// Visibility is "public" when the file is in a visible published post,
	// else "private".
	Visibility string `json:"visibility"`
	// Post is the slug of the post the file was uploaded to.
	Post string `json:"post,omitempty"`
	// Missing is true when the original was not on disk at export time. The
	// sidecar is written, the file is not.
	Missing bool `json:"missing,omitempty"`
}

// exportTagParent and exportTag are the entries of tags.json.
type exportTagParent struct {
	Slug      string `json:"slug"`
	SortOrder *int64 `json:"sort_order,omitempty"`
}

type exportTag struct {
	Name             string            `json:"name"`
	Slug             string            `json:"slug"`
	Description      string            `json:"description,omitempty"`
	Kind             string            `json:"kind"`
	Hidden           bool              `json:"hidden"`
	HidesPosts       bool              `json:"hides_posts"`
	NavOrder         *int64            `json:"nav_order,omitempty"`
	InBreadcrumbs    bool              `json:"in_breadcrumbs"`
	ShowRelated      bool              `json:"show_related"`
	InAncestorFlyout bool              `json:"in_ancestor_flyout"`
	Latitude         *float64          `json:"latitude,omitempty"`
	Longitude        *float64          `json:"longitude,omitempty"`
	CreatedAt        time.Time         `json:"created_at"`
	Parents          []exportTagParent `json:"parents"`
}

// ExportResult is the outcome of one export.
type ExportResult struct {
	Filename  string                  `json:"filename,omitempty"`
	Size      int64                   `json:"size,omitempty"`
	Sha256    string                  `json:"sha256,omitempty"`
	CreatedAt time.Time               `json:"created_at"`
	Counts    repository.ExportCounts `json:"counts"`
	// Missing lists the first originals that were not on disk; MissingCount
	// counts all of them.
	Missing      []string `json:"missing,omitempty"`
	MissingCount int      `json:"missing_count"`
	// Error is set when the export failed. Then no archive was published.
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func (s *SystemService) exportDir() string {
	return filepath.Join(s.dataPath, "backups", exportDirName)
}

// ExportRunning reports whether an export is running now.
func (s *SystemService) ExportRunning() bool {
	s.exportMu.Lock()
	defer s.exportMu.Unlock()
	return s.exportRunning
}

// LastExport returns the result of the last export, or nil when no export
// has run.
func (s *SystemService) LastExport() *ExportResult {
	data, err := os.ReadFile(filepath.Join(s.exportDir(), exportResultFile))
	if err != nil {
		return nil
	}
	var r ExportResult
	if err := json.Unmarshal(data, &r); err != nil {
		return nil
	}
	return &r
}

// ExportPath returns the path of the export archive filename, if filename is
// the published export.
func (s *SystemService) ExportPath(filename string) (string, error) {
	if !isSafeBackupName(filename) || !strings.HasPrefix(filename, exportFilePrefix) || !strings.HasSuffix(filename, ".tar.gz") {
		return "", wrapKind(ErrInvalidInput, errors.New("invalid filename"))
	}
	p := filepath.Join(s.exportDir(), filename)
	if _, err := os.Stat(p); err != nil {
		return "", wrapKind(ErrNotFound, errors.New("export not found"))
	}
	return p, nil
}

// CreateExport writes a new export archive into <data>/backups/exports and
// removes the older ones. instanceVersion goes into the manifest. The result
// is also stored for LastExport, on success and on failure.
func (s *SystemService) CreateExport(ctx context.Context, instanceVersion string) (ExportResult, error) {
	s.exportMu.Lock()
	if s.exportRunning {
		s.exportMu.Unlock()
		return ExportResult{}, ErrExportInProgress
	}
	s.exportRunning = true
	s.exportMu.Unlock()
	defer func() {
		s.exportMu.Lock()
		s.exportRunning = false
		s.exportMu.Unlock()
	}()

	start := time.Now()
	res, err := s.createExport(ctx, instanceVersion, start)
	res.DurationMS = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = err.Error()
	}
	if werr := s.writeExportResult(res); werr != nil {
		slog.Warn("export: could not store the result", "err", werr)
	}
	if s.health != nil {
		var herr error
		switch {
		case err != nil:
			herr = err
		case res.MissingCount > 0:
			herr = fmt.Errorf("%d originals were missing on disk", res.MissingCount)
		}
		s.health.Record(healthTaskExport, herr)
	}
	return res, err
}

func (s *SystemService) createExport(ctx context.Context, instanceVersion string, start time.Time) (ExportResult, error) {
	res := ExportResult{CreatedAt: start.UTC()}
	dir := s.exportDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, fmt.Errorf("create exports directory: %w", err)
	}
	s.removePartials(dir)

	snap, err := os.CreateTemp("", "point-export-snapshot-*.db")
	if err != nil {
		return res, err
	}
	snapPath := snap.Name()
	_ = snap.Close()
	// VACUUM INTO requires the destination file to not exist.
	_ = os.Remove(snapPath)
	if err := s.repo.BackupDB(ctx, snapPath); err != nil {
		_ = os.Remove(snapPath)
		return res, fmt.Errorf("db snapshot: %w", err)
	}
	defer func() { _ = os.Remove(snapPath) }()

	name := exportFilePrefix + start.Format("20060102_150405") + ".tar.gz"
	final := filepath.Join(dir, name)
	partial := final + partialSuffix
	sum, err := s.writeExportArchive(ctx, snapPath, partial, instanceVersion, start, &res)
	if err != nil {
		_ = os.Remove(partial)
		return res, err
	}
	if err := os.Rename(partial, final); err != nil {
		_ = os.Remove(partial)
		return res, err
	}
	if info, err := os.Stat(final); err == nil {
		res.Size = info.Size()
	}
	res.Filename = name
	res.Sha256 = sum
	s.removeOldExports(dir, name)
	slog.Info("export created", "file", name, "size", res.Size,
		"posts", res.Counts.Posts, "pages", res.Counts.Pages, "media", res.Counts.Media,
		"missing", res.MissingCount)
	return res, nil
}

// writeExportArchive writes the archive from the snapshot at snapPath to dest
// and returns the SHA-256 (hex) of the .tar.gz.
func (s *SystemService) writeExportArchive(ctx context.Context, snapPath, dest, instanceVersion string, start time.Time, res *ExportResult) (string, error) {
	db, err := repository.OpenExportSnapshot(snapPath)
	if err != nil {
		return "", err
	}
	defer func() { _ = db.Close() }()

	counts, err := db.Counts(ctx)
	if err != nil {
		return "", fmt.Errorf("count rows: %w", err)
	}
	res.Counts = counts
	media, err := db.MediaPaths(ctx)
	if err != nil {
		return "", fmt.Errorf("read media paths: %w", err)
	}
	tags, err := db.Tags(ctx)
	if err != nil {
		return "", fmt.Errorf("read tags: %w", err)
	}

	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	hasher := sha256.New()
	gz, err := gzip.NewWriterLevel(io.MultiWriter(f, hasher), gzip.BestSpeed)
	if err != nil {
		return "", err
	}
	tw := tar.NewWriter(gz)

	// The manifest is the first entry, so a reader can refuse an unknown
	// version before it reads the rest.
	if err := writeJSONToTar(tw, "manifest.json", exportManifest{
		Format:          ExportFormat,
		Version:         ExportFormatVersion,
		InstanceVersion: instanceVersion,
		CreatedAt:       start.UTC(),
		Counts:          counts,
	}, start); err != nil {
		return "", err
	}
	if err := writeJSONToTar(tw, "tags.json", exportTagsJSON(tags), start); err != nil {
		return "", err
	}

	if err := db.EachPost(ctx, func(p repository.ExportPost) error {
		data, err := exportPostMarkdown(p, media)
		if err != nil {
			return fmt.Errorf("post %d: %w", p.ID, err)
		}
		return writeBytesToTar(tw, "posts/"+exportPostFileName(p)+".md", data, p.UpdatedAt)
	}); err != nil {
		return "", err
	}

	if err := db.EachMedia(ctx, func(m repository.ExportMedia) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, ok := exportMediaPath(m.OriginalPath)
		if !ok {
			slog.Warn("export: skipped media with an unsafe path", "id", m.ID, "path", m.OriginalPath)
			res.addMissing(m.OriginalPath)
			return nil
		}
		entry := "media/" + rel
		written, err := exportFileToTar(tw, filepath.Join(s.dataPath, "media", filepath.FromSlash(rel)), entry)
		if err != nil {
			return err
		}
		if !written {
			res.addMissing(m.OriginalPath)
		}
		side, err := json.MarshalIndent(exportSidecar(m, !written), "", "  ")
		if err != nil {
			return err
		}
		return writeBytesToTar(tw, entry+".json", append(side, '\n'), m.UploadedAt)
	}); err != nil {
		return "", err
	}

	if err := tw.Close(); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	if err := f.Sync(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func (r *ExportResult) addMissing(p string) {
	r.MissingCount++
	if len(r.Missing) < exportMaxMissing {
		r.Missing = append(r.Missing, p)
	}
}

func (s *SystemService) writeExportResult(r ExportResult) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	dir := s.exportDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, exportResultFile+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, exportResultFile))
}

// removeOldExports removes each export archive in dir except keep. An export
// holds a copy of every original, so only the newest one stays.
func (s *SystemService) removeOldExports(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || n == keep || !strings.HasPrefix(n, exportFilePrefix) || !strings.HasSuffix(n, ".tar.gz") {
			continue
		}
		if err := os.Remove(filepath.Join(dir, n)); err != nil {
			slog.Warn("export: could not remove an old export", "file", n, "err", err)
		}
	}
}

// exportMediaPath returns the slash path of an original under <data>/media
// ("originals/YYYY/MM/file"), or ok=false when the stored path is not a clean
// relative path inside originals/.
func exportMediaPath(originalPath string) (string, bool) {
	p := filepath.ToSlash(originalPath)
	if p == "" || strings.HasPrefix(p, "/") || path.Clean(p) != p || !strings.HasPrefix(p, "originals/") {
		return "", false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", false
		}
	}
	return p, true
}

// exportPostFileName is the base name of the post file: the slug, or
// "post-<id>" when the slug cannot be a file name.
func exportPostFileName(p repository.ExportPost) string {
	s := p.Slug
	if s == "" || s == "." || s == ".." || strings.ContainsAny(s, "/\\\x00") {
		return fmt.Sprintf("post-%d", p.ID)
	}
	return s
}

// exportMediaRefPrefix replaces the leading "/" of a media reference in a post
// file. posts/<slug>.md is one level down, so "../media/originals" resolves to
// the original inside the archive.
const exportMediaRefPrefix = "../media/originals"

// exportRewriteMediaRefs rewrites each media reference "/YYYY/MM/file" in
// content to "../media/originals/YYYY/MM/file" when that original is in the
// export (media holds "originals/YYYY/MM/file" paths). A reference to a file
// that is not in the export, and a "/YYYY/MM/" segment inside a longer URL,
// stay as they are.
func exportRewriteMediaRefs(content string, media map[string]bool) string {
	matches := mediaPathRe.FindAllStringIndex(content, -1)
	if len(matches) == 0 {
		return content
	}
	var b strings.Builder
	last := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		if start > 0 && isURLByte(content[start-1]) {
			continue
		}
		ref := content[start:end]
		// The pattern allows spaces in a file name, so a match can run into the
		// words after the reference. Cut at whitespace until the rest names a
		// file of the export.
		for !media["originals"+ref] {
			i := strings.LastIndexAny(ref, " \t")
			if i < 0 {
				ref = ""
				break
			}
			ref = strings.TrimRight(ref[:i], " \t")
		}
		if ref == "" {
			continue
		}
		b.WriteString(content[last:start])
		b.WriteString(exportMediaRefPrefix)
		b.WriteString(ref)
		last = start + len(ref)
	}
	b.WriteString(content[last:])
	return b.String()
}

// isURLByte reports whether c, just before a "/YYYY/MM/" match, makes the
// match part of a longer URL or path ("https://host/2024/01/x.jpg").
func isURLByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("/.:_-~%", c) >= 0
}

// exportPostMarkdown returns the post file: YAML front matter, then the body
// with its media references rewritten.
func exportPostMarkdown(p repository.ExportPost, media map[string]bool) ([]byte, error) {
	fm := exportFrontMatter{
		Title:           p.Title,
		Slug:            p.Slug,
		Type:            p.Type,
		Status:          p.Status,
		Formatter:       p.Formatter,
		Featured:        p.IsFeatured,
		CreatedAt:       p.CreatedAt.UTC(),
		UpdatedAt:       p.UpdatedAt.UTC(),
		Tags:            p.TagSlugs,
		Excerpt:         p.Excerpt.String,
		MetaDescription: p.MetaDescription.String,
		Css:             p.Css,
	}
	if p.ImmersiveMode != "" && p.ImmersiveMode != "auto" {
		fm.ImmersiveMode = p.ImmersiveMode
	}
	if p.PublishedAt.Valid {
		t := p.PublishedAt.Time.UTC()
		fm.PublishedAt = &t
	}
	if p.ScheduledAt.Valid {
		t := p.ScheduledAt.Time.UTC()
		fm.ScheduledAt = &t
	}
	if p.ThumbnailPath.Valid && p.ThumbnailPath.String != "" {
		fm.Thumbnail = exportRewriteMediaRefs(p.ThumbnailPath.String, media)
	}
	head, err := yaml.Marshal(fm)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.Write(head)
	buf.WriteString("---\n\n")
	buf.WriteString(exportRewriteMediaRefs(p.Content, media))
	if !strings.HasSuffix(p.Content, "\n") {
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

// exportJSONField returns raw as JSON: itself when it is valid JSON, else a
// JSON string, and nil when it is empty.
func exportJSONField(raw string) json.RawMessage {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "{}" || raw == "null" {
		return nil
	}
	if json.Valid([]byte(raw)) {
		return json.RawMessage(raw)
	}
	b, _ := json.Marshal(raw)
	return b
}

func exportSidecar(m repository.ExportMedia, missing bool) exportMediaSidecar {
	side := exportMediaSidecar{
		Filename:     m.Filename,
		OriginalPath: m.OriginalPath,
		FileType:     m.FileType,
		MimeType:     m.MimeType,
		FileSize:     m.FileSize,
		UploadedAt:   m.UploadedAt.UTC(),
		Checksum:     m.Checksum,
		AltText:      m.AltText.String,
		Caption:      m.Caption.String,
		Exif:         exportJSONField(m.Metadata.String),
		OriginalExif: exportJSONField(m.OriginalMetadata.String),
		Visibility:   "private",
		Post:         m.PostSlug.String,
		Missing:      missing,
	}
	if m.IsPublic {
		side.Visibility = "public"
	}
	if m.Width.Valid {
		w := m.Width.Int64
		side.Width = &w
	}
	if m.Height.Valid {
		h := m.Height.Int64
		side.Height = &h
	}
	return side
}

func exportTagsJSON(tags []repository.ExportTag) []exportTag {
	out := make([]exportTag, 0, len(tags))
	for _, t := range tags {
		et := exportTag{
			Name:             t.Name,
			Slug:             t.Slug,
			Description:      t.Description.String,
			Kind:             t.Kind,
			Hidden:           t.Hidden,
			HidesPosts:       t.HidesPosts,
			InBreadcrumbs:    t.InBreadcrumbs,
			ShowRelated:      t.ShowRelated,
			InAncestorFlyout: t.InAncestorFlyout,
			CreatedAt:        t.CreatedAt.UTC(),
			Parents:          make([]exportTagParent, 0, len(t.Parents)),
		}
		if t.NavOrder.Valid {
			v := t.NavOrder.Int64
			et.NavOrder = &v
		}
		if t.Latitude.Valid && t.Longitude.Valid {
			lat, lon := t.Latitude.Float64, t.Longitude.Float64
			et.Latitude, et.Longitude = &lat, &lon
		}
		for _, p := range t.Parents {
			ep := exportTagParent{Slug: p.Slug}
			if p.SortOrder.Valid {
				v := p.SortOrder.Int64
				ep.SortOrder = &v
			}
			et.Parents = append(et.Parents, ep)
		}
		out = append(out, et)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slug < out[j].Slug })
	return out
}

// exportFileToTar streams the file at srcPath into tw under name. The header
// has the size and modification time of the file, but no owner: the archive
// leaves the host, and the user and group names of the host do not go with it.
// It returns false, with nothing written, when the file cannot be opened.
func exportFileToTar(tw *tar.Writer, srcPath, name string) (bool, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		slog.Warn("export: original not on disk", "path", srcPath, "err", err)
		return false, nil
	}
	defer func() { _ = src.Close() }()
	info, err := src.Stat()
	if err != nil || !info.Mode().IsRegular() {
		slog.Warn("export: original is not a readable file", "path", srcPath, "err", err)
		return false, nil
	}
	if err := tw.WriteHeader(&tar.Header{
		Name:     name,
		Typeflag: tar.TypeReg,
		Mode:     0o644,
		Size:     info.Size(),
		ModTime:  info.ModTime(),
	}); err != nil {
		return false, err
	}
	if _, err := io.CopyN(tw, src, info.Size()); err != nil {
		return false, fmt.Errorf("copy %s: %w", name, err)
	}
	return true, nil
}

func writeJSONToTar(tw *tar.Writer, name string, v any, modTime time.Time) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeBytesToTar(tw, name, append(data, '\n'), modTime)
}

func writeBytesToTar(tw *tar.Writer, name string, data []byte, modTime time.Time) error {
	if err := tw.WriteHeader(&tar.Header{
		Name:     name,
		Typeflag: tar.TypeReg,
		Mode:     0o644,
		Size:     int64(len(data)),
		ModTime:  modTime,
	}); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}
