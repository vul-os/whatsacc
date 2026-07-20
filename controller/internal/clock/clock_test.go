package clock_test

import (
	"testing"

	"github.com/vul-os/lintel/controller/internal/clock"
)

// TestStaleBothDirections covers the defect: a naive "elapsed > limit"
// check only catches a clock that has drifted too far FORWARD. A clock
// reset BACKWARD past lastSynced (RTC-less reboot landing before the
// persisted sync instant) produces a negative elapsed time that such a
// check never flags. Stale must fail closed in both directions.
func TestStaleBothDirections(t *testing.T) {
	const limit = 1209600 // 14 days, proto/grants.md
	cases := []struct {
		name            string
		now, lastSynced int64
		want            bool
	}{
		{"never synced", 1_000_000, 0, true},
		{"fresh sync, now==lastSynced", 1_000_000, 1_000_000, false},
		{"well within window", 1_000_000, 1_000_000 - 100, false},
		{"exactly at forward limit", 1_000_000 + limit, 1_000_000, false},
		{"one second past forward limit", 1_000_000 + limit + 1, 1_000_000, true},
		{"far forward drift", 1_000_000 + 50*limit, 1_000_000, true},
		// Backward: now is BEFORE lastSynced — the RTC-less-reboot case.
		{"one second backward", 999_999, 1_000_000, true},
		{"far backward reset (bad wall clock)", 1_000_000, 1_000_000 + 2*limit, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := clock.Stale(c.now, c.lastSynced, limit); got != c.want {
				t.Errorf("Stale(now=%d, lastSynced=%d, limit=%d) = %v, want %v",
					c.now, c.lastSynced, limit, got, c.want)
			}
		})
	}
}
