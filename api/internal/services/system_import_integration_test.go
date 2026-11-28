//go:build !unit

package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/repository"
)

// importTestJPEG returns a small real JPEG, so the import decodes it and
// writes the derived files as for an upload.
func importTestJPEG(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 200, 150))
	for x := 0; x < 200; x++ {
		for y := 0; y < 150; y++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func openImportTestRepo(t *testing.T, dataPath string) repository.Repository {
	t.Helper()
	repo, err := repository.NewRepository(filepath.Join(dataPath, "point.db"))
	if err != nil {
		t.Fatalf("open repo: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	if _, err := repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1, 'u', 'u@x.com', 'h', 'U')`); err != nil {
		t.Fatal(err)
	}
	return repo
}

// newImportTarget is an empty instance with the services the import uses.
func newImportTarget(t *testing.T) (*ImportService, string, repository.Repository) {
	t.Helper()
	dataPath := t.TempDir()
	repo := openImportTestRepo(t, dataPath)
	settings := NewSettingsService(repo)
	tags := NewTagService(repo)
	media := NewMediaService(repo, &config.Config{StoragePath: dataPath}, settings, tags)
	posts := NewPostService(repo, settings, nil, tags, "")
	return NewImportService(repo, media, posts, tags, dataPath), dataPath, repo
}

// newImportSource is a small site with real files and real checksums: a tag
// hierarchy, a published post with two photos and a thumbnail, a draft page
// with a text file, and a media row whose file is not on disk.
func newImportSource(t *testing.T) (*SystemService, string, repository.Repository) {
	t.Helper()
	dataPath := t.TempDir()
	repo := openImportTestRepo(t, dataPath)
	river := importTestJPEG(t, color.RGBA{R: 10, G: 80, B: 200, A: 255})
	bridge := importTestJPEG(t, color.RGBA{R: 200, G: 80, B: 10, A: 255})
	notes := []byte("field notes\n")
	files := map[string][]byte{
		"originals/2024/01/river.jpg":     river,
		"originals/2024/01/my bridge.jpg": bridge,
		"originals/2024/02/notes.txt":     notes,
	}
	for rel, data := range files {
		p := filepath.Join(dataPath, "media", filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := repo.DB().Exec(q, args...); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	exec(`INSERT INTO tags (id, name, slug, kind, description, nav_order, hidden, latitude, longitude)
		VALUES (101, 'Places', 'places', 'tag', 'Where I was', 2, 0, NULL, NULL),
		       (102, 'Paris', 'paris', 'location', NULL, NULL, 0, 48.85, 2.35),
		       (103, 'Notes', 'notes', 'tag', NULL, NULL, 1, NULL, NULL)`)
	exec(`INSERT INTO tag_relationships (parent_id, child_id, sort_order) VALUES (101, 102, 3)`)
	exec(`INSERT INTO posts (id, title, slug, content, excerpt, formatter, status, type, is_featured, view_count,
		published_at, created_at, updated_at, author_id, thumbnail_path, css, meta_description, immersive_mode)
		VALUES (1, 'Evening walk', 'evening-walk', ?, 'A walk', 'markdown', 'published', 'post', 1, 7,
		'2024-01-05 18:00:00', '2024-01-05 17:00:00', '2024-01-06 09:00:00', 1, '/2024/01/river.jpg',
		'.post { color: red; }', 'By the river', 'immersive')`,
		"/2024/01/river.jpg\n![Bridge](/2024/01/my bridge.jpg) at dusk\nSee https://example.com/2024/01/river.jpg and /2024/01/gone.jpg")
	exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1, 102), (1, 101)`)
	exec(`INSERT INTO posts (id, title, slug, content, formatter, status, type, is_featured, view_count,
		created_at, updated_at, author_id) VALUES (2, 'About', 'about', 'Hello.
/2024/02/notes.txt
', 'markdown', 'draft', 'page', 0, 0, '2024-02-01 10:00:00', '2024-02-03 11:00:00', 1)`)
	exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (2, 103)`)
	media := func(id int, name, rel, ftype, mime string, data []byte, w, h any, postID any, public int, meta, orig any) {
		t.Helper()
		exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, width, height,
			post_id, uploaded_at, checksum, alt_text, caption, is_public, metadata, original_metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2024-01-05 16:00:00', ?, ?, ?, ?, ?, ?)`,
			id, name, rel, ftype, mime, len(data), w, h, postID, CalculateChecksum(data),
			"Alt "+name, "Caption "+name, public, meta, orig)
	}
	media(1, "river.jpg", "originals/2024/01/river.jpg", "image", "image/jpeg", river, 200, 150, 1, 1,
		`{"Make":"NIKON","FNumber":"28/10"}`, `{"Make":"NIKON"}`)
	media(2, "my bridge.jpg", "originals/2024/01/my bridge.jpg", "image", "image/jpeg", bridge, 200, 150, 1, 1, nil, nil)
	media(3, "notes.txt", "originals/2024/02/notes.txt", "file", "text/plain", notes, nil, nil, 2, 0, nil, nil)
	media(4, "gone.jpg", "originals/2024/01/gone.jpg", "image", "image/jpeg", []byte("gone"), 16, 12, nil, 0, nil, nil)
	return NewSystemService(repo, dataPath, filepath.Join(dataPath, "point.db")), dataPath, repo
}

// importSiteView is the content of a site that an export and an import must
// keep, in a form that compares with reflect.DeepEqual.
type importSiteView struct {
	Posts []string
	Media []string
	Tags  []string
}

func readImportSiteView(t *testing.T, repo repository.Repository) importSiteView {
	t.Helper()
	rows := func(q string) []string {
		t.Helper()
		r, err := repo.DB().Query(q)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		defer func() { _ = r.Close() }()
		cols, _ := r.Columns()
		var out []string
		for r.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := r.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			parts := make([]string, len(cols))
			for i, v := range vals {
				if b, ok := v.([]byte); ok {
					v = string(b)
				}
				parts[i] = fmt.Sprintf("%s=%v", cols[i], v)
			}
			out = append(out, strings.Join(parts, " | "))
		}
		if err := r.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}
	tsf := func(col string) string {
		return "strftime('%Y-%m-%d %H:%M:%S', " + col + ") AS " + strings.ReplaceAll(col, ".", "_")
	}
	return importSiteView{
		Posts: rows(`SELECT p.slug, p.title, p.content, p.excerpt, p.formatter, p.status, p.type, p.is_featured, ` +
			tsf("p.published_at") + `, ` + tsf("p.scheduled_at") + `, ` + tsf("p.created_at") + `, ` + tsf("p.updated_at") +
			`, p.thumbnail_path, p.meta_description, p.css, p.immersive_mode,
			(SELECT GROUP_CONCAT(slug) FROM (SELECT t.slug FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
				WHERE pt.post_id = p.id ORDER BY t.slug)) AS tags
			FROM posts p WHERE p.deleted_at IS NULL ORDER BY p.slug`),
		Media: rows(`SELECT m.original_path, m.filename, m.file_type, m.mime_type, m.file_size, m.width, m.height, ` +
			tsf("m.uploaded_at") + `, m.checksum, m.alt_text, m.caption, m.metadata, m.original_metadata, m.is_public,
			p.slug AS post FROM media m LEFT JOIN posts p ON p.id = m.post_id
			WHERE m.deleted_at IS NULL ORDER BY m.original_path`),
		Tags: rows(`SELECT t.slug, t.name, t.description, t.kind, t.hidden, t.hides_posts, t.nav_order, t.in_breadcrumbs,
			t.show_related, t.in_ancestor_flyout, t.latitude, t.longitude, t.post_count,
			(SELECT GROUP_CONCAT(p.slug || ':' || IFNULL(r.sort_order, '')) FROM tag_relationships r
				JOIN tags p ON p.id = r.parent_id WHERE r.child_id = t.id) AS parents
			FROM tags t ORDER BY t.slug`),
	}
}

func TestImport_RoundTrip(t *testing.T) {
	src, srcData, srcRepo := newImportSource(t)
	ctx := context.Background()
	exp, err := src.CreateExport(ctx, "v9.9.9")
	if err != nil {
		t.Fatalf("CreateExport: %v", err)
	}
	if _, err := srcRepo.DB().Exec(`UPDATE tags SET post_count = 0`); err != nil {
		t.Fatal(err)
	}
	if err := srcRepo.UpdateAllTagPostCounts(ctx); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(srcData, "backups", "exports", exp.Filename)

	imp, dstData, dstRepo := newImportTarget(t)
	res, err := imp.Import(ctx, archive, 1)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if res.SourceVersion != "v9.9.9" || res.Error != "" {
		t.Errorf("result = %+v", res)
	}
	if res.Counts.Posts != 1 || res.Counts.Pages != 1 || res.Counts.Media != 3 {
		t.Errorf("counts = %+v, want 1 post, 1 page, 3 media", res.Counts)
	}
	// The original that was not on disk at export time is the one problem.
	if res.ProblemCount != 1 || !strings.Contains(res.Problems[0], "originals/2024/01/gone.jpg") {
		t.Errorf("problems = %d %v", res.ProblemCount, res.Problems)
	}
	if last := imp.LastImport(); last == nil || last.Counts != res.Counts {
		t.Errorf("LastImport = %+v", last)
	}
	if imp.Running() || imp.Progress() != nil {
		t.Error("the import still shows as running")
	}

	want := readImportSiteView(t, srcRepo)
	// The row of the missing file cannot come back: the archive has no file.
	var wantMedia []string
	for _, m := range want.Media {
		if !strings.Contains(m, "gone.jpg") {
			wantMedia = append(wantMedia, m)
		}
	}
	want.Media = wantMedia
	got := readImportSiteView(t, dstRepo)
	for _, part := range []struct {
		name      string
		got, want []string
	}{{"posts", got.Posts, want.Posts}, {"media", got.Media, want.Media}, {"tags", got.Tags, want.Tags}} {
		if !reflect.DeepEqual(part.got, part.want) {
			t.Errorf("%s differ after the round trip\n got: %s\nwant: %s", part.name,
				strings.Join(part.got, "\n      "), strings.Join(part.want, "\n      "))
		}
	}

	// The originals are on disk at the same paths, with the same bytes, and
	// an image has its derived files, as after an upload.
	for _, rel := range []string{"originals/2024/01/river.jpg", "originals/2024/01/my bridge.jpg", "originals/2024/02/notes.txt"} {
		a, err := os.ReadFile(filepath.Join(srcData, "media", rel))
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(dstData, "media", rel))
		if err != nil {
			t.Fatalf("imported original %s: %v", rel, err)
		}
		if !bytes.Equal(a, b) {
			t.Errorf("original %s differs", rel)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(dstData, "media", "variants")); len(entries) == 0 {
		t.Error("the import wrote no derived files")
	}

	// A second import is refused: the site is not empty now.
	if _, err := imp.Import(ctx, archive, 1); !errors.Is(err, ErrImportNotEmpty) {
		t.Errorf("second Import error = %v, want ErrImportNotEmpty", err)
	}
}

// writeImportTestArchive writes a .tar.gz with the given entries, in order.
func writeImportTestArchive(t *testing.T, entries ...[2]string) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: e[0], Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(e[1]))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "archive.tar.gz")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestImport_RefusesUnknownArchives(t *testing.T) {
	ctx := context.Background()
	manifest := func(format string, version int) [2]string {
		return [2]string{"manifest.json", fmt.Sprintf(`{"format":%q,"version":%d}`, format, version)}
	}
	cases := []struct {
		name    string
		entries [][2]string
		want    string
	}{
		{"higher version", [][2]string{manifest(ExportFormat, ExportFormatVersion+1)}, "format version"},
		{"other format", [][2]string{manifest("other", 1)}, "archive format"},
		{"no manifest first", [][2]string{{"tags.json", "[]"}, manifest(ExportFormat, 1)}, "manifest.json"},
		{"post without front matter", [][2]string{manifest(ExportFormat, 1), {"posts/a.md", "no front matter"}}, "front matter"},
		{"original without sidecar", [][2]string{manifest(ExportFormat, 1), {"media/originals/2024/01/a.jpg", "x"}}, "no sidecar"},
		{"unsafe media path", [][2]string{manifest(ExportFormat, 1), {"media/../../etc/passwd", "x"}}, "unsafe"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			imp, _, repo := newImportTarget(t)
			_, err := imp.Import(ctx, writeImportTestArchive(t, tc.entries...), 1)
			if !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Import error = %v, want an invalid-input error with %q", err, tc.want)
			}
			// The first pass refuses before it writes anything.
			if posts, media, _ := repo.CountContentRows(ctx); posts != 0 || media != 0 {
				t.Errorf("the refused import wrote %d posts and %d media", posts, media)
			}
			if last := imp.LastImport(); last == nil || last.Error == "" {
				t.Errorf("LastImport = %+v, want the error", last)
			}
		})
	}
}

func TestImport_RefusesTooLargeArchives(t *testing.T) {
	ctx := context.Background()
	manifest := [2]string{"manifest.json", fmt.Sprintf(`{"format":%q,"version":%d}`, ExportFormat, ExportFormatVersion)}
	post := func(slug string, size int) [2]string {
		return [2]string{"posts/" + slug + ".md", "---\nslug: " + slug + "\n---\n" + strings.Repeat("a", size)}
	}
	cases := []struct {
		name    string
		limits  importLimits
		entries [][2]string
		want    string
	}{
		{"post file above the text limit", importLimits{text: 1024},
			[][2]string{manifest, post("a", 2048)}, "posts/a.md is 2.0 KiB"},
		{"tags.json above the text limit", importLimits{text: 1024},
			[][2]string{manifest, {"tags.json", "[" + strings.Repeat(" ", 2048) + "]"}}, "tags.json is"},
		{"original above the media limit", importLimits{media: 1024},
			[][2]string{manifest, {"media/originals/2024/01/a.jpg", strings.Repeat("x", 2048)}}, "media/originals/2024/01/a.jpg is"},
		{"total above the archive limit", importLimits{total: 8 << 10},
			[][2]string{manifest, post("a", 3000), post("b", 3000), post("c", 3000)}, "decompressed size"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			imp, _, repo := newImportTarget(t)
			imp.limits = tc.limits
			_, err := imp.Import(ctx, writeImportTestArchive(t, tc.entries...), 1)
			if !errors.Is(err, ErrInvalidInput) || !errors.Is(err, errImportTooLarge) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Import error = %v, want a too-large error with %q", err, tc.want)
			}
			if posts, media, _ := repo.CountContentRows(ctx); posts != 0 || media != 0 {
				t.Errorf("the refused import wrote %d posts and %d media", posts, media)
			}
		})
	}
}

// rawTarHeader returns one USTAR header block. The test writes the blocks
// itself because archive/tar does not write sparse files.
func rawTarHeader(name string, typeflag byte, size int) []byte {
	b := make([]byte, 512)
	copy(b[0:100], name)
	copy(b[100:108], "0000644\x00")
	copy(b[108:116], "0000000\x00")
	copy(b[116:124], "0000000\x00")
	copy(b[124:136], fmt.Sprintf("%011o\x00", size))
	copy(b[136:148], "00000000000\x00")
	b[156] = typeflag
	copy(b[257:265], "ustar\x0000")
	copy(b[148:156], "        ")
	var sum int
	for _, c := range b {
		sum += int(c)
	}
	copy(b[148:156], fmt.Sprintf("%06o\x00 ", sum))
	return b
}

// rawTarPad pads data to a whole number of 512-byte blocks.
func rawTarPad(data []byte) []byte {
	if r := len(data) % 512; r != 0 {
		data = append(data, make([]byte, 512-r)...)
	}
	return data
}

// writeSparseImportArchive writes a manifest and one PAX GNU sparse 1.0 entry
// at name. The stream has 5 data bytes; the tar reader gives realSize bytes.
func writeSparseImportArchive(t *testing.T, name string, realSize int) string {
	t.Helper()
	var tarBuf bytes.Buffer
	manifest := []byte(fmt.Sprintf(`{"format":%q,"version":%d}`, ExportFormat, ExportFormatVersion))
	tarBuf.Write(rawTarHeader("manifest.json", tar.TypeReg, len(manifest)))
	tarBuf.Write(rawTarPad(manifest))
	var pax []byte
	for _, kv := range [][2]string{
		{"GNU.sparse.major", "1"}, {"GNU.sparse.minor", "0"},
		{"GNU.sparse.name", name}, {"GNU.sparse.realsize", fmt.Sprint(realSize)},
	} {
		rec := " " + kv[0] + "=" + kv[1] + "\n"
		n := len(rec) + 1
		if len(fmt.Sprint(n)+rec) != n {
			n++
		}
		pax = append(pax, fmt.Sprint(n)+rec...)
	}
	tarBuf.Write(rawTarHeader("PaxHeaders/x", tar.TypeXHeader, len(pax)))
	tarBuf.Write(rawTarPad(pax))
	// One data region of 5 bytes at the end of the file; the rest is a hole.
	data := rawTarPad([]byte(fmt.Sprintf("1\n%d\n5\n", realSize-5)))
	data = append(data, "aaaaa"...)
	tarBuf.Write(rawTarHeader("GNUSparseFile.0/x", tar.TypeReg, len(data)))
	tarBuf.Write(rawTarPad(data))
	tarBuf.Write(make([]byte, 1024))

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(tarBuf.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "sparse.tar.gz")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestImport_RefusesSparseEntries checks that a sparse entry is refused, and
// that the total limit counts the size the tar reader gives, not only the
// bytes in the stream.
func TestImport_RefusesSparseEntries(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name     string
		limits   importLimits
		realSize int
		want     string
		tooLarge bool
	}{
		{"sparse entry", importLimits{}, 4096, "sparse file", false},
		{"logical total above the limit", importLimits{total: 64 << 10}, 1 << 20, "size of its files", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			imp, _, repo := newImportTarget(t)
			imp.limits = tc.limits
			path := writeSparseImportArchive(t, "posts/a.md", tc.realSize)
			if st, err := os.Stat(path); err != nil || (tc.limits.total > 0 && st.Size() >= tc.limits.total) {
				t.Fatalf("archive size = %v (%v), want below the limit", st, err)
			}
			_, err := imp.Import(ctx, path, 1)
			if !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), tc.want) || errors.Is(err, errImportTooLarge) != tc.tooLarge {
				t.Fatalf("Import error = %v, want an invalid-input error with %q (too large: %v)", err, tc.want, tc.tooLarge)
			}
			if posts, media, _ := repo.CountContentRows(ctx); posts != 0 || media != 0 {
				t.Errorf("the refused import wrote %d posts and %d media", posts, media)
			}
		})
	}
}

// TestImportSizeLimits_MediaFromImportEntryLimit checks that the media limit is
// MAX_IMPORT_ENTRY_MB, with 2048 MB when it is not set, and that
// MAX_UPLOAD_SIZE_MB does not change it.
func TestImportSizeLimits_MediaFromImportEntryLimit(t *testing.T) {
	imp, _, _ := newImportTarget(t)
	if got := imp.sizeLimits().media; got != 2048<<20 {
		t.Errorf("default media limit = %d, want %d", got, int64(2048)<<20)
	}
	imp.media.cfg.MaxUploadSizeMB = 10
	imp.media.cfg.MaxImportEntryMB = 200
	if got := imp.sizeLimits().media; got != 200<<20 {
		t.Errorf("media limit = %d, want %d", got, 200<<20)
	}
	if got := imp.sizeLimits().text; got != importMaxTextBytes {
		t.Errorf("text limit = %d, want %d", got, importMaxTextBytes)
	}
}

// importEntryFiles returns the temporary files of originals that an import
// left in its directory.
func importEntryFiles(t *testing.T, imp *ImportService) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(imp.importDir(), importEntryPrefix+"*"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// TestImport_EntryLimitAboveUploadLimit checks that an original larger than
// MAX_UPLOAD_SIZE_MB imports when it is smaller than MAX_IMPORT_ENTRY_MB, and
// that an original larger than MAX_IMPORT_ENTRY_MB stops the import. The
// large original goes through the file path of the upload (a move, not a
// buffer), and no temporary file stays.
func TestImport_EntryLimitAboveUploadLimit(t *testing.T) {
	ctx := context.Background()
	manifest := [2]string{"manifest.json", fmt.Sprintf(`{"format":%q,"version":%d}`, ExportFormat, ExportFormatVersion)}
	const rel = "originals/2024/02/big.txt"
	original := func(size int) [][2]string {
		side := fmt.Sprintf(`{"filename":"big.txt","original_path":%q,"file_type":"file","mime_type":"text/plain","file_size":%d}`, rel, size)
		return [][2]string{manifest, {"media/" + rel, strings.Repeat("x", size)}, {"media/" + rel + ".json", side}}
	}
	cases := []struct {
		name  string
		size  int
		media int64
	}{
		{"above the upload limit, below the entry limit", 3 << 19, 1}, // 1.5 MiB
		{"above the entry limit", 5 << 19, 0},                         // 2.5 MiB
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			imp, dataPath, repo := newImportTarget(t)
			imp.media.cfg.MaxUploadSizeMB = 1
			imp.media.cfg.MaxImportEntryMB = 2
			res, err := imp.Import(ctx, writeImportTestArchive(t, original(tc.size)...), 1)
			_, media, _ := repo.CountContentRows(ctx)
			if left := importEntryFiles(t, imp); len(left) != 0 {
				t.Errorf("the import left temporary files: %v", left)
			}
			if tc.media == 0 {
				if !errors.Is(err, ErrInvalidInput) || !errors.Is(err, errImportTooLarge) || !strings.Contains(err.Error(), "media/"+rel+" is") {
					t.Fatalf("Import error = %v, want a too-large error for the original", err)
				}
				if media != 0 {
					t.Errorf("the refused import wrote %d media", media)
				}
				return
			}
			if err != nil {
				t.Fatalf("Import: %v", err)
			}
			if res.Counts.Media != 1 || len(res.Problems) != 0 || media != 1 {
				t.Errorf("result = %+v, media rows = %d, want one media file and no problems", res, media)
			}
			got, err := os.ReadFile(filepath.Join(dataPath, "media", filepath.FromSlash(rel)))
			if err != nil || len(got) != tc.size {
				t.Errorf("the original on disk has %d bytes (%v), want %d", len(got), err, tc.size)
			}
		})
	}
}

// TestImport_EntryAboveTheRestOfTheTotal checks that an original that is
// smaller than the media limit, but larger than the part of the total limit
// that the entries before it did not use, stops the import.
func TestImport_EntryAboveTheRestOfTheTotal(t *testing.T) {
	ctx := context.Background()
	imp, _, repo := newImportTarget(t)
	imp.limits = importLimits{total: 64 << 10}
	_, err := imp.Import(ctx, writeImportTestArchive(t,
		[2]string{"manifest.json", fmt.Sprintf(`{"format":%q,"version":%d}`, ExportFormat, ExportFormatVersion)},
		[2]string{"posts/a.md", "---\nslug: a\n---\n" + strings.Repeat("a", 40<<10)},
		[2]string{"media/originals/2024/01/a.jpg", strings.Repeat("x", 30<<10)},
	), 1)
	if !errors.Is(err, errImportTooLarge) || !strings.Contains(err.Error(), "size of its files") {
		t.Fatalf("Import error = %v, want a too-large error for the total", err)
	}
	if posts, media, _ := repo.CountContentRows(ctx); posts != 0 || media != 0 {
		t.Errorf("the refused import wrote %d posts and %d media", posts, media)
	}
	if left := importEntryFiles(t, imp); len(left) != 0 {
		t.Errorf("the import left temporary files: %v", left)
	}
}

// TestUploadFileFromPath_LargeImage checks that an image above the upload
// limit is moved into the store, not read into memory, and still gets its
// size and checksum.
func TestUploadFileFromPath_LargeImage(t *testing.T) {
	ctx := context.Background()
	imp, dataPath, _ := newImportTarget(t)
	imp.media.cfg.MaxUploadSizeMB = 1
	content := append(importTestJPEG(t, color.RGBA{R: 1, G: 2, B: 3, A: 255}), make([]byte, 3<<19)...)
	src := filepath.Join(t.TempDir(), "big.jpg")
	if err := os.WriteFile(src, content, 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := imp.media.UploadFileFromPath(ctx, src, UploadFileParams{
		Filename: "big.jpg", MimeType: "image/jpeg", OriginalPath: "originals/2024/03/big.jpg",
	})
	if err != nil {
		t.Fatalf("UploadFileFromPath: %v", err)
	}
	if m.OriginalPath != "originals/2024/03/big.jpg" || m.FileSize != int64(len(content)) ||
		m.Checksum != CalculateChecksum(content) || m.Width.Int64 != 200 || m.Height.Int64 != 150 {
		t.Errorf("media = %+v", m)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Errorf("the source file is still there: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(dataPath, "media", "originals", "2024", "03", "big.jpg")); err != nil || !bytes.Equal(got, content) {
		t.Errorf("the stored original is not the source (%v)", err)
	}
}

func TestStartImport_RefusesBeforeItRuns(t *testing.T) {
	ctx := context.Background()
	imp, dataPath, repo := newImportTarget(t)
	body := func(version int) *bytes.Reader {
		data, err := os.ReadFile(writeImportTestArchive(t, [2]string{"manifest.json", fmt.Sprintf(`{"format":%q,"version":%d}`, ExportFormat, version)}))
		if err != nil {
			t.Fatal(err)
		}
		return bytes.NewReader(data)
	}

	if err := imp.StartImport(ctx, body(ExportFormatVersion+1), 1); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("StartImport of an unknown version = %v, want ErrInvalidInput", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dataPath, "backups", "imports")); len(entries) != 0 {
		t.Errorf("a refused upload stays on disk: %v", entries)
	}
	if imp.Running() {
		t.Fatal("a refused import shows as running")
	}

	if _, err := repo.DB().Exec(`INSERT INTO posts (title, slug, content, formatter, status, type, author_id)
		VALUES ('x', 'x', '', 'markdown', 'draft', 'post', 1)`); err != nil {
		t.Fatal(err)
	}
	if err := imp.StartImport(ctx, body(1), 1); !errors.Is(err, ErrImportNotEmpty) {
		t.Fatalf("StartImport into a site with a post = %v, want ErrImportNotEmpty", err)
	}
	if empty, err := imp.InstanceEmpty(ctx); err != nil || empty {
		t.Errorf("InstanceEmpty = %v, %v, want false", empty, err)
	}
}

func TestParseImportPost(t *testing.T) {
	fm, body, err := parseImportPost([]byte("---\ntitle: A\nslug: a\n---\n\nline one\n\nline two\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if fm.Title != "A" || fm.Slug != "a" {
		t.Errorf("front matter = %+v", fm)
	}
	// The export adds one "\n" after the body; the body itself ends in "\n".
	if body != "line one\n\nline two\n" {
		t.Errorf("body = %q", body)
	}
	if _, _, err := parseImportPost([]byte("---\ntitle: A\n")); err == nil {
		t.Error("a front matter without an end is accepted")
	}
}

func TestImportJSONField(t *testing.T) {
	for in, want := range map[string]string{
		``:             "<null>",
		`null`:         "<null>",
		`{"Make":"X"}`: `{"Make":"X"}`,
		`"not json {"`: "not json {",
		`  {"a":1}  `:  `{"a":1}`,
	} {
		got := importJSONField([]byte(in))
		s := "<null>"
		if got.Valid {
			s = got.String
		}
		if s != want {
			t.Errorf("importJSONField(%q) = %q, want %q", in, s, want)
		}
	}
}

func TestUploadFile_KeepsTheGivenPath(t *testing.T) {
	imp, dataPath, _ := newImportTarget(t)
	ctx := context.Background()
	m, err := imp.media.UploadFile(ctx, UploadFileParams{
		Content: []byte("a"), Filename: "a.txt", MimeType: "text/plain", OriginalPath: "originals/2020/05/a.txt",
	})
	if err != nil || m.OriginalPath != "originals/2020/05/a.txt" {
		t.Fatalf("UploadFile = %q, %v", m.OriginalPath, err)
	}
	if _, err := os.Stat(filepath.Join(dataPath, "media", "originals", "2020", "05", "a.txt")); err != nil {
		t.Fatal(err)
	}
	// A path that is on disk already, and a path outside originals/, are refused.
	if _, err := imp.media.UploadFile(ctx, UploadFileParams{
		Content: []byte("b"), Filename: "a.txt", MimeType: "text/plain", OriginalPath: "originals/2020/05/a.txt",
	}); !errors.Is(err, ErrConflict) {
		t.Errorf("upload over a file on disk = %v, want ErrConflict", err)
	}
	if _, err := imp.media.UploadFile(ctx, UploadFileParams{
		Content: []byte("c"), Filename: "c.txt", MimeType: "text/plain", OriginalPath: "originals/../../c.txt",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("upload to an unsafe path = %v, want ErrInvalidInput", err)
	}
}
