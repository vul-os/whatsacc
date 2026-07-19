// Package relay is the actuation seam between verified commands and the
// physical gate. Two implementations ship: Mock (logs + state, used by
// tests and the simulator) and a GPIO stub behind the `gpio` build tag
// (documented scaffold — this reference tree carries no hardware driver).
package relay

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Relay drives the gate hardware. Implementations must be safe for
// concurrent use.
type Relay interface {
	// Pulse energizes the relay for d (the classic gate-opener trigger).
	Pulse(d time.Duration) error
	// Hold latches the relay open until Release (gate-day mode).
	Hold() error
	// Release ends a Hold.
	Release() error
	// State returns "idle" | "pulsing" | "held" for telemetry/sim output.
	State() string
}

// Sensors exposes position/tamper inputs. STUB: the reference controller
// has no sensor driver; the mock returns static values. Wire real
// debounced GPIO inputs here (position → held_open events, enclosure →
// tamper events).
type Sensors interface {
	// GateClosed reports the position sensor (true = closed), and whether
	// a position sensor is present at all.
	GateClosed() (closed, present bool)
}

// Mock is the in-memory Relay + Sensors used by tests and controller-sim.
// It logs every transition and, for Pulse, returns to idle after the pulse
// duration on a background timer.
type Mock struct {
	mu     sync.Mutex
	state  string
	Log    *slog.Logger // optional; nil = slog.Default()
	OnFail error        // when set, all actuations fail with this error (hw:… testing)
}

// NewMock returns an idle mock relay.
func NewMock(l *slog.Logger) *Mock {
	if l == nil {
		l = slog.Default()
	}
	return &Mock{state: "idle", Log: l}
}

func (m *Mock) set(s string) {
	m.state = s
	m.Log.Info("relay", "state", s)
}

// Pulse implements Relay.
func (m *Mock) Pulse(d time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.OnFail != nil {
		return m.OnFail
	}
	if m.state == "held" {
		return fmt.Errorf("relay: pulse while held")
	}
	m.set("pulsing")
	time.AfterFunc(d, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.state == "pulsing" {
			m.set("idle")
		}
	})
	return nil
}

// Hold implements Relay.
func (m *Mock) Hold() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.OnFail != nil {
		return m.OnFail
	}
	m.set("held")
	return nil
}

// Release implements Relay.
func (m *Mock) Release() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.OnFail != nil {
		return m.OnFail
	}
	m.set("idle")
	return nil
}

// State implements Relay.
func (m *Mock) State() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// GateClosed implements Sensors (stub: no sensor present).
func (m *Mock) GateClosed() (bool, bool) { return true, false }
