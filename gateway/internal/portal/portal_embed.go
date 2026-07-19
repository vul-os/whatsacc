//go:build portal

package portal

import (
	"embed"
	"io/fs"
)

// The real portal build. dist/ is populated by the documented copy step
// (npm run build && cp -r dist gateway/internal/portal/dist) — a committed
// dist/index.html placeholder keeps this compilable before that runs.
//
//go:embed all:dist
var distFS embed.FS

func init() {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err) // embed is compile-time; cannot fail at runtime
	}
	content = sub
	spaFallback = true
}
