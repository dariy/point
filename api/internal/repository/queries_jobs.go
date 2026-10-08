package repository

import (
	"context"
	"database/sql"
	"encoding/json"
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

// ListJobs returns jobs in the given states, newest first, at most limit rows.
func (r *sqliteRepository) ListJobs(ctx context.Context, states []string, limit int) ([]Job, error) {
	if len(states) == 0 {
		return nil, nil
	}
	raw, err := json.Marshal(states)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+jobColumns+` FROM jobs WHERE state IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT ?`,
		string(raw), limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// CountJobsByState returns the number of jobs in each state.
func (r *sqliteRepository) CountJobsByState(ctx context.Context) (map[string]int64, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT state, COUNT(*) FROM jobs GROUP BY state`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]int64{}
	for rows.Next() {
		var s string
		var n int64
		if err := rows.Scan(&s, &n); err != nil {
			return nil, err
		}
		out[s] = n
	}
	return out, rows.Err()
}

// RetryFailedJob sets a failed job back to queued with no attempts, due at
// runAt. It reports false when no failed job has that id.
func (r *sqliteRepository) RetryFailedJob(ctx context.Context, id int64, runAt time.Time) (bool, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE jobs SET state = 'queued', attempts = 0, next_run_at = ?, updated_at = ? WHERE id = ? AND state = 'failed'`,
		runAt.Unix(), time.Now().Unix(), id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// DeleteDoneJobsBefore removes done jobs last updated before the given time.
// It never touches queued, running or failed rows.
func (r *sqliteRepository) DeleteDoneJobsBefore(ctx context.Context, before time.Time) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM jobs WHERE state = 'done' AND updated_at < ?`, before.Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DeleteFailedJobs removes every failed job. Only the operator calls this.
func (r *sqliteRepository) DeleteFailedJobs(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx, `DELETE FROM jobs WHERE state = 'failed'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
