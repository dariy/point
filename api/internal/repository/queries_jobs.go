package repository

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Job is one row of the jobs table. Times are unix seconds.
type Job struct {
	ID          int64
	Kind        string
	Payload     string
	State       string
	Attempts    int64
	MaxAttempts int64
	NextRunAt   int64
	LastError   string
	CreatedAt   int64
	UpdatedAt   int64
}

const jobColumns = `id, kind, payload, state, attempts, max_attempts, next_run_at, last_error, created_at, updated_at`

func scanJob(row interface{ Scan(...any) error }) (Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.Kind, &j.Payload, &j.State, &j.Attempts, &j.MaxAttempts,
		&j.NextRunAt, &j.LastError, &j.CreatedAt, &j.UpdatedAt)
	return j, err
}

func (r *sqliteRepository) InsertJob(ctx context.Context, kind, payload string, maxAttempts int64, runAt time.Time) (int64, error) {
	now := time.Now().Unix()
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO jobs (kind, payload, state, max_attempts, next_run_at, created_at, updated_at)
		 VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
		kind, payload, maxAttempts, runAt.Unix(), now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ClaimDueJob moves the oldest due queued job to running, counts the attempt,
// and returns it. It returns (nil, nil) when no job is due.
func (r *sqliteRepository) ClaimDueJob(ctx context.Context, now time.Time) (*Job, error) {
	row := r.db.QueryRowContext(ctx,
		`UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ?1
		 WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND next_run_at <= ?1 ORDER BY next_run_at, id LIMIT 1)
		 RETURNING `+jobColumns, now.Unix())
	j, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &j, nil
}

// FinishJob sets the terminal or retry state of a running job.
func (r *sqliteRepository) FinishJob(ctx context.Context, id int64, state, lastError string, nextRunAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE jobs SET state = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
		state, lastError, nextRunAt.Unix(), time.Now().Unix(), id)
	return err
}

// RequeueRunningJobs sets every running job back to queued. A running row at
// startup belongs to a process that stopped before it finished.
func (r *sqliteRepository) RequeueRunningJobs(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE jobs SET state = 'queued', updated_at = ? WHERE state = 'running'`, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (r *sqliteRepository) GetJob(ctx context.Context, id int64) (Job, error) {
	return scanJob(r.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id = ?`, id))
}
