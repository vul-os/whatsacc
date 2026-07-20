// Package lanserver is the LAN transport for offline grant redemption
// (proto/grants.md §LAN): plain HTTP on a LAN TCP port — POST /grant/open →
// grant.challenge, POST /grant/proof → grant.result — advertised via mDNS
// _lintel._tcp (TXT device=<device_id>, proto=0). Plain HTTP is
// acceptable: every message is Ed25519-signed and single-use; the transport
// adds no trust. Verification lives entirely in the shared grants.Exchange
// (the same core the BLE session drives).
package lanserver

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/vul-os/lintel/controller/internal/blesession"
	"github.com/vul-os/lintel/controller/internal/grants"
	"github.com/vul-os/lintel/controller/internal/mdns"
)

// MaxBody bounds request bodies (a grant.open with a full grant is < 8 KiB,
// mirroring the BLE frame cap).
const MaxBody = 8 * 1024

// Server serves the two redemption endpoints.
type Server struct {
	DeviceID   string
	Exchange   *grants.Exchange
	Env        func() grants.Env
	OnRedeemed blesession.Redeemed
	Log        *slog.Logger
}

// Handler returns the HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /grant/open", s.handleOpen)
	mux.HandleFunc("POST /grant/proof", s.handleProof)
	return mux
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(body) > MaxBody {
		writeJSON(w, http.StatusOK, &grants.Result{V: 0, Typ: "grant.result", Result: "denied", Detail: "frame_too_large"})
		return
	}
	ch, err := s.Exchange.HandleOpen(body, s.Env())
	if err != nil {
		writeJSON(w, http.StatusOK, &grants.Result{V: 0, Typ: "grant.result", Result: "denied", Detail: "badsig"})
		return
	}
	writeJSON(w, http.StatusOK, ch)
}

func (s *Server) handleProof(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(body) > MaxBody {
		writeJSON(w, http.StatusOK, &grants.Result{V: 0, Typ: "grant.result", Result: "denied", Detail: "frame_too_large"})
		return
	}
	res, g, p := s.Exchange.HandleProof(body, s.Env())
	if res.Result == "opened" && s.OnRedeemed != nil {
		s.OnRedeemed(g, p)
	}
	writeJSON(w, http.StatusOK, res)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// Serve listens on addr (e.g. ":8737"), advertises via mDNS, and blocks
// until ctx is done.
func (s *Server) Serve(ctx context.Context, addr string) error {
	log := s.Log
	if log == nil {
		log = slog.Default()
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	var port uint16
	if p, err := net.LookupPort("tcp", portStr); err == nil {
		port = uint16(p)
	}
	adv := &mdns.Advertiser{
		Instance: instanceName(s.DeviceID),
		Port:     port,
		TXT:      []string{"device=" + s.DeviceID, "proto=0"},
		Log:      log,
	}
	go func() {
		if err := adv.Serve(ctx); err != nil {
			log.Warn("mdns advertiser stopped", "err", err) // best-effort
		}
	}()
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	log.Info("lan grant listener", "addr", ln.Addr().String(), "mdns", adv.Instance+"._lintel._tcp.local")
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// instanceName mirrors the BLE local name: lintel-<first 8 hex of device_id>.
func instanceName(deviceID string) string {
	hex := make([]byte, 0, 8)
	for i := 0; i < len(deviceID) && len(hex) < 8; i++ {
		c := deviceID[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') {
			hex = append(hex, c)
		}
	}
	return "lintel-" + string(hex)
}
