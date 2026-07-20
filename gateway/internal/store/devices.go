package store

import (
	"context"
	"database/sql"
	"errors"
)

// Pairing errors — the backend's claim vocabulary (devices.ts + proto/pairing.md).
var (
	ErrDeviceAlreadyPaired = errors.New("device_already_paired")
	ErrClaimExpired        = errors.New("claim_expired")
)

// DeviceDetail is the devices listing shape (claim token hash never leaves
// the store; claim_expires_at is shown so admins can see pending claims).
type DeviceDetail struct {
	ID             string
	LocationID     string
	Label          string
	Status         string
	PublicKey      string
	PairedAt       sql.NullInt64
	LastSeenAt     sql.NullInt64
	ClaimExpiresAt sql.NullInt64
	CreatedAt      int64
}

// CreateDeviceWithClaim inserts an unpaired device carrying a hashed,
// expiring claim token (proto/pairing.md rule 1: random ≥128-bit, stored
// hashed, single-use, TTL default 1h max 7d — bounds enforced in the handler).
func (s *Store) CreateDeviceWithClaim(ctx context.Context, accountID, locationID, label, tokenHash string, expiresAt int64) (*DeviceDetail, error) {
	if _, err := s.LocationByID(ctx, accountID, locationID); err != nil {
		return nil, err
	}
	t := now()
	id := NewID()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (id, location_id, label, claim_token_hash, claim_expires_at, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'unpaired', ?, ?)`,
		id, locationID, nullable(label), tokenHash, expiresAt, t, t)
	if err != nil {
		return nil, err
	}
	return &DeviceDetail{ID: id, LocationID: locationID, Label: label, Status: "unpaired",
		ClaimExpiresAt: sql.NullInt64{Int64: expiresAt, Valid: true}, CreatedAt: t}, nil
}

// DevicesByAccountDetailed lists devices across the account's locations
// (optionally one location), newest first — GET /v1/devices.
func (s *Store) DevicesByAccountDetailed(ctx context.Context, accountID, locationID string) ([]DeviceDetail, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT d.id, d.location_id, coalesce(d.label,''), d.status, coalesce(d.public_key,''),
		        d.paired_at, d.last_seen_at, d.claim_expires_at, d.created_at
		 FROM devices d JOIN locations l ON l.id = d.location_id
		 WHERE l.account_id = ? AND (? = '' OR d.location_id = ?)
		 ORDER BY d.created_at DESC`, accountID, locationID, locationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceDetail
	for rows.Next() {
		var d DeviceDetail
		if err := rows.Scan(&d.ID, &d.LocationID, &d.Label, &d.Status, &d.PublicKey,
			&d.PairedAt, &d.LastSeenAt, &d.ClaimExpiresAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// RedeemClaim burns a claim token: the FIRST redeem wins (the token hash is
// cleared in the same transaction on the store's single serialized
// connection), the controller public key is enrolled, and the device goes
// active. Fail modes: ErrNotFound (unknown/already-burned token),
// ErrDeviceAlreadyPaired, ErrClaimExpired.
func (s *Store) RedeemClaim(ctx context.Context, tokenHash, controllerPubkey string) (*DeviceDetail, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var d DeviceDetail
	var pairedAt sql.NullInt64
	var claimExp sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT id, location_id, coalesce(label,''), status, paired_at, claim_expires_at
		 FROM devices WHERE claim_token_hash = ?`, tokenHash).
		Scan(&d.ID, &d.LocationID, &d.Label, &d.Status, &pairedAt, &claimExp)
	if err != nil {
		return nil, err // ErrNotFound: unknown or already-burned token
	}
	if pairedAt.Valid {
		return nil, ErrDeviceAlreadyPaired
	}
	if claimExp.Valid && claimExp.Int64 <= now() {
		return nil, ErrClaimExpired
	}
	t := now()
	if _, err := tx.ExecContext(ctx,
		`UPDATE devices SET paired_at = ?, public_key = ?, status = 'active',
		        claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
		 WHERE id = ?`, t, controllerPubkey, t, d.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	d.Status = "active"
	d.PublicKey = controllerPubkey
	d.PairedAt = sql.NullInt64{Int64: t, Valid: true}
	return &d, nil
}

// ExpireDeviceClaim force-expires a pending claim — test/dev hook (backend
// tests time-travel the same way); never exposed over HTTP.
func (s *Store) ExpireDeviceClaim(ctx context.Context, deviceID string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE devices SET claim_expires_at = ? WHERE id = ? AND paired_at IS NULL`,
		now()-1, deviceID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DevicePublicKey returns the enrolled controller key for an ACTIVE paired
// device — the ws.auth / ack / event verification key. Fail-closed: unpaired
// or unknown devices yield ErrNotFound.
func (s *Store) DevicePublicKey(ctx context.Context, deviceID string) (string, error) {
	var pk sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT public_key FROM devices WHERE id = ? AND status = 'active' AND paired_at IS NOT NULL`,
		deviceID).Scan(&pk)
	if err != nil {
		return "", err
	}
	if !pk.Valid || pk.String == "" {
		return "", ErrNotFound
	}
	return pk.String, nil
}

// TouchDeviceSeen stamps last_seen_at (WS auth success, acks, polls).
func (s *Store) TouchDeviceSeen(ctx context.Context, deviceID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`, now(), now(), deviceID)
	return err
}
