// Package jcs renders Go values as RFC 8785 (JCS) canonical JSON, for the
// subset of values the whatsacc wire contracts use.
//
// DUPLICATION NOTE: this file is a copy/adaptation of
// gateway/internal/keys/jcs.go. The controller is its own Go module
// (github.com/vul-os/whatsacc/controller) so it can be vendored onto devices
// without dragging in the gateway; the ~170 lines of JCS are deliberately
// duplicated rather than imported. If a canonicalization bug is found, fix
// it in BOTH places and re-run each module's conformance-vector tests
// (proto/vectors/) — the vectors are the arbiter, not either copy.
package jcs

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Canonicalize renders v as RFC 8785 (JCS) canonical JSON.
//
// Implemented per RFC 8785: no insignificant whitespace; object keys sorted
// by UTF-16 code units; strings with the shortest-form escapes (\b \t \n \f
// \r \" \\ and \u00XX for other control chars, everything else literal
// UTF-8); literals true/false/null; arrays in order.
//
// DEVIATION (documented, on purpose): full ECMAScript double formatting for
// non-integer numbers is NOT implemented — envelopes only carry integers
// (iat, exp, v, rssi, …) and strings, so Canonicalize accepts integral
// numbers within the IEEE-754 safe range (|n| <= 2^53) and returns an error
// for anything else. If proto/vectors/ later ships vectors requiring general
// doubles, implement the Ryu/ECMAScript algorithm and drop this restriction.
func Canonicalize(v any) ([]byte, error) {
	var b strings.Builder
	if err := writeJCS(&b, v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

// CanonicalizeJSON canonicalizes a raw JSON document (parse, then re-render
// canonically).
func CanonicalizeJSON(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return Canonicalize(v)
}

func writeJCS(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJCSString(b, x)
	case int:
		b.WriteString(strconv.FormatInt(int64(x), 10))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case uint64:
		b.WriteString(strconv.FormatUint(x, 10))
	case float64:
		return writeJCSFloat(b, x)
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return err
		}
		return writeJCSFloat(b, f)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeJCS(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJCSString(b, k)
			b.WriteByte(':')
			if err := writeJCS(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("jcs: unsupported type %T", v)
	}
	return nil
}

func writeJCSFloat(b *strings.Builder, f float64) error {
	if f != math.Trunc(f) || math.Abs(f) > 1<<53 || math.IsNaN(f) || math.IsInf(f, 0) {
		return fmt.Errorf("jcs: non-integer number %v not supported (see Canonicalize deviation note)", f)
	}
	b.WriteString(strconv.FormatInt(int64(f), 10))
	return nil
}

// writeJCSString emits the RFC 8785 §3.2.2.2 shortest-form string encoding.
func writeJCSString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// lessUTF16 compares strings by UTF-16 code units (RFC 8785 key ordering).
// For BMP-only strings this equals byte order; it differs once one side has
// supplementary-plane characters.
func lessUTF16(a, b string) bool {
	if isASCII(a) && isASCII(b) {
		return a < b
	}
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}
