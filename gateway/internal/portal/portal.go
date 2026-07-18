// Package portal embeds the management portal into the gateway binary.
//
// This is the seam only: static/ currently holds a placeholder page. The real
// portal (Svelte 5 build, shared with the Tauri app) will drop its production
// bundle into static/ at build time and this package will serve it unchanged
// — SPA fallback and asset routing get wired then.
package portal

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed static
var staticFS embed.FS

// Handler serves the embedded portal at /.
func Handler() http.Handler {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err) // embed is compile-time; cannot fail at runtime
	}
	return http.FileServerFS(sub)
}
