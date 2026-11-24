package main

// `point verify-backup [<archive>]` runs the restore check from the command
// line: it unpacks a backup into a temporary directory under <data>/backups,
// opens its database read-only, and compares it with the archive's manifest.
// It does not open the live database, so it also runs while the server runs.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"point-api/internal/config"
	"point-api/internal/services"
)

const verifyBackupCmd = "verify-backup"

// parseVerifyBackupArgs reports whether args invoke verify-backup and returns
// the archive name that follows it ("" means the newest backup). Merged args
// such as "point verify-backup x.tar.gz" are split the same way.
func parseVerifyBackupArgs(args []string) (bool, string) {
	var fields []string
	for _, arg := range args {
		fields = append(fields, strings.Fields(strings.Trim(arg, " \t\n\r\"'"))...)
	}
	for i, f := range fields {
		if f == verifyBackupCmd {
			if i+1 < len(fields) {
				return true, fields[i+1]
			}
			return true, ""
		}
	}
	return false, ""
}

// runVerifyBackupCLI prints the result as JSON and returns the exit code:
// 0 for a pass, 1 for a fail or an error.
func runVerifyBackupCLI(sys *services.SystemService, filename string) int {
	res, err := sys.VerifyBackup(context.Background(), filename)
	if err != nil {
		fmt.Fprintln(os.Stderr, "verify-backup:", err)
		return 1
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(out))
	if !res.Passed {
		return 1
	}
	return 0
}

func runVerifyBackupFromArgs(args []string) {
	ok, filename := parseVerifyBackupArgs(args)
	if !ok {
		return
	}
	cfg, err := config.LoadConfig(".")
	if err != nil {
		fmt.Fprintln(os.Stderr, "verify-backup: failed to load config:", err)
		os.Exit(1)
	}
	os.Exit(runVerifyBackupCLI(services.NewSystemService(nil, cfg.StoragePath, cfg.DatabaseURL), filename))
}
