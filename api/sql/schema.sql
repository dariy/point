-- Users
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(200) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    avatar_path VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);
CREATE INDEX idx_users_username ON users(username);

-- Posts
CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(200) NOT NULL UNIQUE,
    content TEXT NOT NULL,
    excerpt TEXT,
    formatter TEXT NOT NULL DEFAULT 'markdown',
    status TEXT NOT NULL DEFAULT 'draft',
    is_featured BOOLEAN NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    published_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thumbnail_path VARCHAR(500),
    meta_description VARCHAR(300),
    preview_token VARCHAR(64) UNIQUE,
    preview_expires_at DATETIME
);
CREATE INDEX idx_posts_slug ON posts(slug);
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_published_at ON posts(published_at);
CREATE INDEX idx_posts_preview_token ON posts(preview_token);

-- Tags
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    custom_url VARCHAR(200),
    is_important BOOLEAN NOT NULL DEFAULT 0,
    is_featured BOOLEAN NOT NULL DEFAULT 0,
    is_hidden BOOLEAN NOT NULL DEFAULT 0,
    is_hidden_posts BOOLEAN NOT NULL DEFAULT 0,
    include_in_breadcrumbs BOOLEAN NOT NULL DEFAULT 1,
    show_related_tags_as_children BOOLEAN NOT NULL DEFAULT 0,
    sort_order INTEGER,
    post_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tags_name ON tags(name);
CREATE INDEX idx_tags_slug ON tags(slug);

-- PostTags
CREATE TABLE post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
);

-- TagLocations
CREATE TABLE tag_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL UNIQUE REFERENCES tags(id) ON DELETE CASCADE,
    latitude FLOAT NOT NULL,
    longitude FLOAT NOT NULL
);
CREATE INDEX idx_tag_locations_tag_id ON tag_locations(tag_id);

-- TagRelationships (Hierarchy)
CREATE TABLE tag_relationships (
    parent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id)
);

-- Media
CREATE TABLE media (
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
    is_public INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_media_post_id ON media(post_id);
CREATE INDEX idx_media_uploaded_at ON media(uploaded_at);
CREATE INDEX idx_media_checksum ON media(checksum);

-- Sessions
CREATE TABLE sessions (
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
CREATE INDEX idx_sessions_token ON sessions(token);

-- MediaVisibilityLog — audit trail for is_public changes on media records
CREATE TABLE media_visibility_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    is_public  INTEGER NOT NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    post_id    INTEGER REFERENCES posts(id) ON DELETE SET NULL
);
CREATE INDEX idx_media_visibility_log_media_id ON media_visibility_log(media_id);

-- BlogSettings
CREATE TABLE blog_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    value_type VARCHAR(20) NOT NULL DEFAULT 'string',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
