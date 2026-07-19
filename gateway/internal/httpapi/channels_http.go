package httpapi

// Shared plumbing for the chat-channel webhooks.

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// contextT is a short alias used across the channel handlers.
type contextT = context.Context

// readWebhookBody slurps the raw request body (capped) for signature
// verification — providers HMAC the exact bytes, so a struct round-trip would
// lose them.
func (s *Server) readWebhookBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body")
		return nil, false
	}
	return raw, true
}

// channelPublicURL is the external base URL for signup/dashboard links.
func (s *Server) channelPublicURL() string {
	if s.cfg.Channels.PublicURL != "" {
		return s.cfg.Channels.PublicURL
	}
	return s.cfg.PublicURL
}

func trimURL(u string) string { return strings.TrimRight(u, "/") }
