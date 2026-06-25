package repository

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
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
	ListPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.ListPostsParams) ([]models.Post, error)
	CountPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.CountPostsParams) (int64, error)
	ListPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool, limit, offset int64) ([]models.Post, error)
	CountPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool) (int64, error)
	GetPostByPreviewToken(ctx context.Context, token string) (models.Post, error)
	GetPostNavigation(ctx context.Context, postID int64, publicOnly bool) (prev, next *PostNavItem, err error)
	ReplacePostContentPath(ctx context.Context, oldPath, newPath string) (int64, error)
	UpdatePostThumbnailPath(ctx context.Context, oldPath, newPath string) (int64, error)
	ListPublishedPostStubs(ctx context.Context) ([]PostStub, error)
	ListPostNodesForGraph(ctx context.Context, publishedOnly bool) ([]GraphPostNode, error)
	GetPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error)
	CountPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error)
	GetPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error)
	CountPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error)
	GetAllPublishedPostContents(ctx context.Context) ([]PostContentRow, error)
	GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error)
	GetExistingInstagramIDs(ctx context.Context, ids []string) ([]string, error)
	SetPostInstagramID(ctx context.Context, postID int64, instagramID string) error
	SetPostMediaURL(ctx context.Context, postID int64, mediaURL string) error
	BackfillPostMediaURLs(ctx context.Context) error

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

func NewRepository(dbURL string) (Repository, error) {
	db, err := sql.Open("sqlite", dbURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Limit to a single connection so PRAGMAs apply to every query and
	// concurrent writers serialize at the Go level instead of racing at SQLite.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	// Set busy timeout to handle concurrent access
	if _, err := db.Exec("PRAGMA busy_timeout = 5000;"); err != nil {
		return nil, fmt.Errorf("failed to set busy timeout: %w", err)
	}

	// Optimize read performance
	if _, err := db.Exec("PRAGMA mmap_size = 30000000000;"); err != nil {
		return nil, fmt.Errorf("failed to set mmap_size: %w", err)
	}
	if _, err := db.Exec("PRAGMA cache_size = -200000;"); err != nil {
		return nil, fmt.Errorf("failed to set cache_size: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Enable foreign keys
	if _, err := db.Exec("PRAGMA foreign_keys = ON;"); err != nil {
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Enable WAL mode and verify the database is writable.
	// If either fails, the data directory has wrong permissions and we
	// must exit now rather than letting the server start in a broken state
	// where reads succeed but every write (e.g. first-run setup) silently fails.
	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode = WAL;").Scan(&journalMode); err != nil {
		return nil, fmt.Errorf("database is not writable — check permissions on the data directory: %w", err)
	}

	// Check if the database needs initialization.
	// We check for multiple core tables to detect partially-initialized databases.
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts', 'tags', 'blog_settings');").Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("failed to check database schema: %w", err)
	}

	if count < 4 {
		slog.Info("Initializing new database with schema...")
		tx, err := db.Begin()
		if err != nil {
			return nil, fmt.Errorf("failed to begin transaction: %w", err)
		}
		defer func() { _ = tx.Rollback() }()

		// Use SplitSeq for efficient iteration without allocating a full slice
		for stmt := range strings.SplitSeq(pointsql.SchemaSQL, ";") {
			trimmed := strings.TrimSpace(stmt)
			if trimmed == "" {
				continue
			}
			if _, err := tx.Exec(trimmed); err != nil {
				return nil, fmt.Errorf("failed to execute schema statement: %w\nStatement: %s", err, trimmed)
			}
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("failed to commit schema transaction: %w", err)
		}
		slog.Info("Database schema initialized successfully.")
	} else {
		// Run migrations for existing databases.
		// SQLite returns an error if the column already exists — that's safe to ignore.
		if _, err := db.Exec(`ALTER TABLE posts ADD COLUMN css TEXT NOT NULL DEFAULT ''`); err != nil {
			if !isDuplicateColumnError(err) {
				return nil, fmt.Errorf("migration failed (add posts.css): %w", err)
			}
		}
		if _, err := db.Exec(`ALTER TABLE posts ADD COLUMN immersive_mode TEXT NOT NULL DEFAULT 'auto'`); err != nil {
			if !isDuplicateColumnError(err) {
				return nil, fmt.Errorf("migration failed (add posts.immersive_mode): %w", err)
			}
		}
		// Instagram cross-posting columns (point-xq28).
		for _, m := range []struct {
			name string
			stmt string
		}{
			{"instagram_share", `ALTER TABLE posts ADD COLUMN instagram_share BOOLEAN NOT NULL DEFAULT 0`},
			{"instagram_status", `ALTER TABLE posts ADD COLUMN instagram_status TEXT NOT NULL DEFAULT 'none'`},
			{"instagram_media_id", `ALTER TABLE posts ADD COLUMN instagram_media_id TEXT`},
			{"instagram_published_at", `ALTER TABLE posts ADD COLUMN instagram_published_at DATETIME`},
			{"instagram_error", `ALTER TABLE posts ADD COLUMN instagram_error TEXT`},
			{"instagram_id", `ALTER TABLE posts ADD COLUMN instagram_id TEXT`},
		} {
			if _, err := db.Exec(m.stmt); err != nil {
				if !isDuplicateColumnError(err) {
					return nil, fmt.Errorf("migration failed (add posts.%s): %w", m.name, err)
				}
			}
		}
	}

	queries := models.New(db)
	repo := &sqliteRepository{
		Queries: queries,
		db:      db,
	}

	if count >= 4 {
		// Run migrations for existing databases.
		if err := repo.ApplyMigration(context.Background(), "add_api_keys", `
CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    key_hash    VARCHAR(64) NOT NULL UNIQUE,
    prefix      VARCHAR(16) NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    expires_at  DATETIME,
    revoked_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`); err != nil {
			return nil, fmt.Errorf("migration failed (add_api_keys): %w", err)
		}

		if err := repo.ApplyMigration(context.Background(), "posts_instagram_id_unique_idx",
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_instagram_id ON posts(instagram_id) WHERE instagram_id IS NOT NULL`); err != nil {
			return nil, fmt.Errorf("migration failed (posts_instagram_id_unique_idx): %w", err)
		}

		// Denormalized list-preview URL so list/grid queries no longer read the
		// full content body. Add the column, then backfill existing rows.
		if err := repo.ApplyMigration(context.Background(), "posts_media_url",
			`ALTER TABLE posts ADD COLUMN media_url VARCHAR(500)`); err != nil {
			return nil, fmt.Errorf("migration failed (posts_media_url): %w", err)
		}
		if err := repo.BackfillPostMediaURLs(context.Background()); err != nil {
			return nil, fmt.Errorf("migration failed (backfill posts.media_url): %w", err)
		}
	}

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
