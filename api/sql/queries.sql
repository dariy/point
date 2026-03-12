-- name: GetUser :one
SELECT * FROM users
WHERE id = ? LIMIT 1;

-- name: GetFirstUser :one
SELECT * FROM users
ORDER BY id LIMIT 1;

-- name: GetUserByUsername :one
SELECT * FROM users
WHERE username = ? LIMIT 1;

-- name: GetUserByEmail :one
SELECT * FROM users
WHERE email = ? LIMIT 1;

-- name: CreateUser :one
INSERT INTO users (
    username, email, password_hash, display_name, avatar_path
) VALUES (
    ?, ?, ?, ?, ?
)
RETURNING *;

-- name: UpdateUserLogin :exec
UPDATE users
SET last_login = CURRENT_TIMESTAMP
WHERE id = ?;

-- name: CreateSession :one
INSERT INTO sessions (
    user_id, token, ip_address, user_agent, expires_at, created_at, last_activity
) VALUES (
    ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
RETURNING *;

-- name: GetSessionByToken :one
SELECT s.*, u.username, u.display_name
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.token = ? LIMIT 1;

-- name: DeleteSession :exec
DELETE FROM sessions
WHERE id = ? AND user_id = ?;

-- name: DeleteUserSessions :exec
DELETE FROM sessions
WHERE user_id = ? AND id != ?;

-- name: GetUserSessions :many
SELECT * FROM sessions
WHERE user_id = ?
ORDER BY last_activity DESC;

-- name: UpdateSessionActivity :exec
UPDATE sessions
SET last_activity = CURRENT_TIMESTAMP
WHERE id = ?;

-- name: DeleteExpiredSessions :exec
DELETE FROM sessions
WHERE expires_at < CURRENT_TIMESTAMP;

-- name: UpdateUserPassword :exec
UPDATE users
SET password_hash = ?
WHERE id = ?;

-- SETTINGS

-- name: GetSetting :one
SELECT * FROM blog_settings
WHERE key = ? LIMIT 1;

-- name: ListSettings :many
SELECT * FROM blog_settings;

-- name: UpdateSetting :one
INSERT INTO blog_settings (key, value, value_type, updated_at)
VALUES (?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    value_type = excluded.value_type,
    updated_at = CURRENT_TIMESTAMP
RETURNING *;

-- name: DeleteSetting :exec
DELETE FROM blog_settings
WHERE key = ?;

-- POSTS

-- name: GetPost :one
SELECT p.*, u.username as author_username, u.display_name as author_display_name, u.avatar_path as author_avatar
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.id = ? LIMIT 1;

-- name: GetPostBySlug :one
SELECT p.*, u.username as author_username, u.display_name as author_display_name, u.avatar_path as author_avatar
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.slug = ? LIMIT 1;

-- name: ListPosts :many
WITH RECURSIVE effectively_hidden_posts_tags(id) AS (
    SELECT id FROM tags WHERE is_hidden_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr
    JOIN effectively_hidden_posts_tags ehpt ON tr.parent_id = ehpt.id
)
SELECT p.*, u.username as author_username, u.display_name as author_display_name, u.avatar_path as author_avatar
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE 
    (CASE WHEN sqlc.arg('status_filter') THEN p.status = sqlc.arg('status') ELSE 1=1 END)
    AND (CASE WHEN sqlc.arg('featured_filter') THEN p.is_featured = 1 ELSE 1=1 END)
    AND (CASE 
        WHEN sqlc.arg('include_drafts') THEN 1=1 
        WHEN sqlc.arg('include_hidden') THEN p.status IN ('published', 'hidden')
        ELSE p.status = 'published' 
    END)
    AND (sqlc.arg('include_hidden') OR NOT EXISTS (
        SELECT 1 FROM post_tags pt 
        WHERE pt.post_id = p.id AND pt.tag_id IN (SELECT id FROM effectively_hidden_posts_tags)
    ))
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountPosts :one
WITH RECURSIVE effectively_hidden_posts_tags(id) AS (
    SELECT id FROM tags WHERE is_hidden_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr
    JOIN effectively_hidden_posts_tags ehpt ON tr.parent_id = ehpt.id
)
SELECT COUNT(*) FROM posts p
WHERE 
    (CASE WHEN sqlc.arg('status_filter') THEN p.status = sqlc.arg('status') ELSE 1=1 END)
    AND (CASE WHEN sqlc.arg('featured_filter') THEN p.is_featured = 1 ELSE 1=1 END)
    AND (CASE 
        WHEN sqlc.arg('include_drafts') THEN 1=1 
        WHEN sqlc.arg('include_hidden') THEN p.status IN ('published', 'hidden')
        ELSE p.status = 'published' 
    END)
    AND (sqlc.arg('include_hidden') OR NOT EXISTS (
        SELECT 1 FROM post_tags pt 
        WHERE pt.post_id = p.id AND pt.tag_id IN (SELECT id FROM effectively_hidden_posts_tags)
    ));

-- name: CreatePost :one
INSERT INTO posts (
    title, slug, content, excerpt, formatter, status, is_featured, author_id, thumbnail_path, meta_description, view_count, published_at, created_at, updated_at
) VALUES (
    sqlc.arg('title'), sqlc.arg('slug'), sqlc.arg('content'), sqlc.arg('excerpt'), sqlc.arg('formatter'), sqlc.arg('status'), sqlc.arg('is_featured'), sqlc.arg('author_id'), sqlc.arg('thumbnail_path'), sqlc.arg('meta_description'), 0, (CASE WHEN sqlc.arg('status') = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
RETURNING *;

-- name: UpdatePost :one
UPDATE posts
SET title = sqlc.arg('title'), slug = sqlc.arg('slug'), content = sqlc.arg('content'), excerpt = sqlc.arg('excerpt'), formatter = sqlc.arg('formatter'), status = sqlc.arg('status'), is_featured = sqlc.arg('is_featured'), thumbnail_path = sqlc.arg('thumbnail_path'), meta_description = sqlc.arg('meta_description'),
    published_at = (CASE WHEN sqlc.arg('status') = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END),
    updated_at = CURRENT_TIMESTAMP
WHERE id = sqlc.arg('id') AND author_id = sqlc.arg('author_id')
RETURNING *;

-- name: DeletePost :exec
DELETE FROM posts
WHERE id = ? AND author_id = ?;

-- name: IncrementPostViewCount :exec
UPDATE posts
SET view_count = view_count + 1
WHERE id = ?;

-- name: PublishPost :one
UPDATE posts
SET status = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
WHERE id = ?
RETURNING *;

-- name: WithdrawPost :one
UPDATE posts
SET status = 'draft', updated_at = CURRENT_TIMESTAMP
WHERE id = ?
RETURNING *;

-- name: SetPostPreviewToken :exec
UPDATE posts
SET preview_token = ?, preview_expires_at = ?
WHERE id = ?;

-- TAGS

-- name: GetTag :one
SELECT * FROM tags
WHERE id = ? LIMIT 1;

-- name: GetTagBySlug :one
SELECT * FROM tags
WHERE slug = ? LIMIT 1;

-- name: ListTags :many
SELECT * FROM tags
WHERE (CASE WHEN sqlc.arg('important_only_filter') THEN is_important = 1 ELSE 1=1 END)
AND (CASE WHEN sqlc.arg('include_empty_filter') THEN 1=1 ELSE post_count > 0 END)
ORDER BY sort_order ASC, name ASC;

-- name: CreateTag :one
INSERT INTO tags (
    name, slug, description, custom_url, is_important, is_featured, is_hidden, is_hidden_posts, include_in_breadcrumbs, show_related_tags_as_children, sort_order, post_count, created_at
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP
)
RETURNING *;

-- name: UpdateTag :one
UPDATE tags
SET name = ?, slug = ?, description = ?, custom_url = ?, is_important = ?, is_featured = ?, is_hidden = ?, is_hidden_posts = ?, include_in_breadcrumbs = ?, show_related_tags_as_children = ?, sort_order = ?
WHERE id = ?
RETURNING *;

-- name: DeleteTag :exec
DELETE FROM tags
WHERE id = ?;

-- name: GetTagsForPost :many
SELECT t.* FROM tags t
JOIN post_tags pt ON t.id = pt.tag_id
WHERE pt.post_id = ?
ORDER BY t.name ASC;

-- name: AddTagToPost :exec
INSERT OR IGNORE INTO post_tags (post_id, tag_id)
VALUES (?, ?);

-- name: RemoveTagFromPost :exec
DELETE FROM post_tags
WHERE post_id = ? AND tag_id = ?;

-- name: ClearPostTags :exec
DELETE FROM post_tags
WHERE post_id = ?;

-- name: GetPostsByTag :many
WITH RECURSIVE effectively_hidden_posts_tags(id) AS (
    SELECT id FROM tags WHERE is_hidden_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr
    JOIN effectively_hidden_posts_tags ehpt ON tr.parent_id = ehpt.id
)
SELECT p.*, u.username as author_username, u.display_name as author_display_name, u.avatar_path as author_avatar
FROM posts p
JOIN users u ON p.author_id = u.id
JOIN post_tags pt ON p.id = pt.post_id
WHERE pt.tag_id = sqlc.arg('tag_id')
AND (CASE 
    WHEN sqlc.arg('include_drafts') THEN 1=1
    WHEN sqlc.arg('published_only_filter') THEN p.status = 'published' 
    ELSE p.status IN ('published', 'hidden') 
END)
AND (sqlc.arg('include_drafts') OR NOT (sqlc.arg('published_only_filter')) OR NOT EXISTS (
    SELECT 1 FROM post_tags pt2 
    WHERE pt2.post_id = p.id AND pt2.tag_id IN (SELECT id FROM effectively_hidden_posts_tags)
))
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountPostsByTag :one
WITH RECURSIVE effectively_hidden_posts_tags(id) AS (
    SELECT id FROM tags WHERE is_hidden_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr
    JOIN effectively_hidden_posts_tags ehpt ON tr.parent_id = ehpt.id
)
SELECT COUNT(*) FROM posts p
JOIN post_tags pt ON p.id = pt.post_id
WHERE pt.tag_id = sqlc.arg('tag_id')
AND (CASE 
    WHEN sqlc.arg('include_drafts') THEN 1=1
    WHEN sqlc.arg('published_only_filter') THEN p.status = 'published' 
    ELSE p.status IN ('published', 'hidden') 
END)
AND (sqlc.arg('include_drafts') OR NOT (sqlc.arg('published_only_filter')) OR NOT EXISTS (
    SELECT 1 FROM post_tags pt2 
    WHERE pt2.post_id = p.id AND pt2.tag_id IN (SELECT id FROM effectively_hidden_posts_tags)
));

-- name: UpdateTagPostCount :exec
UPDATE tags
SET post_count = (
    SELECT COUNT(*) FROM post_tags
    JOIN posts ON post_tags.post_id = posts.id
    WHERE post_tags.tag_id = tags.id AND posts.status != 'draft'
)
WHERE tags.id = ?;

-- name: UpdateAllTagPostCounts :exec
UPDATE tags
SET post_count = (
    SELECT COUNT(*) FROM post_tags
    JOIN posts ON post_tags.post_id = posts.id
    WHERE tag_id = tags.id AND posts.status != 'draft'
);

-- HIERARCHY

-- name: GetTagParents :many
SELECT t.* FROM tags t
JOIN tag_relationships tr ON t.id = tr.parent_id
WHERE tr.child_id = ?;

-- name: GetTagChildren :many
SELECT t.* FROM tags t
JOIN tag_relationships tr ON t.id = tr.child_id
WHERE tr.parent_id = ?;

-- name: AddTagRelationship :exec
INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
VALUES (?, ?);

-- name: RemoveTagRelationship :exec
DELETE FROM tag_relationships
WHERE parent_id = ? AND child_id = ?;

-- name: ClearTagRelationships :exec
DELETE FROM tag_relationships
WHERE parent_id = ? OR child_id = ?;

-- MEDIA

-- name: GetMedia :one
SELECT * FROM media
WHERE id = ? LIMIT 1;

-- name: GetMediaByChecksum :one
SELECT * FROM media
WHERE checksum = ? LIMIT 1;

-- name: ListMedia :many
SELECT * FROM media
WHERE (CASE WHEN sqlc.arg('type_filter') THEN file_type = sqlc.arg('file_type') ELSE 1=1 END)
ORDER BY uploaded_at DESC
LIMIT sqlc.arg('limit') OFFSET sqlc.arg('offset');

-- name: CountMedia :one
SELECT COUNT(*) FROM media
WHERE (CASE WHEN sqlc.arg('type_filter') THEN file_type = sqlc.arg('file_type') ELSE 1=1 END);

-- name: CreateMedia :one
INSERT INTO media (
    filename, original_path, thumbnail_path, file_type, mime_type, file_size, width, height, post_id, checksum, alt_text, caption, uploaded_at
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
RETURNING *;

-- name: UpdateMedia :one
UPDATE media
SET alt_text = ?, caption = ?, post_id = ?
WHERE id = ?
RETURNING *;

-- name: UpdateMediaFilename :one
UPDATE media
SET filename = ?, original_path = ?, thumbnail_path = ?
WHERE id = ?
RETURNING *;

-- name: DeleteMedia :exec
DELETE FROM media
WHERE id = ?;

-- name: GetStorageUsage :one
SELECT SUM(file_size) FROM media;

-- name: GetMediaByPostID :many
SELECT * FROM media
WHERE post_id = ?
ORDER BY uploaded_at ASC;
