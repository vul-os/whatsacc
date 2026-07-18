package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// adminClaimedKey is the one-shot admin-claim burn flag, mirroring the
// Postgres backend's instance_settings key of the same name.
const adminClaimedKey = "admin_claimed"

// InstanceSettingGet returns the raw JSON value for a setting key, or
// ErrNotFound.
func (s *Store) InstanceSettingGet(ctx context.Context, key string) (json.RawMessage, error) {
	var v string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM instance_settings WHERE key = ?`, key).Scan(&v); err != nil {
		return nil, err
	}
	return json.RawMessage(v), nil
}

// InstanceSettingSet upserts a setting. The platform-admin gate lives in the
// HTTP layer (SQLite has no per-role SECURITY DEFINER seam to hide behind).
func (s *Store) InstanceSettingSet(ctx context.Context, key string, value any, updatedBy string) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	t := now()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO instance_settings (key, value, updated_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value,
		     updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		key, string(raw), nullable(updatedBy), t, t)
	return err
}

// PlatformAdminExists reports whether any platform admin exists.
func (s *Store) PlatformAdminExists(ctx context.Context) (bool, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE is_platform_admin = 1`).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// AdminClaimState reports (adminExists OR burn-flag-set) — "claimed" in the
// backend's GET /admin/claim sense.
func (s *Store) AdminClaimState(ctx context.Context) (claimed bool, err error) {
	exists, err := s.PlatformAdminExists(ctx)
	if err != nil {
		return false, err
	}
	if exists {
		return true, nil
	}
	_, err = s.InstanceSettingGet(ctx, adminClaimedKey)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, err
}

// ClaimPlatformAdmin is the atomic one-shot first-run claim, porting
// app.claim_platform_admin: exactly one caller can ever win, and the
// mechanism burns permanently once any platform admin exists. Returns false
// (never errors) when the claim is closed or the user is not active.
//
// Atomicity: the check-and-promote runs inside one transaction on the store's
// single serialized SQLite connection (Postgres used an advisory xact lock).
func (s *Store) ClaimPlatformAdmin(ctx context.Context, userID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE is_platform_admin = 1`).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM instance_settings WHERE key = ?`, adminClaimedKey).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE users SET is_platform_admin = 1, updated_at = ?
		 WHERE id = ? AND status = 'active'`, now(), userID)
	if err != nil {
		return false, err
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		return false, nil
	}

	burn := fmt.Sprintf(`{"claimed_by":%q,"claimed_at":%d}`, userID, now())
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO instance_settings (key, value, updated_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`, adminClaimedKey, burn, userID, now(), now()); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}
