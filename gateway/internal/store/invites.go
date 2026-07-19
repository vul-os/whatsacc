package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Invite errors — the backend's accept-invite error vocabulary.
var (
	ErrInviteUsed          = errors.New("invite_used")
	ErrInviteRevoked       = errors.New("invite_revoked")
	ErrInviteExpired       = errors.New("invite_expired")
	ErrInviteEmailMismatch = errors.New("invite_email_mismatch")
	ErrInvitePhoneMismatch = errors.New("invite_phone_mismatch")
)

// Invite is one account invite. TokenHash only — the plaintext accept token
// is NEVER stored and NEVER returned to the inviter (delivered out-of-band to
// the invitee; see backend/src/routes/accounts.ts security note).
type Invite struct {
	ID         string
	AccountID  string
	Email      string
	Role       string
	PhoneE164  string // "" when none
	ExpiresAt  int64
	AcceptedAt sql.NullInt64
	RevokedAt  sql.NullInt64
}

// CreateInvite records an invite under the account. Handlers gate on the
// caller being an admin of accountID first.
func (s *Store) CreateInvite(ctx context.Context, accountID, email, role, phoneE164, tokenHash string, expiresAt int64) (string, error) {
	id := NewID()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO account_invites (id, account_id, email, role, token_hash, phone_e164, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, accountID, strings.ToLower(strings.TrimSpace(email)), role, tokenHash, nullable(phoneE164), expiresAt, now())
	return id, err
}

// SetInviteTokenHash overwrites an invite's token hash. Dev/test ergonomics
// only (backend parity: with delivery mocked, tests recover the token by
// overwriting token_hash via the admin handle) — no HTTP route exposes this.
func (s *Store) SetInviteTokenHash(ctx context.Context, inviteID, tokenHash string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE account_invites SET token_hash = ? WHERE id = ?`, tokenHash, inviteID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// AcceptInviteResult is the successful accept outcome.
type AcceptInviteResult struct {
	AccountID string
	Role      string
	// PhoneVerificationRequired is true when a phone was linked (always
	// UNVERIFIED — accepting an invite never proves phone control; only the
	// OTP verify flow flips verified_at).
	PhoneVerificationRequired bool
}

// AcceptInvite runs the whole transactional accept per the backend spec:
// look the invite up by token hash, reject used/revoked/expired, require the
// accepting user's email to match, upsert the account membership + every
// location membership, mark accepted, and link the invite's phone UNVERIFIED.
//
// SECURITY (ported design choice): accepting NEVER verifies a phone number —
// the accept token is dual-delivered (email AND WhatsApp), so possessing it
// proves nothing about controlling the phone. A body-supplied phone is
// attacker-typed input: it must equal the invite's phone when both exist.
func (s *Store) AcceptInvite(ctx context.Context, tokenHash, userID, bodyPhoneE164 string) (*AcceptInviteResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var inv Invite
	var phone sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT id, account_id, email, role, phone_e164, expires_at, accepted_at, revoked_at
		 FROM account_invites WHERE token_hash = ?`, tokenHash).
		Scan(&inv.ID, &inv.AccountID, &inv.Email, &inv.Role, &phone, &inv.ExpiresAt, &inv.AcceptedAt, &inv.RevokedAt)
	if err != nil {
		return nil, err // ErrNotFound for unknown tokens
	}
	inv.PhoneE164 = phone.String
	switch {
	case inv.AcceptedAt.Valid:
		return nil, ErrInviteUsed
	case inv.RevokedAt.Valid:
		return nil, ErrInviteRevoked
	case inv.ExpiresAt <= now():
		return nil, ErrInviteExpired
	}

	var userEmail string
	if err := tx.QueryRowContext(ctx, `SELECT email FROM users WHERE id = ?`, userID).Scan(&userEmail); err != nil {
		return nil, err
	}
	if !strings.EqualFold(userEmail, inv.Email) {
		return nil, ErrInviteEmailMismatch
	}

	if bodyPhoneE164 != "" && inv.PhoneE164 != "" && bodyPhoneE164 != inv.PhoneE164 {
		return nil, ErrInvitePhoneMismatch
	}
	effectivePhone := bodyPhoneE164
	if effectivePhone == "" {
		effectivePhone = inv.PhoneE164
	}

	if err := upsertAccountMember(ctx, tx, inv.AccountID, userID, inv.Role); err != nil {
		return nil, err
	}
	if err := upsertLocationMembersForAccount(ctx, tx, inv.AccountID, userID, inv.Role); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE account_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?`,
		now(), userID, inv.ID); err != nil {
		return nil, err
	}

	res := &AcceptInviteResult{AccountID: inv.AccountID, Role: inv.Role}
	if effectivePhone != "" {
		// Link UNVERIFIED and non-primary (unverified phones cannot be
		// primary). Re-linking an existing row leaves it untouched.
		t := now()
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO profile_phone_numbers (id, profile_id, phone_e164, is_primary, verified_at, created_at, updated_at)
			 VALUES (?, ?, ?, 0, NULL, ?, ?)
			 ON CONFLICT (profile_id, phone_e164) DO NOTHING`,
			NewID(), userID, effectivePhone, t, t); err != nil {
			return nil, err
		}
		var verified sql.NullInt64
		if err := tx.QueryRowContext(ctx,
			`SELECT verified_at FROM profile_phone_numbers WHERE profile_id = ? AND phone_e164 = ?`,
			userID, effectivePhone).Scan(&verified); err != nil {
			return nil, err
		}
		res.PhoneVerificationRequired = !verified.Valid
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return res, nil
}

// PhoneVerified reports whether a profile phone row exists and is verified —
// test hook for the "accept never auto-verifies" invariant.
func (s *Store) PhoneVerified(ctx context.Context, userID, phoneE164 string) (linked, verified bool, err error) {
	var v sql.NullInt64
	err = s.db.QueryRowContext(ctx,
		`SELECT verified_at FROM profile_phone_numbers WHERE profile_id = ? AND phone_e164 = ?`,
		userID, phoneE164).Scan(&v)
	if errors.Is(err, ErrNotFound) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return true, v.Valid, nil
}
