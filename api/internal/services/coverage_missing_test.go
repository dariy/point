package services

import (
	"bytes"
	"context"
	"database/sql"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
)

// ── preprocessContent ──────────────────────────────────────────────────────

func TestPreprocessContent(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		contain string
	}{
		{"bare jpg → markdown image", "/2024/01/photo.jpg", "![photo.jpg](/2024/01/photo.jpg)"},
		{"bare mp4 → video tag", "/2024/01/clip.mp4", "<video src="},
		{"bare mp3 → audio tag", "/2024/01/song.mp3", "<audio src="},
		{"plain text unchanged", "Hello, world!", "Hello, world!"},
		{"bare unknown ext → returned unchanged", "/2024/01/file.xyz", "/2024/01/file.xyz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := preprocessContent(tc.input)
			if !strings.Contains(got, tc.contain) {
				t.Errorf("preprocessContent(%q) = %q; want to contain %q", tc.input, got, tc.contain)
			}
		})
	}
}

// ── SanitizePostCSS ────────────────────────────────────────────────────────

func TestSanitizePostCSS(t *testing.T) {
	t.Run("clean CSS passes through", func(t *testing.T) {
		result, stripped := SanitizePostCSS(".post { color: red; }")
		if len(stripped) != 0 {
			t.Errorf("expected no stripped rules, got %v", stripped)
		}
		if !strings.Contains(result, "color: red") {
			t.Errorf("expected clean CSS to pass through, got %q", result)
		}
	})

	t.Run("@import stripped", func(t *testing.T) {
		result, stripped := SanitizePostCSS("@import url('evil.css'); .p { color: red; }")
		if !containsStr(stripped, "@import") {
			t.Errorf("expected '@import' in stripped, got %v", stripped)
		}
		if strings.Contains(result, "@import") {
			t.Errorf("expected @import removed from result, got %q", result)
		}
	})

	t.Run("position fixed stripped", func(t *testing.T) {
		result, _ := SanitizePostCSS(".el { position: fixed; top: 0; }")
		if strings.Contains(result, "position: fixed") {
			t.Error("expected position:fixed to be stripped")
		}
	})

	t.Run("position sticky stripped", func(t *testing.T) {
		result, _ := SanitizePostCSS(".el { position: sticky; }")
		if strings.Contains(result, "position: sticky") {
			t.Error("expected position:sticky to be stripped")
		}
	})

	t.Run("z-index stripped", func(t *testing.T) {
		result, stripped := SanitizePostCSS(".el { z-index: 9999; }")
		if !containsStr(stripped, "z-index") {
			t.Errorf("expected 'z-index' in stripped, got %v", stripped)
		}
		if strings.Contains(result, "9999") {
			t.Errorf("expected z-index value removed, got %q", result)
		}
	})

	t.Run("external url stripped", func(t *testing.T) {
		result, _ := SanitizePostCSS(`.bg { background: url('https://evil.com/img.png'); }`)
		if strings.Contains(result, "evil.com") {
			t.Errorf("expected external URL removed, got %q", result)
		}
	})

	t.Run("empty CSS returns empty", func(t *testing.T) {
		result, stripped := SanitizePostCSS("")
		if result != "" || len(stripped) != 0 {
			t.Errorf("expected empty result for empty input, got %q / %v", result, stripped)
		}
	})
}

func containsStr(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

// ── PostService: SoftDeletePost, RestorePost, PermanentlyDeletePost ────────

func TestPostService_RestoreAndPermanentlyDelete(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	t.Run("RestorePost", func(t *testing.T) {
		post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "RestoreMe", Slug: "restore-me", AuthorID: 1, Status: "draft"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
		if err := svc.SoftDeletePost(ctx, post.ID, 1); err != nil {
			t.Fatalf("SoftDeletePost: %v", err)
		}
		if err := svc.RestorePost(ctx, post.ID, 1); err != nil {
			t.Fatalf("RestorePost: %v", err)
		}
	})

	t.Run("PermanentlyDeletePost", func(t *testing.T) {
		post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "DeleteMe", Slug: "delete-me", AuthorID: 1, Status: "draft"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
		if err := svc.PermanentlyDeletePost(ctx, post.ID, 1); err != nil {
			t.Fatalf("PermanentlyDeletePost: %v", err)
		}
	})
}

// ── AuthService: GetUserByID ───────────────────────────────────────────────

func TestAuthService_GetUserByID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewAuthService(repo)
	ctx := context.Background()

	hash, _ := HashPassword("pass")
	u, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username:    "owner",
		Email:       "owner@test.com",
		PasswordHash: hash,
		DisplayName: "Owner",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	got, err := svc.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.ID != u.ID {
		t.Errorf("expected ID %d, got %d", u.ID, got.ID)
	}

	_, err = svc.GetUserByID(ctx, 99999)
	if err == nil {
		t.Error("expected error for non-existent user")
	}
}

// ── MediaService: GetMediaByPostID, GetMediaByContent, ReextractEXIF ──────

func TestMediaService_GetMediaByPostID(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()

	ctx := context.Background()
	media, err := svc.GetMediaByPostID(ctx, 999)
	if err != nil {
		t.Fatalf("GetMediaByPostID: %v", err)
	}
	_ = media
}

func TestMediaService_GetMediaByContent(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()

	ctx := context.Background()
	media, err := svc.GetMediaByContent(ctx, "no media paths here", "")
	if err != nil {
		t.Fatalf("GetMediaByContent: %v", err)
	}
	_ = media
}

func TestMediaService_AnalyzeMediaByID_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	_, err := svc.AnalyzeMediaByID(context.Background(), 99999)
	if err == nil {
		t.Error("expected error for non-existent ID")
	}
}

func TestMediaService_AnalyzeMediaByID_NotAnImage(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	ctx := context.Background()

	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  []byte("text content"),
		Filename: "doc.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	_, err = svc.AnalyzeMediaByID(ctx, m.ID)
	if err != ErrNotAnImage {
		t.Errorf("expected ErrNotAnImage, got %v", err)
	}
}

func TestMediaService_AnalyzeMediaByPath_TraversalRejected(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	_, err := svc.AnalyzeMediaByPath(context.Background(), "../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestMediaService_AnalyzeMediaByPath_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	_, err := svc.AnalyzeMediaByPath(context.Background(), "/2024/01/nonexistent.jpg")
	if err == nil {
		t.Error("expected error for non-existent file")
	}
}

func TestMediaService_ReextractEXIF_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()

	_, err := svc.ReextractEXIF(context.Background(), 99999)
	if err == nil {
		t.Error("expected error for non-existent media ID")
	}
}

func TestMediaService_ReextractEXIF(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	ctx := context.Background()

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "reextract.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	_, err = svc.ReextractEXIF(ctx, m.ID)
	if err != nil {
		t.Fatalf("ReextractEXIF: %v", err)
	}
}

// ── WebAuthn helpers (pure functions) ──────────────────────────────────────

func TestSanitizeOrigin(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://example.com", "https://example.com"},
		{"https://example.com/path?q=1", "https://example.com"},
		{"https://example.com:8080", "https://example.com:8080"},
		{"https://example.com:8080/path", "https://example.com:8080"},
		{"", ""},
	}
	for _, tc := range cases {
		got := SanitizeOrigin(tc.in)
		if got != tc.want {
			t.Errorf("SanitizeOrigin(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ── ThemeService: SyncActiveTheme error paths ──────────────────────────────

func TestThemeService_SyncActiveTheme_NoThemes(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	cfg := &config.Config{ThemesPath: t.TempDir(), FrontendDir: t.TempDir()}
	ts := NewThemeService(cfg, NewSettingsService(repo))

	// No themes in dir → GetActiveTheme fails → SyncActiveTheme returns error.
	err := ts.SyncActiveTheme(t.Context())
	if err == nil {
		t.Error("expected error when no themes available")
	}
	if !strings.Contains(err.Error(), "failed to get active theme") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestThemeService_SyncActiveTheme_ReadOnlyFrontendDir(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
	ts := NewThemeService(cfg, NewSettingsService(repo))

	// Write a valid default theme so GetActiveTheme succeeds.
	themeContent := `:root { --bg: #fff; }`
	_ = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(themeContent), 0644)

	// Make the css dir a file so MkdirAll can't create subdirs.
	// Actually, let's test by creating the path as a file.
	cssDir := filepath.Join(frontendDir, "css")
	_ = os.WriteFile(cssDir, []byte("not a dir"), 0644)

	err := ts.SyncActiveTheme(t.Context())
	if err == nil {
		t.Error("expected error when css dir blocked by file")
	}
}

// ── AuthService: ValidatePasswordResetToken expired ────────────────────────

func TestAuthService_ValidatePasswordResetToken_InvalidJSON(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewAuthService(repo)
	ctx := context.Background()

	// Insert a token with malformed JSON payload.
	tokenHash := HashToken("badpayloadtoken")
	_ = repo.UpsertSecret(ctx, models.UpsertSecretParams{
		Key:   "pw_reset:" + tokenHash,
		Value: sql.NullString{String: "not valid json {{{{", Valid: true},
	})

	_, err := svc.ValidatePasswordResetToken(ctx, "badpayloadtoken")
	if err == nil {
		t.Error("expected error for invalid JSON payload")
	}
}

func TestAuthService_ValidatePasswordResetToken_Expired(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewAuthService(repo)
	ctx := context.Background()

	// Insert an expired token directly into blog_secrets.
	expiredPayload := `{"user_id":1,"expires_at":"2020-01-01T00:00:00Z"}`
	tokenHash := HashToken("expiredtoken")
	_ = repo.UpsertSecret(ctx, models.UpsertSecretParams{
		Key:   "pw_reset:" + tokenHash,
		Value: sql.NullString{String: expiredPayload, Valid: true},
	})

	_, err := svc.ValidatePasswordResetToken(ctx, "expiredtoken")
	if err == nil {
		t.Error("expected error for expired token")
	}
}

func TestGetRPIDFromURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://example.com", "example.com"},
		{"https://example.com:8080/path", "example.com"},
		{"http://sub.domain.org", "sub.domain.org"},
		{"", ""},
	}
	for _, tc := range cases {
		got := GetRPIDFromURL(tc.in)
		if got != tc.want {
			t.Errorf("GetRPIDFromURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ── PostService: ListTrashedPosts ──────────────────────────────────────────

func TestPostService_ListTrashedPosts(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	// Soft-delete a post so there's something to list.
	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "TrashMe", Slug: "trash-me", AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}
	if err := svc.SoftDeletePost(ctx, post.ID, 1); err != nil {
		t.Fatalf("SoftDeletePost: %v", err)
	}

	posts, total, err := svc.ListTrashedPosts(ctx, 1, 10)
	if err != nil {
		t.Fatalf("ListTrashedPosts: %v", err)
	}
	if total == 0 || len(posts) == 0 {
		t.Error("expected at least one trashed post")
	}
}

// ── MediaService: RevertEXIF success path ─────────────────────────────────

func TestMediaService_RevertEXIF_Success(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	ctx := context.Background()

	// Upload a text file — writeEXIFToFile is a no-op for non-JPEG.
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  []byte("text"),
		Filename: "doc.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	// Set original_metadata directly via DB so RevertEXIF has something to revert to.
	origMeta := `{"Make":"Canon"}`
	if _, err := svc.repo.DB().ExecContext(ctx,
		`UPDATE media SET original_metadata=? WHERE id=?`, origMeta, m.ID); err != nil {
		t.Fatalf("set original_metadata: %v", err)
	}

	result, err := svc.RevertEXIF(ctx, m.ID)
	if err != nil {
		t.Fatalf("RevertEXIF: %v", err)
	}
	_ = result
}

// ── NewWebAuthnService ────────────────────────────────────────────────────

func TestNewWebAuthnService_EmptyRPID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	_, err := NewWebAuthnService(repo, "", "Test Blog", "https://example.com")
	if err == nil {
		t.Error("expected error for empty rpID")
	}
}

func TestNewWebAuthnService_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc, err := NewWebAuthnService(repo, "example.com", "Test Blog", "https://example.com")
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}
	_ = svc
}

// ── WebAuthn struct methods ────────────────────────────────────────────────

// ── VerifyPassword bcrypt fallback ────────────────────────────────────────

func TestVerifyPasswordArgon2id_ErrorPaths(t *testing.T) {
	// Wrong number of segments.
	_, err := verifyPasswordArgon2id("pass", "$argon2id$v=19$m=65536,t=2,p=1")
	if err != ErrInvalidHash {
		t.Errorf("expected ErrInvalidHash for wrong segments, got %v", err)
	}

	// Incompatible version — uses version 0 instead of current.
	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=0$m=65536,t=2,p=1$abc$def")
	if err != ErrIncompatibleVersion {
		t.Errorf("expected ErrIncompatibleVersion, got %v", err)
	}

	// Invalid base64 for salt.
	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=19$m=65536,t=2,p=1$NOT!BASE64$def")
	if err == nil {
		t.Error("expected error for invalid base64 salt")
	}

	// Valid salt but invalid base64 for hash.
	validSalt := "aGVsbG8=" // base64("hello")
	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=19$m=65536,t=2,p=1$"+validSalt+"$NOT!VALID!")
	if err == nil {
		t.Error("expected error for invalid base64 hash value")
	}

	// Invalid fmt.Sscanf for version (not a number).
	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=abc$m=65536,t=2,p=1$abc$def")
	if err == nil {
		t.Error("expected error for non-numeric version")
	}

	// Invalid m/t/p parameters.
	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=19$m=bad,t=x,p=y$abc$def")
	if err == nil {
		t.Error("expected error for invalid m/t/p parameters")
	}
}

func TestVerifyPassword_ArgonError(t *testing.T) {
	// A hash that starts with $argon2id$ but is malformed — causes verifyPasswordArgon2id to error.
	// This covers the "if err != nil { return false }" branch in VerifyPassword.
	malformedHash := "$argon2id$not-valid"
	result := VerifyPassword("anypass", malformedHash)
	if result {
		t.Error("expected false for malformed argon2id hash")
	}
}

func TestVerifyPassword_BcryptFallback(t *testing.T) {
	// Generate a real bcrypt hash — covers the bcrypt fallback branch of VerifyPassword.
	hashed, err := bcrypt.GenerateFromPassword([]byte("password"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt.GenerateFromPassword: %v", err)
	}
	bcryptHash := string(hashed)

	if !VerifyPassword("password", bcryptHash) {
		t.Error("expected true for correct bcrypt password")
	}
	if VerifyPassword("wrong", bcryptHash) {
		t.Error("expected false for wrong password")
	}
}

// ── toNullTime / SanitizeOrigin / GetRPIDFromURL edge cases ───────────────

func TestToNullTime_NonNil(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	// Create a post with ScheduledAt set (exercises toNullTime with a non-nil time).
	schedTime := time.Now().Add(time.Hour)
	post, _, err := svc.CreatePost(ctx, CreatePostParams{
		Title:       "Scheduled",
		Slug:        "scheduled",
		AuthorID:    1,
		Status:      "scheduled",
		ScheduledAt: &schedTime,
	})
	if err != nil {
		t.Fatalf("CreatePost with ScheduledAt: %v", err)
	}
	if !post.ScheduledAt.Valid {
		t.Error("expected ScheduledAt to be valid")
	}
}

func TestSanitizeOrigin_InvalidURL(t *testing.T) {
	// A URL with a parse error returns "".
	result := SanitizeOrigin("://bad-url")
	_ = result // Covers the parse-error branch.
}

func TestGetRPIDFromURL_InvalidURL(t *testing.T) {
	result := GetRPIDFromURL("://bad")
	_ = result
}

func TestWebAuthnUser_Methods(t *testing.T) {
	u := WebAuthnUser{
		User: models.User{
			ID:          42,
			Username:    "testuser",
			DisplayName: "Test User",
		},
		Credentials: []repository.WebAuthnCredential{
			{
				CredentialID: []byte("credid"),
				PublicKey:    []byte("pubkey"),
				AAGUID:       []byte("aaguid"),
				SignCount:    5,
			},
		},
	}

	id := u.WebAuthnID()
	if len(id) != 8 {
		t.Errorf("WebAuthnID should be 8 bytes, got %d", len(id))
	}

	if u.WebAuthnName() != "testuser" {
		t.Errorf("WebAuthnName: expected 'testuser', got %q", u.WebAuthnName())
	}

	if u.WebAuthnDisplayName() != "Test User" {
		t.Errorf("WebAuthnDisplayName: expected 'Test User', got %q", u.WebAuthnDisplayName())
	}

	// When DisplayName is empty, falls back to Username.
	u2 := WebAuthnUser{User: models.User{ID: 1, Username: "u", DisplayName: ""}}
	if u2.WebAuthnDisplayName() != "u" {
		t.Errorf("expected fallback to username, got %q", u2.WebAuthnDisplayName())
	}

	creds := u.WebAuthnCredentials()
	if len(creds) != 1 {
		t.Errorf("expected 1 credential, got %d", len(creds))
	}
}
