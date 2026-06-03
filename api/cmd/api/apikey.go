package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"

	"golang.org/x/term"
)

func runCreateAPIKeyCLI(svcs *AppServices, name string) {
	fmt.Fprint(os.Stderr, "Password: ")
	rawBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr) // newline after the hidden input
	if err != nil {
		log.Fatalf("failed to read password: %v", err)
	}
	if len(rawBytes) == 0 {
		log.Fatalf("password is required")
	}

	ctx := context.Background()

	// Match the web frontend: SHA-256 of the raw password before Authenticate.
	h := sha256.Sum256(rawBytes)
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
