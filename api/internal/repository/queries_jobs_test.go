package repository

import (
	"context"
	"testing"
	"time"
)

func TestRepository_Jobs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	// The migrations package owns this DDL; it imports repository, so the
	// test creates the same table here.
	if _, err := repo.DB().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS jobs (
		id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
		state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
		max_attempts INTEGER NOT NULL DEFAULT 5, next_run_at INTEGER NOT NULL,
		last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}

	now := time.Unix(1_700_000_000, 0)
	later, err := repo.InsertJob(ctx, "k", `{}`, 3, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	due, err := repo.InsertJob(ctx, "k", `{"a":1}`, 3, now)
	if err != nil {
		t.Fatal(err)
	}

	j, err := repo.ClaimDueJob(ctx, now)
	if err != nil || j == nil || j.ID != due || j.State != "running" || j.Attempts != 1 || j.Payload != `{"a":1}` {
		t.Fatalf("claim: %+v %v", j, err)
	}
	if j, err := repo.ClaimDueJob(ctx, now); err != nil || j != nil {
		t.Fatalf("second claim: %+v %v", j, err)
	}

	if n, err := repo.RequeueRunningJobs(ctx); err != nil || n != 1 {
		t.Fatalf("requeue: %d %v", n, err)
	}
	if err := repo.FinishJob(ctx, due, "failed", "boom", now); err != nil {
		t.Fatal(err)
	}
	got, err := repo.GetJob(ctx, due)
	if err != nil || got.State != "failed" || got.LastError != "boom" {
		t.Fatalf("get: %+v %v", got, err)
	}
	if got, _ := repo.GetJob(ctx, later); got.State != "queued" {
		t.Fatalf("later job state %q", got.State)
	}
}
