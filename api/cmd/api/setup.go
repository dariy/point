package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func runSetupCLI(repo *repository.Repository, svcs *AppServices) {
	var blogTitle, authorName, email, password string

	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		if strings.HasPrefix(arg, "--title=") {
			blogTitle = strings.TrimPrefix(arg, "--title=")
		} else if strings.HasPrefix(arg, "--user=") {
			authorName = strings.TrimPrefix(arg, "--user=")
		} else if strings.HasPrefix(arg, "--email=") {
			email = strings.TrimPrefix(arg, "--email=")
		} else if strings.HasPrefix(arg, "--password=") {
			password = strings.TrimPrefix(arg, "--password=")
		}
	}

	if blogTitle == "" || authorName == "" || password == "" {
		fmt.Println("Usage: point setup --title=\"Blog Title\" --user=\"Author Name\" --email=\"email@example.com\" --password=\"SHA256_HASH\"")
		os.Exit(1)
	}

	ctx := context.Background()

	// Check if already setup
	_, err := repo.GetFirstUser(ctx)
	if err == nil {
		fmt.Println("Setup already complete.")
		return
	}

	hash, err := services.HashPassword(password)
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}

	_, err = repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "the_owner",
		Email:        email,
		PasswordHash: hash,
		DisplayName:  authorName,
	})
	if err != nil {
		log.Fatalf("failed to create user: %v", err)
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
		{"show_tag_cloud", "true", "boolean"},
		{"map_mode", "off", "string"},
		{"enable_backup", "false", "boolean"},
	}

	for _, s := range seedSettings {
		if err := svcs.Settings.SetSetting(ctx, s.key, s.value, s.vType); err != nil {
			log.Fatalf("failed to seed setting %s: %v", s.key, err)
		}
	}

	fmt.Println("Setup complete!")
}
