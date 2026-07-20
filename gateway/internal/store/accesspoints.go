package store

import (
	"context"
	"database/sql"
	"errors"
)

// ErrDeviceNotAtLocation mirrors the backend's device_not_at_location check
// on access-point create.
var ErrDeviceNotAtLocation = errors.New("device_not_at_location")

// AccessPointDetail is the GET /access-points shape: the row plus the meter
// summary. lintel-gateway derives the meter from access_logs (the Postgres
// backend kept a separate access_point_meters table fed by device acks;
// movement metering is deferred with the maintenance module — see README).
type AccessPointDetail struct {
	ID          string
	LocationID  string
	Name        string
	Kind        string
	DeviceID    string // "" = none
	Status      string
	Lat, Long   sql.NullFloat64
	TotalOpens  int
	TotalCloses int
	LastOpAt    sql.NullInt64
}

const apDetailSelect = `
	SELECT ap.id, ap.location_id, ap.name, ap.kind, coalesce(ap.device_id, ''), ap.status, ap.lat, ap.long,
	  (SELECT count(*) FROM access_logs al WHERE al.access_point_id = ap.id AND al.command = 'open'  AND al.success = 1),
	  (SELECT count(*) FROM access_logs al WHERE al.access_point_id = ap.id AND al.command = 'close' AND al.success = 1),
	  (SELECT max(al.ts) FROM access_logs al WHERE al.access_point_id = ap.id AND al.success = 1)
	FROM access_points ap JOIN locations l ON l.id = ap.location_id`

func scanAPDetail(sc interface{ Scan(...any) error }) (*AccessPointDetail, error) {
	var d AccessPointDetail
	if err := sc.Scan(&d.ID, &d.LocationID, &d.Name, &d.Kind, &d.DeviceID, &d.Status, &d.Lat, &d.Long,
		&d.TotalOpens, &d.TotalCloses, &d.LastOpAt); err != nil {
		return nil, err
	}
	return &d, nil
}

// AccessPointsByAccountDetailed lists the account's access points, oldest
// first (creation order — the stable portal ordering).
func (s *Store) AccessPointsByAccountDetailed(ctx context.Context, accountID string) ([]AccessPointDetail, error) {
	rows, err := s.db.QueryContext(ctx,
		apDetailSelect+` WHERE l.account_id = ? ORDER BY ap.created_at ASC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccessPointDetail
	for rows.Next() {
		d, err := scanAPDetail(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// AccessPointDetailByID fetches one access point iff it belongs to the account.
func (s *Store) AccessPointDetailByID(ctx context.Context, accountID, id string) (*AccessPointDetail, error) {
	return scanAPDetail(s.db.QueryRowContext(ctx,
		apDetailSelect+` WHERE ap.id = ? AND l.account_id = ?`, id, accountID))
}

// AccessPointContext is the open-path resolution: where an access point
// lives and the states the verdict function needs.
type AccessPointContext struct {
	ID            string
	LocationID    string
	AccountID     string
	AccountStatus string
	DeviceID      string // "" = no controller attached
}

// AccessPointContextByID resolves an access point UNSCOPED — used only (a)
// by handlers immediately before a MemberRole gate and (b) by the open-path
// choke point, which audits every attempt (backend logAccess does the same
// pre-RLS join).
func (s *Store) AccessPointContextByID(ctx context.Context, id string) (*AccessPointContext, error) {
	var c AccessPointContext
	err := s.db.QueryRowContext(ctx,
		`SELECT ap.id, ap.location_id, l.account_id, a.status, coalesce(ap.device_id, '')
		 FROM access_points ap
		 JOIN locations l ON l.id = ap.location_id
		 JOIN accounts a ON a.id = l.account_id
		 WHERE ap.id = ?`, id).
		Scan(&c.ID, &c.LocationID, &c.AccountID, &c.AccountStatus, &c.DeviceID)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// CreateAccessPointFull inserts an access point after verifying the location
// belongs to the account and (when given) the device sits at that location.
func (s *Store) CreateAccessPointFull(ctx context.Context, accountID, locationID, name, kind, deviceID string, lat, long *float64) (*AccessPointDetail, error) {
	if _, err := s.LocationByID(ctx, accountID, locationID); err != nil {
		return nil, err
	}
	if deviceID != "" {
		var n int
		if err := s.db.QueryRowContext(ctx,
			`SELECT count(*) FROM devices WHERE id = ? AND location_id = ?`, deviceID, locationID).Scan(&n); err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, ErrDeviceNotAtLocation
		}
	}
	t := now()
	id := NewID()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO access_points (id, location_id, name, kind, device_id, lat, long, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
		id, locationID, name, kind, nullable(deviceID), nullFloat(lat), nullFloat(long), t, t)
	if err != nil {
		return nil, err
	}
	return s.AccessPointDetailByID(ctx, accountID, id)
}
