// Command routegen is the Go side of the frontend/gateway route-parity test
// (see src/lib/__tests__/routeParity.test.ts).
//
// It parses gateway/internal/httpapi/server.go with go/parser — NOT regex —
// and walks the AST for every mux.HandleFunc(...) / mux.Handle(...) call
// inside Router(), extracting the "METHOD /path" string literal each one
// registers. That is the single source of truth for what the gateway
// actually serves; this tool exists so the frontend test can diff against it
// mechanically instead of a hand-maintained (and driftable) list.
//
// Output: a JSON array of {"method": "...", "path": "..."} on stdout, sorted
// for stable diffs. Bare pattern registrations with no method prefix (e.g.
// the "/" catch-all that serves the embedded portal) are skipped — they are
// not endpoints the frontend api client calls by method+path.
//
// Usage: go run ./cmd/routegen [path/to/server.go]
// Defaults to internal/httpapi/server.go relative to the gateway module root.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

var methodPrefix = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(/.*)$`)

func main() {
	target := "internal/httpapi/server.go"
	if len(os.Args) > 1 {
		target = os.Args[1]
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		fmt.Fprintln(os.Stderr, "routegen:", err)
		os.Exit(1)
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, abs, nil, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "routegen: parse:", err)
		os.Exit(1)
	}

	var routes []route
	seen := map[string]bool{}

	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		// mux.HandleFunc(pattern, handler) / mux.Handle(pattern, handler)
		if sel.Sel.Name != "HandleFunc" && sel.Sel.Name != "Handle" {
			return true
		}
		if len(call.Args) == 0 {
			return true
		}
		lit, ok := call.Args[0].(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		pattern, err := strconv.Unquote(lit.Value)
		if err != nil {
			return true
		}
		m := methodPrefix.FindStringSubmatch(pattern)
		if m == nil {
			// Bare pattern (e.g. "/") — not a method+path endpoint the
			// frontend api client would call. Skip.
			return true
		}
		method, path := m[1], m[2]
		// Go 1.22 mux patterns allow "METHOD /path" or "METHOD host/path" —
		// this codebase never uses a host prefix, but strip defensively.
		if idx := strings.Index(path, "://"); idx >= 0 {
			path = path[idx+3:]
		}
		key := method + " " + path
		if seen[key] {
			return true
		}
		seen[key] = true
		routes = append(routes, route{Method: method, Path: path})
		return true
	})

	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Path != routes[j].Path {
			return routes[i].Path < routes[j].Path
		}
		return routes[i].Method < routes[j].Method
	})

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(routes); err != nil {
		fmt.Fprintln(os.Stderr, "routegen: encode:", err)
		os.Exit(1)
	}
}
