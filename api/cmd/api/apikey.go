package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"point-api/internal/plugins"

	"golang.org/x/term"
)

func runCreateAPIKeyCLI(svcs *AppServices, name string) {
	fmt.Fprint(os.Stderr, "Password: ")
	rawBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr) // newline after the hidden input
	if err != nil {
		slog.Error("failed to read password", "error", err)
		os.Exit(1)
	}
	if len(rawBytes) == 0 {
		slog.Error("password is required")
		os.Exit(1)
	}
	if err := execCreateAPIKey(svcs, name, rawBytes); err != nil {
		slog.Error("failed to create API key", "error", err)
		os.Exit(1)
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

	// The key is inert while the api-keys plugin is off, and it ships off. Say
	// so here rather than let the admin discover it as an unexplained 401.
	if all, err := svcs.Settings.Snapshot(ctx); err == nil && !plugins.IsEnabled("api-keys", all) {
		fmt.Println()
		fmt.Println("NOTE: the api-keys plugin is disabled, so this key will not authenticate.")
		fmt.Println("Enable it on the Plugins page (Admin -> Plugins -> API Keys) to use it.")
	}
	return nil
}
