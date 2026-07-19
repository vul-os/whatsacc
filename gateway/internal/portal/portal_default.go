//go:build !portal

package portal

import (
	"embed"
	"io/fs"
)

//go:embed static
var staticFS embed.FS

// Default build: serve the placeholder page, no SPA fallback (there is no
// client router to hand unmatched paths to). Build with `-tags portal` to
// embed the real React bundle from dist/ instead.
func init() {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err) // embed is compile-time; cannot fail at runtime
	}
	content = sub
	spaFallback = false
}
