package main

import (
	"context"
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
	if err := execCreateAPIKey(svcs, name, rawBytes); err != nil {
		log.Fatalf("%v", err)
	}
	os.Exit(0)
}

// execCreateAPIKey authenticates with the given raw password and creates an API key.
// Extracted from runCreateAPIKeyCLI so it can be tested without a real terminal.
func execCreateAPIKey(svcs *AppServices, name string, password []byte) error {
	ctx := context.Background()

	user, err := svcs.Auth.AuthenticatePassword(ctx, "", password)
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}

	rawKey, _, err := svcs.ApiKey.GenerateAPIKey(ctx, user.ID, name, nil)
	if err != nil {
		return fmt.Errorf("failed to generate API key: %w", err)
	}

	fmt.Printf("Successfully created API key %q for user %q (ID: %d)\n", name, user.Username, user.ID)
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Printf("API Key: %s\n", rawKey)
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Println("CRITICAL: This key is never stored in raw form and cannot be recovered.")
	fmt.Println("Copy it now and store it securely (e.g., in your password manager).")
	return nil
}
