package store

import (
	"context"
	"regexp"
	"strings"
)

// Account is a top-level tenant.
type Account struct {
	ID          string
	Name        string
	CountryCode string
	Status      string
	Role        string // caller's role, when loaded via AccountsForUser
}

// Location is a physical property under an account.
type Location struct {
	ID        string
	AccountID string
	Type      string
	Name      string
	Slug      string
	Status    string
}

// AccessPoint is a gate/door/barrier under a location.
type AccessPoint struct {
	ID         string
	LocationID string
	Name       string
	Kind       string
	Status     string
}

// Device is a physical controller paired to a location.
type Device struct {
	ID         string
	LocationID string
	Label      string
	Status     string
	PublicKey  string
}

// AccessLog is one append-only audit row.
type AccessLog struct {
	ID            string
	AccountID     string
	LocationID    string
	AccessPointID string
	UserID        string
	Command       string
	Source        string
	Lat, Long     *float64
	Success       bool
	Error         string
	TS            int64
	// ReconcilesLogID is "" for every ordinary row. It is set only on a
	// reconciliation row inserted after the fact by a late-but-verified
	// cmd.ack (see store.ReconcileLateAck): it names the original row this
	// one corrects, so the two remain distinct, equally durable facts
	// rather than one row silently overwriting the other.
	ReconcilesLogID string
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// Slugify turns a display name into the location slug convention.
func Slugify(name string) string {
	s := slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(name)), "-")
	return strings.Trim(s, "-")
}

// CreateAccountWithOwner bootstraps a personal account: the account row, the
// owner membership, and one anchor location of the same name (mirrors the
// backend's bootstrapPersonalAccount + anchor-location insert).
func (s *Store) CreateAccountWithOwner(ctx context.Context, ownerUserID, name, countryCode string) (*Account, *Location, error) {
	if countryCode == "" {
		countryCode = "ZA"
	}
	t := now()
	acctID, locID := NewID(), NewID()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO accounts (id, name, country_code, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', ?, ?)`, acctID, name, countryCode, t, t); err != nil {
		return nil, nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO account_members (account_id, user_id, role, status, joined_at, created_at, updated_at)
		 VALUES (?, ?, 'owner', 'active', ?, ?, ?)`, acctID, ownerUserID, t, t, t); err != nil {
		return nil, nil, err
	}
	slug := Slugify(name)
	if slug == "" {
		slug = "home"
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO locations (id, account_id, type, name, slug, status, created_at, updated_at)
		 VALUES (?, ?, 'house', ?, ?, 'active', ?, ?)`, locID, acctID, name, slug, t, t); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return &Account{ID: acctID, Name: name, CountryCode: countryCode, Status: "active", Role: "owner"},
		&Location{ID: locID, AccountID: acctID, Type: "house", Name: name, Slug: slug, Status: "active"},
		nil
}

// AccountsForUser lists the accounts the user is an active member of.
func (s *Store) AccountsForUser(ctx context.Context, userID string) ([]Account, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT a.id, a.name, a.country_code, a.status, m.role
		 FROM accounts a JOIN account_members m ON m.account_id = a.id
		 WHERE m.user_id = ? AND m.status = 'active' AND a.status = 'active'
		 ORDER BY a.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.ID, &a.Name, &a.CountryCode, &a.Status, &a.Role); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// MemberRole returns the caller's active role in the account, or ErrNotFound —
// the membership gate handlers call before any tenant operation.
func (s *Store) MemberRole(ctx context.Context, accountID, userID string) (string, error) {
	var role string
	err := s.db.QueryRowContext(ctx,
		`SELECT role FROM account_members
		 WHERE account_id = ? AND user_id = ? AND status = 'active'`, accountID, userID).Scan(&role)
	return role, err
}

// ---------------------------------------------------------------------------
// Locations — every accessor scoped by accountID
// ---------------------------------------------------------------------------

// CreateLocation inserts a location under the account.
func (s *Store) CreateLocation(ctx context.Context, accountID, typ, name string) (*Location, error) {
	t := now()
	l := Location{ID: NewID(), AccountID: accountID, Type: typ, Name: name, Slug: Slugify(name), Status: "active"}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO locations (id, account_id, type, name, slug, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, l.ID, l.AccountID, l.Type, l.Name, l.Slug, t, t)
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// LocationsByAccount lists the account's locations.
func (s *Store) LocationsByAccount(ctx context.Context, accountID string) ([]Location, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, account_id, type, name, slug, status FROM locations
		 WHERE account_id = ? ORDER BY created_at`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Location
	for rows.Next() {
		var l Location
		if err := rows.Scan(&l.ID, &l.AccountID, &l.Type, &l.Name, &l.Slug, &l.Status); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// LocationByID fetches one location if — and only if — it belongs to accountID.
func (s *Store) LocationByID(ctx context.Context, accountID, id string) (*Location, error) {
	var l Location
	err := s.db.QueryRowContext(ctx,
		`SELECT id, account_id, type, name, slug, status FROM locations
		 WHERE id = ? AND account_id = ?`, id, accountID).
		Scan(&l.ID, &l.AccountID, &l.Type, &l.Name, &l.Slug, &l.Status)
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// ---------------------------------------------------------------------------
// Access points — scoped via JOIN to locations.account_id
// ---------------------------------------------------------------------------

// CreateAccessPoint inserts an access point after verifying the target
// location belongs to the account.
func (s *Store) CreateAccessPoint(ctx context.Context, accountID, locationID, name, kind string) (*AccessPoint, error) {
	if _, err := s.LocationByID(ctx, accountID, locationID); err != nil {
		return nil, err
	}
	t := now()
	ap := AccessPoint{ID: NewID(), LocationID: locationID, Name: name, Kind: kind, Status: "active"}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO access_points (id, location_id, name, kind, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'active', ?, ?)`, ap.ID, ap.LocationID, ap.Name, ap.Kind, t, t)
	if err != nil {
		return nil, err
	}
	return &ap, nil
}

// AccessPointsByAccount lists every access point across the account's locations.
func (s *Store) AccessPointsByAccount(ctx context.Context, accountID string) ([]AccessPoint, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT ap.id, ap.location_id, ap.name, ap.kind, ap.status
		 FROM access_points ap JOIN locations l ON l.id = ap.location_id
		 WHERE l.account_id = ? ORDER BY ap.created_at`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccessPoint
	for rows.Next() {
		var ap AccessPoint
		if err := rows.Scan(&ap.ID, &ap.LocationID, &ap.Name, &ap.Kind, &ap.Status); err != nil {
			return nil, err
		}
		out = append(out, ap)
	}
	return out, rows.Err()
}

// AccessPointByID fetches one access point iff it belongs to the account.
func (s *Store) AccessPointByID(ctx context.Context, accountID, id string) (*AccessPoint, error) {
	var ap AccessPoint
	err := s.db.QueryRowContext(ctx,
		`SELECT ap.id, ap.location_id, ap.name, ap.kind, ap.status
		 FROM access_points ap JOIN locations l ON l.id = ap.location_id
		 WHERE ap.id = ? AND l.account_id = ?`, id, accountID).
		Scan(&ap.ID, &ap.LocationID, &ap.Name, &ap.Kind, &ap.Status)
	if err != nil {
		return nil, err
	}
	return &ap, nil
}

// ---------------------------------------------------------------------------
// Devices — scoped via JOIN to locations.account_id
// ---------------------------------------------------------------------------

// CreateDevice inserts an unpaired device under a location of the account.
func (s *Store) CreateDevice(ctx context.Context, accountID, locationID, label string) (*Device, error) {
	if _, err := s.LocationByID(ctx, accountID, locationID); err != nil {
		return nil, err
	}
	t := now()
	d := Device{ID: NewID(), LocationID: locationID, Label: label, Status: "unpaired"}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (id, location_id, label, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'unpaired', ?, ?)`, d.ID, d.LocationID, d.Label, t, t)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// DevicesByAccount lists every device across the account's locations.
func (s *Store) DevicesByAccount(ctx context.Context, accountID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT d.id, d.location_id, coalesce(d.label, ''), d.status, coalesce(d.public_key, '')
		 FROM devices d JOIN locations l ON l.id = d.location_id
		 WHERE l.account_id = ? ORDER BY d.created_at`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.LocationID, &d.Label, &d.Status, &d.PublicKey); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Access logs — append-only, listed per account
// ---------------------------------------------------------------------------

// InsertAccessLog appends one audit row (denormalised account/location ids).
// A non-empty l.ReconcilesLogID marks this row as a late-ack reconciliation
// (see ReconcileLateAck) rather than an ordinary open/close attempt.
//
// Every insert also chains the row into the tamper-evident hash chain (see
// internal/store/audithash.go): read-last-hash + insert run inside one
// transaction so concurrent inserts can never interleave and fork the
// chain (the store's single SQLite connection makes each individual
// statement atomic, but NOT a read followed by a later write unless both
// are in the same transaction).
func (s *Store) InsertAccessLog(ctx context.Context, l AccessLog) (string, error) {
	id := NewID()
	t := now()
	ts := l.TS
	if ts == 0 {
		ts = t
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	prev, err := lastAccessLogRowHash(ctx, tx)
	if err != nil {
		return "", err
	}
	fields := accessLogHashFields{
		ID: id, AccountSnap: l.AccountID, LocationSnap: l.LocationID,
		AccessPointSnap: l.AccessPointID, UserSnap: l.UserID,
		Command: l.Command, Source: l.Source, Lat: l.Lat, Long: l.Long,
		Success: l.Success, Error: l.Error, TS: ts, CreatedAt: t,
		ReconcilesLogID: l.ReconcilesLogID,
	}
	rowHash, err := computeRowHash("access_logs", prev, fields.canonicalMap())
	if err != nil {
		return "", err
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO access_logs (id, access_point_id, location_id, account_id, user_id,
		                          command, source, lat, long, success, error, ts, created_at, reconciles_log_id,
		                          account_id_snapshot, location_id_snapshot, access_point_id_snapshot, user_id_snapshot,
		                          prev_hash, row_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, nullable(l.AccessPointID), nullable(l.LocationID), nullable(l.AccountID), nullable(l.UserID),
		l.Command, l.Source, nullFloat(l.Lat), nullFloat(l.Long), boolInt(l.Success), nullable(l.Error), ts, t,
		nullable(l.ReconcilesLogID),
		l.AccountID, l.LocationID, l.AccessPointID, l.UserID,
		prev, rowHash)
	if err != nil {
		return "", err
	}
	return id, tx.Commit()
}

// AccessLogsByAccount lists the account's audit rows, newest first.
func (s *Store) AccessLogsByAccount(ctx context.Context, accountID string, limit int) ([]AccessLog, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, coalesce(access_point_id,''), coalesce(location_id,''), coalesce(account_id,''),
		        coalesce(user_id,''), coalesce(command,''), coalesce(source,''), success, coalesce(error,''), ts,
		        coalesce(reconciles_log_id,'')
		 FROM access_logs WHERE account_id = ? ORDER BY ts DESC LIMIT ?`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccessLog
	for rows.Next() {
		var l AccessLog
		var success int
		if err := rows.Scan(&l.ID, &l.AccessPointID, &l.LocationID, &l.AccountID, &l.UserID,
			&l.Command, &l.Source, &success, &l.Error, &l.TS, &l.ReconcilesLogID); err != nil {
			return nil, err
		}
		l.Success = success != 0
		out = append(out, l)
	}
	return out, rows.Err()
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
