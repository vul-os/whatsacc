package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"testing"
)

// TestRoutegenParsesServerGo is a smoke test that keeps `go test ./...`
// honest about this tool: if server.go's Router() ever stops parsing (syntax
// error, moved file, etc.) this fails loudly here in the gateway CI job,
// rather than the frontend route-parity test silently getting an empty route
// list and "passing" for the wrong reason.
func TestRoutegenParsesServerGo(t *testing.T) {
	out, err := exec.Command("go", "run", ".", "../../internal/httpapi/server.go").CombinedOutput()
	if err != nil {
		t.Fatalf("routegen failed: %v\n%s", err, out)
	}
	var routes []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &routes); err != nil {
		t.Fatalf("routegen did not emit valid JSON: %v\n%s", err, out)
	}
	if len(routes) < 20 {
		t.Fatalf("routegen only found %d routes — server.go's Router() likely stopped parsing as expected (mux.Handle/mux.HandleFunc calls)", len(routes))
	}
	// A couple of known-stable anchors — if these disappear, either the
	// route was removed for real (update this test) or extraction broke.
	want := map[string]bool{"GET /v1/access-points": false, "POST /v1/auth/login": false}
	for _, r := range routes {
		key := r.Method + " " + r.Path
		if _, ok := want[key]; ok {
			want[key] = true
		}
	}
	for k, found := range want {
		if !found {
			t.Errorf("expected route %q not found in routegen output", k)
		}
	}
}
