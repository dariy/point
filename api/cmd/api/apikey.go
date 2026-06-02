package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"point-api/internal/repository"
)

func runCreateAPIKeyCLI(repo *repository.Repository, svcs *AppServices, name string) {
	ctx := context.Background()
	user, err := repo.GetFirstUser(ctx)
	if err != nil {
		log.Fatalf("failed to find a user. Run setup first: %v", err)
	}

	rawKey, _, err := svcs.ApiKey.GenerateAPIKey(ctx, user.ID, name, nil)
	if err != nil {
		log.Fatalf("failed to generate API key: %v", err)
	}

	fmt.Printf("Successfully created API key %q for user %q (ID: %d)\n", name, user.Username, user.ID)
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Printf("API Key: %s\n", rawKey)
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Println("CRITICAL: This key is never stored in raw form and cannot be recovered.")
	fmt.Println("Copy it now and store it securely (e.g., in your password manager).")
	os.Exit(0)
}
