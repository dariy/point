package main

// Subcommand dispatch. `point` is one binary: with no subcommand it starts the
// server, otherwise it runs an operator command and exits. The commands
// themselves live one per file (setup.go, resetpassword.go, apikey.go); this
// file only decides which one the args name.

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"point-api/internal/config"
	"point-api/internal/repository"
)

// runEarlyCLI dispatches the subcommands that must run before the server's own
// startup path — each of them exits the process. It returns only when the args
// name no such command, i.e. when this invocation is meant to serve.
//
// `--create-api-key` is deliberately not here: it needs the fully wired
// services, so main dispatches it after initServices.
func runEarlyCLI() {
	if isSetupCmd(os.Args) {
		slog.Info("CLI Setup command detected. Initializing...")
		cfg, err := config.LoadConfig(".")
		if err != nil {
			slog.Error("setup: failed to load config", "error", err)
			os.Exit(1)
		}
		slog.Debug("config loaded", "DATABASE_URL", cfg.DatabaseURL, "STORAGE_PATH", cfg.StoragePath)

		repo, err := repository.NewRepository(cfg.DatabaseURL)
		if err != nil {
			slog.Error("setup: failed to initialize repository", "error", err)
			os.Exit(1)
		}
		svcs := initServices(&cfg, repo)
		slog.Info("Running CLI setup...")
		runSetupCLI(repo, svcs)
		os.Exit(0)
	}

	// Offline operator password recovery: `point reset-password ...`. Runs against
	// /data/point.db with no SMTP and no manual SQL (see resetpassword.go).
	if isResetPasswordCmd(os.Args) {
		slog.Info("CLI reset-password command detected. Initializing...")
		cfg, err := config.LoadConfig(".")
		if err != nil {
			slog.Error("reset-password: failed to load config", "error", err)
			os.Exit(1)
		}
		repo, err := repository.NewRepository(cfg.DatabaseURL)
		if err != nil {
			slog.Error("reset-password: failed to initialize repository", "error", err)
			os.Exit(1)
		}
		runResetPasswordCLI(repo)
		os.Exit(0)
	}

	for _, arg := range os.Args[1:] {
		if arg == "-v" || arg == "--version" || arg == "-version" {
			fmt.Println(Version)
			os.Exit(0)
		}
	}
}

// isSetupCmd reports whether the args invoke the setup wizard. It matches
// "setup" as a standalone arg OR as part of a merged string like "point setup",
// which is how a container ENTRYPOINT/command often arrives.
func isSetupCmd(args []string) bool {
	for _, arg := range args {
		trimmed := strings.Trim(arg, " \t\n\r\"'")
		if trimmed == "setup" || strings.HasPrefix(trimmed, "setup ") ||
			strings.Contains(trimmed, " setup ") || strings.HasSuffix(trimmed, " setup") {
			return true
		}
	}
	return false
}

// isResetPasswordCmd reports whether the args invoke the reset-password
// subcommand, tolerating merged args like "point reset-password" the same way
// setup detection does.
func isResetPasswordCmd(args []string) bool {
	for _, arg := range args {
		trimmed := strings.Trim(arg, " \t\n\r\"'")
		if trimmed == "reset-password" || strings.HasPrefix(trimmed, "reset-password ") ||
			strings.Contains(trimmed, " reset-password ") || strings.HasSuffix(trimmed, " reset-password") {
			return true
		}
	}
	return false
}

// parseCreateAPIKeyName scans args for --create-api-key=<name> or
// --create-api-key <name> and returns the name, or "" if not present.
func parseCreateAPIKeyName(args []string) string {
	for i, arg := range args {
		if val, ok := strings.CutPrefix(arg, "--create-api-key="); ok {
			return val
		}
		if arg == "--create-api-key" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}
