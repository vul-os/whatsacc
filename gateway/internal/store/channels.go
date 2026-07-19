package store

// The channel seam's persistence layer: identity resolution keyed on
// (channel, external_id), the available-access-point lookup (port of backend
// src/lib/access-lookup.ts getAvailableAccessPoints), linked-location menus,
// and the channel chat/message log with inbound dedupe. Everything here is
// channel-agnostic; the httpapi channel handlers + internal/channels supply
// the per-provider wire translation.

import (
	"context"
	"database/sql"
	"encoding/json"
)

// APAccessType is how a phone/profile reaches an access point.
type APAccessType string

const (
	APMember  APAccessType = "member"
	APVisitor APAccessType = "visitor"
)

// AvailableAP mirrors backend AvailableAP: an access point a sender may open,
// with the location it lives in and (for visitor grants) the remaining-uses
// bookkeeping used to render "N uses remaining".
type AvailableAP struct {
	APID      string
	APName    string
	LocID     string
	LocName   string
	Type      APAccessType
	GrantID   string        // "" unless Type == APVisitor
	MaxUses   sql.NullInt64 // visitor grant cap (null = unlimited)
	UsesCount int64
}

// LinkedLocation is one distinct location a phone is linked to (menu row).
type LinkedLocation struct {
	ID   string
	Name string
}

// AvailableAccessPointsByPhone returns every access point a phone can open:
// active visitor grants first (backend order — visitor grants push before
// member access), then member-by-verified-phone access, de-duplicated by
// access point. Disabled users and suspended memberships are filtered out.
func (s *Store) AvailableAccessPointsByPhone(ctx context.Context, phoneE164 string, nowUnix int64) ([]AvailableAP, error) {
	if nowUnix == 0 {
		nowUnix = now()
	}
	var out []AvailableAP
	seen := map[string]bool{}

	// 1. Visitor grants by phone.
	rows, err := s.db.QueryContext(ctx,
		`SELECT g.id, g.max_uses, g.uses_count,
		        ap.id, ap.name, l.id, l.name
		 FROM temporary_access_grants g
		 JOIN temporary_access_grant_access_points t ON t.grant_id = g.id
		 JOIN access_points ap ON ap.id = t.access_point_id
		 JOIN locations l ON l.id = ap.location_id
		 WHERE g.phone_e164 = ?
		   AND g.status = 'active'
		   AND g.starts_at <= ? AND g.ends_at > ?
		   AND (g.max_uses IS NULL OR g.uses_count < g.max_uses)
		   AND ap.status = 'active'
		 ORDER BY g.ends_at ASC`, phoneE164, nowUnix, nowUnix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ap AvailableAP
		ap.Type = APVisitor
		if err := rows.Scan(&ap.GrantID, &ap.MaxUses, &ap.UsesCount, &ap.APID, &ap.APName, &ap.LocID, &ap.LocName); err != nil {
			return nil, err
		}
		if seen[ap.APID] {
			continue
		}
		seen[ap.APID] = true
		out = append(out, ap)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 2. Member access by verified phone.
	mrows, err := s.db.QueryContext(ctx,
		`SELECT ap.id, ap.name, l.id, l.name
		 FROM profile_phone_numbers ppn
		 JOIN users u ON u.id = ppn.profile_id
		 JOIN account_members am ON am.user_id = ppn.profile_id
		 JOIN locations l ON l.account_id = am.account_id
		 JOIN access_points ap ON ap.location_id = l.id
		 WHERE ppn.phone_e164 = ?
		   AND ppn.verified_at IS NOT NULL
		   AND u.status = 'active'
		   AND am.status = 'active'
		   AND ap.status = 'active'`, phoneE164)
	if err != nil {
		return nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		var ap AvailableAP
		ap.Type = APMember
		if err := mrows.Scan(&ap.APID, &ap.APName, &ap.LocID, &ap.LocName); err != nil {
			return nil, err
		}
		if seen[ap.APID] {
			continue
		}
		seen[ap.APID] = true
		out = append(out, ap)
	}
	return out, mrows.Err()
}

// AvailableAccessPointsByProfile returns member access resolved by profile id
// (the Slack / Telegram path — identity came from channel_identities, not a
// phone). Disabled users and suspended memberships are filtered out.
func (s *Store) AvailableAccessPointsByProfile(ctx context.Context, profileID string) ([]AvailableAP, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT ap.id, ap.name, l.id, l.name
		 FROM profiles p
		 JOIN users u ON u.id = p.id
		 JOIN account_members am ON am.user_id = p.id
		 JOIN locations l ON l.account_id = am.account_id
		 JOIN access_points ap ON ap.location_id = l.id
		 WHERE p.id = ?
		   AND u.status = 'active'
		   AND am.status = 'active'
		   AND ap.status = 'active'`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AvailableAP
	seen := map[string]bool{}
	for rows.Next() {
		var ap AvailableAP
		ap.Type = APMember
		if err := rows.Scan(&ap.APID, &ap.APName, &ap.LocID, &ap.LocName); err != nil {
			return nil, err
		}
		if seen[ap.APID] {
			continue
		}
		seen[ap.APID] = true
		out = append(out, ap)
	}
	return out, rows.Err()
}

// LinkedLocationsByPhone lists the distinct active locations a verified,
// active phone is a member of (the welcome/location menu when there are no
// ready access points). Disabled users get no menus (backend parity).
func (s *Store) LinkedLocationsByPhone(ctx context.Context, phoneE164 string) ([]LinkedLocation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT l.id, l.name
		 FROM profile_phone_numbers ppn
		 JOIN users u ON u.id = ppn.profile_id
		 JOIN account_members am ON am.user_id = ppn.profile_id
		 JOIN locations l ON l.account_id = am.account_id
		 WHERE ppn.phone_e164 = ?
		   AND ppn.verified_at IS NOT NULL
		   AND u.status = 'active'
		   AND am.status = 'active'
		   AND l.status = 'active'
		 ORDER BY l.name ASC`, phoneE164)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LinkedLocation
	for rows.Next() {
		var l LinkedLocation
		if err := rows.Scan(&l.ID, &l.Name); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// PhoneLinkState reports (linked, activeLinked) for a phone — the two facts
// the WhatsApp handler needs to tell "not linked, sign up" from "linked but
// your account is disabled" without a second misleading nudge.
func (s *Store) PhoneLinkState(ctx context.Context, phoneE164 string) (linked, activeLinked bool, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT
		   EXISTS (SELECT 1 FROM profile_phone_numbers
		           WHERE phone_e164 = ? AND verified_at IS NOT NULL),
		   EXISTS (SELECT 1 FROM profile_phone_numbers ppn
		           JOIN users u ON u.id = ppn.profile_id
		           WHERE ppn.phone_e164 = ? AND ppn.verified_at IS NOT NULL
		             AND u.status = 'active')`,
		phoneE164, phoneE164).Scan(&linked, &activeLinked)
	return linked, activeLinked, err
}

// MemberUserIDByPhoneForAP returns the active member's user id when a verified
// phone has member access to a specific access point (the WhatsApp non-visitor
// open path — backend's memberCheck). ok=false when there is no such member.
func (s *Store) MemberUserIDByPhoneForAP(ctx context.Context, phoneE164, accessPointID string) (string, bool, error) {
	var userID string
	err := s.db.QueryRowContext(ctx,
		`SELECT am.user_id
		 FROM profile_phone_numbers ppn
		 JOIN users u ON u.id = ppn.profile_id
		 JOIN account_members am ON am.user_id = ppn.profile_id
		 JOIN locations l ON l.account_id = am.account_id
		 JOIN access_points ap ON ap.location_id = l.id
		 WHERE ppn.phone_e164 = ? AND ppn.verified_at IS NOT NULL
		   AND ap.id = ? AND u.status = 'active' AND am.status = 'active'
		 LIMIT 1`, phoneE164, accessPointID).Scan(&userID)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return userID, true, nil
}

// ---------------------------------------------------------------------------
// Channel identities (Slack / Telegram): (channel, external_id) → profile
// ---------------------------------------------------------------------------

// ResolveChannelIdentity returns the member profile id linked to a channel's
// external id, or ErrNotFound. This is the seam's identity resolver for
// channels whose identity is not a phone number.
func (s *Store) ResolveChannelIdentity(ctx context.Context, channel, externalID string) (string, error) {
	var profileID string
	err := s.db.QueryRowContext(ctx,
		`SELECT profile_id FROM channel_identities WHERE channel = ? AND external_id = ?`,
		channel, externalID).Scan(&profileID)
	if err != nil {
		return "", err
	}
	return profileID, nil
}

// ChannelIdentityDisplayName returns the linked profile's display name (""
// when none / unresolved) — used to greet a Slack/Telegram member by name.
func (s *Store) ChannelIdentityDisplayName(ctx context.Context, channel, externalID string) (string, error) {
	var name sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT p.display_name
		 FROM channel_identities ci JOIN profiles p ON p.id = ci.profile_id
		 WHERE ci.channel = ? AND ci.external_id = ?`, channel, externalID).Scan(&name)
	if err != nil {
		return "", err
	}
	return name.String, nil
}

// LinkChannelIdentity upserts a (channel, external_id) → profile mapping.
// Admin/onboarding surface (the portal Members page links a Slack/Telegram id
// to a member); also used by tests.
func (s *Store) LinkChannelIdentity(ctx context.Context, channel, externalID, profileID string) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_identities (channel, external_id, profile_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (channel, external_id) DO UPDATE SET
		   profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
		channel, externalID, profileID, t, t)
	return err
}

// AddVerifiedPhone links a verified phone to a profile (WhatsApp identity /
// onboarding). Idempotent per (profile, phone). The one-verified-owner unique
// index (migration 0002) prevents two profiles claiming the same number.
func (s *Store) AddVerifiedPhone(ctx context.Context, profileID, phoneE164 string) error {
	t := now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO profile_phone_numbers (id, profile_id, phone_e164, verified_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (profile_id, phone_e164) DO UPDATE SET
		   verified_at = excluded.verified_at, updated_at = excluded.updated_at`,
		NewID(), profileID, phoneE164, t, t, t)
	return err
}

// ---------------------------------------------------------------------------
// Channel chat + message log
// ---------------------------------------------------------------------------

// UpsertChannelChat finds-or-creates the chat thread for (channel, externalKey)
// and stamps last_inbound_at. profileID/phone/meta are best-effort context.
// Returns the chat id.
func (s *Store) UpsertChannelChat(ctx context.Context, channel, externalKey, profileID, phoneE164 string, meta map[string]any) (string, error) {
	metaJSON := []byte("{}")
	if meta != nil {
		if b, err := json.Marshal(meta); err == nil {
			metaJSON = b
		}
	}
	t := now()
	id := NewID()
	// INSERT ... ON CONFLICT keeps the original id; coalesce so a resolved
	// profile is never blanked by a later anonymous inbound.
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_chats (id, channel, external_key, profile_id, phone_e164, meta,
		                            last_inbound_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (channel, external_key) DO UPDATE SET
		   last_inbound_at = excluded.last_inbound_at,
		   profile_id = coalesce(channel_chats.profile_id, excluded.profile_id),
		   phone_e164 = coalesce(channel_chats.phone_e164, excluded.phone_e164),
		   meta = excluded.meta,
		   updated_at = excluded.updated_at`,
		id, channel, externalKey, nullable(profileID), nullable(phoneE164), string(metaJSON), t, t, t)
	if err != nil {
		return "", err
	}
	var got string
	if err := s.db.QueryRowContext(ctx,
		`SELECT id FROM channel_chats WHERE channel = ? AND external_key = ?`,
		channel, externalKey).Scan(&got); err != nil {
		return "", err
	}
	return got, nil
}

// InsertInboundMessage logs an inbound message and reports whether it is NEW.
// isNew == false means a redelivered webhook (same provider message id) — the
// caller must not reply or open again. Messages with no provider id are always
// new (never deduped).
func (s *Store) InsertInboundMessage(ctx context.Context, chatID, channel, kind string, body any, providerMessageID string, ts int64) (bool, error) {
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		bodyJSON = []byte("{}")
	}
	if ts == 0 {
		ts = now()
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_messages (id, chat_id, channel, direction, kind, body, provider_message_id, status, ts, created_at)
		 VALUES (?, ?, ?, 'in', ?, ?, ?, 'received', ?, ?)
		 ON CONFLICT (channel, provider_message_id) WHERE direction = 'in' AND provider_message_id IS NOT NULL
		 DO NOTHING`,
		NewID(), chatID, channel, kind, string(bodyJSON), nullable(providerMessageID), ts, now())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// InsertOutboundMessage logs one reply the bot sent (status = sent |
// failed:<err>) and stamps last_outbound_at on the chat.
func (s *Store) InsertOutboundMessage(ctx context.Context, chatID, channel, kind string, body any, providerMessageID, status string) error {
	bodyJSON, err := json.Marshal(body)
	if err != nil {
		bodyJSON = []byte("{}")
	}
	t := now()
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO channel_messages (id, chat_id, channel, direction, kind, body, provider_message_id, status, ts, created_at)
		 VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
		NewID(), chatID, channel, kind, string(bodyJSON), nullable(providerMessageID), status, t, t); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE channel_chats SET last_outbound_at = ?, updated_at = ? WHERE id = ?`, t, t, chatID)
	return err
}
