//go:build gpio

// GPIO build-tag stub — NOT FUNCTIONAL. This reference implementation
// carries no hardware driver; on a real Pi, replace the panics below with a
// /dev/gpiochip0 character-device driver (GPIOD ioctls — still CGO-free) or
// a maintained pure-Go GPIO library, honoring:
//
//   - pulse_ms / hold_max / sensor_debounce_ms from the config store
//   - a normally-open relay on a single output line (active high)
//   - fail-safe: on process exit or panic the line MUST drop (gate closed)
//
// Build with `go build -tags gpio` once implemented; without the tag the
// agent uses the mock relay and logs actuations instead.
package relay

import "time"

// GPIO is the hardware relay stub.
type GPIO struct {
	Chip string // e.g. "/dev/gpiochip0"
	Line int    // BCM line number wired to the relay board
}

// NewGPIO returns the (non-functional) hardware relay stub.
func NewGPIO(chip string, line int) *GPIO { return &GPIO{Chip: chip, Line: line} }

func (g *GPIO) Pulse(d time.Duration) error {
	panic("relay: gpio build-tag stub — implement the gpiochip driver before deploying to hardware")
}

func (g *GPIO) Hold() error {
	panic("relay: gpio build-tag stub — implement the gpiochip driver before deploying to hardware")
}

func (g *GPIO) Release() error {
	panic("relay: gpio build-tag stub — implement the gpiochip driver before deploying to hardware")
}

func (g *GPIO) State() string { return "idle" }

// GateClosed implements Sensors (stub: no sensor wired).
func (g *GPIO) GateClosed() (bool, bool) { return true, false }
