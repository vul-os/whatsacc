// Package clock provides the controller's gateway-synced clock. GSM/RTC-less
// boards drift, so the authoritative time base is the gateway: on every
// connect/ping the controller stores the gateway timestamp and advances it
// with the LOCAL MONOTONIC clock (immune to wall-clock steps/NTP jumps).
// The last-sync instant feeds the grants.md stale-clock rule.
package clock

import (
	"sync"
	"time"
)

// Clock is the time source the verification pipelines consume; tests use a
// fake implementation.
type Clock interface {
	// Now returns the current unix time (seconds), gateway time base.
	Now() int64
	// LastGatewaySync returns the unix time of the most recent gateway
	// sync in the same time base as Now (0 = never synced).
	LastGatewaySync() int64
}

// Synced is the production Clock.
type Synced struct {
	mu       sync.Mutex
	base     int64     // gateway unix seconds at sync instant
	baseMono time.Time // local monotonic reading at sync instant
	synced   bool
	persist  func(ts int64) // optional persistence hook (state store)
}

// NewSynced builds a Synced clock. lastSync is the persisted unix time of
// the previous run's last gateway sync (0 = never); until the first live
// sync the clock falls back to the system wall clock, and LastGatewaySync
// reports the persisted value — so the stale-clock rule keeps working
// across reboots. persist (may be nil) is called on every sync.
func NewSynced(lastSync int64, persist func(ts int64)) *Synced {
	return &Synced{base: lastSync, persist: persist}
}

// Now returns gateway-base unix seconds: system wall clock before the first
// sync, monotonic-advanced gateway time after.
func (c *Synced) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.synced {
		return time.Now().Unix()
	}
	return c.base + int64(time.Since(c.baseMono)/time.Second)
}

// LastGatewaySync returns the unix instant of the last sync (this run or,
// before the first live sync, the persisted one from previous runs).
func (c *Synced) LastGatewaySync() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.synced {
		return c.base
	}
	return c.base
}

// SyncFromGateway records a gateway-authoritative timestamp (from a ws
// challenge/command iat or ping) and re-bases the monotonic clock.
func (c *Synced) SyncFromGateway(ts int64) {
	c.mu.Lock()
	c.base = ts
	c.baseMono = time.Now()
	c.synced = true
	persist := c.persist
	c.mu.Unlock()
	if persist != nil {
		persist(ts)
	}
}

// Stale reports whether a clock is too untrustworthy to use for an offline
// decision — in EITHER direction, not just "too far forward". grants.md's
// 14-day rule was specified as "now - lastSynced > limit", which only
// catches a clock that has drifted forward too far. An RTC-less controller
// rebooting after a power cut can come up with `now` reading BEFORE the
// persisted lastSynced (a wall-clock reset backward, e.g. to the epoch or
// some other stale default) — that produces a NEGATIVE elapsed time, which
// never trips ">", so the naive check silently does not fire even though
// the clock is exactly as untrustworthy as the forward-drift case
// (proto/events.md "Clock after a power cut"). Stale treats a clock that
// has never synced, OR whose elapsed time since lastSynced falls outside
// [0, limit] in either direction, as stale.
func Stale(now, lastSynced, limit int64) bool {
	if lastSynced == 0 {
		return true
	}
	elapsed := now - lastSynced
	return elapsed < 0 || elapsed > limit
}

// Fake is a settable clock for tests and the simulator's offline demo.
type Fake struct {
	NowSec  int64
	SyncSec int64
}

// Now implements Clock.
func (f *Fake) Now() int64 { return f.NowSec }

// LastGatewaySync implements Clock.
func (f *Fake) LastGatewaySync() int64 { return f.SyncSec }
