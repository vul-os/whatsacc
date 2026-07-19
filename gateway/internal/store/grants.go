package store

// Temporary access grants (backend routes/access.ts grants section +
// app.try_consume_grant / refundGrantUse).

import (
	"context"
	"database/sql"
)

// Grant is one temporary access grant.
type Grant struct {
	ID              string
	AccountID       string
	GrantedByUserID string
	PhoneE164       string
	VisitorName     string
	StartsAt        int64
	EndsAt          int64
	MaxUses         sql.NullInt64
	UsesCount       int64
	Status          string // active | revoked (stored)
	RevokedAt       sql.NullInt64
	RevokedByUserID string
	Notes           string
	LastUsedAt      sql.NullInt64
	CreatedAt       int64
	AccessPointIDs  []string
}

// EffectiveStatus derives the live status the portal shows:
// revoked > exhausted > pending > expired > active.
func (g *Grant) EffectiveStatus(nowUnix int64) string {
	switch {
	case g.Status == "revoked":
		return "revoked"
	case g.MaxUses.Valid && g.UsesCount >= g.MaxUses.Int64:
		return "exhausted"
	case g.StartsAt > nowUnix:
		return "pending"
	case g.EndsAt <= nowUnix:
		return "expired"
	default:
		return "active"
	}
}

const grantCols = `g.id, g.account_id, coalesce(g.granted_by_user_id,''), g.phone_e164,
	coalesce(g.visitor_name,''), g.starts_at, g.ends_at, g.max_uses, g.uses_count,
	g.status, g.revoked_at, coalesce(g.revoked_by_user_id,''), coalesce(g.notes,''),
	g.last_used_at, g.created_at`

func scanGrant(sc interface{ Scan(...any) error }) (*Grant, error) {
	var g Grant
	if err := sc.Scan(&g.ID, &g.AccountID, &g.GrantedByUserID, &g.PhoneE164, &g.VisitorName,
		&g.StartsAt, &g.EndsAt, &g.MaxUses, &g.UsesCount, &g.Status, &g.RevokedAt,
		&g.RevokedByUserID, &g.Notes, &g.LastUsedAt, &g.CreatedAt); err != nil {
		return nil, err
	}
	return &g, nil
}

func (s *Store) grantAccessPoints(ctx context.Context, grantID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT access_point_id FROM temporary_access_grant_access_points WHERE grant_id = ?`, grantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// CreateGrantArgs are the insert inputs (handler has already verified the
// access points all belong to accountID and the caller admins it).
type CreateGrantArgs struct {
	GrantedByUserID string
	PhoneE164       string
	VisitorName     string
	StartsAt        int64
	EndsAt          int64
	MaxUses         *int64
	Notes           string
	AccessPointIDs  []string
}

// CreateGrant inserts the grant + its access-point join rows atomically.
func (s *Store) CreateGrant(ctx context.Context, accountID string, a CreateGrantArgs) (*Grant, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	id := NewID()
	t := now()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO temporary_access_grants
		   (id, account_id, granted_by_user_id, phone_e164, visitor_name,
		    starts_at, ends_at, max_uses, notes, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, accountID, nullable(a.GrantedByUserID), a.PhoneE164, nullable(a.VisitorName),
		a.StartsAt, a.EndsAt, nullInt(a.MaxUses), nullable(a.Notes), t, t); err != nil {
		return nil, err
	}
	for _, apID := range a.AccessPointIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO temporary_access_grant_access_points (grant_id, access_point_id)
			 VALUES (?, ?)`, id, apID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GrantByID(ctx, accountID, id)
}

// GrantsByAccount lists the account's grants, newest first (limit 200), with
// optional phone/status filters.
func (s *Store) GrantsByAccount(ctx context.Context, accountID, phoneE164, status string) ([]Grant, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+grantCols+` FROM temporary_access_grants g
		 WHERE g.account_id = ?
		   AND (? = '' OR g.phone_e164 = ?)
		   AND (? = '' OR g.status = ?)
		 ORDER BY g.created_at DESC LIMIT 200`,
		accountID, phoneE164, phoneE164, status, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Grant
	for rows.Next() {
		g, err := scanGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].AccessPointIDs, err = s.grantAccessPoints(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// GrantByID fetches one grant iff it belongs to accountID.
func (s *Store) GrantByID(ctx context.Context, accountID, id string) (*Grant, error) {
	g, err := scanGrant(s.db.QueryRowContext(ctx,
		`SELECT `+grantCols+` FROM temporary_access_grants g
		 WHERE g.id = ? AND g.account_id = ?`, id, accountID))
	if err != nil {
		return nil, err
	}
	if g.AccessPointIDs, err = s.grantAccessPoints(ctx, g.ID); err != nil {
		return nil, err
	}
	return g, nil
}

// RevokeGrant flips an ACTIVE grant to revoked (idempotence surface: a grant
// already revoked is ErrNotFound — backend's grant_not_revocable).
func (s *Store) RevokeGrant(ctx context.Context, accountID, id, byUserID string) (*Grant, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE temporary_access_grants
		 SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
		 WHERE id = ? AND account_id = ? AND status = 'active'`,
		now(), byUserID, now(), id, accountID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.GrantByID(ctx, accountID, id)
}

// TryConsumeGrant atomically checks + consumes one use of a usable grant for
// (phone, access point): active, inside its window, uses remaining, covering
// the access point. Returns the grant id, or "" when no usable grant exists.
// One UPDATE ... RETURNING statement = exact under concurrency (the Postgres
// app.try_consume_grant SECURITY DEFINER equivalent).
func (s *Store) TryConsumeGrant(ctx context.Context, phoneE164, accessPointID string, nowUnix int64) (string, error) {
	if nowUnix == 0 {
		nowUnix = now()
	}
	var id string
	err := s.db.QueryRowContext(ctx,
		`UPDATE temporary_access_grants
		 SET uses_count = uses_count + 1, last_used_at = ?, updated_at = ?
		 WHERE id = (
		   SELECT g.id FROM temporary_access_grants g
		   JOIN temporary_access_grant_access_points t ON t.grant_id = g.id
		   WHERE g.phone_e164 = ? AND t.access_point_id = ?
		     AND g.status = 'active'
		     AND g.starts_at <= ? AND g.ends_at > ?
		     AND (g.max_uses IS NULL OR g.uses_count < g.max_uses)
		   ORDER BY g.ends_at ASC LIMIT 1
		 )
		 RETURNING id`,
		nowUnix, nowUnix, phoneE164, accessPointID, nowUnix, nowUnix).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// RefundGrantUse hands one use back — a consumed grant whose open was then
// denied (rate limit / quota) must not cost the visitor a use.
func (s *Store) RefundGrantUse(ctx context.Context, grantID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE temporary_access_grants
		 SET uses_count = max(uses_count - 1, 0), updated_at = ?
		 WHERE id = ?`, now(), grantID)
	return err
}
