package store

import (
	"context"
	"database/sql"
)

// LocationDetail is the GET /locations shape: the row plus address json and
// the aggregate counts the portal shows.
type LocationDetail struct {
	Location
	ParentLocationID string
	Address          string // raw json object, "{}" default
	Lat, Long        sql.NullFloat64
	AccessPointCount int
	MemberCount      int
	LastOpenedAt     sql.NullInt64
}

// LocationsByAccountDetailed lists the account's locations with counts +
// last successful open, mirroring GET /accounts/:id/locations.
func (s *Store) LocationsByAccountDetailed(ctx context.Context, accountID string) ([]LocationDetail, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT l.id, l.account_id, coalesce(l.parent_location_id, ''), l.type, l.name, l.slug,
		        l.status, l.address, l.lat, l.long,
		        (SELECT count(*) FROM access_points ap WHERE ap.location_id = l.id),
		        (SELECT count(*) FROM location_members lm WHERE lm.location_id = l.id),
		        (SELECT max(al.ts) FROM access_logs al
		          WHERE al.location_id = l.id AND al.command = 'open' AND al.success = 1)
		 FROM locations l
		 WHERE l.account_id = ?
		 ORDER BY l.created_at ASC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LocationDetail
	for rows.Next() {
		var d LocationDetail
		if err := rows.Scan(&d.ID, &d.AccountID, &d.ParentLocationID, &d.Type, &d.Name, &d.Slug,
			&d.Status, &d.Address, &d.Lat, &d.Long,
			&d.AccessPointCount, &d.MemberCount, &d.LastOpenedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// LocationDetailByID fetches one location (with address/coords) iff it
// belongs to accountID.
func (s *Store) LocationDetailByID(ctx context.Context, accountID, id string) (*LocationDetail, error) {
	var d LocationDetail
	err := s.db.QueryRowContext(ctx,
		`SELECT id, account_id, coalesce(parent_location_id, ''), type, name, slug, status, address, lat, long
		 FROM locations WHERE id = ? AND account_id = ?`, id, accountID).
		Scan(&d.ID, &d.AccountID, &d.ParentLocationID, &d.Type, &d.Name, &d.Slug, &d.Status,
			&d.Address, &d.Lat, &d.Long)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// CreateLocationArgs are the nested-create inputs (POST /accounts/:id/locations).
type CreateLocationArgs struct {
	ParentLocationID string
	Type             string
	Name             string
	Slug             string // "" = derive from name
	AddressJSON      string // "" = "{}"
	Lat, Long        *float64
	CreatorUserID    string // added as location 'owner' member
}

// CreateLocationFull inserts a location under the account and makes the
// creator a location owner-member.
func (s *Store) CreateLocationFull(ctx context.Context, accountID string, a CreateLocationArgs) (string, error) {
	slug := a.Slug
	if slug == "" {
		slug = Slugify(a.Name)
		if slug == "" {
			slug = "home"
		}
	}
	addr := a.AddressJSON
	if addr == "" {
		addr = "{}"
	}
	t := now()
	id := NewID()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO locations (id, account_id, parent_location_id, type, name, slug, address, lat, long, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		id, accountID, nullable(a.ParentLocationID), a.Type, a.Name, slug, addr,
		nullFloat(a.Lat), nullFloat(a.Long), t, t); err != nil {
		return "", err
	}
	if a.CreatorUserID != "" {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO location_members (location_id, user_id, role, created_at, updated_at)
			 VALUES (?, ?, 'owner', ?, ?)
			 ON CONFLICT (location_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at`,
			id, a.CreatorUserID, t, t); err != nil {
			return "", err
		}
	}
	return id, tx.Commit()
}

// LocationAccountID resolves a location to its owning account — the gating
// lookup handlers use before a MemberRole check (never exposed raw).
func (s *Store) LocationAccountID(ctx context.Context, id string) (string, error) {
	var accountID string
	err := s.db.QueryRowContext(ctx, `SELECT account_id FROM locations WHERE id = ?`, id).Scan(&accountID)
	return accountID, err
}

// UpdateLocationType changes the location type (top-level create adjusts the
// anchor location after CreateAccountWithOwner defaults it to 'house').
func (s *Store) UpdateLocationType(ctx context.Context, accountID, id, typ string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE locations SET type = ?, updated_at = ? WHERE id = ? AND account_id = ?`,
		typ, now(), id, accountID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// LocationPatch is the PATCH /locations/:id partial update. Nil = unchanged.
type LocationPatch struct {
	Name        *string
	AddressJSON *string
	Lat, Long   *float64
	Status      *string
}

// UpdateLocation applies the patch iff the location belongs to accountID
// (ErrNotFound otherwise — cross-tenant PATCH must not leak existence).
func (s *Store) UpdateLocation(ctx context.Context, accountID, id string, p LocationPatch) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE locations SET
		   name    = coalesce(?, name),
		   address = coalesce(?, address),
		   lat     = coalesce(?, lat),
		   long    = coalesce(?, long),
		   status  = coalesce(?, status),
		   updated_at = ?
		 WHERE id = ? AND account_id = ?`,
		nullStr(p.Name), nullStr(p.AddressJSON), nullFloat(p.Lat), nullFloat(p.Long), nullStr(p.Status),
		now(), id, accountID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteLocation drops the location and — locations being 1:1 with accounts
// in the product model — the parent account when no sibling remains.
// Returns whether the account was dropped too.
func (s *Store) DeleteLocation(ctx context.Context, accountID, id string) (accountDropped bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`DELETE FROM locations WHERE id = ? AND account_id = ?`, id, accountID)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, ErrNotFound
	}
	var remaining int
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM locations WHERE account_id = ?`, accountID).Scan(&remaining); err != nil {
		return false, err
	}
	if remaining == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE id = ?`, accountID); err != nil {
			return false, err
		}
	}
	return remaining == 0, tx.Commit()
}

// ---------------------------------------------------------------------------
// Quotas ("limits") + usage
// ---------------------------------------------------------------------------

// Quotas are the two optional per-location daily caps. Nil = unlimited.
type Quotas struct {
	MaxOpensPerMemberPerDay   *int64
	MaxOpensPerLocationPerDay *int64
}

// LocationQuotas reads the location's quota settings (zero-value Quotas when
// no settings row exists).
func (s *Store) LocationQuotas(ctx context.Context, locationID string) (Quotas, error) {
	var q Quotas
	var m, l sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT max_opens_per_member_per_day, max_opens_per_location_per_day
		 FROM location_settings WHERE location_id = ?`, locationID).Scan(&m, &l)
	if err == sql.ErrNoRows {
		return q, nil
	}
	if err != nil {
		return q, err
	}
	if m.Valid {
		q.MaxOpensPerMemberPerDay = &m.Int64
	}
	if l.Valid {
		q.MaxOpensPerLocationPerDay = &l.Int64
	}
	return q, nil
}

// PatchLocationQuotas upserts location_settings with omitted-vs-null
// semantics: hasX=false leaves the column unchanged, hasX=true sets it to
// val (nil = clear = unlimited). Returns the resulting quotas.
func (s *Store) PatchLocationQuotas(ctx context.Context, locationID string, hasMember bool, memberVal *int64, hasLocation bool, locationVal *int64) (Quotas, error) {
	t := now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Quotas{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO location_settings (location_id, max_opens_per_member_per_day, max_opens_per_location_per_day, created_at, updated_at)
		 VALUES (?, NULL, NULL, ?, ?)
		 ON CONFLICT (location_id) DO NOTHING`, locationID, t, t); err != nil {
		return Quotas{}, err
	}
	if hasMember {
		if _, err := tx.ExecContext(ctx,
			`UPDATE location_settings SET max_opens_per_member_per_day = ?, updated_at = ? WHERE location_id = ?`,
			nullInt(memberVal), t, locationID); err != nil {
			return Quotas{}, err
		}
	}
	if hasLocation {
		if _, err := tx.ExecContext(ctx,
			`UPDATE location_settings SET max_opens_per_location_per_day = ?, updated_at = ? WHERE location_id = ?`,
			nullInt(locationVal), t, locationID); err != nil {
			return Quotas{}, err
		}
	}
	var q Quotas
	var m, l sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT max_opens_per_member_per_day, max_opens_per_location_per_day
		 FROM location_settings WHERE location_id = ?`, locationID).Scan(&m, &l); err != nil {
		return Quotas{}, err
	}
	if m.Valid {
		q.MaxOpensPerMemberPerDay = &m.Int64
	}
	if l.Valid {
		q.MaxOpensPerLocationPerDay = &l.Int64
	}
	return q, tx.Commit()
}

// MemberOpens is one member's successful-open count for the usage breakdown.
type MemberOpens struct {
	UserID     string
	Email      string
	OpensToday int
}

// LocationUsage computes today's successful opens from access_logs over the
// same UTC day window the limiter counts, so UI numbers match enforcement.
func (s *Store) LocationUsage(ctx context.Context, locationID, userID string, dayStart int64) (locationOpens, myOpens int, members []MemberOpens, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT
		   count(*) FILTER (WHERE success = 1 AND command = 'open'),
		   count(*) FILTER (WHERE success = 1 AND command = 'open' AND user_id = ?)
		 FROM access_logs WHERE location_id = ? AND ts >= ?`,
		userID, locationID, dayStart).Scan(&locationOpens, &myOpens)
	if err != nil {
		return 0, 0, nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT coalesce(al.user_id, ''), coalesce(u.email, ''), count(*)
		 FROM access_logs al LEFT JOIN users u ON u.id = al.user_id
		 WHERE al.location_id = ? AND al.success = 1 AND al.command = 'open' AND al.ts >= ?
		 GROUP BY al.user_id, u.email
		 ORDER BY count(*) DESC
		 LIMIT 50`, locationID, dayStart)
	if err != nil {
		return 0, 0, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m MemberOpens
		if err := rows.Scan(&m.UserID, &m.Email, &m.OpensToday); err != nil {
			return 0, 0, nil, err
		}
		members = append(members, m)
	}
	return locationOpens, myOpens, members, rows.Err()
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullInt(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
