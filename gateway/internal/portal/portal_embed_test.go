//go:build portal

package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The -tags portal build serves dist/ with SPA history fallback: index.html
// for the root and for unknown client routes, but a real 404 for missing
// asset-looking paths (so a broken bundle reference never renders as a blank
// 200). Exercised against the committed dist/ placeholder.
func TestPortalBuildSPAFallback(t *testing.T) {
	if !spaFallback {
		t.Fatal("portal build must enable SPA fallback")
	}
	h := Handler()

	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		return rec
	}

	if rec := get("/"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "lintel") {
		t.Errorf("root: %d %s", rec.Code, rec.Body)
	}
	// unknown client route → index.html (200), so deep links work
	if rec := get("/admin/accounts"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<html") {
		t.Errorf("client route fallback: %d", rec.Code)
	}
	// missing asset → 404, not HTML
	if rec := get("/assets/missing-bundle.js"); rec.Code != http.StatusNotFound {
		t.Errorf("missing asset must 404: %d", rec.Code)
	}
}
