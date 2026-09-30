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

	// The admin view: list by state, count per state, retry a failed job.
	if err := repo.FinishJob(ctx, due, "failed", "boom", now); err != nil {
		t.Fatal(err)
	}
	listed, err := repo.ListJobs(ctx, []string{"failed"}, 10)
	if err != nil || len(listed) != 1 || listed[0].ID != due {
		t.Fatalf("ListJobs failed = %+v, %v", listed, err)
	}
	if none, err := repo.ListJobs(ctx, nil, 10); err != nil || none != nil {
		t.Fatalf("ListJobs no states = %+v, %v", none, err)
	}
	counts, err := repo.CountJobsByState(ctx)
	if err != nil || counts["failed"] != 1 || counts["queued"] != 1 {
		t.Fatalf("CountJobsByState = %v, %v", counts, err)
	}
	if ok, err := repo.RetryFailedJob(ctx, later, now); err != nil || ok {
		t.Fatalf("retry of a queued job: ok=%v err=%v", ok, err)
	}
	if ok, err := repo.RetryFailedJob(ctx, due, now); err != nil || !ok {
		t.Fatalf("retry: ok=%v err=%v", ok, err)
	}
	if got, _ := repo.GetJob(ctx, due); got.State != "queued" || got.Attempts != 0 {
		t.Fatalf("after retry: %+v", got)
	}
}

func TestRepository_JobsDelete(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	if _, err := repo.DB().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS jobs (
		id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
		state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
		max_attempts INTEGER NOT NULL DEFAULT 5, next_run_at INTEGER NOT NULL,
		last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	// One old and one new row in each state.
	cutoff := time.Unix(1_700_000_000, 0)
	ids := map[string]int64{}
	for _, st := range []string{"queued", "running", "done", "failed"} {
		for _, age := range []string{"old", "new"} {
			at := cutoff.Add(time.Hour)
			if age == "old" {
				at = cutoff.Add(-time.Hour)
			}
			res, err := repo.DB().ExecContext(ctx,
				`INSERT INTO jobs (kind, state, next_run_at, created_at, updated_at) VALUES ('k', ?, 0, ?, ?)`,
				st, at.Unix(), at.Unix())
			if err != nil {
				t.Fatal(err)
			}
			ids[st+"/"+age], _ = res.LastInsertId()
		}
	}
	exists := func(key string) bool {
		_, err := repo.GetJob(ctx, ids[key])
		return err == nil
	}

	if n, err := repo.DeleteDoneJobsBefore(ctx, cutoff); err != nil || n != 1 {
		t.Fatalf("DeleteDoneJobsBefore = %d, %v", n, err)
	}
	for key := range ids {
		if want := key != "done/old"; exists(key) != want {
			t.Fatalf("after prune: %s exists = %v", key, !want)
		}
	}

	if n, err := repo.DeleteFailedJobs(ctx); err != nil || n != 2 {
		t.Fatalf("DeleteFailedJobs = %d, %v", n, err)
	}
	for _, key := range []string{"queued/old", "queued/new", "running/old", "running/new", "done/new"} {
		if !exists(key) {
			t.Fatalf("after clear: %s is gone", key)
		}
	}
	if exists("failed/old") || exists("failed/new") {
		t.Fatal("failed rows remain after clear")
	}
}
