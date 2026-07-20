package httpapi

// The channel open path: every chat-channel open funnels through the SAME
// store.LogAccess choke point + hub dispatch the HTTP /v1 open route uses
// (open.go). Channels differ only in how they resolve the opener (verified
// phone → visitor grant or member; Slack/Telegram user id → member) and how
// they phrase the reply — never in the authorization. Nothing here
// re-implements verdict logic.

import (
	"context"
	"errors"

	"github.com/vul-os/lintel/gateway/internal/store"
)

// chVerdict is the reply-layer view of a channel open: the choke point's
// verdict plus the hub delivery outcome.
type chVerdict struct {
	Allowed     bool
	Reason      string // rate_limited | quota_exceeded | account_suspended | user_disabled | access_point_not_found
	RetryAfterS int64
	Delivery    string // acked | queued | no_device | undelivered
}

// finishOpen turns a LogAccess result into a chVerdict, dispatching to the
// device when allowed.
func (s *Server) finishOpen(ctx context.Context, command string, res *store.LogAccessResult) chVerdict {
	if res == nil {
		return chVerdict{}
	}
	if !res.Allowed {
		return chVerdict{Reason: res.Reason, RetryAfterS: res.RetryAfterS}
	}
	return chVerdict{Allowed: true, Delivery: s.dispatchCommand(ctx, command, res)}
}

// phoneOpen resolves a phone's authority for an access point (any phone-
// verified channel — today WhatsApp, but the path is channel-agnostic): an
// active visitor grant first (atomic consume, refunded on a limiter denial),
// then verified-member access. hadAccess=false means neither — the caller
// renders "you no longer have access". 'close' is the safe direction: it never
// consumes a grant use and is not rate-limited by the choke point.
//
// source is the calling channel's Kind (e.g. channels.KindWhatsApp) — it is
// the audit_logs.source value, so it MUST be the real channel the request
// came in on. Never hardcode a channel constant here: a wrong source
// misattributes the open in the audit log, which is evidence for a system
// that opens physical gates.
func (s *Server) phoneOpen(ctx context.Context, phoneE164, accessPointID, command, source string) (hadAccess bool, v chVerdict, err error) {
	if command == "open" {
		// Visitor grant path: consume + verdict + refund-on-deny in one call.
		res, grantID, err := s.store.VisitorOpenWithGrant(ctx, s.cfg.RateLimits, phoneE164, accessPointID, source)
		if err != nil {
			return false, chVerdict{}, err
		}
		if grantID != "" {
			return true, s.finishOpen(ctx, command, res), nil
		}
	}
	// Member-by-phone path (also the close path for members AND visitors: a
	// visitor who has an active grant covering this AP counts as having access
	// to close it, without burning a use).
	userID, ok, err := s.store.MemberUserIDByPhoneForAP(ctx, phoneE164, accessPointID)
	if err != nil {
		return false, chVerdict{}, err
	}
	if !ok {
		if command == "close" {
			// Allow a visitor grant holder to close what they opened.
			if has, err := s.phoneHasVisitorGrant(ctx, phoneE164, accessPointID); err != nil {
				return false, chVerdict{}, err
			} else if !has {
				return false, chVerdict{}, nil
			}
		} else {
			return false, chVerdict{}, nil
		}
	}
	res, err := s.store.LogAccess(ctx, s.cfg.RateLimits, store.LogAccessArgs{
		UserID:        userID, // "" for a visitor closing
		PhoneE164:     phoneE164,
		AccessPointID: accessPointID,
		Command:       command,
		Source:        source,
	})
	if errors.Is(err, store.ErrNotFound) {
		return true, chVerdict{Reason: "access_point_not_found"}, nil
	}
	if err != nil {
		return false, chVerdict{}, err
	}
	return true, s.finishOpen(ctx, command, res), nil
}

// phoneHasVisitorGrant reports whether an active grant for this phone covers
// the access point (used to authorize a visitor 'close').
func (s *Server) phoneHasVisitorGrant(ctx context.Context, phoneE164, accessPointID string) (bool, error) {
	gates, err := s.store.AvailableAccessPointsByPhone(ctx, phoneE164, 0)
	if err != nil {
		return false, err
	}
	for _, g := range gates {
		if g.APID == accessPointID && g.Type == store.APVisitor {
			return true, nil
		}
	}
	return false, nil
}

// profileOpen resolves a profile-linked member (Slack/Telegram) and runs the
// choke point. hadAccess=false means the member no longer has access to this
// gate.
func (s *Server) profileOpen(ctx context.Context, profileID, accessPointID, command, source string) (hadAccess bool, v chVerdict, err error) {
	gates, err := s.store.AvailableAccessPointsByProfile(ctx, profileID)
	if err != nil {
		return false, chVerdict{}, err
	}
	has := false
	for _, g := range gates {
		if g.APID == accessPointID {
			has = true
			break
		}
	}
	if !has {
		return false, chVerdict{}, nil
	}
	res, err := s.store.LogAccess(ctx, s.cfg.RateLimits, store.LogAccessArgs{
		UserID:        profileID,
		AccessPointID: accessPointID,
		Command:       command,
		Source:        source,
	})
	if errors.Is(err, store.ErrNotFound) {
		return true, chVerdict{Reason: "access_point_not_found"}, nil
	}
	if err != nil {
		return false, chVerdict{}, err
	}
	return true, s.finishOpen(ctx, command, res), nil
}
