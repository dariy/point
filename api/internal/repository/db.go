package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"point-api/internal/models"
	pointsql "point-api/sql"
)

type Repository interface {
	models.Querier
	Close() error
	DB() *sql.DB

	// Auth / WebAuthn
	//
	// DeleteSession is hand-written (it reports "not found" rather than silently
	// deleting nothing), so it is declared here rather than inherited from
	// models.Querier.
	DeleteSession(ctx context.Context, arg models.DeleteSessionParams) error
	DeleteSecret(ctx context.Context, key string) error
	CreateWebAuthnCredential(ctx context.Context, userID int64, credID, pubKey, aaguid []byte, signCount uint32, backupEligible, backupState bool) (*WebAuthnCredential, error)
	GetWebAuthnCredentialsByUserID(ctx context.Context, userID int64) ([]WebAuthnCredential, error)
	GetWebAuthnCredentialByCredentialID(ctx context.Context, credID []byte) (*WebAuthnCredential, error)
	DeleteWebAuthnCredentialByUserID(ctx context.Context, userID int64) error
	UpdateWebAuthnCredential(ctx context.Context, credID []byte, signCount uint32, backupState bool) error

	// Feed / Sitemap
	GetPublishedPostsForFeed(ctx context.Context, limit int) ([]models.Post, error)
	GetPublishedPostsForSitemap(ctx context.Context) ([]struct {
		Slug      string
		UpdatedAt time.Time
	}, error)
	GetPublicTagsForSitemap(ctx context.Context) ([]struct {
		ID   int64
		Slug string
	}, error)

	// Locations
	UpsertTagLocation(ctx context.Context, tagID int64, lat, lon float64) error
	GetTagLocationsByTagIDs(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error)
	DeleteTagLocation(ctx context.Context, tagID int64) error

	// Media
	ListOrphanedMedia(ctx context.Context, limit, offset int64) ([]models.Medium, error)
	CountOrphanedMedia(ctx context.Context) (int64, error)
	GetMediaByIDs(ctx context.Context, ids []int64) ([]models.Medium, error)
	DeleteMediaByIDs(ctx context.Context, ids []int64) error
	ListOrphanedMediaByPage(ctx context.Context, limit, offset int64) ([]models.Medium, int64, error)
	ListMediaFolders(ctx context.Context, fileType string) ([]MediaFolder, error)
	ListMediaFiltered(ctx context.Context, fileType, folder string, limit, offset int64) ([]models.Medium, error)
	CountMediaFiltered(ctx context.Context, fileType, folder string) (int64, error)
	GetMediaByPath(ctx context.Context, originalPath string) (models.Medium, error)
	SetMediaPublic(ctx context.Context, mediaID int64, isPublic bool, postID *int64) error
	GetAllMediaPaths(ctx context.Context) ([]models.Medium, error)
	GetMediaByPaths(ctx context.Context, paths []string) ([]models.Medium, error)
	GetStorageStats(ctx context.Context) (StorageStats, error)

	// Migrations
	GetMigrations(ctx context.Context) ([]MigrationRecord, error)
	ApplyMigration(ctx context.Context, name, sql string) error
	MigrateFlagsToSystemTags(ctx context.Context) error
	RebuildTagsTableDropBooleans(ctx context.Context) error
	EnsureSystemTags(ctx context.Context) error
	MigrateTagFlagsFromSystemTags(ctx context.Context) error

	// Posts
	//
	// ListPosts, ListPostsByViews and CountPosts are declared here rather than
	// reaching callers through the embedded models.Querier: buildPostsQuery
	// composes their WHERE clause from filters sqlc cannot express, so this layer
	// owns the SQL outright. They were sqlc queries once, and the hand-written
	// methods below shadowed the generated ones without anything saying so.
	ListPosts(ctx context.Context, arg models.ListPostsParams) ([]models.Post, error)
	ListPostsByViews(ctx context.Context, arg models.ListPostsByViewsParams) ([]models.Post, error)
	CountPosts(ctx context.Context, arg models.CountPostsParams) (int64, error)
	ListPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.ListPostsParams) ([]models.Post, error)
	CountPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.CountPostsParams) (int64, error)
	ListPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool, limit, offset int64) ([]models.Post, error)
	CountPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool) (int64, error)
	GetPostByPreviewToken(ctx context.Context, token string) (models.Post, error)
	GetPostNavigation(ctx context.Context, postID int64, publicOnly bool, tag string) (prev, next *PostNavItem, err error)
	ReplacePostContentPath(ctx context.Context, oldPath, newPath string) (int64, error)
	ListPublishedPostStubs(ctx context.Context) ([]PostStub, error)
	ListScheduledPosts(ctx context.Context, limit, offset int64) ([]models.Post, error)
	CountScheduledPosts(ctx context.Context) (int64, error)
	ListScheduledPostsByTagIDs(ctx context.Context, tagIDs []int64, limit, offset int64) ([]models.Post, error)
	CountScheduledPostsByTagIDs(ctx context.Context, tagIDs []int64) (int64, error)
	ListPostNodesForGraph(ctx context.Context, publishedOnly bool) ([]GraphPostNode, error)
	GetPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error)
	CountPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error)
	GetPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error)
	CountPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error)
	GetAllPublishedPostContents(ctx context.Context) ([]PostContentRow, error)
	ListPostLinkAuditRows(ctx context.Context) ([]PostLinkAuditRow, error)
	GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error)
	GetHierarchicalPostCountsInYearRange(ctx context.Context, publishedOnly bool, fromYear, toYear int) (map[int64]int64, error)
	GetExistingInstagramIDs(ctx context.Context, ids []string) ([]string, error)
	SetPostInstagramID(ctx context.Context, postID int64, instagramID string) error
	SetPostMediaURL(ctx context.Context, postID int64, mediaURL string) error
	BackfillPostMediaURLs(ctx context.Context) error

	// OAuth (MCP authorization server state that must survive a restart)
	SaveOAuthClient(ctx context.Context, clientID string, redirectURIs []string, registeredAt time.Time) error
	GetOAuthClient(ctx context.Context, clientID string) (redirectURIs []string, registeredAt time.Time, found bool, err error)
	SaveOAuthToken(ctx context.Context, tokenHash, clientID string, expiresAt time.Time) error
	GetOAuthToken(ctx context.Context, tokenHash string) (clientID string, expiresAt time.Time, found bool, err error)
	DeleteOAuthToken(ctx context.Context, tokenHash string) error
	DeleteExpiredOAuthTokens(ctx context.Context, now time.Time) error

	// System
	GetSystemStats(ctx context.Context) (SystemStats, error)
	BackupDB(ctx context.Context, destPath string) error

	// Tags
	SearchTags(ctx context.Context, query string, limit int) ([]models.Tag, error)
	GetTagAncestors(ctx context.Context, tagID int64) ([]models.Tag, error)
	GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error)
	GetCoOccurringTags(ctx context.Context, tagID int64, publicOnly bool) ([]models.Tag, error)
	GetTopCoOccurringTagsForTagIDs(ctx context.Context, tagIDs []int64, rootID int64, publicOnly bool, limit int64) ([]PostTagInfo, error)
	GetAllTagRelationships(ctx context.Context) ([]TagRelationship, error)
	ClearTagParents(ctx context.Context, childID int64) error
	ClearTagChildren(ctx context.Context, parentID int64) error
	GetTagsWithoutLocation(ctx context.Context, tagIDs []int64) ([]models.Tag, error)
	FindTagsByNames(ctx context.Context, names []string) ([]models.Tag, error)
	FindTagsBySlugs(ctx context.Context, slugs []string) (map[string]models.Tag, error)
	GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]PostTagInfo, error)
	GetChildrenOfTag(ctx context.Context, parentID int64) ([]models.Tag, error)
	GetRootTags(ctx context.Context) ([]models.Tag, error)
	UpdateTagSortOrder(ctx context.Context, id int64, sortOrder int32) error
	UpdateEdgeSortOrder(ctx context.Context, parentID, childID int64, sortOrder int32) error
	MergeTags(ctx context.Context, winnerID, loserID int64) error

	// Timeline
	ListMapTagsForYearRange(ctx context.Context, fromYear, toYear int) ([]MapYearRangeTag, error)
	ListInTimelineDescendants(ctx context.Context) ([]InTimelineTag, error)
	ListInTimelineDescendantsForTag(ctx context.Context, contextTagSlug string) ([]InTimelineTag, error)
	GetLocationTagsCoOccurringWith(ctx context.Context, dateTagSlug, contextTagSlug string, limit int) ([]LocationTagCoOccurrence, error)
	GetYearTagsByLocationTagIDs(ctx context.Context, locTagIDs []int64) (map[int64][]PostTagInfo, error)
}

type sqliteRepository struct {
	*models.Queries
	db *sql.DB
}

// maxInClauseParams bounds how many values a batch query puts in one IN list.
// SQLite caps bound parameters per statement (999 on older builds), and batch
// helpers are fed caller-sized slices — every media path in a post, every tag
// name on a save — so they chunk rather than trusting the input to be small.
const maxInClauseParams = 500

// maxOpenConns is the pool size for a file-backed database. WAL lets readers
// run concurrently with each other and with the single writer, which is the
// whole point of enabling it; capping the pool at one connection throws that
// away and serializes every request, the scheduler and feed generation behind
// one queue. Writes still serialize — SQLite allows one writer at a time — but
// they now do so at the SQLite lock (with busy_timeout to wait it out) instead
// of blocking readers.
const maxOpenConns = 8

// totalCacheSizeKB is the page-cache budget for the whole pool, in KB. SQLite's
// cache_size is per connection, so it is divided by the pool size — otherwise
// raising the connection count would multiply memory use by the same factor.
const totalCacheSizeKB = 200000

// isMemoryDSN reports whether dbURL names an in-memory database. Each
// connection to a private in-memory DSN gets its OWN empty database, so such a
// pool must stay at one connection or callers would see a missing schema at
// random. Used by tests (":memory:") and never in production.
func isMemoryDSN(dbURL string) bool {
	return strings.Contains(dbURL, ":memory:") || strings.Contains(dbURL, "mode=memory")
}

// pragmaDSN appends the connection PRAGMAs to dbURL as modernc `_pragma` query
// parameters. This is the mechanism that makes a multi-connection pool safe:
// PRAGMAs are per-connection state, so applying them with db.Exec only
// configures whichever connection happened to serve that call. Anything the
// pool opens later would otherwise run without foreign keys, without the busy
// timeout, and outside WAL.
func pragmaDSN(dbURL string, conns int) string {
	params := []string{
		"_pragma=busy_timeout(5000)",
		"_pragma=journal_mode(WAL)",
		// WAL's usual companion: fsync at checkpoints rather than at every
		// commit. A crash can lose the last transactions but never corrupts
		// the database, which is the right trade for a blog engine.
		"_pragma=synchronous(NORMAL)",
		"_pragma=foreign_keys(ON)",
		fmt.Sprintf("_pragma=cache_size(-%d)", totalCacheSizeKB/conns),
		"_pragma=mmap_size(30000000000)",
		// Take the write lock at BEGIN rather than at the first write
		// statement. Without this a transaction that reads before it writes
		// can fail to upgrade its lock and gets SQLITE_BUSY immediately —
		// busy_timeout does not apply to that case.
		"_txlock=immediate",
	}
	sep := "?"
	if strings.Contains(dbURL, "?") {
		sep = "&"
	}
	return dbURL + sep + strings.Join(params, "&")
}

// coreTables are the tables whose presence tells an initialized database from
// an empty file. All four are created by schema.sql and never dropped, so
// finding some but not all of them means something is wrong — either an
// initialization that died part way through, or a database that has lost a
// table.
var coreTables = []string{"users", "posts", "tags", "blog_settings"}

// inspectCoreSchema reports which of coreTables exist, and whether any of the
// ones that exist holds a row. "Holds a row" is what separates a real
// installation from a half-built one, and therefore what separates a database
// worth refusing to overwrite from a file with nothing in it.
func inspectCoreSchema(db *sql.DB) (present []string, populated bool, err error) {
	for _, name := range coreTables {
		var found string
		err := db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, name).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, false, err
		}
		present = append(present, name)
	}

	for _, name := range present {
		var any int
		// The name comes from coreTables, never from input.
		//nolint:gosec // G201: interpolating one of four compile-time constants
		if err := db.QueryRow(fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s)`, name)).Scan(&any); err != nil {
			return nil, false, err
		}
		if any == 1 {
			return present, true, nil
		}
	}
	return present, false, nil
}

// missingFrom returns the core tables absent from present.
func missingFrom(present []string) []string {
	var missing []string
	for _, name := range coreTables {
		if !slices.Contains(present, name) {
			missing = append(missing, name)
		}
	}
	return missing
}

func NewRepository(dbURL string) (Repository, error) {
	conns := maxOpenConns
	if isMemoryDSN(dbURL) {
		conns = 1
	}

	db, err := sql.Open("sqlite", pragmaDSN(dbURL, conns))
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Every error below leaves the caller with no handle to close, so close the
	// pool here instead of leaking it — and the file with it. A caller told to
	// restore a backup needs nothing still holding the database open.
	opened := false
	defer func() {
		if !opened {
			_ = db.Close()
		}
	}()

	db.SetMaxOpenConns(conns)
	// Keep every connection warm: re-opening one means paying for the mmap and
	// page cache again, and SQLite connections are cheap to hold.
	db.SetMaxIdleConns(conns)
	db.SetConnMaxLifetime(0)

	// The PRAGMAs run when a connection is actually opened, so this is where a
	// wrong-permissions data directory surfaces. Failing here rather than
	// letting the server start is deliberate: a half-open database reads fine
	// and silently fails every write (e.g. first-run setup).
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("database is not usable — check permissions on the data directory: %w", err)
	}

	// Verify WAL actually engaged rather than trusting the DSN. A read-only
	// directory is the usual reason it does not.
	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode;").Scan(&journalMode); err != nil {
		return nil, fmt.Errorf("database is not writable — check permissions on the data directory: %w", err)
	}
	if !isMemoryDSN(dbURL) && !strings.EqualFold(journalMode, "wal") {
		return nil, fmt.Errorf("database is not in WAL mode (got %q) — check permissions on the data directory", journalMode)
	}

	// Check if the database needs initialization.
	present, populated, err := inspectCoreSchema(db)
	if err != nil {
		return nil, fmt.Errorf("failed to check database schema: %w", err)
	}
	initialized := len(present) == len(coreTables)

	if !initialized {
		// A database that holds data but is missing a core table is damaged,
		// not new. Initializing over it would create the missing table empty
		// and boot as if nothing had happened — every row that table held, and
		// every relation into it, silently gone. Refuse instead: the file is
		// still there, and a backup or a snapshot can still be put back.
		if populated {
			return nil, fmt.Errorf(
				"database at %s is missing the core table(s) %v but is not empty — refusing to initialize over it, "+
					"which would replace them with empty ones and lose whatever they held. "+
					"Restore a backup (scripts/restore-db.sh), or move the file aside to start fresh",
				dbURL, missingFrom(present))
		}
		if len(present) > 0 {
			// No rows anywhere, so this is an initialization that died part way
			// through rather than a database with something to lose. schema.sql
			// is all IF NOT EXISTS, so re-running it completes the job.
			slog.Warn("completing a partially initialized database",
				"existing", present, "missing", missingFrom(present))
		}
		slog.Info("Initializing new database with schema...")
		tx, err := db.Begin()
		if err != nil {
			return nil, fmt.Errorf("failed to begin transaction: %w", err)
		}
		defer func() { _ = tx.Rollback() }()

		for _, stmt := range pointsql.SchemaStatements() {
			if _, err := tx.Exec(stmt); err != nil {
				return nil, fmt.Errorf("failed to execute schema statement: %w\nStatement: %s", err, stmt)
			}
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("failed to commit schema transaction: %w", err)
		}
		slog.Info("Database schema initialized successfully.")
	} else {
		// Run migrations for existing databases.
		// SQLite returns an error if the column already exists — that's safe to ignore.
		for _, m := range bootstrapColumns {
			if _, err := db.Exec(m.sql); err != nil {
				// SQLite has no ADD COLUMN IF NOT EXISTS; re-running one on a
				// database that already has the column is the expected no-op.
				if !isDuplicateColumnError(err) {
					return nil, fmt.Errorf("migration failed (%s): %w", m.name, err)
				}
			}
		}
	}

	queries := models.New(db)
	repo := &sqliteRepository{
		Queries: queries,
		db:      db,
	}

	if initialized {
		for _, m := range bootstrapMigrations {
			if err := repo.ApplyMigration(context.Background(), m.name, m.sql); err != nil {
				return nil, fmt.Errorf("migration failed (%s): %w", m.name, err)
			}
		}
		// posts.media_url is the one bootstrap step with a Go body: the column
		// is added above, and existing rows are then filled in from content.
		if err := repo.BackfillPostMediaURLs(context.Background()); err != nil {
			return nil, fmt.Errorf("migration failed (backfill posts.media_url): %w", err)
		}
	}

	opened = true
	return repo, nil
}

func (r *sqliteRepository) Close() error {
	return r.db.Close()
}

func isDuplicateColumnError(err error) bool {
	return strings.Contains(err.Error(), "duplicate column name")
}

func (r *sqliteRepository) DB() *sql.DB {
	return r.db
}
