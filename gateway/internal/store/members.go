package store

import (
	"context"
	"database/sql"
)

// Member is one row of an account's member roster (backend
// app.account_member_list shape: membership joined with user + profile).
type Member struct {
	UserID      string
	Role        string
	Status      string
	Email       string
	DisplayName string // "" when the profile has none
}

// MemberList returns the full roster for an account. Handlers must gate on
// membership first (the caller sees co-members only for accounts they belong
// to — the SECURITY DEFINER helper's self-gate, done in the HTTP layer here).
func (s *Store) MemberList(ctx context.Context, accountID string) ([]Member, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT am.user_id, am.role, am.status, u.email, coalesce(p.display_name, '')
		 FROM account_members am
		 JOIN users u ON u.id = am.user_id
		 LEFT JOIN profiles p ON p.id = am.user_id
		 WHERE am.account_id = ?
		 ORDER BY am.joined_at ASC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Role, &m.Status, &m.Email, &m.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// upsertAccountMember mirrors the backend's ON CONFLICT DO UPDATE on
// account_members: role is replaced and status re-activated.
func upsertAccountMember(ctx context.Context, tx *sql.Tx, accountID, userID, role string) error {
	t := now()
	_, err := tx.ExecContext(ctx,
		`INSERT INTO account_members (account_id, user_id, role, status, joined_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', ?, ?, ?)
		 ON CONFLICT (account_id, user_id) DO UPDATE SET
		     role = excluded.role, status = 'active', updated_at = excluded.updated_at`,
		accountID, userID, role, t, t, t)
	return err
}

// upsertLocationMembersForAccount adds the user to every location of the
// account (invite-accept semantics).
func upsertLocationMembersForAccount(ctx context.Context, tx *sql.Tx, accountID, userID, role string) error {
	t := now()
	_, err := tx.ExecContext(ctx,
		`INSERT INTO location_members (location_id, user_id, role, created_at, updated_at)
		 SELECT id, ?, ?, ?, ? FROM locations WHERE account_id = ?
		 ON CONFLICT (location_id, user_id) DO UPDATE SET
		     role = excluded.role, updated_at = excluded.updated_at`,
		userID, role, t, t, accountID)
	return err
}

// UpsertLocationMember adds (or re-roles) one user on one location.
func (s *Store) UpsertLocationMember(ctx context.Context, locationID, userID, role string) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO location_members (location_id, user_id, role, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (location_id, user_id) DO UPDATE SET
		     role = excluded.role, updated_at = excluded.updated_at`,
		locationID, userID, role, t, t)
	return err
}

// RenameAccount updates the account name; ErrNotFound when the id is unknown.
// Tenancy: handlers only call this after an admin-role gate on accountID.
func (s *Store) RenameAccount(ctx context.Context, accountID, name string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?`, name, now(), accountID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// AccountByIDScoped returns the account iff the user is an active member —
// the read path handlers use for GET /v1/accounts/:id.
func (s *Store) AccountByIDScoped(ctx context.Context, accountID, userID string) (*Account, error) {
	var a Account
	err := s.db.QueryRowContext(ctx,
		`SELECT a.id, a.name, a.country_code, a.status, m.role
		 FROM accounts a JOIN account_members m ON m.account_id = a.id
		 WHERE a.id = ? AND m.user_id = ? AND m.status = 'active'`, accountID, userID).
		Scan(&a.ID, &a.Name, &a.CountryCode, &a.Status, &a.Role)
	if err != nil {
		return nil, err
	}
	return &a, nil
}
