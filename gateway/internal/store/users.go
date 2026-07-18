package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// User is an authenticated end-user of this gateway instance.
type User struct {
	ID              string
	Email           string
	PasswordHash    string
	Status          string
	IsPlatformAdmin bool
	CreatedAt       int64
}

// ErrEmailTaken is returned by CreateUser when the email already exists.
var ErrEmailTaken = errors.New("email_taken")

// CreateUser inserts a user plus their 1:1 profile row.
func (s *Store) CreateUser(ctx context.Context, email, passwordHash, displayName, countryCode string) (*User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	id := NewID()
	t := now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE email = ?`, email).Scan(&n); err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, ErrEmailTaken
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO users (id, email, password_hash, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', ?, ?)`, id, email, passwordHash, t, t); err != nil {
		return nil, err
	}
	var cc any
	if countryCode != "" {
		cc = countryCode
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO profiles (id, display_name, country_code, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`, id, displayName, cc, t, t); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &User{ID: id, Email: email, PasswordHash: passwordHash, Status: "active", CreatedAt: t}, nil
}

func scanUser(row *sql.Row) (*User, error) {
	var u User
	var hash sql.NullString
	var admin int
	if err := row.Scan(&u.ID, &u.Email, &hash, &u.Status, &admin, &u.CreatedAt); err != nil {
		return nil, err
	}
	u.PasswordHash = hash.String
	u.IsPlatformAdmin = admin != 0
	return &u, nil
}

const userCols = `id, email, password_hash, status, is_platform_admin, created_at`

// UserByEmail looks a user up by (case-insensitive) email.
func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE email = ?`, email))
}

// UserByID looks a user up by id.
func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

// ---------------------------------------------------------------------------
// Refresh tokens (rotating, grouped by family for reuse detection)
// ---------------------------------------------------------------------------

// RefreshToken is one rotating refresh-token record.
type RefreshToken struct {
	ID         string
	FamilyID   string
	UserID     string
	TokenHash  string
	ExpiresAt  int64
	RevokedAt  sql.NullInt64
	ReplacedBy sql.NullString
}

// InsertRefreshToken records a new refresh token (hash only, never plaintext).
func (s *Store) InsertRefreshToken(ctx context.Context, id, familyID, userID, tokenHash string, expiresAt int64) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO refresh_tokens (id, family_id, user_id, token_hash, issued_at, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`, id, familyID, userID, tokenHash, t, expiresAt, t)
	return err
}

// RefreshTokenByHash fetches a refresh token record by its hash.
func (s *Store) RefreshTokenByHash(ctx context.Context, tokenHash string) (*RefreshToken, error) {
	var r RefreshToken
	err := s.db.QueryRowContext(ctx,
		`SELECT id, family_id, user_id, token_hash, expires_at, revoked_at, replaced_by
		 FROM refresh_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&r.ID, &r.FamilyID, &r.UserID, &r.TokenHash, &r.ExpiresAt, &r.RevokedAt, &r.ReplacedBy)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// RotateRefreshToken marks old as replaced and inserts its successor in the
// same family, atomically.
func (s *Store) RotateRefreshToken(ctx context.Context, oldID, newID, familyID, userID, newHash string, expiresAt int64) error {
	t := now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL`,
		t, newID, oldID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("refresh token %s already rotated", oldID)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO refresh_tokens (id, family_id, user_id, token_hash, issued_at, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`, newID, familyID, userID, newHash, t, expiresAt, t); err != nil {
		return err
	}
	return tx.Commit()
}

// RevokeRefreshFamily revokes every live token in a family (logout, or reuse
// detected).
func (s *Store) RevokeRefreshFamily(ctx context.Context, familyID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`,
		now(), familyID)
	return err
}
