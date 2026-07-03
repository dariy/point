package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func runSetupCLI(repo repository.Repository, svcs *AppServices) {
	var blogTitle, authorName, email, password string

	// Collect all parts from all arguments (handles merged args like "setup --title=...")
	var allParts []string
	for i := 1; i < len(os.Args); i++ {
		trimmed := strings.Trim(os.Args[i], " \t\n\r\"'")
		if trimmed == "setup" {
			continue
		}
		trimmed = strings.TrimPrefix(trimmed, "setup ")

		// Split by spaces but respect quotes would be complex.
		// For now, let's just split by whitespace and see if it helps.
		// Note: this will break titles with spaces IF they are passed as a single string.
		// However, most container engines pass them as separate args if quoted.
		parts := strings.Fields(trimmed)
		allParts = append(allParts, parts...)
	}

	for _, arg := range allParts {
		if val, ok := strings.CutPrefix(arg, "--title="); ok {
			blogTitle = val
		} else if val, ok := strings.CutPrefix(arg, "--user="); ok {
			authorName = val
		} else if val, ok := strings.CutPrefix(arg, "--email="); ok {
			email = val
		} else if val, ok := strings.CutPrefix(arg, "--password="); ok {
			password = val
		}
	}

	if blogTitle == "" || authorName == "" || password == "" {
		slog.Error("missing required setup arguments", "title", blogTitle, "user", authorName, "password_set", password != "")
		fmt.Println("Usage: point setup --title=\"Blog Title\" --user=\"Author Name\" --email=\"email@example.com\" --password=\"SHA256_HASH\"")
		os.Exit(1)
	}

	slog.Info("Starting CLI setup", "blog", blogTitle, "user", authorName)
	ctx := context.Background()

	// Check if already setup
	_, err := repo.GetFirstUser(ctx)
	if err == nil {
		fmt.Println("Setup already complete.")
		return
	}

	hash, err := services.HashPassword(password)
	if err != nil {
		slog.Error("failed to hash password", "error", err)
		os.Exit(1)
	}

	_, err = repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "the_owner",
		Email:        email,
		PasswordHash: hash,
		DisplayName:  authorName,
	})
	if err != nil {
		slog.Error("failed to create user", "error", err)
		os.Exit(1)
	}

	seedSettings := []struct {
		key   string
		value string
		vType string
	}{
		{"blog_title", blogTitle, "string"},
		{"author_name", authorName, "string"},
		{"posts_per_page", "10", "integer"},
		{"default_theme", "dark", "string"},
		{"active_css_theme", "default", "string"},
		{"use_thumbnails", "true", "boolean"},
		{"show_view_counts", "false", "boolean"},

		{"tags_visibility", "hidden", "string"},
		{"enable_backup", "false", "boolean"},
	}

	for _, s := range seedSettings {
		if err := svcs.Settings.SetSetting(ctx, s.key, s.value, s.vType); err != nil {
			slog.Error("failed to seed setting", "key", s.key, "error", err)
			os.Exit(1)
		}
	}

	fmt.Println("Setup complete!")
}
