package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Minimal HS256 JWT — std-lib only, deliberately no dependency. Only what the
// gateway needs: iss "lintel", sub, email, admin flag, iat/exp.

// Claims is the access-token payload.
type Claims struct {
	Iss     string `json:"iss"`
	Sub     string `json:"sub"`
	Email   string `json:"email,omitempty"`
	IsAdmin bool   `json:"adm,omitempty"`
	IAT     int64  `json:"iat"`
	EXP     int64  `json:"exp"`
}

var (
	// ErrTokenInvalid covers malformed tokens and bad signatures.
	ErrTokenInvalid = errors.New("token_invalid")
	// ErrTokenExpired is returned for structurally valid but expired tokens.
	ErrTokenExpired = errors.New("token_expired")
)

const jwtIssuer = "lintel"

var jwtHeaderB64 = b64(`{"alg":"HS256","typ":"JWT"}`)

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

// SignJWT issues an HS256 token for the user with the given TTL.
func SignJWT(secret []byte, sub, email string, isAdmin bool, ttl time.Duration) (string, error) {
	now := time.Now()
	c := Claims{Iss: jwtIssuer, Sub: sub, Email: email, IsAdmin: isAdmin,
		IAT: now.Unix(), EXP: now.Add(ttl).Unix()}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signing := jwtHeaderB64 + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signing))
	return signing + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// VerifyJWT validates signature, issuer and expiry, returning the claims.
func VerifyJWT(secret []byte, token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrTokenInvalid
	}
	// The header is fixed at issue time; verify by recomputation, not by
	// trusting an attacker-controlled alg field (no alg:none, no downgrade).
	if parts[0] != jwtHeaderB64 {
		return nil, ErrTokenInvalid
	}
	signing := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signing))
	want := mac.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(got, want) {
		return nil, ErrTokenInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrTokenInvalid
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, ErrTokenInvalid
	}
	if c.Iss != jwtIssuer || c.Sub == "" {
		return nil, ErrTokenInvalid
	}
	if time.Now().Unix() >= c.EXP {
		return nil, ErrTokenExpired
	}
	return &c, nil
}
