package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// runResetPasswordCLI implements `point reset-password --user=<username> --password=<plaintext>`.
//
// This is the offline operator recovery path (no SMTP, no manual SQL): it resets
// a user's password directly against /data/point.db from inside the instance
// container. If --user is omitted it targets the single/first user.
//
// Unlike `setup` (which takes a client-side SHA-256 hash), this accepts the
// PLAINTEXT password and applies the same sha256-hex pre-hash the web login does
// before Argon2id, so the stored value is Argon2id(sha256hex(plaintext)) and the
// new password verifies through the normal login path (see auth_service.go
// Authenticate / AuthenticatePassword). It also clears the user's sessions,
// matching the recovery semantics of the web ResetPassword flow.
func runResetPasswordCLI(repo repository.Repository) {
	var username, password string

	// Collect flag parts across all args, mirroring runSetupCLI's handling of
	// merged args like "reset-password --user=...".
	var allParts []string
	for i := 1; i < len(os.Args); i++ {
		trimmed := strings.Trim(os.Args[i], " \t\n\r\"'")
		if trimmed == "reset-password" {
			continue
		}
		trimmed = strings.TrimPrefix(trimmed, "reset-password ")
		allParts = append(allParts, strings.Fields(trimmed)...)
	}

	for _, arg := range allParts {
		if val, ok := strings.CutPrefix(arg, "--user="); ok {
			username = val
		} else if val, ok := strings.CutPrefix(arg, "--password="); ok {
			password = val
		}
	}

	if password == "" {
		fmt.Println("Usage: point reset-password --user=\"username\" --password=\"PLAINTEXT_PASSWORD\"")
		fmt.Println("  --user      username to reset (optional; defaults to the first/only user)")
		fmt.Println("  --password  the new plaintext password (pre-hashed internally, unlike setup)")
		os.Exit(1)
	}

	ctx := context.Background()

	// Resolve the target user: by username, or the single/first user.
	var user models.User
	var err error
	if username != "" {
		user, err = repo.GetUserByUsername(ctx, username)
	} else {
		user, err = repo.GetFirstUser(ctx)
	}
	if err != nil {
		if username != "" {
			slog.Error("reset-password: user not found", "user", username, "error", err)
		} else {
			slog.Error("reset-password: no user found (has setup run?)", "error", err)
		}
		os.Exit(1)
	}

	// Apply the same sha256-hex pre-hash the web login/reset performs client-side,
	// then Argon2id, so the result verifies via the normal login path.
	// codeql[go/weak-crypto] - false positive: pre-hash to avoid truncation; securely hashed with Argon2id next
	preHash := sha256.Sum256([]byte(password))
	hash, err := services.HashPassword(hex.EncodeToString(preHash[:]))
	if err != nil {
		slog.Error("reset-password: failed to hash password", "error", err)
		os.Exit(1)
	}

	if err := repo.UpdateUserPassword(ctx, models.UpdateUserPasswordParams{
		PasswordHash: hash,
		ID:           user.ID,
	}); err != nil {
		slog.Error("reset-password: failed to update password", "error", err)
		os.Exit(1)
	}

	// Recovery semantics: kill every existing session (ID 0 matches none), so any
	// stale or compromised session can't survive the reset.
	_ = repo.DeleteUserSessions(ctx, models.DeleteUserSessionsParams{UserID: user.ID, ID: 0})

	fmt.Printf("Password reset for user %q (id %d). All sessions cleared.\n", user.Username, user.ID)
}
