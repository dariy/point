package repository

import (
	"context"
	"fmt"
	"time"

	"point-api/internal/models"
)

// DeleteSession removes a session and returns an error if not found.
func (r *sqliteRepository) DeleteSession(ctx context.Context, arg models.DeleteSessionParams) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ? AND user_id = ?`, arg.ID, arg.UserID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("session not found")
	}
	return nil
}

// DeleteSecret removes a secret by key (used to invalidate one-time tokens).
func (r *sqliteRepository) DeleteSecret(ctx context.Context, key string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM blog_secrets WHERE key = ?`, key)
	return err
}

// WebAuthnCredential represents a stored passkey credential
type WebAuthnCredential struct {
	ID             int64
	UserID         int64
	CredentialID   []byte
	PublicKey      []byte
	AAGUID         []byte
	SignCount      uint32
	BackupEligible bool
	BackupState    bool
	CreatedAt      time.Time
	LastUsedAt     *time.Time
}

func (r *sqliteRepository) CreateWebAuthnCredential(ctx context.Context, userID int64, credID, pubKey, aaguid []byte, signCount uint32, backupEligible, backupState bool) (*WebAuthnCredential, error) {
	const q = `
INSERT INTO webauthn_credentials (user_id, credential_id, public_key, aaguid, sign_count, backup_eligible, backup_state)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING id, created_at, last_used_at`

	var id int64
	var createdAt time.Time
	var lastUsedAt *time.Time
	err := r.db.QueryRowContext(ctx, q, userID, credID, pubKey, aaguid, signCount, backupEligible, backupState).Scan(&id, &createdAt, &lastUsedAt)
	if err != nil {
		return nil, err
	}

	return &WebAuthnCredential{
		ID:             id,
		UserID:         userID,
		CredentialID:   credID,
		PublicKey:      pubKey,
		AAGUID:         aaguid,
		SignCount:      signCount,
		BackupEligible: backupEligible,
		BackupState:    backupState,
		CreatedAt:      createdAt,
		LastUsedAt:     lastUsedAt,
	}, nil
}

func (r *sqliteRepository) GetWebAuthnCredentialsByUserID(ctx context.Context, userID int64) ([]WebAuthnCredential, error) {
	const q = `
SELECT id, user_id, credential_id, public_key, aaguid, sign_count, backup_eligible, backup_state, created_at, last_used_at
FROM webauthn_credentials
WHERE user_id = ?`

	rows, err := r.db.QueryContext(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var creds []WebAuthnCredential
	for rows.Next() {
		var cred WebAuthnCredential
		err := rows.Scan(&cred.ID, &cred.UserID, &cred.CredentialID, &cred.PublicKey, &cred.AAGUID, &cred.SignCount, &cred.BackupEligible, &cred.BackupState, &cred.CreatedAt, &cred.LastUsedAt)
		if err != nil {
			return nil, err
		}
		creds = append(creds, cred)
	}

	return creds, rows.Err()
}

func (r *sqliteRepository) GetWebAuthnCredentialByCredentialID(ctx context.Context, credID []byte) (*WebAuthnCredential, error) {
	const q = `
SELECT id, user_id, credential_id, public_key, aaguid, sign_count, backup_eligible, backup_state, created_at, last_used_at
FROM webauthn_credentials
WHERE credential_id = ?`

	row := r.db.QueryRowContext(ctx, q, credID)

	var cred WebAuthnCredential
	err := row.Scan(&cred.ID, &cred.UserID, &cred.CredentialID, &cred.PublicKey, &cred.AAGUID, &cred.SignCount, &cred.BackupEligible, &cred.BackupState, &cred.CreatedAt, &cred.LastUsedAt)
	if err != nil {
		return nil, err
	}

	return &cred, nil
}

func (r *sqliteRepository) DeleteWebAuthnCredentialByUserID(ctx context.Context, userID int64) error {
	const q = `DELETE FROM webauthn_credentials WHERE user_id = ?`
	_, err := r.db.ExecContext(ctx, q, userID)
	return err
}

// UpdateWebAuthnCredential updates the sign count, backup state, and last-used timestamp after a successful login.
func (r *sqliteRepository) UpdateWebAuthnCredential(ctx context.Context, credID []byte, signCount uint32, backupState bool) error {
	const q = `UPDATE webauthn_credentials SET sign_count = ?, backup_state = ?, last_used_at = CURRENT_TIMESTAMP WHERE credential_id = ?`
	_, err := r.db.ExecContext(ctx, q, signCount, backupState, credID)
	return err
}
