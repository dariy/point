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
    user_id, token, ip_address, user_agent, expires_at
) VALUES (
    ?, ?, ?, ?, ?
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
