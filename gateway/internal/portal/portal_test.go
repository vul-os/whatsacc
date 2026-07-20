//go:build !portal

package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The default build (no portal tag) serves the placeholder and does NOT do
// SPA fallback — every unknown path is a plain 404, matching a static file
// server. The -tags portal build's SPA behavior is documented and exercised
// manually against a real dist/; here we assert the default seam.
func TestDefaultBuildServesPlaceholder(t *testing.T) {
	h := Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "lintel gateway") {
		t.Fatalf("placeholder: %d %s", rec.Code, rec.Body)
	}
	if spaFallback {
		t.Error("default build must not enable SPA fallback")
	}
}
