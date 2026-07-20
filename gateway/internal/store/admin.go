package store

// Instance-admin (platform operator) store methods, porting the moderation +
// observation queries of backend/src/routes/admin.ts. These are CROSS-TENANT
// on purpose: handlers may only reach them through the platform-admin gate
// (live users-row check), mirroring the Postgres app.is_platform_admin()
// derivation.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// ErrLastAdmin guards the "never zero active platform admins" invariant.
var ErrLastAdmin = errors.New("last_admin")

// SetAccountStatus suspends/reactivates an account. Enforcement happens in
// the open-path choke point (account_suspended denials).
func (s *Store) SetAccountStatus(ctx context.Context, accountID, status string) (*Account, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?`, status, now(), accountID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	var a Account
	if err := s.db.QueryRowContext(ctx,
		`SELECT id, name, country_code, status FROM accounts WHERE id = ?`, accountID).
		Scan(&a.ID, &a.Name, &a.CountryCode, &a.Status); err != nil {
		return nil, err
	}
	return &a, nil
}

// SetUserStatus disables/reactivates a user. Disabling revokes every live
// refresh token immediately (access tokens die at the live admin gate /
// choke point on next use) and refuses to disable the LAST active platform
// admin. The check-then-update runs in one transaction on the single
// serialized SQLite connection — the Postgres advisory-lock equivalent.
func (s *Store) SetUserStatus(ctx context.Context, userID, status string) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var isAdmin int
	err = tx.QueryRowContext(ctx, `SELECT is_platform_admin FROM users WHERE id = ?`, userID).Scan(&isAdmin)
	if err != nil {
		return nil, err
	}
	if status == "disabled" && isAdmin == 1 {
		var others int
		if err := tx.QueryRowContext(ctx,
			`SELECT count(*) FROM users WHERE is_platform_admin = 1 AND status = 'active' AND id <> ?`,
			userID).Scan(&others); err != nil {
			return nil, err
		}
		if others == 0 {
			return nil, ErrLastAdmin
		}
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`, status, now(), userID); err != nil {
		return nil, err
	}
	if status == "disabled" {
		if err := revokeAllRefreshTokens(ctx, tx, userID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.UserByID(ctx, userID)
}

// SetPlatformAdmin grants/revokes the platform-admin flag, refusing to
// revoke the last active admin (same tx discipline as SetUserStatus).
func (s *Store) SetPlatformAdmin(ctx context.Context, userID string, grant bool) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var isAdmin int
	err = tx.QueryRowContext(ctx, `SELECT is_platform_admin FROM users WHERE id = ?`, userID).Scan(&isAdmin)
	if err != nil {
		return nil, err
	}
	if !grant && isAdmin == 1 {
		var others int
		if err := tx.QueryRowContext(ctx,
			`SELECT count(*) FROM users WHERE is_platform_admin = 1 AND status = 'active' AND id <> ?`,
			userID).Scan(&others); err != nil {
			return nil, err
		}
		if others == 0 {
			return nil, ErrLastAdmin
		}
	}
	g := 0
	if grant {
		g = 1
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET is_platform_admin = ?, updated_at = ? WHERE id = ?`, g, now(), userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.UserByID(ctx, userID)
}

// ---------------------------------------------------------------------------
// Admin audit log
// ---------------------------------------------------------------------------

// AdminAuditEntry is one admin-action trail row.
type AdminAuditEntry struct {
	ID          string
	ActorUserID string
	ActorEmail  string
	Action      string
	TargetKind  string
	TargetID    string
	Allowed     bool
	Detail      json.RawMessage
	CreatedAt   int64
}

// WriteAdminAudit appends one admin-action row (claims, suspensions, grants,
// denied /admin probes). Callers treat failures as best-effort — a 403 never
// depends on the audit write.
//
// Like InsertAccessLog, every write also extends the tamper-evident hash
// chain (internal/store/audithash.go) inside one transaction so concurrent
// writers can never fork the chain.
func (s *Store) WriteAdminAudit(ctx context.Context, actorUserID, action, targetKind, targetID string, allowed bool, detail any) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		raw = []byte("{}")
	}
	id := NewID()
	t := now()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	prev, err := lastAdminAuditRowHash(ctx, tx)
	if err != nil {
		return err
	}
	fields := adminAuditHashFields{
		ID: id, ActorSnap: actorUserID, Action: action, TargetKind: targetKind,
		TargetID: targetID, Allowed: allowed, Detail: string(raw), CreatedAt: t,
	}
	rowHash, err := computeRowHash("admin_audit_log", prev, fields.canonicalMap())
	if err != nil {
		return err
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO admin_audit_log (id, actor_user_id, action, target_kind, target_id, allowed, detail, created_at,
		                              actor_user_id_snapshot, prev_hash, row_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, nullable(actorUserID), action, nullable(targetKind), nullable(targetID),
		boolInt(allowed), string(raw), t,
		actorUserID, prev, rowHash)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// AdminAuditActions lists the admin-action trail, newest first.
func (s *Store) AdminAuditActions(ctx context.Context, limit, offset int) ([]AdminAuditEntry, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM admin_audit_log`).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT aal.id, coalesce(aal.actor_user_id,''), coalesce(u.email,''), aal.action,
		        coalesce(aal.target_kind,''), coalesce(aal.target_id,''), aal.allowed, aal.detail, aal.created_at
		 FROM admin_audit_log aal LEFT JOIN users u ON u.id = aal.actor_user_id
		 ORDER BY aal.created_at DESC, aal.rowid DESC
		 LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AdminAuditEntry
	for rows.Next() {
		var e AdminAuditEntry
		var allowed int
		var detail string
		if err := rows.Scan(&e.ID, &e.ActorUserID, &e.ActorEmail, &e.Action, &e.TargetKind,
			&e.TargetID, &allowed, &detail, &e.CreatedAt); err != nil {
			return nil, 0, err
		}
		e.Allowed = allowed == 1
		e.Detail = json.RawMessage(detail)
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// ---------------------------------------------------------------------------
// Observation (overview / listings / audit)
// ---------------------------------------------------------------------------

// AdminTotals is the overview counters block.
type AdminTotals struct {
	Users, Accounts, Locations, Devices, AccessPoints int
	OpensToday, OpensLast7d                           int
	DenialsToday                                      map[string]int
}

// AdminOverview computes the overview blocks (UTC-day windows, matching the
// limiter's windows).
func (s *Store) AdminOverview(ctx context.Context, nowUnix int64) (*AdminTotals, error) {
	t := &AdminTotals{DenialsToday: map[string]int{}}
	dayStart := FixedWindowStart(nowUnix, DayS)
	weekStart := dayStart - 6*DayS
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM users),
		(SELECT count(*) FROM accounts),
		(SELECT count(*) FROM locations),
		(SELECT count(*) FROM devices),
		(SELECT count(*) FROM access_points),
		(SELECT count(*) FROM access_logs WHERE command='open' AND success=1 AND ts >= ?),
		(SELECT count(*) FROM access_logs WHERE command='open' AND success=1 AND ts >= ?)`,
		dayStart, weekStart).
		Scan(&t.Users, &t.Accounts, &t.Locations, &t.Devices, &t.AccessPoints, &t.OpensToday, &t.OpensLast7d)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT coalesce(error, 'other'), count(*) FROM access_logs
		 WHERE success = 0 AND ts >= ? GROUP BY 1`, dayStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var reason string
		var n int
		if err := rows.Scan(&reason, &n); err != nil {
			return nil, err
		}
		t.DenialsToday[reason] = n
	}
	return t, rows.Err()
}

// AdminUserRow is one /admin/users listing row.
type AdminUserRow struct {
	ID              string
	Email           string
	Status          string
	IsPlatformAdmin bool
	DisplayName     string
	CreatedAt       int64
	LastAccessAt    sql.NullInt64
	Accounts        []AdminUserAccount
}

// AdminUserAccount is one membership of a listed user.
type AdminUserAccount struct {
	AccountID string `json:"account_id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
}

// likeEscape makes a LIKE pattern treating q as a literal substring.
func likeEscape(q string) string {
	q = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
	return "%" + q + "%"
}

// AdminUsers lists users (email-substring search, paged), cross-tenant.
func (s *Store) AdminUsers(ctx context.Context, query string, limit, offset int) ([]AdminUserRow, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	pattern := ""
	if query != "" {
		pattern = likeEscape(query)
	}
	var total int
	if err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM users WHERE (? = '' OR email LIKE ? ESCAPE '\')`,
		pattern, pattern).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT u.id, u.email, u.status, u.is_platform_admin, coalesce(p.display_name,''), u.created_at,
		        (SELECT max(al.ts) FROM access_logs al WHERE al.user_id = u.id)
		 FROM users u LEFT JOIN profiles p ON p.id = u.id
		 WHERE (? = '' OR u.email LIKE ? ESCAPE '\')
		 ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
		pattern, pattern, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AdminUserRow
	for rows.Next() {
		var u AdminUserRow
		var admin int
		if err := rows.Scan(&u.ID, &u.Email, &u.Status, &admin, &u.DisplayName, &u.CreatedAt, &u.LastAccessAt); err != nil {
			return nil, 0, err
		}
		u.IsPlatformAdmin = admin == 1
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	for i := range out {
		ars, err := s.db.QueryContext(ctx,
			`SELECT a.id, a.name, am.role FROM account_members am
			 JOIN accounts a ON a.id = am.account_id WHERE am.user_id = ?`, out[i].ID)
		if err != nil {
			return nil, 0, err
		}
		for ars.Next() {
			var aa AdminUserAccount
			if err := ars.Scan(&aa.AccountID, &aa.Name, &aa.Role); err != nil {
				ars.Close()
				return nil, 0, err
			}
			out[i].Accounts = append(out[i].Accounts, aa)
		}
		if err := ars.Err(); err != nil {
			ars.Close()
			return nil, 0, err
		}
		ars.Close()
	}
	return out, total, nil
}

// AdminAccountRow is one /admin/accounts listing row.
type AdminAccountRow struct {
	ID            string
	Name          string
	Status        string
	CountryCode   string
	CreatedAt     int64
	MemberCount   int
	LocationCount int
	Opens7d       int
}

// AdminAccounts lists accounts (name-substring search, paged), cross-tenant.
func (s *Store) AdminAccounts(ctx context.Context, query string, limit, offset int, nowUnix int64) ([]AdminAccountRow, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	pattern := ""
	if query != "" {
		pattern = likeEscape(query)
	}
	weekStart := FixedWindowStart(nowUnix, DayS) - 6*DayS
	var total int
	if err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM accounts WHERE (? = '' OR name LIKE ? ESCAPE '\')`,
		pattern, pattern).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT a.id, a.name, a.status, a.country_code, a.created_at,
		        (SELECT count(*) FROM account_members am WHERE am.account_id = a.id),
		        (SELECT count(*) FROM locations l WHERE l.account_id = a.id),
		        (SELECT count(*) FROM access_logs al WHERE al.account_id = a.id
		           AND al.command='open' AND al.success=1 AND al.ts >= ?)
		 FROM accounts a
		 WHERE (? = '' OR a.name LIKE ? ESCAPE '\')
		 ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
		weekStart, pattern, pattern, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AdminAccountRow
	for rows.Next() {
		var a AdminAccountRow
		if err := rows.Scan(&a.ID, &a.Name, &a.Status, &a.CountryCode, &a.CreatedAt,
			&a.MemberCount, &a.LocationCount, &a.Opens7d); err != nil {
			return nil, 0, err
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}

// AuditLogEntry is one enriched cross-tenant access_logs row.
type AuditLogEntry struct {
	ID              string
	TS              int64
	Command         string
	Source          string
	Success         bool
	Error           string
	AccountID       string
	AccountName     string
	LocationID      string
	LocationName    string
	AccessPointID   string
	AccessPointName string
	UserID          string
	UserEmail       string
	// ReconcilesLogID mirrors AccessLog.ReconcilesLogID: "" for every
	// ordinary row, else the id of the original row this one is a
	// late-cmd.ack reconciliation of (see store.ReconcileLateAck). Exposed
	// so the admin audit view can show the linkage instead of a mysterious
	// unexplained extra row.
	ReconcilesLogID string
}

// AdminAudit lists access_logs cross-tenant with the backend's kind filter:
// all | denied | success | open | close | <error value>.
func (s *Store) AdminAudit(ctx context.Context, kind string, limit, offset int) ([]AuditLogEntry, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var successFilter any // nil = no filter, else 0/1
	var commandFilter, errorFilter string
	switch kind {
	case "", "all":
	case "denied":
		successFilter = 0
	case "success":
		successFilter = 1
	case "open", "close":
		commandFilter = kind
	default:
		errorFilter = kind
	}
	where := ` WHERE (? IS NULL OR al.success = ?)
	   AND (? = '' OR al.command = ?)
	   AND (? = '' OR al.error = ?)`
	args := []any{successFilter, successFilter, commandFilter, commandFilter, errorFilter, errorFilter}
	var total int
	if err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM access_logs al`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT al.id, al.ts, coalesce(al.command,''), coalesce(al.source,''), al.success, coalesce(al.error,''),
		        coalesce(al.account_id,''), coalesce(a.name,''),
		        coalesce(al.location_id,''), coalesce(l.name,''),
		        coalesce(al.access_point_id,''), coalesce(ap.name,''),
		        coalesce(al.user_id,''), coalesce(u.email,''),
		        coalesce(al.reconciles_log_id,'')
		 FROM access_logs al
		 LEFT JOIN accounts a ON a.id = al.account_id
		 LEFT JOIN locations l ON l.id = al.location_id
		 LEFT JOIN access_points ap ON ap.id = al.access_point_id
		 LEFT JOIN users u ON u.id = al.user_id`+where+`
		 ORDER BY al.ts DESC, al.rowid DESC LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLogEntry
	for rows.Next() {
		var e AuditLogEntry
		var success int
		if err := rows.Scan(&e.ID, &e.TS, &e.Command, &e.Source, &success, &e.Error,
			&e.AccountID, &e.AccountName, &e.LocationID, &e.LocationName,
			&e.AccessPointID, &e.AccessPointName, &e.UserID, &e.UserEmail,
			&e.ReconcilesLogID); err != nil {
			return nil, 0, err
		}
		e.Success = success == 1
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// RecentSignups returns the newest users (overview block).
func (s *Store) RecentSignups(ctx context.Context, limit int) ([]AdminUserRow, error) {
	rows, _, err := s.AdminUsers(ctx, "", limit, 0)
	return rows, err
}

// AdminAccountDetail is the GET /admin/accounts/:id composite.
type AdminAccountDetail struct {
	Account   Account
	CreatedAt int64
	Members   []Member
	Locations []Location
	Recent    []AuditLogEntry
}

// AdminAccountByID fetches one account with members, locations and recent
// access logs (cross-tenant; platform-admin gate at the handler).
func (s *Store) AdminAccountByID(ctx context.Context, id string) (*AdminAccountDetail, error) {
	var d AdminAccountDetail
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, country_code, status, created_at FROM accounts WHERE id = ?`, id).
		Scan(&d.Account.ID, &d.Account.Name, &d.Account.CountryCode, &d.Account.Status, &d.CreatedAt)
	if err != nil {
		return nil, err
	}
	if d.Members, err = s.MemberList(ctx, id); err != nil {
		return nil, err
	}
	if d.Locations, err = s.LocationsByAccount(ctx, id); err != nil {
		return nil, err
	}
	logs, err := s.AccessLogsByAccount(ctx, id, 25)
	if err != nil {
		return nil, err
	}
	for _, l := range logs {
		d.Recent = append(d.Recent, AuditLogEntry{
			ID: l.ID, TS: l.TS, Command: l.Command, Source: l.Source,
			Success: l.Success, Error: l.Error,
			AccountID: l.AccountID, LocationID: l.LocationID,
			AccessPointID: l.AccessPointID, UserID: l.UserID,
			ReconcilesLogID: l.ReconcilesLogID,
		})
	}
	return &d, nil
}
