package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"
)

// The portable import reads an archive of the portable export
// (system_export.go) into an empty instance. It creates each post with
// PostService.CreatePost and each media file with MediaService.UploadFile, so
// the derived files and the EXIF read are the same as for a normal upload.
// Then it sets the fields of the archive that those services do not take: the
// dates, the stored metadata and the post link of each file. Media visibility
// is derived from the posts, so the import recalculates it at the end.
//
// The import reads the archive two times. The first pass reads every entry and
// writes nothing, so a damaged or unknown archive stops the import before it
// changes the instance. The second pass writes.
// docs/features/export.md § Import describes it.

// importDirName is the directory under <data>/backups that holds the uploaded
// archive while an import runs, and the result of the last import.
const importDirName = "imports"

// importResultFile, in the imports directory, stores the last import result.
const importResultFile = "import.json"

// importMaxProblems limits the problems a result lists. The count is always
// complete.
const importMaxProblems = 20

// Size limits for an archive. A crafted archive (a decompression bomb, or an
// entry with a very large declared size) must not use all memory or disk of
// the server.
const (
	// importMaxTextBytes is the maximum size of a post file, tags.json and a
	// media sidecar.
	importMaxTextBytes = 8 << 20
	// importMinTotalBytes is the smallest total decompressed size that the
	// import accepts, for each archive.
	importMinTotalBytes = 1 << 30
	// importTotalRatio is the maximum ratio of the total decompressed size to
	// the size of the archive file. Originals are already compressed, so a real
	// export decompresses to little more than its own size.
	importTotalRatio = 20
	// importDefaultMediaMB is the media limit when MAX_UPLOAD_SIZE_MB is not set.
	importDefaultMediaMB = 50
)

// importLimits are the size limits of one import.
type importLimits struct {
	media int64 // one original or one sidecar alone, in bytes
	text  int64 // one post file, tags.json or one sidecar, in bytes
	total int64 // all decompressed data of the archive, in bytes; 0 = from the file size
}

// errImportTooLarge marks an archive that is above a size limit.
var errImportTooLarge = errors.New("the archive is too large")

// healthTaskImport is the HealthRegistry key for the import.
const healthTaskImport = "portable import"

// ErrImportInProgress is returned when an import is requested while one is
// already running.
var ErrImportInProgress = kindSentinel(ErrConflict, "an import is already in progress")

// ErrImportNotEmpty is returned when the instance has posts or media. The
// import goes into an empty instance only.
var ErrImportNotEmpty = kindSentinel(ErrConflict, "this site already has posts or media: import goes into an empty site only")

// ArchiveImportProgress is the state of a running import.
type ArchiveImportProgress struct {
	// Phase is "check" (the first pass), "tags", "posts", "media" or
	// "finish".
	Phase string `json:"phase"`
	// Total is from the first pass; Done counts the rows written so far.
	Total repository.ExportCounts `json:"total"`
	Done  repository.ExportCounts `json:"done"`
}

// ArchiveImportResult is the outcome of one import.
type ArchiveImportResult struct {
	StartedAt time.Time `json:"started_at"`
	// SourceVersion and ExportedAt are from the manifest of the archive.
	SourceVersion string    `json:"source_version,omitempty"`
	ExportedAt    time.Time `json:"exported_at"`
	// Counts are the rows the import wrote.
	Counts repository.ExportCounts `json:"counts"`
	// Problems lists the first files that were not imported, or that were
	// imported with a difference; ProblemCount counts all of them.
	Problems     []string `json:"problems,omitempty"`
	ProblemCount int      `json:"problem_count"`
	// Error is set when the import failed.
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func (r *ArchiveImportResult) addProblem(format string, args ...any) {
	r.ProblemCount++
	if len(r.Problems) < importMaxProblems {
		r.Problems = append(r.Problems, fmt.Sprintf(format, args...))
	}
}

// ImportService imports a portable export archive.
type ImportService struct {
	repo     repository.Repository
	media    *MediaService
	posts    *PostService
	tags     *TagService
	dataPath string
	health   *HealthRegistry
	// limits, if not zero, replace the limits from the configuration. Tests
	// set them.
	limits importLimits

	mu       sync.Mutex
	running  bool
	progress ArchiveImportProgress
}

// NewImportService returns an import service that writes through media, posts
// and tags. dataPath is the data directory.
func NewImportService(repo repository.Repository, media *MediaService, posts *PostService, tags *TagService, dataPath string) *ImportService {
	return &ImportService{repo: repo, media: media, posts: posts, tags: tags, dataPath: dataPath}
}

// WithHealth attaches the background-job health registry.
func (s *ImportService) WithHealth(h *HealthRegistry) *ImportService {
	s.health = h
	return s
}

// sizeLimits returns the size limits of an import. The media limit is the
// upload limit (MAX_UPLOAD_SIZE_MB), so an archive cannot have a file that an
// upload cannot have.
func (s *ImportService) sizeLimits() importLimits {
	lim := s.limits
	if lim.media == 0 {
		mb := importDefaultMediaMB
		if s.media != nil && s.media.cfg != nil && s.media.cfg.MaxUploadSizeMB > 0 {
			mb = s.media.cfg.MaxUploadSizeMB
		}
		lim.media = int64(mb) << 20
	}
	if lim.text == 0 {
		lim.text = importMaxTextBytes
	}
	return lim
}

func (s *ImportService) importDir() string {
	return filepath.Join(s.dataPath, "backups", importDirName)
}

// Running reports whether an import is running now.
func (s *ImportService) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// Progress returns the progress of the running import, or nil when no import
// runs.
func (s *ImportService) Progress() *ArchiveImportProgress {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return nil
	}
	p := s.progress
	return &p
}

func (s *ImportService) setPhase(phase string) {
	s.mu.Lock()
	s.progress.Phase = phase
	s.mu.Unlock()
}

func (s *ImportService) updateProgress(fn func(p *ArchiveImportProgress)) {
	s.mu.Lock()
	fn(&s.progress)
	s.mu.Unlock()
}

// LastImport returns the result of the last import, or nil when no import has
// run.
func (s *ImportService) LastImport() *ArchiveImportResult {
	data, err := os.ReadFile(filepath.Join(s.importDir(), importResultFile))
	if err != nil {
		return nil
	}
	var r ArchiveImportResult
	if err := json.Unmarshal(data, &r); err != nil {
		return nil
	}
	return &r
}

// InstanceEmpty reports whether the instance has no posts and no media, the
// trash included.
func (s *ImportService) InstanceEmpty(ctx context.Context) (bool, error) {
	posts, media, err := s.repo.CountContentRows(ctx)
	if err != nil {
		return false, err
	}
	return posts == 0 && media == 0, nil
}

func (s *ImportService) checkEmpty(ctx context.Context) error {
	empty, err := s.InstanceEmpty(ctx)
	if err != nil {
		return err
	}
	if !empty {
		return ErrImportNotEmpty
	}
	return nil
}

func (s *ImportService) reserve() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return false
	}
	s.running = true
	s.progress = ArchiveImportProgress{Phase: "check"}
	return true
}

func (s *ImportService) release() {
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

// StartImport stages the archive in body to disk, refuses it when the
// instance is not empty or the manifest is not a known export, and then runs
// the import in the background. Progress shows the state; LastImport shows the
// result. authorID owns the imported posts.
func (s *ImportService) StartImport(ctx context.Context, body io.Reader, authorID int64) error {
	if !s.reserve() {
		return ErrImportInProgress
	}
	started := false
	defer func() {
		if !started {
			s.release()
		}
	}()
	if err := s.checkEmpty(ctx); err != nil {
		return err
	}
	path, err := s.stage(body)
	if err != nil {
		return err
	}
	if _, err := readImportManifest(path); err != nil {
		_ = os.Remove(path)
		return err
	}
	started = true
	utils.SafeGo("system: portable import", func() {
		defer s.release()
		if _, err := s.run(context.Background(), path, authorID); err != nil {
			slog.Error("import failed", "err", err)
		}
	})
	return nil
}

// Import imports the archive at path and waits for the result. The archive
// file stays where it is.
func (s *ImportService) Import(ctx context.Context, path string, authorID int64) (ArchiveImportResult, error) {
	if !s.reserve() {
		return ArchiveImportResult{}, ErrImportInProgress
	}
	defer s.release()
	if err := s.checkEmpty(ctx); err != nil {
		return ArchiveImportResult{}, err
	}
	return s.runArchive(ctx, path, authorID)
}

// stage writes body to a new file in the imports directory and returns its
// path. A staged file from an earlier run is removed first: only one import
// runs at a time.
func (s *ImportService) stage(body io.Reader) (string, error) {
	dir := s.importDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create imports directory: %w", err)
	}
	s.removeStaged()
	f, err := os.CreateTemp(dir, "upload-*.tar.gz")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, body); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", fmt.Errorf("upload failed: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// removeStaged removes each staged upload in the imports directory.
func (s *ImportService) removeStaged() {
	entries, err := os.ReadDir(s.importDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "upload-") {
			_ = os.Remove(filepath.Join(s.importDir(), e.Name()))
		}
	}
}

// run imports the staged archive at path and removes it after.
func (s *ImportService) run(ctx context.Context, path string, authorID int64) (ArchiveImportResult, error) {
	defer func() { _ = os.Remove(path) }()
	return s.runArchive(ctx, path, authorID)
}

// runArchive imports the archive at path and stores the result, on success
// and on failure.
func (s *ImportService) runArchive(ctx context.Context, path string, authorID int64) (ArchiveImportResult, error) {
	start := time.Now()
	res := ArchiveImportResult{StartedAt: start.UTC()}
	err := s.importArchive(ctx, path, authorID, &res)
	res.DurationMS = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = err.Error()
	}
	if werr := s.writeResult(res); werr != nil {
		slog.Warn("import: could not store the result", "err", werr)
	}
	if s.health != nil {
		var herr error
		switch {
		case err != nil:
			herr = err
		case res.ProblemCount > 0:
			herr = fmt.Errorf("%d files were not imported as they are in the archive", res.ProblemCount)
		}
		s.health.Record(healthTaskImport, herr)
	}
	if err == nil {
		slog.Info("import done", "posts", res.Counts.Posts, "pages", res.Counts.Pages,
			"media", res.Counts.Media, "tags", res.Counts.Tags, "problems", res.ProblemCount)
	}
	return res, err
}

func (s *ImportService) writeResult(r ArchiveImportResult) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	dir := s.importDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, importResultFile+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, importResultFile))
}

func (s *ImportService) importArchive(ctx context.Context, path string, authorID int64, res *ArchiveImportResult) error {
	man, err := readImportManifest(path)
	if err != nil {
		return err
	}
	res.SourceVersion = man.InstanceVersion
	res.ExportedAt = man.CreatedAt

	// Pass 1: read all, write nothing.
	s.setPhase("check")
	var total repository.ExportCounts
	slugs := map[string]bool{}
	lim := s.sizeLimits()
	if err := walkImportArchive(ctx, path, false, lim, importVisitor{
		tags: func(tags []exportTag) error {
			total.Tags = int64(len(tags))
			return nil
		},
		post: func(fm exportFrontMatter, _ string) error {
			if fm.Slug == "" {
				return errors.New("a post has no slug")
			}
			if slugs[fm.Slug] {
				return fmt.Errorf("two posts have the slug %q", fm.Slug)
			}
			slugs[fm.Slug] = true
			if fm.Type == "page" {
				total.Pages++
			} else {
				total.Posts++
			}
			return nil
		},
		media: func(exportMediaSidecar, []byte) error {
			total.Media++
			return nil
		},
	}); err != nil {
		return wrapKind(ErrInvalidInput, fmt.Errorf("the archive cannot be imported: %w", err))
	}
	s.updateProgress(func(p *ArchiveImportProgress) { p.Total = total })

	// Pass 2: write.
	w := &importWriter{s: s, authorID: authorID, res: res, tagIDs: map[string]int64{}, postIDs: map[string]int64{}}
	if err := walkImportArchive(ctx, path, true, lim, importVisitor{
		tags:  w.writeTags,
		post:  w.writePost,
		media: w.writeMedia,
	}); err != nil {
		return fmt.Errorf("the import stopped after %d posts, %d pages and %d media files, and the site is not empty now: %w",
			res.Counts.Posts, res.Counts.Pages, res.Counts.Media, err)
	}

	s.setPhase("finish")
	if err := s.repo.UpdateAllTagPostCounts(ctx); err != nil {
		return fmt.Errorf("update tag post counts: %w", err)
	}
	if s.tags != nil {
		s.tags.Invalidate()
	}
	if _, err := s.media.RecalculateAllMediaVisibility(ctx); err != nil {
		return fmt.Errorf("recalculate media visibility: %w", err)
	}
	return nil
}

// readImportManifest reads manifest.json, which must be the first entry, and
// refuses an archive that is not a portable export or that has a format
// version this build does not know.
func readImportManifest(path string) (exportManifest, error) {
	var man exportManifest
	f, err := os.Open(path)
	if err != nil {
		return man, err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return man, wrapKind(ErrInvalidInput, errors.New("the file is not a .tar.gz archive"))
	}
	tr := tar.NewReader(gz)
	h, err := tr.Next()
	if err != nil || h.Name != "manifest.json" {
		return man, wrapKind(ErrInvalidInput, errors.New("the archive is not a portable export: manifest.json is not the first entry"))
	}
	data, err := io.ReadAll(io.LimitReader(tr, 1<<20))
	if err != nil {
		return man, wrapKind(ErrInvalidInput, fmt.Errorf("read manifest.json: %w", err))
	}
	if err := json.Unmarshal(data, &man); err != nil {
		return man, wrapKind(ErrInvalidInput, fmt.Errorf("manifest.json is not valid JSON: %w", err))
	}
	if man.Format != ExportFormat {
		return man, wrapKind(ErrInvalidInput, fmt.Errorf("the archive format is %q, not %q", man.Format, ExportFormat))
	}
	if man.Version < 1 || man.Version > ExportFormatVersion {
		return man, wrapKind(ErrInvalidInput, fmt.Errorf("the archive has export format version %d; this version of Point reads version %d or lower", man.Version, ExportFormatVersion))
	}
	return man, nil
}

// importVisitor receives the content of an archive in archive order. media
// gets data nil when the archive has only the sidecar (the original was
// missing at export time).
type importVisitor struct {
	tags  func([]exportTag) error
	post  func(fm exportFrontMatter, body string) error
	media func(side exportMediaSidecar, data []byte) error
}

// importPending is an original that waits for its sidecar, the next entry.
type importPending struct {
	rel  string
	data []byte
}

// walkImportArchive reads the archive at path after the manifest and calls v
// for each item. With readData false, the originals are read but not kept.
// An entry above its limit in lim, or a total decompressed size or a total
// of entry sizes above lim.total, stops the walk with errImportTooLarge. A
// sparse entry stops the walk.
func walkImportArchive(ctx context.Context, path string, readData bool, lim importLimits, v importVisitor) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if lim.total == 0 {
		st, err := f.Stat()
		if err != nil {
			return err
		}
		lim.total = max(int64(importMinTotalBytes), st.Size()*importTotalRatio)
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(&importTotalReader{r: gz, left: lim.total, max: lim.total})
	var pending *importPending
	// logical is the sum of the entry sizes that the tar reader gives. For a
	// sparse entry it is more than the bytes in the stream, so the
	// importTotalReader alone does not see it.
	var logical int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.Is(err, errImportTooLarge) {
			return err
		}
		if err != nil {
			return fmt.Errorf("read archive: %w", err)
		}
		logical += max(h.Size, 0)
		if logical > lim.total {
			return fmt.Errorf("%w: the size of its files is more than %s, the maximum for this archive",
				errImportTooLarge, humanizeBytes(lim.total))
		}
		if isSparseEntry(h) {
			return fmt.Errorf("%s is a sparse file; an export has no sparse files", h.Name)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		name := h.Name
		switch {
		case name == "manifest.json":
			continue
		case name == "tags.json":
			data, err := readImportEntry(tr, h, lim.text)
			if err != nil {
				return err
			}
			var tags []exportTag
			if err := json.Unmarshal(data, &tags); err != nil {
				return fmt.Errorf("tags.json: %w", err)
			}
			if err := v.tags(tags); err != nil {
				return err
			}
		case strings.HasPrefix(name, "posts/") && strings.HasSuffix(name, ".md"):
			data, err := readImportEntry(tr, h, lim.text)
			if err != nil {
				return err
			}
			fm, body, err := parseImportPost(data)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			if err := v.post(fm, body); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		case strings.HasPrefix(name, "media/"):
			rel, ok := exportMediaPath(strings.TrimPrefix(name, "media/"))
			if !ok {
				return fmt.Errorf("unsafe media path %q", name)
			}
			if pending != nil && rel == pending.rel+".json" {
				data, err := readImportEntry(tr, h, lim.text)
				if err != nil {
					return err
				}
				side, err := readImportSidecar(bytes.NewReader(data), name)
				if err != nil {
					return err
				}
				if side.OriginalPath != pending.rel {
					return fmt.Errorf("%s: original_path is %q", name, side.OriginalPath)
				}
				if err := v.media(side, pending.data); err != nil {
					return fmt.Errorf("%s: %w", pending.rel, err)
				}
				pending = nil
				continue
			}
			if pending != nil {
				return fmt.Errorf("media/%s has no sidecar", pending.rel)
			}
			data, err := readImportEntry(tr, h, lim.media)
			if err != nil {
				return err
			}
			// The sidecar of an original that was missing at export time comes
			// alone. Any other entry is an original, and its sidecar is next.
			if side, ok := missingSidecar(rel, data); ok {
				if err := v.media(side, nil); err != nil {
					return fmt.Errorf("%s: %w", side.OriginalPath, err)
				}
				continue
			}
			if !readData {
				data = nil
			}
			pending = &importPending{rel: rel, data: data}
		}
	}
	if pending != nil {
		return fmt.Errorf("media/%s has no sidecar", pending.rel)
	}
	return nil
}

// isSparseEntry reports whether h is a GNU sparse file, in the old GNU format
// or with GNU.sparse.* PAX records. The tar reader gives the holes of a sparse
// file as zero bytes that are not in the stream.
func isSparseEntry(h *tar.Header) bool {
	if h.Typeflag == tar.TypeGNUSparse {
		return true
	}
	for k := range h.PAXRecords {
		if strings.HasPrefix(k, "GNU.sparse.") {
			return true
		}
	}
	return false
}

// readImportEntry reads the entry h from tr. It refuses an entry that declares
// or gives more than limit bytes.
func readImportEntry(tr io.Reader, h *tar.Header, limit int64) ([]byte, error) {
	if h.Size > limit {
		return nil, fmt.Errorf("%w: %s is %s, and the maximum for this entry is %s",
			errImportTooLarge, h.Name, humanizeBytes(h.Size), humanizeBytes(limit))
	}
	data, err := io.ReadAll(io.LimitReader(tr, limit+1))
	if err != nil {
		if errors.Is(err, errImportTooLarge) {
			return nil, err
		}
		return nil, fmt.Errorf("read %s: %w", h.Name, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: %s is more than %s, the maximum for this entry",
			errImportTooLarge, h.Name, humanizeBytes(limit))
	}
	return data, nil
}

// importTotalReader gives at most max bytes of r. After that it returns
// errImportTooLarge, so a decompression bomb stops the import.
type importTotalReader struct {
	r    io.Reader
	left int64
	max  int64
}

func (t *importTotalReader) Read(p []byte) (int, error) {
	if t.left <= 0 {
		// Read one byte to know if r has more data than max.
		var one [1]byte
		if n, err := t.r.Read(one[:]); n == 0 {
			return 0, err
		}
		return 0, fmt.Errorf("%w: its decompressed size is more than %s, the maximum for this archive",
			errImportTooLarge, humanizeBytes(t.max))
	}
	if int64(len(p)) > t.left {
		p = p[:t.left]
	}
	n, err := t.r.Read(p)
	t.left -= int64(n)
	return n, err
}

func readImportSidecar(r io.Reader, name string) (exportMediaSidecar, error) {
	var side exportMediaSidecar
	if err := json.NewDecoder(r).Decode(&side); err != nil {
		return side, fmt.Errorf("%s: %w", name, err)
	}
	return side, nil
}

// missingSidecar reports whether data, at rel, is the sidecar of an original
// that was missing at export time.
func missingSidecar(rel string, data []byte) (exportMediaSidecar, bool) {
	var side exportMediaSidecar
	if !strings.HasSuffix(rel, ".json") || json.Unmarshal(data, &side) != nil {
		return side, false
	}
	return side, side.Missing && side.OriginalPath == strings.TrimSuffix(rel, ".json")
}

// parseImportPost splits a post file into its front matter and its body. The
// export writes "---\n", the YAML, "---\n\n", the body and one "\n".
func parseImportPost(data []byte) (exportFrontMatter, string, error) {
	var fm exportFrontMatter
	s := string(data)
	if !strings.HasPrefix(s, "---\n") {
		return fm, "", errors.New("no front matter")
	}
	end := strings.Index(s[4:], "\n---\n")
	if end < 0 {
		return fm, "", errors.New("the front matter has no end")
	}
	head := s[4 : 4+end+1]
	if err := yaml.Unmarshal([]byte(head), &fm); err != nil {
		return fm, "", fmt.Errorf("front matter: %w", err)
	}
	body := s[4+end+5:]
	body = strings.TrimPrefix(body, "\n")
	body = strings.TrimSuffix(body, "\n")
	return fm, body, nil
}

// importRestoreMediaRefs reverses exportRewriteMediaRefs:
// "../media/originals/YYYY/MM/file" becomes "/YYYY/MM/file" again.
func importRestoreMediaRefs(s string) string {
	return strings.ReplaceAll(s, exportMediaRefPrefix+"/", "/")
}

// importJSONField reverses exportJSONField: a JSON object stays as it is, a
// JSON string becomes its text, and nothing becomes NULL.
func importJSONField(raw json.RawMessage) sql.NullString {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return sql.NullString{}
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return sql.NullString{String: s, Valid: s != ""}
		}
	}
	// The export indents the sidecar, and with it this field. The column
	// holds compact JSON, as json.Marshal writes it.
	var buf bytes.Buffer
	if json.Compact(&buf, raw) == nil {
		return sql.NullString{String: buf.String(), Valid: true}
	}
	return sql.NullString{String: string(raw), Valid: true}
}

// importWriter is the state of the write pass.
type importWriter struct {
	s        *ImportService
	authorID int64
	res      *ArchiveImportResult
	// tagIDs and postIDs map a slug to the new row id.
	tagIDs  map[string]int64
	postIDs map[string]int64
}

func (w *importWriter) writeTags(tags []exportTag) error {
	ctx := context.Background()
	w.s.setPhase("tags")
	slugs := make([]string, 0, len(tags))
	for _, t := range tags {
		slugs = append(slugs, t.Slug)
	}
	// The system tags exist on a new instance. Those stay as they are.
	existing, err := w.s.repo.FindTagsBySlugs(ctx, slugs)
	if err != nil {
		return err
	}
	for _, t := range tags {
		if e, ok := existing[t.Slug]; ok {
			w.tagIDs[t.Slug] = e.ID
			continue
		}
		p := models.CreateTagParams{
			Name:             t.Name,
			Slug:             t.Slug,
			Description:      sql.NullString{String: t.Description, Valid: t.Description != ""},
			Kind:             t.Kind,
			Hidden:           t.Hidden,
			HidesPosts:       t.HidesPosts,
			InBreadcrumbs:    t.InBreadcrumbs,
			ShowRelated:      t.ShowRelated,
			InAncestorFlyout: t.InAncestorFlyout,
		}
		if p.Kind == "" {
			p.Kind = "tag"
		}
		if t.NavOrder != nil {
			p.NavOrder = sql.NullInt64{Int64: *t.NavOrder, Valid: true}
		}
		if t.Latitude != nil && t.Longitude != nil {
			p.Latitude = sql.NullFloat64{Float64: *t.Latitude, Valid: true}
			p.Longitude = sql.NullFloat64{Float64: *t.Longitude, Valid: true}
		}
		tag, err := w.s.repo.CreateTag(ctx, p)
		if err != nil {
			return fmt.Errorf("create tag %q: %w", t.Slug, err)
		}
		w.tagIDs[t.Slug] = tag.ID
		w.res.Counts.Tags++
	}
	// The parent links come after all tags exist: a parent can come later in
	// the list than its child.
	for _, t := range tags {
		if _, ok := existing[t.Slug]; ok {
			continue
		}
		child := w.tagIDs[t.Slug]
		for _, parent := range t.Parents {
			pid, ok := w.tagIDs[parent.Slug]
			if !ok {
				w.res.addProblem("tag %s: parent %s is not in tags.json", t.Slug, parent.Slug)
				continue
			}
			if err := w.s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{ParentID: pid, ChildID: child}); err != nil {
				return fmt.Errorf("link tag %q to %q: %w", t.Slug, parent.Slug, err)
			}
			if parent.SortOrder != nil {
				if err := w.s.repo.UpdateEdgeSortOrder(ctx, pid, child, int32(*parent.SortOrder)); err != nil {
					return err
				}
			}
		}
	}
	w.s.updateProgress(func(p *ArchiveImportProgress) { p.Done.Tags = w.res.Counts.Tags })
	return nil
}

// tagID returns the id of the tag slug, and creates the tag when tags.json
// did not have it.
func (w *importWriter) tagID(ctx context.Context, slug string) (int64, error) {
	if id, ok := w.tagIDs[slug]; ok {
		return id, nil
	}
	tag, err := w.s.repo.GetTagBySlug(ctx, slug)
	if err != nil {
		tag, err = w.s.repo.CreateTag(ctx, models.CreateTagParams{Name: slug, Slug: slug, Kind: "tag"})
		if err != nil {
			return 0, fmt.Errorf("create tag %q: %w", slug, err)
		}
		w.res.Counts.Tags++
	}
	w.tagIDs[slug] = tag.ID
	return tag.ID, nil
}

func (w *importWriter) writePost(fm exportFrontMatter, body string) error {
	ctx := context.Background()
	w.s.setPhase("posts")
	post, _, err := w.s.posts.CreatePost(ctx, CreatePostParams{
		Title:           fm.Title,
		Slug:            fm.Slug,
		Content:         importRestoreMediaRefs(body),
		CSS:             fm.Css,
		ImmersiveMode:   fm.ImmersiveMode,
		Excerpt:         fm.Excerpt,
		Formatter:       fm.Formatter,
		Status:          fm.Status,
		Type:            fm.Type,
		IsFeatured:      fm.Featured,
		AuthorID:        w.authorID,
		ThumbnailPath:   importRestoreMediaRefs(fm.Thumbnail),
		MetaDescription: fm.MetaDescription,
		ScheduledAt:     fm.ScheduledAt,
	})
	if err != nil {
		return fmt.Errorf("create post: %w", err)
	}
	var pub sql.NullTime
	if fm.PublishedAt != nil {
		pub = sql.NullTime{Time: *fm.PublishedAt, Valid: true}
	}
	if err := w.s.repo.SetPostTimestamps(ctx, post.ID, fm.CreatedAt, fm.UpdatedAt, pub); err != nil {
		return fmt.Errorf("set post dates: %w", err)
	}
	for _, slug := range fm.Tags {
		id, err := w.tagID(ctx, slug)
		if err != nil {
			return err
		}
		if err := w.s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: post.ID, TagID: id}); err != nil {
			return fmt.Errorf("tag post: %w", err)
		}
	}
	w.postIDs[fm.Slug] = post.ID
	if fm.Type == "page" {
		w.res.Counts.Pages++
	} else {
		w.res.Counts.Posts++
	}
	w.s.updateProgress(func(p *ArchiveImportProgress) {
		p.Done.Posts, p.Done.Pages, p.Done.Tags = w.res.Counts.Posts, w.res.Counts.Pages, w.res.Counts.Tags
	})
	return nil
}

func (w *importWriter) writeMedia(side exportMediaSidecar, data []byte) error {
	ctx := context.Background()
	w.s.setPhase("media")
	defer w.s.updateProgress(func(p *ArchiveImportProgress) { p.Done.Media++ })
	if data == nil {
		w.res.addProblem("%s: not in the archive (missing at export time)", side.OriginalPath)
		return nil
	}
	m, err := w.s.media.UploadFile(ctx, UploadFileParams{
		Content:      data,
		Filename:     side.Filename,
		MimeType:     side.MimeType,
		AltText:      side.AltText,
		Caption:      side.Caption,
		OriginalPath: side.OriginalPath,
	})
	if err != nil {
		w.res.addProblem("%s: %v", side.OriginalPath, err)
		return nil
	}
	if m.OriginalPath != side.OriginalPath {
		// UploadFile found the same bytes already in the library.
		w.res.addProblem("%s: the same file as %s", side.OriginalPath, m.OriginalPath)
		return nil
	}
	if side.Checksum != "" && side.Checksum != m.Checksum {
		w.res.addProblem("%s: the checksum is not the one in the sidecar", side.OriginalPath)
	}
	var postID sql.NullInt64
	if side.Post != "" {
		if id, ok := w.postIDs[side.Post]; ok {
			postID = sql.NullInt64{Int64: id, Valid: true}
		}
	}
	uploaded := side.UploadedAt
	if uploaded.IsZero() {
		uploaded = m.UploadedAt
	}
	if err := w.s.repo.SetImportedMediaFields(ctx, m.ID, postID, uploaded,
		importJSONField(side.Exif), importJSONField(side.OriginalExif)); err != nil {
		return fmt.Errorf("set media fields: %w", err)
	}
	w.res.Counts.Media++
	return nil
}
