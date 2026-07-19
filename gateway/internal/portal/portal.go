// Package portal embeds the management portal into the gateway binary.
//
// Two build modes, selected by a build tag so the default `go build` never
// needs a compiled frontend present:
//
//   - default (no tag): serves the placeholder page in static/. This is what
//     CI and a bare checkout build.
//
//   - `-tags portal`: serves the real React SPA (Vite build) embedded from
//     internal/portal/dist/, with SPA history fallback. Populate that dir
//     first with the documented copy step, then build:
//
//     npm run build && cp -r dist gateway/internal/portal/dist
//     go build -tags portal ./gateway/cmd/gateway
//
// The React app is the same bundle the Tauri desktop shell ships; it talks to
// this gateway's /v1 API. Which files are embedded, and whether SPA fallback
// applies, is decided in the build-tagged files (portal_default.go /
// portal_embed.go) — this file only holds the shared serving logic.
package portal

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// content is the embedded file tree to serve, set by the active build-tagged
// file. spaFallback is true for the real SPA build (unknown non-asset paths
// rewrite to index.html so client-side routes deep-link).
var (
	content     fs.FS
	spaFallback bool
)

// Handler serves the embedded portal at /. With spaFallback on, a request
// that doesn't map to an embedded file (and isn't an asset request) is served
// index.html so the React router can take over.
func Handler() http.Handler {
	fileServer := http.FileServerFS(content)
	if !spaFallback {
		return fileServer
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(content, p); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Asset-looking misses (a hashed bundle that isn't there) must 404,
		// not silently return HTML — otherwise a broken script tag renders as
		// a blank page under a 200. Everything else is a client route.
		if strings.Contains(path.Base(p), ".") {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r)
	})
}

// serveIndex writes the embedded index.html for a client-route request.
func serveIndex(w http.ResponseWriter, _ *http.Request) {
	raw, err := fs.ReadFile(content, "index.html")
	if err != nil {
		http.Error(w, "portal index missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(raw)
}
