package channels

import (
	"fmt"
	"strconv"
	"strings"
)

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// DenialMessage is the honest, user-facing copy for a denied OPEN attempt,
// shared by every channel (backend lib/rate-limit.ts chatDenialMessage). The
// exact strings are a behavioral contract — a denial never pretends the gate
// opened.
func DenialMessage(reason string, retryAfterS int64, publicURL string) string {
	switch reason {
	case "account_suspended":
		return "This account has been suspended by the gateway operator — the gate cannot be opened. Contact your operator for help."
	case "user_disabled":
		return "Your lintel user has been disabled by the gateway operator — the gate cannot be opened. Contact your operator for help."
	case "quota_exceeded":
		return "Daily limit reached for this location — contact your admin. The web portal: " + trimURL(publicURL) + "/app"
	default: // rate_limited
		mins := (retryAfterS + 59) / 60
		if mins < 1 {
			mins = 1
		}
		return fmt.Sprintf("Too many opens — try again in ~%d min.", mins)
	}
}

func trimURL(u string) string { return strings.TrimRight(u, "/") }
