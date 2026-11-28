//go:build !unit

package services

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"point-api/internal/repository"
)

// newExportFixture is a small site: two tags (one the parent of the other),
// a published post with two photos, a draft page, a post in the trash, and
// media rows for a public file, a private file that is not on disk, and a
// file in the trash.
func newExportFixture(t *testing.T) (*SystemService, string, repository.Repository) {
	t.Helper()
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")
	repo, err := repository.NewRepository(dbPath)
	if err != nil {
		t.Fatalf("open repo: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	exec := func(q string) {
		t.Helper()
		if _, err := repo.DB().Exec(q); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1, 'u', 'u@x.com', 'h', 'U')`)
	exec(`INSERT INTO tags (id, name, slug, kind) VALUES (101, 'Places', 'places', 'tag'), (102, 'Paris', 'paris', 'tag')`)
	exec(`INSERT INTO tag_relationships (parent_id, child_id, sort_order) VALUES (101, 102, 3)`)
	exec(`INSERT INTO posts (id, title, slug, content, formatter, status, type, is_featured, view_count,
		published_at, created_at, updated_at, author_id, thumbnail_path, css)
		VALUES (1, 'Evening walk', 'evening-walk',
		'/2024/01/river.jpg
![Bridge](/2024/01/my bridge.jpg) at dusk
See https://example.com/2024/01/river.jpg and /2024/01/gone.jpg',
		'markdown', 'published', 'post', 1, 7,
		'2024-01-05 18:00:00', '2024-01-05 17:00:00', '2024-01-06 09:00:00', 1, '/2024/01/river.jpg', '.post { color: red; }')`)
	exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1, 102), (1, 101)`)
	exec(`INSERT INTO posts (id, title, slug, content, formatter, status, type, is_featured, view_count,
		created_at, updated_at, author_id) VALUES (2, 'About', 'about', 'Hello.', 'markdown', 'draft', 'page', 0, 0,
		'2024-02-01 10:00:00', '2024-02-01 10:00:00', 1)`)
	exec(`INSERT INTO posts (id, title, slug, content, formatter, status, type, is_featured, view_count,
		created_at, updated_at, author_id, deleted_at) VALUES (3, 'Old', 'old', 'x', 'markdown', 'published', 'post', 0, 0,
		'2024-02-01 10:00:00', '2024-02-01 10:00:00', 1, '2024-03-01 10:00:00')`)
	exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, width, height,
		post_id, uploaded_at, checksum, alt_text, caption, is_public, metadata)
		VALUES (1, 'river.jpg', 'originals/2024/01/river.jpg', 'image', 'image/jpeg', 11, 4000, 3000,
		1, '2024-01-05 16:00:00', 'c1', 'A river', 'The river at dusk', 1, '{"Make":"NIKON","FNumber":"28/10"}')`)
	exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, uploaded_at, checksum, is_public)
		VALUES (2, 'my bridge.jpg', 'originals/2024/01/my bridge.jpg', 'image', 'image/jpeg', 6, '2024-01-05 16:00:00', 'c2', 0)`)
	exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, uploaded_at, checksum, is_public)
		VALUES (3, 'gone-file.jpg', 'originals/2024/01/gone-file.jpg', 'image', 'image/jpeg', 6, '2024-01-05 16:00:00', 'c3', 0)`)
	exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, uploaded_at, checksum, is_public, deleted_at)
		VALUES (4, 'trashed.jpg', 'originals/2024/01/trashed.jpg', 'image', 'image/jpeg', 6, '2024-01-05 16:00:00', 'c4', 0, '2024-03-01 10:00:00')`)

	write := func(rel, data string) {
		t.Helper()
		p := filepath.Join(dataPath, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("media/originals/2024/01/river.jpg", "river bytes")
	write("media/originals/2024/01/my bridge.jpg", "bridge")
	write("media/originals/2024/01/trashed.jpg", "trashed")
	// Derived files stay out of the export.
	write("media/thumbnails/2024/01/river.jpg", "thumb")
	write("media/variants/2024/01/river_800.jpg", "variant")

	return NewSystemService(repo, dataPath, dbPath), dataPath, repo
}

// readExportArchive returns each regular entry of the archive by name, and
// the entry names in archive order.
func readExportArchive(t *testing.T, p string) (map[string][]byte, []string) {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	gr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gr)
	entries := map[string][]byte{}
	var order []string
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		if h.Uname != "" || h.Gname != "" || h.Uid != 0 || h.Gid != 0 {
			t.Errorf("entry %s has an owner: %s/%s %d/%d", h.Name, h.Uname, h.Gname, h.Uid, h.Gid)
		}
		entries[h.Name] = data
		order = append(order, h.Name)
	}
	return entries, order
}

func TestCreateExport_FixtureSite(t *testing.T) {
	svc, dataPath, repo := newExportFixture(t)
	ctx := context.Background()

	res, err := svc.CreateExport(ctx, "v9.9.9")
	if err != nil {
		t.Fatalf("CreateExport: %v", err)
	}
	if res.Filename == "" || res.Sha256 == "" || res.Size == 0 {
		t.Fatalf("result has no archive: %+v", res)
	}
	if res.MissingCount != 1 || len(res.Missing) != 1 || res.Missing[0] != "originals/2024/01/gone-file.jpg" {
		t.Fatalf("missing = %d %v, want the one file that is not on disk", res.MissingCount, res.Missing)
	}

	archive := filepath.Join(dataPath, "backups", "exports", res.Filename)
	entries, order := readExportArchive(t, archive)
	if order[0] != "manifest.json" {
		t.Fatalf("first entry = %q, want manifest.json", order[0])
	}

	var manifest exportManifest
	if err := json.Unmarshal(entries["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	var tagRows int64
	if err := repo.DB().QueryRow(`SELECT COUNT(*) FROM tags`).Scan(&tagRows); err != nil {
		t.Fatal(err)
	}
	if manifest.Format != ExportFormat || manifest.Version != ExportFormatVersion || manifest.InstanceVersion != "v9.9.9" {
		t.Fatalf("manifest header = %+v", manifest)
	}
	want := repository.ExportCounts{Posts: 1, Pages: 1, Media: 3, Tags: tagRows}
	if manifest.Counts != want {
		t.Fatalf("counts = %+v, want %+v", manifest.Counts, want)
	}

	// Only live posts, originals and sidecars; no trash, no derived files.
	for name := range entries {
		switch {
		case strings.Contains(name, "trashed"), name == "posts/old.md",
			strings.Contains(name, "thumbnails"), strings.Contains(name, "variants"), strings.HasSuffix(name, ".db"):
			t.Errorf("archive holds %q", name)
		}
	}
	if got := string(entries["media/originals/2024/01/river.jpg"]); got != "river bytes" {
		t.Errorf("river original = %q", got)
	}
	if got := string(entries["media/originals/2024/01/my bridge.jpg"]); got != "bridge" {
		t.Errorf("bridge original = %q", got)
	}
	if _, ok := entries["media/originals/2024/01/gone-file.jpg"]; ok {
		t.Error("archive holds a file that is not on disk")
	}

	// Post Markdown: front matter, then the body with references that resolve
	// inside the archive.
	post := string(entries["posts/evening-walk.md"])
	parts := strings.SplitN(post, "---\n", 3)
	if len(parts) != 3 || parts[0] != "" {
		t.Fatalf("post has no front matter:\n%s", post)
	}
	var fm exportFrontMatter
	if err := yaml.Unmarshal([]byte(parts[1]), &fm); err != nil {
		t.Fatalf("front matter: %v\n%s", err, parts[1])
	}
	if fm.Title != "Evening walk" || fm.Slug != "evening-walk" || fm.Status != "published" || fm.Type != "post" ||
		!fm.Featured || fm.Css != ".post { color: red; }" || fm.PublishedAt == nil ||
		fm.PublishedAt.Format("2006-01-02 15:04") != "2024-01-05 18:00" {
		t.Errorf("front matter = %+v", fm)
	}
	if strings.Join(fm.Tags, ",") != "paris,places" {
		t.Errorf("tags = %v, want [paris places]", fm.Tags)
	}
	if fm.Thumbnail != "../media/originals/2024/01/river.jpg" {
		t.Errorf("thumbnail = %q", fm.Thumbnail)
	}
	body := parts[2]
	for _, s := range []string{
		"\n../media/originals/2024/01/river.jpg\n",
		"![Bridge](../media/originals/2024/01/my bridge.jpg) at dusk",
		// A path inside a URL, and a file that is not in the export, stay.
		"https://example.com/2024/01/river.jpg and /2024/01/gone.jpg",
	} {
		if !strings.Contains(body, s) {
			t.Errorf("body does not contain %q:\n%s", s, body)
		}
	}
	// Each rewritten reference names an entry of the archive.
	for _, ref := range []string{"2024/01/river.jpg", "2024/01/my bridge.jpg"} {
		if _, ok := entries[filepath.ToSlash(filepath.Join("posts", "..", "media", "originals", ref))]; !ok {
			t.Errorf("reference %q does not resolve inside the archive", ref)
		}
	}

	page := string(entries["posts/about.md"])
	if !strings.Contains(page, "type: page\n") || !strings.Contains(page, "status: draft\n") ||
		strings.Contains(page, "published_at") || !strings.HasSuffix(page, "Hello.\n") {
		t.Errorf("page file:\n%s", page)
	}

	// Sidecars.
	var river exportMediaSidecar
	if err := json.Unmarshal(entries["media/originals/2024/01/river.jpg.json"], &river); err != nil {
		t.Fatal(err)
	}
	var exif bytes.Buffer
	if err := json.Compact(&exif, river.Exif); err != nil {
		t.Fatal(err)
	}
	if river.AltText != "A river" || river.Caption != "The river at dusk" || river.Visibility != "public" ||
		river.Post != "evening-walk" || river.Width == nil || *river.Width != 4000 || river.Missing ||
		exif.String() != `{"Make":"NIKON","FNumber":"28/10"}` {
		t.Errorf("river sidecar = %+v exif=%s", river, river.Exif)
	}
	var gone exportMediaSidecar
	if err := json.Unmarshal(entries["media/originals/2024/01/gone-file.jpg.json"], &gone); err != nil {
		t.Fatal(err)
	}
	if !gone.Missing || gone.Visibility != "private" {
		t.Errorf("missing-file sidecar = %+v", gone)
	}

	// Tags with parent links.
	var tags []exportTag
	if err := json.Unmarshal(entries["tags.json"], &tags); err != nil {
		t.Fatal(err)
	}
	var paris *exportTag
	for i := range tags {
		if tags[i].Slug == "paris" {
			paris = &tags[i]
		}
	}
	if paris == nil || len(paris.Parents) != 1 || paris.Parents[0].Slug != "places" ||
		paris.Parents[0].SortOrder == nil || *paris.Parents[0].SortOrder != 3 {
		t.Errorf("paris tag = %+v", paris)
	}

	// The result is stored, and the export path resolves.
	last := svc.LastExport()
	if last == nil || last.Filename != res.Filename || last.Sha256 != res.Sha256 {
		t.Fatalf("LastExport = %+v", last)
	}
	if _, err := svc.ExportPath(res.Filename); err != nil {
		t.Fatalf("ExportPath: %v", err)
	}
}

func TestCreateExport_KeepsOnlyTheNewest(t *testing.T) {
	svc, dataPath, _ := newExportFixture(t)
	dir := filepath.Join(dataPath, "backups", "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, exportFilePrefix+"20000101_000000.tar.gz")
	stale := filepath.Join(dir, exportFilePrefix+"20000101_000001.tar.gz"+partialSuffix)
	for _, p := range []string{old, stale} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := svc.CreateExport(context.Background(), "dev")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{old, stale} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s was not removed", filepath.Base(p))
		}
	}
	if _, err := os.Stat(filepath.Join(dir, res.Filename)); err != nil {
		t.Errorf("new export is not there: %v", err)
	}
}

func TestCreateExport_RefusesASecondRun(t *testing.T) {
	svc, _, _ := newExportFixture(t)
	svc.exportRunning = true
	if _, err := svc.CreateExport(context.Background(), "dev"); !errors.Is(err, ErrExportInProgress) {
		t.Fatalf("err = %v, want ErrExportInProgress", err)
	}
}

func TestExportPath_RefusesOtherNames(t *testing.T) {
	svc, _, _ := newExportFixture(t)
	for _, name := range []string{"", "../point.db", "backup_x.tar.gz", exportFilePrefix + "x.zip", exportFilePrefix + "nope.tar.gz"} {
		if _, err := svc.ExportPath(name); err == nil {
			t.Errorf("ExportPath(%q) = nil error", name)
		}
	}
}

func TestExportRewriteMediaRefs(t *testing.T) {
	media := map[string]bool{"originals/2024/01/a.jpg": true, "originals/2024/01/b c.jpg": true}
	cases := map[string]string{
		"/2024/01/a.jpg":                   "../media/originals/2024/01/a.jpg",
		"(/2024/01/a.jpg)":                 "(../media/originals/2024/01/a.jpg)",
		`<img src="/2024/01/a.jpg">`:       `<img src="../media/originals/2024/01/a.jpg">`,
		"/2024/01/b c.jpg and more words":  "../media/originals/2024/01/b c.jpg and more words",
		"http://h/2024/01/a.jpg":           "http://h/2024/01/a.jpg",
		"/2024/01/unknown.jpg":             "/2024/01/unknown.jpg",
		"no refs here":                     "no refs here",
		"/2024/01/a.jpg\n\n/2024/01/a.jpg": "../media/originals/2024/01/a.jpg\n\n../media/originals/2024/01/a.jpg",
	}
	for in, want := range cases {
		if got := exportRewriteMediaRefs(in, media); got != want {
			t.Errorf("rewrite(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExportMediaPath(t *testing.T) {
	for in, ok := range map[string]bool{
		"originals/2024/01/a.jpg": true,
		"originals/../point.db":   false,
		"/originals/a.jpg":        false,
		"thumbnails/a.jpg":        false,
		"originals//a.jpg":        false,
		"":                        false,
	} {
		if _, got := exportMediaPath(in); got != ok {
			t.Errorf("exportMediaPath(%q) ok = %v, want %v", in, got, ok)
		}
	}
}
