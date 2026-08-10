package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"point-api/internal/config"
	"point-api/internal/migrations"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// runMigrationsGuarded applies the pending migrations with a snapshot of the
// database taken first, and puts that snapshot back if they fail.
//
// It never retries: the migration that just failed would fail the same way on
// the next attempt, and each attempt would write again. The caller's job is to
// stop, having left the database exactly as it was before the upgrade — which
// makes "roll back to the previous image" a complete recovery rather than the
// first step of one.
//
// It reports whether the database was restored, so the caller can say so.
func runMigrationsGuarded(ctx context.Context, repo repository.Repository,
	sys *services.SystemService, cfg config.Config) (bool, error) {

	pending, err := migrations.Pending(ctx, repo)
	if err != nil {
		// Can't tell what's outstanding, so assume there is something. Being
		// wrong here costs one VACUUM INTO; the other way round costs the
		// safety net on the boot that needed it.
		slog.Warn("could not determine pending migrations — snapshotting anyway", "error", err)
		pending = []string{"unknown"}
	}
	if len(pending) == 0 {
		// Every step is recorded as applied, so Run has nothing to do. Skipping
		// the snapshot here is what keeps an ordinary restart free.
		return false, migrations.Run(ctx, repo)
	}

	var snapshot string
	if cfg.MigrationBackup {
		snapshot, err = sys.SnapshotForMigrations(ctx, cfg.MigrationBackupKeep)
		if err != nil {
			return false, fmt.Errorf("pre-migration snapshot failed — refusing to migrate without one "+
				"(set MIGRATION_BACKUP=false to override): %w", err)
		}
	} else {
		slog.Warn("MIGRATION_BACKUP is off — migrating without a snapshot; a failure here is not recoverable automatically")
	}

	slog.Info("applying database migrations",
		"count", len(pending), "first", pending[0], "snapshot", snapshot)

	runErr := migrations.Run(ctx, repo)
	if runErr == nil {
		return false, nil
	}
	if snapshot == "" {
		return false, runErr
	}

	// The file cannot be replaced under a live pool: SQLite would keep writing
	// through the old handle and replay its WAL over the restored snapshot.
	if err := repo.Close(); err != nil {
		slog.Error("error closing database before restore", "error", err)
	}
	if restoreErr := sys.RestoreDBSnapshot(snapshot, runErr); restoreErr != nil {
		return false, errors.Join(runErr, restoreErr, fmt.Errorf(
			"automatic restore failed — restore by hand: scripts/restore-db.sh %s", snapshot))
	}
	slog.Warn("restored the database to its pre-migration state", "snapshot", snapshot)
	return true, runErr
}
