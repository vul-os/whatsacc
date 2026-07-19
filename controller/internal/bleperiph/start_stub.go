//go:build !ble || (ble && !linux)

package bleperiph

import "context"

// Start is unavailable: without the `ble` build tag no bluetooth dependency
// is compiled in; with it, only Linux/BlueZ has a GATT-server backing
// (tinygo.org/x/bluetooth v0.15.0 exposes no peripheral API on darwin).
func Start(ctx context.Context, cfg Config) error {
	return ErrUnsupported
}
