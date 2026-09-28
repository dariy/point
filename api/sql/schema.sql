-- Users
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(200) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    avatar_path VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Posts
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(200) NOT NULL UNIQUE,
    content TEXT NOT NULL,
    excerpt TEXT,
    formatter TEXT NOT NULL DEFAULT 'markdown',
    status TEXT NOT NULL DEFAULT 'draft',
    type TEXT NOT NULL DEFAULT 'post',
    is_featured BOOLEAN NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    published_at DATETIME,
    scheduled_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thumbnail_path VARCHAR(500),
    -- Denormalized preview URL for list/grid views, derived from thumbnail_path
    -- or the first media in content at write time, so list queries need not load
    -- the full content body. Kept in sync by PostService.Create/UpdatePost.
    media_url VARCHAR(500),
    meta_description VARCHAR(300),
    preview_token VARCHAR(64) UNIQUE,
    preview_expires_at DATETIME,
    deleted_at DATETIME,
    css TEXT NOT NULL DEFAULT '',
    immersive_mode TEXT NOT NULL DEFAULT 'auto',
    instagram_share BOOLEAN NOT NULL DEFAULT 0,
    instagram_status TEXT NOT NULL DEFAULT 'none',
    instagram_media_id TEXT,
    instagram_published_at DATETIME,
    instagram_error TEXT,
    instagram_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_preview_token ON posts(preview_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_instagram_id ON posts(instagram_id) WHERE instagram_id IS NOT NULL;
-- The feed's sort key, restricted to the rows a feed can show. All three
-- columns are needed, and in this order: whatever the ORDER BY leaves to a temp
-- B-tree is most of what the index was meant to remove. id is spelled out
-- because it is the tiebreak the queries name, and DESC because the rowid an
-- index carries implicitly is ascending.
CREATE INDEX IF NOT EXISTS idx_posts_live ON posts(published_at DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL;
-- deleted_at is NULL for all but a handful of rows, so an index over the whole
-- column is one SQLite will happily seek for `deleted_at IS NULL` — reading
-- nearly every post through it and then sorting the feed by hand. Partial on
-- IS NOT NULL, it holds only the trash and cannot be chosen for the feed.
CREATE INDEX IF NOT EXISTS idx_posts_trashed ON posts(deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- Full-text search over posts. Search used to be five leading-wildcard LIKEs
-- over title, slug and content, which is unindexable by construction: every
-- post body read off disk, per keystroke in the admin search box. FTS5 turns
-- that into an index lookup.
--
-- The index is external-content (content='posts'): it stores the inverted index
-- and nothing else, so posts stays the single source of truth and no column is
-- duplicated. The price is that SQLite will not keep it in step by itself —
-- the three triggers below are what does, and they must stay in step with the
-- column list here. Mirrored in internal/migrations for databases that predate
-- this file's version of it.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    title, slug, content,
    content='posts',
    content_rowid='id',
    tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, slug, content)
    VALUES (new.id, new.title, new.slug, new.content);
END;
CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, slug, content)
    VALUES ('delete', old.id, old.title, old.slug, old.content);
END;
-- OF title, slug, content: an unqualified UPDATE trigger would reindex a whole
-- post body every time a view counter ticked. A soft delete is an UPDATE of
-- deleted_at, so trashed posts stay in the index — the queries all carry
-- `deleted_at IS NULL` anyway, and restoring one costs nothing.
CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE OF title, slug, content ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, slug, content)
    VALUES ('delete', old.id, old.title, old.slug, old.content);
    INSERT INTO posts_fts(rowid, title, slug, content)
    VALUES (new.id, new.title, new.slug, new.content);
END;

-- Tags
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'tag',
    hidden BOOLEAN NOT NULL DEFAULT 0,
    hides_posts BOOLEAN NOT NULL DEFAULT 0,
    nav_order INTEGER,
    in_breadcrumbs BOOLEAN NOT NULL DEFAULT 0,
    show_related BOOLEAN NOT NULL DEFAULT 0,
    in_ancestor_flyout BOOLEAN NOT NULL DEFAULT 1,
    latitude REAL,
    longitude REAL,
    post_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug);

-- PostTags
CREATE TABLE IF NOT EXISTS post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
);
-- The PRIMARY KEY indexes post_id first, but every list query looks post_tags
-- up by tag_id alone — the tag filter, and the hides_posts exclusion that runs
-- on every public page. post_id trails so the lookup stays inside the index
-- instead of fetching each matching row from the table.
CREATE INDEX IF NOT EXISTS idx_post_tags_tag_id_post_id ON post_tags(tag_id, post_id);

-- TagRelationships (Hierarchy)
CREATE TABLE IF NOT EXISTS tag_relationships (
    parent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    sort_order INTEGER,
    PRIMARY KEY (parent_id, child_id)
);

-- Media
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename VARCHAR(500) NOT NULL,
    original_path VARCHAR(1000) NOT NULL,
    thumbnail_path VARCHAR(1000),
    file_type TEXT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    file_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checksum VARCHAR(64) NOT NULL UNIQUE,
    alt_text VARCHAR(500),
    caption VARCHAR(1000),
    metadata TEXT,
    original_metadata TEXT,
    is_public INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_post_id ON media(post_id);
CREATE INDEX IF NOT EXISTS idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_media_checksum ON media(checksum);
CREATE INDEX IF NOT EXISTS idx_media_original_path ON media(original_path);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(200) NOT NULL UNIQUE,
    ip_address VARCHAR(45) NOT NULL,
    user_agent VARCHAR(500) NOT NULL,
    location VARCHAR(200),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    last_activity DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- MediaVisibilityLog — audit trail for is_public changes on media records
CREATE TABLE IF NOT EXISTS media_visibility_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    is_public  INTEGER NOT NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    post_id    INTEGER REFERENCES posts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_media_visibility_log_media_id ON media_visibility_log(media_id);

-- BlogSettings
CREATE TABLE IF NOT EXISTS blog_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    value_type VARCHAR(20) NOT NULL DEFAULT 'string',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- BlogSecrets
CREATE TABLE IF NOT EXISTS blog_secrets (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- WebAuthn credentials (passkeys)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   BLOB NOT NULL UNIQUE,
    public_key      BLOB NOT NULL,
    aaguid          BLOB NOT NULL,
    sign_count      INTEGER NOT NULL DEFAULT 0,
    backup_eligible INTEGER NOT NULL DEFAULT 0,
    backup_state    INTEGER NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at    DATETIME
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,           -- human label, e.g. "claude-mcp"
    key_hash    VARCHAR(64) NOT NULL UNIQUE,     -- sha256(raw key), hex
    prefix      VARCHAR(16) NOT NULL,            -- first chars for display, e.g. "point_pat_Abc"
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    expires_at  DATETIME,                        -- NULL = never
    revoked_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- MCP OAuth authorization server state.
-- Persisted so a restart does not invalidate every issued token and force each
-- connected MCP client through the browser login flow again. Authorization
-- codes are deliberately absent: they live two minutes and are redeemed within
-- seconds, so the provider keeps them in memory.
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id     VARCHAR(64) PRIMARY KEY,        -- issued by dynamic registration
    redirect_uris TEXT NOT NULL,                  -- JSON array, matched exactly at authorize time
    registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash VARCHAR(64) PRIMARY KEY,           -- sha256(token), hex — never the token itself
    client_id  VARCHAR(64) NOT NULL,
    expires_at DATETIME,                          -- NULL = never
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at ON oauth_tokens(expires_at);
