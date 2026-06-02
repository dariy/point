package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
)

func runCreateAPIKeyCLI(svcs *AppServices, name, password string) {
	if password == "" {
		log.Fatalf("--password is required to create an API key")
	}

	ctx := context.Background()

	// Match the web frontend: passwords are verified as SHA-256(raw) so the
	// raw password is never stored or transmitted in plain text.
	h := sha256.Sum256([]byte(password))
	user, err := svcs.Auth.Authenticate(ctx, "", hex.EncodeToString(h[:]))
	if err != nil {
		log.Fatalf("authentication failed: %v", err)
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
