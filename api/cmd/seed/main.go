// Command seed populates a stress-test database with synthetic posts, media,
// and tags. It is intentionally separate from the app and writes via raw
// batched INSERTs in transactions (the service/HTTP layers would fire per-post
// cache invalidation + post_count recompute and take hours).
//
// Key correctness notes (see plan):
//   - media.checksum is NOT NULL UNIQUE and media.post_id is single-valued, so
//     N posts * K images => N*K media rows, each with a synthetic unique
//     checksum. Files on disk are a small hardlinked bank; uniqueness lives in
//     the DB row, not the file bytes.
//   - posts must be status='published' (lowercase) with published_at set, and
//     need an author_id, or atlas/homepage show nothing.
//   - tags.post_count is a cached column filtered by post_count>0 in listings,
//     so it is backfilled at the end. ANALYZE runs last so the planner has stats.
package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const maxParams = 32000 // modernc/sqlite allows up to 32766 bound variables

var (
	dbPath    = flag.String("db", "/mnt/lab_storage/point-data/point-stress.db", "stress sqlite db path")
	storage   = flag.String("storage", "/mnt/lab_storage/point-data", "STORAGE_PATH root")
	srcImage  = flag.String("src", "", "source jpg to hardlink the bank from (default: <storage>/media/originals/2026/06/dewdrop-dreams.jpg)")
	nPosts    = flag.Int("posts", 100000, "number of posts")
	imgsPer   = flag.Int("images-per-post", 10, "media rows per post")
	bankSize  = flag.Int("bank", 13400, "number of hardlinked bank images (~100GB nominal @7.5MB)")
	nPlain    = flag.Int("tags-plain", 10000, "plain tags (3-level hierarchy)")
	nYear     = flag.Int("tags-year", 100, "year tags")
	nGeo      = flag.Int("tags-geo", 500, "geo tags")
	tagsPer   = flag.Int("tags-per-post", 20, "tags assigned per post")
	zipfS     = flag.Float64("zipf-s", 1.2, "Zipf exponent for tag skew (higher = more skewed)")
	force     = flag.Bool("force", false, "proceed even if target tables are non-empty")
	imgW      = 5827
	imgH      = 3715
	imgBytes  = int64(7525062)
	startYear = 2017
	endYear   = 2026
)

func main() {
	flag.Parse()
	rng := rand.New(rand.NewSource(42))

	if *srcImage == "" {
		*srcImage = filepath.Join(*storage, "media/originals/2026/06/dewdrop-dreams.jpg")
	}
	if fi, err := os.Stat(*srcImage); err != nil {
		log.Fatalf("source image not found: %s (%v)", *srcImage, err)
	} else {
		imgBytes = fi.Size()
	}

	db, err := sql.Open("sqlite", *dbPath)
	must(err)
	defer db.Close()
	db.SetMaxOpenConns(1)
	for _, p := range []string{
		"PRAGMA busy_timeout=10000", "PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=OFF", "PRAGMA foreign_keys=ON",
		"PRAGMA temp_store=MEMORY", "PRAGMA cache_size=-200000",
	} {
		if _, err := db.Exec(p); err != nil {
			log.Fatalf("pragma %q: %v", p, err)
		}
	}

	assertEmpty(db)
	t0 := time.Now()

	authorID := ensureAuthor(db)
	log.Printf("author id=%d", authorID)

	plainIDs, yearIDs, geoIDs := seedTags(db, rng)
	allTagIDs := append(append(append([]int64{}, plainIDs...), yearIDs...), geoIDs...)
	log.Printf("tags: %d plain, %d year, %d geo (%.1fs)", len(plainIDs), len(yearIDs), len(geoIDs), time.Since(t0).Seconds())

	bank := buildBank(rng)
	log.Printf("image bank: %d hardlinks (%.1fs)", len(bank), time.Since(t0).Seconds())

	seedPostsMediaTags(db, rng, authorID, bank, allTagIDs)
	log.Printf("posts/media/post_tags done (%.1fs)", time.Since(t0).Seconds())

	finalize(db)
	report(db, time.Since(t0))
}

// --- tags -------------------------------------------------------------------

// seedTags creates plain tags in a 3-level hierarchy (100 roots -> 900 mid ->
// rest leaves), flat year tags, and flat geo tags with coordinates. IDs are
// explicit and contiguous starting at 1.
func seedTags(db *sql.DB, rng *rand.Rand) (plain, year, geo []int64) {
	tx, err := db.Begin()
	must(err)
	tcols := []string{"id", "name", "slug", "kind", "latitude", "longitude", "in_ancestor_flyout"}
	var trows [][]any
	rels := [][]any{} // parent_id, child_id, sort_order

	var id int64 = 1
	roots := min(100, *nPlain)
	mid := min(900, *nPlain-roots)
	level := make([]int, 0, *nPlain) // 1,2,3 per plain tag index
	plainStart := id
	for i := 0; i < *nPlain; i++ {
		lvl := 3
		if i < roots {
			lvl = 1
		} else if i < roots+mid {
			lvl = 2
		}
		level = append(level, lvl)
		trows = append(trows, []any{id, fmt.Sprintf("Tag %d", id), fmt.Sprintf("stress-tag-%d", id), "tag", nil, nil, 1})
		plain = append(plain, id)
		id++
	}
	// wire hierarchy: each L2 -> a random L1 parent; each L3 -> a random L2 parent
	l1 := plain[:roots]
	l2 := plain[roots : roots+mid]
	for i := roots; i < *nPlain; i++ {
		var parent int64
		if level[i] == 2 {
			parent = l1[rng.Intn(len(l1))]
		} else { // level 3
			if len(l2) > 0 {
				parent = l2[rng.Intn(len(l2))]
			} else {
				parent = l1[rng.Intn(len(l1))]
			}
		}
		rels = append(rels, []any{parent, plain[i], rng.Intn(100)})
	}
	_ = plainStart

	// year tags
	for i := 0; i < *nYear; i++ {
		y := 1926 + i
		trows = append(trows, []any{id, fmt.Sprintf("%d", y), fmt.Sprintf("year-%d", y), "year", nil, nil, 1})
		year = append(year, id)
		id++
	}
	// geo tags with scattered coordinates
	for i := 0; i < *nGeo; i++ {
		lat := rng.Float64()*150 - 60  // -60..90
		lng := rng.Float64()*360 - 180 // -180..180
		trows = append(trows, []any{id, fmt.Sprintf("Place %d", id), fmt.Sprintf("geo-%d", id), "geo", lat, lng, 1})
		geo = append(geo, id)
		id++
	}

	execBatch(tx, "tags", tcols, trows)
	execBatch(tx, "tag_relationships", []string{"parent_id", "child_id", "sort_order"}, rels)
	must(tx.Commit())
	return plain, year, geo
}

// --- author -----------------------------------------------------------------

func ensureAuthor(db *sql.DB) int64 {
	var id int64
	err := db.QueryRow("SELECT id FROM users ORDER BY id LIMIT 1").Scan(&id)
	if err == nil {
		return id
	}
	res, err := db.Exec(
		`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'stress','stress@example.com','x','Stress Author')`)
	must(err)
	id, _ = res.LastInsertId()
	if id == 0 {
		id = 1
	}
	return id
}

// --- image bank -------------------------------------------------------------

type bankImg struct {
	orig  string // originals/YYYY/MM/name  (DB path)
	thumb string // thumbnails/YYYY/MM/name (DB path)
}

func buildBank(rng *rand.Rand) []bankImg {
	bank := make([]bankImg, 0, *bankSize)
	years := endYear - startYear + 1
	for i := 0; i < *bankSize; i++ {
		y := startYear + i%years
		m := 1 + (i/years)%12
		name := fmt.Sprintf("stress-%d-dewdrop.jpg", i)
		rel := fmt.Sprintf("%d/%02d/%s", y, m, name)
		abs := filepath.Join(*storage, "media", "originals", rel)
		must(os.MkdirAll(filepath.Dir(abs), 0o755))
		if err := os.Link(*srcImage, abs); err != nil && !os.IsExist(err) {
			log.Fatalf("hardlink %s: %v", abs, err)
		}
		bank = append(bank, bankImg{
			orig:  "originals/" + rel,
			thumb: "thumbnails/" + rel,
		})
	}
	return bank
}

// --- posts / media / post_tags ---------------------------------------------

func seedPostsMediaTags(db *sql.DB, rng *rand.Rand, authorID int64, bank []bankImg, tagIDs []int64) {
	zipf := rand.NewZipf(rng, *zipfS, 1.0, uint64(len(tagIDs)-1))
	postCols := []string{"id", "title", "slug", "content", "status", "type", "author_id",
		"thumbnail_path", "published_at", "created_at", "updated_at", "formatter", "css", "immersive_mode"}
	mediaCols := []string{"filename", "original_path", "thumbnail_path", "file_type", "mime_type",
		"file_size", "width", "height", "post_id", "checksum", "uploaded_at", "is_public"}
	ptCols := []string{"post_id", "tag_id"}

	const chunk = 5000
	var mediaSeq int64
	t0 := start2017()
	span := time.Date(endYear, 6, 1, 0, 0, 0, 0, time.UTC).Sub(t0)

	for cs := 1; cs <= *nPosts; cs += chunk {
		ce := min(cs+chunk-1, *nPosts)
		tx, err := db.Begin()
		must(err)
		var posts, media, pts [][]any
		for pid := cs; pid <= ce; pid++ {
			ts := t0.Add(time.Duration(float64(span) * float64(pid) / float64(*nPosts)))
			tsStr := ts.UTC().Format("2006-01-02 15:04:05")

			// pick images for this post
			first := bank[rng.Intn(len(bank))]
			var b strings.Builder
			fmt.Fprintf(&b, "# Stress post %d\n\n%s\n\n", pid, loremParagraph(rng))
			for k := 0; k < *imgsPer; k++ {
				img := bank[rng.Intn(len(bank))]
				if k == 0 {
					first = img
				}
				fmt.Fprintf(&b, "![](%s)\n", img.orig)
				mediaSeq++
				ck := sha256.Sum256([]byte(fmt.Sprintf("stress:%d", mediaSeq)))
				media = append(media, []any{
					filepath.Base(img.orig), img.orig, img.thumb, "image", "image/jpeg",
					imgBytes, imgW, imgH, pid, hex.EncodeToString(ck[:]), tsStr, 1,
				})
			}
			posts = append(posts, []any{
				pid, fmt.Sprintf("Stress Post %d", pid), fmt.Sprintf("stress-%06d", pid),
				b.String(), "published", "post", authorID, first.orig, tsStr, tsStr, tsStr,
				"markdown", "", "auto",
			})
			// skewed distinct tags for this post
			for _, tid := range pickTags(zipf, tagIDs, *tagsPer, rng) {
				pts = append(pts, []any{pid, tid})
			}
		}
		execBatch(tx, "posts", postCols, posts)
		execBatch(tx, "media", mediaCols, media)
		execBatch(tx, "post_tags", ptCols, pts)
		must(tx.Commit())
		log.Printf("  posts %d/%d  (media=%d)", ce, *nPosts, mediaSeq)
	}
}

func pickTags(z *rand.Zipf, tagIDs []int64, n int, rng *rand.Rand) []int64 {
	seen := make(map[int64]bool, n)
	out := make([]int64, 0, n)
	for attempts := 0; len(out) < n && attempts < n*20; attempts++ {
		tid := tagIDs[z.Uint64()]
		if !seen[tid] {
			seen[tid] = true
			out = append(out, tid)
		}
	}
	// top up with uniform if zipf kept colliding
	for len(out) < n {
		tid := tagIDs[rng.Intn(len(tagIDs))]
		if !seen[tid] {
			seen[tid] = true
			out = append(out, tid)
		}
	}
	return out
}

// --- finalize ---------------------------------------------------------------

func finalize(db *sql.DB) {
	log.Printf("backfilling tags.post_count ...")
	// Grouped UPDATE...FROM scans post_tags once (O(post_tags+tags)), instead of
	// a correlated subquery (O(tags * post_tags)) which is pathological without
	// an index on post_tags(tag_id) -- which is intentionally absent at baseline.
	_, err := db.Exec(`UPDATE tags SET post_count = 0`)
	must(err)
	_, err = db.Exec(`UPDATE tags SET post_count = c.cnt FROM
		(SELECT tag_id, COUNT(*) AS cnt FROM post_tags GROUP BY tag_id) AS c
		WHERE c.tag_id = tags.id`)
	must(err)
	log.Printf("ANALYZE ...")
	_, err = db.Exec(`ANALYZE`)
	must(err)
	_, _ = db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
}

func report(db *sql.DB, dur time.Duration) {
	q := func(sql string) int64 {
		var n int64
		_ = db.QueryRow(sql).Scan(&n)
		return n
	}
	fmt.Println("------------------------------------------------------------")
	fmt.Printf("posts        : %d\n", q("SELECT COUNT(*) FROM posts"))
	fmt.Printf("media        : %d\n", q("SELECT COUNT(*) FROM media"))
	fmt.Printf("tags         : %d\n", q("SELECT COUNT(*) FROM tags"))
	fmt.Printf("post_tags    : %d\n", q("SELECT COUNT(*) FROM post_tags"))
	fmt.Printf("tag_rels     : %d\n", q("SELECT COUNT(*) FROM tag_relationships"))
	fmt.Printf("max post_cnt : %d\n", q("SELECT MAX(post_count) FROM tags"))
	fmt.Printf("tags >1000   : %d\n", q("SELECT COUNT(*) FROM tags WHERE post_count>1000"))
	fmt.Printf("tags ==0     : %d\n", q("SELECT COUNT(*) FROM tags WHERE post_count=0"))
	fmt.Printf("elapsed      : %.1fs\n", dur.Seconds())
	fmt.Println("------------------------------------------------------------")
}

// --- helpers ----------------------------------------------------------------

// execBatch inserts rows into table using multi-row INSERTs sized to stay under
// the bound-variable limit.
func execBatch(tx *sql.Tx, table string, cols []string, rows [][]any) {
	if len(rows) == 0 {
		return
	}
	perRow := len(cols)
	batch := maxParams / perRow
	if batch < 1 {
		batch = 1
	}
	colList := strings.Join(cols, ",")
	tuple := "(" + strings.TrimSuffix(strings.Repeat("?,", perRow), ",") + ")"
	for i := 0; i < len(rows); i += batch {
		end := min(i+batch, len(rows))
		n := end - i
		ph := strings.TrimSuffix(strings.Repeat(tuple+",", n), ",")
		args := make([]any, 0, n*perRow)
		for _, r := range rows[i:end] {
			args = append(args, r...)
		}
		_, err := tx.Exec("INSERT INTO "+table+" ("+colList+") VALUES "+ph, args...)
		if err != nil {
			log.Fatalf("insert into %s: %v", table, err)
		}
	}
}

func assertEmpty(db *sql.DB) {
	if *force {
		return
	}
	for _, t := range []string{"posts", "media", "tags", "post_tags"} {
		var n int64
		must(db.QueryRow("SELECT COUNT(*) FROM " + t).Scan(&n))
		if n > 0 {
			log.Fatalf("%s already has %d rows; refusing without --force (use a fresh point-stress.db)", t, n)
		}
	}
}

func start2017() time.Time { return time.Date(startYear, 1, 1, 0, 0, 0, 0, time.UTC) }

var loremWords = strings.Fields(`lorem ipsum dolor sit amet consectetur adipiscing elit sed do
eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud
exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit
voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident`)

func loremParagraph(rng *rand.Rand) string {
	var b strings.Builder
	for i := 0; i < 120; i++ { // ~800-900 bytes of body to exercise content payload
		b.WriteString(loremWords[rng.Intn(len(loremWords))])
		b.WriteByte(' ')
	}
	return b.String()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
